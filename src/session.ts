// One served review: what the page is configured with, and the answers to its API calls.
import fs from 'node:fs';
import path from 'node:path';
import type { Progress, ReviewData } from './build.js';
import { reviewDir } from './cache.js';
import { changedSince, LiveSession, openInEditor, type Side } from './live.js';
import { Metrics } from './metrics.js';
import type { PageConfig } from './page.js';
import { ghReady, GitHubError, PullRequestConversation, type Action, type CommitFacts } from './github.js';
import type { NotesContext, Post, Side as NoteSide } from './notes.js';
import { broughtBy, hasCommit, reviewedHead, sinceRows, type History } from './history.js';
import { git, gitAsync, gitMaybe, runAsync } from './exec.js';
import { fileHunks, generatedPatterns, parseHunks } from './pipeline/diff.js';
import { writeAtomic } from './server.js';
import { marksRef, moveMarks, Snapshot } from './snapshot.js';
import type { Target } from './target.js';
import '../viewer/core.js';

const C = globalThis.ReviewCore;

// A generated file's diff past this many changed lines isn't shown.
const GENERATED_MAX_LINES = 20_000;

interface Edit { id: number; b: string }
interface Block { id: string; edits: number[] }

/** How the page opens a location in the editor: a link it builds, or a command untangle runs. */
export type Editor = { mode: 'uri'; template: string } | { mode: 'command'; template: string } | { mode: 'orca'; command: string };

/** Explicit editor settings win; inside Orca use its CLI, otherwise a VS Code link. */
export function editorFrom(option: string | null): Editor {
  const t = option || process.env.UNTANGLE_EDITOR || '';
  if (t) return t.includes('://') ? { mode: 'uri', template: t } : { mode: 'command', template: t };
  const orca = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.env.ORCA_WORKTREE_ID ? (process.platform === 'linux' ? 'orca-ide' : 'orca') : null);
  if (orca) return { mode: 'orca', command: orca };
  const wsl = process.env.WSL_DISTRO_NAME;
  return { mode: 'uri', template: wsl ? `vscode://vscode-remote/wsl+${wsl}{file}:{line}:{col}` : 'vscode://file{file}:{line}:{col}' };
}

export class ReviewSession {
  readonly snapshot: Snapshot;
  private readonly blocks = new Map<string, Block>();
  private readonly edits: Edit[];
  private readonly stateFile: string;
  private partial = new Set<number>();
  // A change's lines from one commit, reviewed under that commit's lens ("<block>@<sha>").
  private cmarks = new Set<string>();
  private view: { layout?: string; showReviewedDiff?: boolean } = {};
  private snapshotInfo: { ref: string; commit: string | null; note: string | null };
  private readonly generatedRx: RegExp[];
  // Blocks the marks' ref holds.
  private reviewed: Set<string>;
  private readonly metrics = new Metrics();
  private lines: Record<string, number> | null = null;
  private readonly github: PullRequestConversation | null;

  constructor(
    private readonly target: Target,
    private readonly data: ReviewData,
    readonly live: LiveSession,
    private readonly editor: Editor,
    private readonly page: { key: string; url: string | null; where: string; snapshotKey: string },
    progress: Progress,
    /** The commits and who wrote each line, as the page has them (null when git couldn't tell). */
    private readonly history: History | null = null,
  ) {
    const c = data.model.compares.base;
    c.files.forEach((f: { blocks: Block[] }) => f.blocks.forEach((b) => this.blocks.set(b.id, b)));
    this.edits = c.edits;
    this.generatedRx = generatedPatterns(target.repo, target.headSha).map((g) => C.globToRegExp(g));
    const marks = marksRef(target.repo, page.snapshotKey);
    moveMarks(target.repo, marks);
    this.snapshot = new Snapshot(target.repo, marks, target.baseSha, target.headSha, c);
    // Marks on parts of a change, the layout, and the blocks of the last commit this review wrote
    // live next to the review, for these commits only.
    this.stateFile = path.join(reviewDir(target.repoKey, target.baseSha, target.headSha), 'state.json');
    let saved: { partial?: number[]; cmarks?: string[]; layout?: string; showReviewedDiff?: boolean; snapshot?: { commit: string; blocks: string[] } } = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      // No marks yet.
    }
    const loaded = this.snapshot.load(saved.snapshot || null);
    let note: string | null = null;
    if (loaded.replayed) {
      note = `replayed onto ${target.baseSha.slice(0, 7)}${loaded.replayed.conflicts.length ? `; ${loaded.replayed.conflicts.length} file${loaded.replayed.conflicts.length > 1 ? 's' : ''} conflicted and went back to unreviewed` : ''}`;
      progress.note(`your review in ${this.snapshot.name} was ${note}`);
    }
    this.snapshotInfo = { ref: this.snapshot.name, commit: loaded.commit, note };
    this.reviewed = loaded.reviewed;
    this.partial = new Set((saved.partial || []).filter((id: number) => this.edits[id] && !this.reviewed.has(this.edits[id].b)));
    this.cmarks = this.commitMarks(saved.cmarks);
    this.view = { layout: saved.layout, showReviewedDiff: saved.showReviewedDiff };
    const pr = target.pr;
    this.github = pr && ghReady() ? new PullRequestConversation({ owner: pr.owner, repo: pr.repo, number: pr.number }, target.headSha) : null;
  }

  // Rows changed since an older head, by that head: the diffs behind them don't change.
  private readonly since = new Map<string, Promise<Record<number, Record<number, number[]>> | null>>();
  // GitHub's facts about the commits, asked at most twice a minute.
  private facts: { at: number; value: CommitFacts | null; error: string | null; pending: Promise<void> | null } = { at: 0, value: null, error: null, pending: null };
  // Old heads fetched (or tried) once each.
  private readonly fetched = new Map<string, Promise<boolean>>();

  /** An old head, fetched from GitHub when this clone doesn't have it (GitHub keeps them a while). */
  private oldHead(sha: string): Promise<boolean> {
    if (hasCommit(this.target.repo, sha)) return Promise.resolve(true);
    let p = this.fetched.get(sha);
    if (!p) {
      p = gitAsync(this.target.repo, ['fetch', '--quiet', '--no-tags', 'origin', sha]).then(() => hasCommit(this.target.repo, sha), () => false);
      this.fetched.set(sha, p);
    }
    return p;
  }

  /**
   * What the commits' graph learns live: the head of your last review before this one, GitHub's
   * checks, reviews and force pushes, and each old head (a force push's, or the one you reviewed
   * when it's no longer in the branch) with where it left the branch and how many commits it had.
   */
  private async commitsNow() {
    const t = this.target;
    const inHistory = new Set((this.history ? this.history.commits : []).map((c) => c.sha));
    const prev = reviewedHead(t.repo, this.snapshot.ref, t.headSha);
    if (this.github && Date.now() - this.facts.at > 30_000 && !this.facts.pending) {
      this.facts.pending = this.github.commits().then(
        (v) => { this.facts = { at: Date.now(), value: v, error: null, pending: null }; },
        (e) => { this.facts = { at: Date.now(), value: this.facts.value, error: (e as Error).message, pending: null }; },
      );
    }
    if (this.facts.pending) await this.facts.pending;
    const facts = this.facts.value;
    const olds = new Map<string, { at: number; actor: string | null; after: string | null; yours: boolean }>();
    (facts ? facts.pushes : []).forEach((p) => { if (p.before && !inHistory.has(p.before)) olds.set(p.before, { at: Date.parse(p.at) / 1000, actor: p.actor, after: p.after, yours: false }); });
    if (prev && !inHistory.has(prev.head)) {
      const o = olds.get(prev.head);
      if (o) o.yours = true;
      else olds.set(prev.head, { at: prev.at, actor: null, after: null, yours: true });
    }
    // The latest few force pushes, and always the head of your last review.
    const kept = [...olds].sort((a, b) => b[1].at - a[1].at).filter(([, o], i) => o.yours || i < 5);
    const ghosts = await Promise.all(kept.map(async ([sha, o]) => {
      const here = await this.oldHead(sha);
      if (!here) return { sha, ...o, here, fork: null, replaced: null };
      const fork = gitMaybe(t.repo, 'merge-base', sha, t.headSha)?.trim() || null;
      const replaced = Number(gitMaybe(t.repo, 'rev-list', '--count', sha, `^${t.headSha}`, `^${t.baseSha}`)?.trim()) || 0;
      return { sha, ...o, here, fork: fork && inHistory.has(fork) ? fork : null, replaced };
    }));
    return {
      review: prev ? { head: prev.head, at: prev.at, here: prev.head === t.headSha ? true : await this.oldHead(prev.head), inBranch: inHistory.has(prev.head) } : null,
      github: facts,
      githubError: this.github ? this.facts.error : null,
      ghosts,
    };
  }

  // Each changed line's change, by "<path>\n<side>\n<line>": built the first time a note asks.
  private changes: Map<string, { name: string; sha: string | null }> | null = null;

  /** The change a line is in: its chain's name and, by commit, the commit that started it. */
  private changeAt(p: string, side: NoteSide, line: number): { name: string; sha: string | null } | null {
    if (!this.changes) {
      const c = this.data.model.compares.base;
      const families = new Map<number, { sha?: string; same?: boolean }>((c.families || []).map((f: { id: number }) => [f.id, f]));
      const chainOf = new Map<string, { name: string; sha: string | null }>();
      c.chains.forEach((ch: { name: string; kind?: string; family: number; blocks: string[] }) => {
        const fam = ch.kind === 'commit' ? families.get(ch.family) : undefined;
        ch.blocks.forEach((id) => { if (!chainOf.has(id)) chainOf.set(id, { name: ch.name, sha: fam && !fam.same && fam.sha ? fam.sha : null }); });
      });
      this.changes = new Map();
      c.files.forEach((f: { p: string; hunks: Array<{ o: number; n: number; rows: Array<[string]> }>; blocks: Array<{ id: string; hunk: number; first: number; len: number }> }) => {
        f.blocks.forEach((b) => {
          const change = chainOf.get(b.id);
          const h = f.hunks[b.hunk];
          if (!change || !h) return;
          let o = h.o, n = h.n;
          h.rows.forEach(([t], i) => {
            if (i >= b.first && i < b.first + b.len) {
              if (t !== '-') this.changes!.set(`${f.p}\nRIGHT\n${n}`, change);
              if (t !== '+') this.changes!.set(`${f.p}\nLEFT\n${o}`, change);
            }
            if (t !== '+') o++;
            if (t !== '-') n++;
          });
        });
      });
    }
    return this.changes.get(`${p}\n${side}\n${line}`) || null;
  }

  /** What the notes need of this review: its commits, the change of each line, and GitHub to post to. */
  notesContext(name: string, branch: string | null, checkout: string | null): NotesContext {
    const gh = this.github;
    return {
      repo: this.target.repo, base: this.target.baseSha, head: this.target.headSha, name, branch, checkout,
      change: (p, side, line) => this.changeAt(p, side, line),
      post: gh ? (x: Post) => gh.act('thread' in x
        ? { action: 'reply', mode: 'review', thread: x.thread, body: x.body }
        : { action: 'thread', mode: 'review', draft: { path: x.path, body: x.body, line: x.line, side: x.side, startLine: x.startLine, startSide: x.startSide } }) : null,
    };
  }

  /** Marks on one commit's lines of a change, for changes of this review that aren't reviewed whole. */
  private commitMarks(list: unknown): Set<string> {
    return new Set((Array.isArray(list) ? list : []).filter((k): k is string => typeof k === 'string' && /@[0-9a-f]{40}$/.test(k) && this.blocks.has(k.slice(0, k.lastIndexOf('@'))) && !this.reviewed.has(k.slice(0, k.lastIndexOf('@')))));
  }

  /** Edits marked reviewed: the snapshot's blocks, and marks on parts of a change. */
  private rev(): number[] {
    const out = new Set(this.partial);
    this.reviewed.forEach((id) => this.blocks.get(id)?.edits.forEach((e) => out.add(e)));
    return [...out].sort((a, b) => a - b);
  }

  /** Changes marked reviewed, of all, as the page counts them: a change in several places counts once. */
  progress(): { done: number; total: number } {
    const rev = new Set(this.rev());
    const units = new Map<string, boolean>();
    for (const f of this.data.model.compares.base.files as Array<{ blocks: Array<{ id: string; unit?: string; edits: number[] }> }>) {
      for (const b of f.blocks) {
        if (!b.edits.length) continue;
        const key = b.unit || b.id;
        units.set(key, (units.get(key) ?? true) && b.edits.every((e) => rev.has(e)));
      }
    }
    return { done: [...units.values()].filter(Boolean).length, total: units.size };
  }

  /** Lines added and removed, and files, generated ones included. */
  size(): { add: number; del: number; files: number } {
    const c = this.data.model.compares.base;
    const all = [...c.files, ...c.generated] as Array<{ a?: number; d?: number }>;
    return { add: all.reduce((n, f) => n + Math.max(0, f.a || 0), 0), del: all.reduce((n, f) => n + Math.max(0, f.d || 0), 0), files: all.length };
  }

  config(): PageConfig {
    const roots = this.live.roots;
    if (!this.lines) {
      const c = this.data.model.compares.base;
      this.lines = this.live.lineCounts([...c.files, ...c.generated].filter((f: { s: string }) => f.s === 'M').map((f: { p: string }) => f.p));
    }
    return {
      served: true,
      key: this.page.key,
      url: this.page.url,
      where: this.page.where,
      state: { rev: { base: this.rev() }, cmarks: [...this.cmarks], layout: this.view.layout, showReviewedDiff: this.view.showReviewedDiff },
      roots,
      editor: this.editor.mode === 'uri' ? { mode: 'uri', template: this.editor.template } : { mode: this.editor.mode },
      snapshot: this.snapshotInfo,
      lines: this.lines,
      github: !this.target.pr ? null : this.github ? { number: this.target.pr.number, url: this.target.pr.url } : { off: 'Comments from GitHub need the gh command line, logged in (gh auth login).' },
      head: this.target.headSha,
      base: this.target.baseSha,
    };
  }

  private saveState(body: { rev?: { base?: number[] }; cmarks?: string[]; layout?: string; showReviewedDiff?: boolean }) {
    const rev = new Set((body.rev?.base || []).filter((id) => Number.isInteger(id) && this.edits[id]));
    const reviewed = new Set([...this.blocks.values()].filter((b) => b.edits.length && b.edits.every((e) => rev.has(e))).map((b) => b.id));
    if (this.snapshot.differs(reviewed)) {
      const total = [...this.blocks.values()].filter((b) => b.edits.length).length;
      const saved = this.snapshot.save(reviewed, `Review: ${reviewed.size} of ${total} change${total === 1 ? '' : 's'} reviewed`);
      this.snapshotInfo = { ...this.snapshotInfo, commit: saved.commit };
      this.reviewed = reviewed;
    }
    this.partial = new Set([...rev].filter((id) => !reviewed.has(this.edits[id].b)));
    this.cmarks = this.commitMarks(body.cmarks);
    this.view = { layout: body.layout, showReviewedDiff: body.showReviewedDiff };
    writeAtomic(this.stateFile, JSON.stringify({ partial: [...this.partial], cmarks: [...this.cmarks], ...this.view, snapshot: this.snapshotInfo.commit ? { commit: this.snapshotInfo.commit, blocks: [...this.reviewed] } : undefined }));
    return { snapshot: this.snapshotInfo };
  }

  private generated(p: string) {
    const g = this.data.model.compares.base.generated.find((x: { p: string }) => x.p === p);
    if (!g) return { status: 404, data: { error: `${p} is not a generated file of this review` } };
    if (g.hunks) return { data: { hunks: g.hunks } };
    if (g.a + g.d > GENERATED_MAX_LINES) return { status: 413, data: { error: `${(g.a + g.d).toLocaleString('en-US')} changed lines: too many to show here` } };
    return { data: { hunks: fileHunks(this.target.repo, this.target.baseSha, this.target.headSha, p).map((h) => ({ o: h.o, n: h.n, h: h.h, rows: h.l.map((l) => [l[0], l.slice(1)]) })) } };
  }

  /** The page's API. */
  async call(route: string, method: string, q: URLSearchParams, body: unknown): Promise<{ status?: number; data: unknown }> {
    const where = () => ({ side: q.get('side') || undefined, p: q.get('p') || undefined, ext: q.has('ext') ? Number(q.get('ext')) : undefined });
    if (route === 'metrics' && method === 'GET') return { data: this.metrics.sample(this.live.state()) };
    if (route === 'lsp/restart' && method === 'POST') {
      await this.live.restart();
      return { data: this.live.state() };
    }
    if (route === 'state' && method === 'PUT') return { data: this.saveState((body || {}) as Parameters<ReviewSession['saveState']>[0]) };
    if (route === 'generated' && method === 'GET') return this.generated(q.get('p') || '');
    if (route === 'definition' && method === 'GET') {
      const target = await this.live.definition(where(), Number(q.get('l')), Number(q.get('c')));
      return { data: { target } };
    }
    if ((route === 'usages' || route === 'implementations') && method === 'GET') {
      const gone = q.get('side') === 'base' ? 'A' : 'D';
      const files = this.data.model.compares.base.files.filter((f: { s: string }) => f.s !== gone).map((f: { p: string }) => f.p);
      const l = Number(q.get('l')), c = Number(q.get('c'));
      return { data: route === 'usages' ? await this.live.usages(where(), l, c, files) : await this.live.implementations(where(), l, c, files) };
    }
    if (route === 'commit-file' && method === 'GET') {
      const p = q.get('p') || '';
      const commit = this.history?.commits.find((c) => c.sha === q.get('sha'));
      const file = commit?.files.find((f) => this.history!.paths[f[0]] === p);
      if (!commit || !file) return { status: 404, data: { error: 'not a file changed by this commit' } };
      if ((file[2] || 0) + (file[3] || 0) > GENERATED_MAX_LINES) {
        return { status: 413, data: { error: 'More than 20,000 changed lines: too many to show here' } };
      }
      const parent = gitMaybe(this.target.repo, 'rev-parse', `${commit.sha}^1`)?.trim()
        || git(this.target.repo, 'hash-object', '-t', 'tree', '--stdin').trim();
      const from = file[4] == null ? null : this.history!.paths[file[4]];
      const revisions = from ? [`${parent}:${from}`, `${commit.sha}:${p}`] : [parent, commit.sha, '--', p];
      const diff = git(this.target.repo, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '-U3', ...revisions);
      return { data: { hunks: parseHunks(diff), from, binary: file[2] < 0, status: file[1] } };
    }
    if (route === 'file' && method === 'GET') {
      const w = where();
      const out = await this.live.file(w);
      if ('error' in out) return { status: 404, data: out };
      const p = w.p || out.abs || '';
      return { data: { ...out, generated: !!w.p && this.generatedRx.some((rx) => rx.test(w.p!)), lang: C.langOf(p) } };
    }
    if (route === 'search' && method === 'GET') {
      const side = (q.get('side') === 'base' ? 'base' : 'head') as Side;
      const term = q.get('q') || '';
      if (term.trim().length < 2) return { data: { results: [], truncated: false } };
      const out = this.live.search(side, term);
      return { data: { ...out, results: out.results.map((r) => ({ ...r, generated: this.generatedRx.some((rx) => rx.test(r.p)) })) } };
    }
    if (route === 'files' && method === 'GET') return { data: { files: this.live.files() } };
    if (route === 'symbols' && method === 'GET') {
      const term = (q.get('q') || '').trim();
      if (term.length < 2) return { data: { symbols: [] } };
      const files = this.data.model.compares.base.files.filter((f: { s: string }) => f.s !== 'D').map((f: { p: string }) => f.p);
      return { data: { symbols: await this.live.symbols(term, files) } };
    }
    if (route === 'changed' && method === 'GET') {
      // After a refresh: the lines at the head that changed since the commit the page showed.
      const from = q.get('from') || '';
      if (!/^[0-9a-f]{7,40}$/.test(from)) return { status: 400, data: { error: 'which commit?' } };
      return { data: { files: changedSince(this.target.repo, from, this.target.headSha) } };
    }
    if (route === 'open' && method === 'POST') {
      if (this.editor.mode === 'uri') return { status: 400, data: { error: 'no editor command: start untangle with -editor' } };
      const b = (body || {}) as { side?: string; p?: string; ext?: number; l?: number; c?: number };
      if (this.editor.mode === 'orca') {
        // Orca opens files inside a managed worktree, not the cached analysis checkouts.
        // Select the reviewed repository explicitly: the terminal may belong to a different one.
        if (!b.p || (b.side !== 'head' && b.side !== 'base') || path.isAbsolute(b.p) || b.p.split(/[\\/]/).includes('..')) {
          return { status: 400, data: { error: 'Orca can open the working copy of a file in this review’s repository.' } };
        }
        const file = path.join(this.target.repo, b.p);
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
          return { status: 404, data: { error: 'This file is absent from the working copy. Its reviewed version is available in the review page.' } };
        }
        try {
          await runAsync(this.editor.command, ['file', 'open', '--path', b.p, '--worktree', 'path:' + this.target.repo, '--focus', '--json'], { cwd: this.target.repo });
          return { data: { opened: file } };
        } catch (e) {
          return { status: 502, data: { error: `Orca could not open the file: ${(e as Error).message}` } };
        }
      }
      const file = await this.live.absolute(b);
      if (!file) return { status: 404, data: { error: 'not a file of this review' } };
      openInEditor(this.editor.template, file, b.l || 1, b.c || 0);
      return { data: { opened: file } };
    }
    if (route === 'github' && (method === 'GET' || method === 'POST')) {
      if (!this.github) return { status: 404, data: { error: this.target.pr ? 'Comments from GitHub need the gh command line, logged in (gh auth login).' : 'This review has no pull request.' } };
      try {
        return { data: method === 'GET' ? await this.github.load() : await this.github.act(body as Action) };
      } catch (e) {
        return { status: e instanceof GitHubError ? 502 : 500, data: { error: (e as Error).message } };
      }
    }
    if (route === 'history' && method === 'GET') return { data: await this.commitsNow() };
    if (route === 'since' && method === 'GET') {
      const from = q.get('from') || '';
      if (!/^[0-9a-f]{40}$/.test(from)) return { status: 400, data: { error: 'since which commit?' } };
      let rows = this.since.get(from);
      if (!rows) {
        rows = sinceRows(this.target.repo, this.target.baseSha, this.target.headSha, from, this.data.model.compares.base.files);
        this.since.set(from, rows);
        rows.catch(() => this.since.delete(from));
      }
      const out = await rows;
      return out ? { data: { rows: out } } : { status: 404, data: { error: `${from.slice(0, 7)} isn’t in the repository` } };
    }
    if (route === 'brought' && method === 'GET') {
      const sha = q.get('sha') || '';
      if (!/^[0-9a-f]{40}$/.test(sha)) return { status: 400, data: { error: 'which merge?' } };
      const out = await broughtBy(this.target.repo, sha);
      return out ? { data: out } : { status: 404, data: { error: `${sha.slice(0, 7)} isn’t in the repository` } };
    }
    if (route === 'roots' && method === 'GET') {
      // The checkouts, made when the review came from the cache: links to the editor need them.
      const { headDir, baseDir } = await this.live.checkouts();
      return { data: { head: headDir, base: baseDir } };
    }
    return { status: 404, data: { error: `no such call: ${method} ${route}` } };
  }
}
