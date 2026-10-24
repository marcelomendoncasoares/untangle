// Line numbers in a stack's comparison and in each pull request's own diff.
import { gitAsync } from './exec.js';
import { GitHubError, type Draft } from './github.js';
import { diffHunks, type History } from './history.js';
import { parseDiff } from './notes.js';
import type { Target } from './target.js';

export interface Placed { pr: number; line: number | null; startLine: number | null; side: 'LEFT' | 'RIGHT' }
interface Location { path: string; line: number }
type File = { p: string; hunks?: Array<{ o: number; n: number; rows: Array<[string, ...unknown[]]> }> | null };

export class StackLines {
  private readonly owners = new Map<string, number>();
  private readonly diffs = new Map<string, Promise<ReturnType<typeof parseDiff>>>();
  private readonly mapped = new Map<string, ReturnType<typeof parseDiff>>();
  private readonly ranges = new Map<number, { RIGHT: Map<string, Array<[number, number]>>; LEFT: Map<string, Array<[number, number]>> }>();
  private readonly bases = new Map<number, string>();
  private readonly visible = new Map<string, Array<[number, number]>>();

  constructor(private readonly target: Target, history: History | null, files: File[]) {
    files.forEach((f, fi) => f.hunks?.forEach((h, hi) => {
      for (const side of ['LEFT', 'RIGHT'] as const) {
        const key = `${f.p}\n${side}`, ranges = this.visible.get(key) ?? [];
        ranges.push([side === 'LEFT' ? h.o : h.n, h.rows.filter(([kind]) => kind !== (side === 'LEFT' ? '+' : '-')).length]);
        this.visible.set(key, ranges);
      }
      let o = h.o, n = h.n;
      h.rows.forEach(([kind], ri) => {
        const i = history?.rows[fi]?.[hi]?.[ri] ?? -1, leg = history?.commits[i]?.leg;
        if (leg != null && kind !== ' ') this.owners.set(`${f.p}\n${kind === '-' ? 'LEFT' : 'RIGHT'}\n${kind === '-' ? o : n}`, leg);
        if (kind !== '+') o++;
        if (kind !== '-') n++;
      });
    }));
  }

  private diff(from: string, to: string): Promise<ReturnType<typeof parseDiff>> {
    const key = `${from}:${to}`;
    let reading = this.diffs.get(key);
    if (!reading) {
      reading = (from === to ? Promise.resolve('') : gitAsync(this.target.repo, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '-M', '--unified=0', from, to]))
        .then((s) => { const d = parseDiff(s); this.mapped.set(key, d); return d; });
      this.diffs.set(key, reading);
    }
    return reading;
  }

  /** The immutable maps are ready before notes or the composer can ask for a location. */
  async prepare(): Promise<void> {
    const t = this.target;
    for (const leg of t.stack!.legs) {
      const head = leg.pr.headRefOid;
      const base = leg.base;
      this.bases.set(leg.pr.number, base);
      const diff = await gitAsync(t.repo, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', base, head]);
      this.ranges.set(leg.pr.number, { RIGHT: diffHunks(diff, 'plus'), LEFT: diffHunks(diff, 'minus') });
      await Promise.all([this.diff(t.headSha, head), this.diff(head, t.headSha), this.diff(t.baseSha, base), this.diff(base, t.baseSha)]);
    }
  }

  private map(from: string, to: string, p: string, line: number): Location | null {
    const d = this.mapped.get(`${from}:${to}`)?.get(p);
    if (!d) return { path: p, line };
    if (!d.to || d.binary) return null;
    let delta = 0;
    for (const [old, count, , added] of d.hunks) {
      if (count && line >= old && line < old + count) return null;
      if (line < (count ? old : old + 1)) break;
      delta += added - count;
    }
    return { path: d.to, line: line + delta };
  }

  private inDiff(pr: number, side: 'LEFT' | 'RIGHT', at: Location): boolean {
    return !!this.ranges.get(pr)?.[side].get(at.path)?.some(([first, count]) => at.line >= first && at.line < first + count);
  }

  private toLeg(pr: number, side: 'LEFT' | 'RIGHT', p: string, line: number): Location | null {
    const leg = this.target.stack!.legs.find((l) => l.pr.number === pr)!;
    return this.map(side === 'RIGHT' ? this.target.headSha : this.target.baseSha, side === 'RIGHT' ? leg.pr.headRefOid : this.bases.get(pr)!, p, line);
  }

  /** The last line owns a range. Context follows a leg whose diff contains it. */
  owner(p: string, side: 'LEFT' | 'RIGHT', line: number | null): number {
    const own = line == null ? null : this.owners.get(`${p}\n${side}\n${line}`);
    if (own != null) return own;
    for (const leg of this.target.stack!.legs) {
      if (line == null ? this.ranges.get(leg.pr.number)?.[side].has(p) : (() => { const at = this.toLeg(leg.pr.number, side, p, line); return at && this.inDiff(leg.pr.number, side, at); })()) return leg.pr.number;
    }
    return this.target.pr!.number;
  }

  place(d: Omit<Draft, 'body'>, preferred?: number | null): Placed & { path: string } {
    const side = d.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    if (typeof d.path !== 'string' || !d.path || d.path.includes('\0') || d.path.split(/[\\/]/).includes('..')) throw new GitHubError('which file?');
    if (d.line != null && (!Number.isInteger(d.line) || d.line < 1)) throw new GitHubError('which line?');
    const pr = preferred ?? this.owner(d.path, side, d.line ?? null);
    if (!this.target.stack!.legs.some((l) => l.pr.number === pr)) throw new GitHubError(`#${pr} is no longer in this stack; refresh the review`);
    if (d.line == null) return { pr, path: d.path, line: null, startLine: null, side };
    const at = this.toLeg(pr, side, d.path, d.line);
    if (!at || !this.inDiff(pr, side, at)) throw new GitHubError(`This line is not in #${pr}'s diff on GitHub.`);
    let start: Location | null = null;
    if (d.startLine != null) {
      if (!Number.isInteger(d.startLine) || d.startLine < 1 || d.startLine > d.line || (d.startSide && d.startSide !== side)) throw new GitHubError('which range?');
      start = this.toLeg(pr, side, d.path, d.startLine);
      if (!start || start.path !== at.path || !this.inDiff(pr, side, start)) throw new GitHubError(`The first line of this range is not in #${pr}'s diff.`);
    }
    return { pr, path: at.path, line: at.line, startLine: start?.line ?? null, side };
  }

  /** GitHub already marked old threads outdated; never guess a replacement line for them. */
  async fromLeg(pr: number, side: 'LEFT' | 'RIGHT', p: string, line: number, head?: string): Promise<Location | null> {
    const leg = this.target.stack!.legs.find((l) => l.pr.number === pr)!;
    const from = side === 'RIGHT' ? head ?? leg.pr.headRefOid : this.bases.get(pr)!;
    const to = side === 'RIGHT' ? this.target.headSha : this.target.baseSha;
    try { await this.diff(from, to); } catch { return null; }
    const at = this.map(from, to, p, line);
    return at && this.visible.get(`${at.path}\n${side}`)?.some(([first, count]) => at.line >= first && at.line < first + count) ? at : null;
  }
}
