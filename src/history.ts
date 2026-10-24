// The pull request's commits, and which commit wrote each changed line.
//
// git log lists the commits between the base and the head; git blame over the same range gives
// each added line the commit that last wrote it, and blame --reverse each removed line the last
// commit that still had it (the commit after it removed it). The page uses both for a lens: the
// changes of some commits, or of everything since an older head (your last review, or the head
// before a force push), which a content diff answers instead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitAsync, gitMaybe } from './exec.js';
import type { StackTarget } from './stack.js';

export interface HistoryCommit {
  sha: string;
  leg: number | null;
  brings: number | null;
  /** Parents in the history, the first one first. */
  parents: string[];
  /** Parents outside it: where the branch starts, or what a merge brought in. */
  outside: string[];
  /** Commits a merge brought in from outside the review (from its first parent to the others). */
  brought: number;
  subject: string;
  body: string;
  author: string;
  email: string;
  /** Author time, in seconds. */
  at: number;
  committer: string;
  cemail: string;
  /** Commit time, in seconds. */
  cat: number;
  /** The files it changed against its first parent (a merge's: what it brought in). */
  files: CommitFile[];
  /** How many more files it changed than are listed. */
  more: number;
}

/**
 * A file a commit changed: its path (an index into History.paths), its status (A, M, D, R, C or
 * T), the lines added and removed (-1 for a binary file), and the path a rename or copy came from.
 */
export type CommitFile = [number, string, number, number] | [number, string, number, number, number];

export interface History {
  version: string;
  stack: Stack | null;
  base: string;
  head: string;
  /** Newest first, in topological order. */
  commits: HistoryCommit[];
  /** The paths the commits' files name. */
  paths: string[];
  /**
   * For each file of the review (by index), each hunk's rows: the commit (an index into
   * commits) that wrote an added line or removed a line, -1 for context and the unknown.
   */
  rows: Array<number[][] | null>;
}

export interface Stack {
  base: { ref: string; sha: string; squashed: number | null };
  legs: Array<{ number: number; title: string; url: string; branch: string; head: string; draft: boolean; author: string | null; commits: number[] }>;
  above: Array<{ number: number; title: string; url: string; branch: string }>;
}

interface ModelFile {
  p: string;
  s: string;
  hunks?: Array<{ o: number; n: number; rows: Array<[string, ...unknown[]]> }> | null;
}

const VERSION = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);
const BODY_MAX = 4000;
const FILES_MAX = 1000;
const WIDTH = 6;

async function pool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

/** Final line -> the commit blame gives it, from porcelain output. */
function blameLines(out: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (m) lines.set(Number(m[2]), m[1]);
  }
  return lines;
}

/** The commits of base..head, newest first. */
async function readCommits(repo: string, base: string, head: string): Promise<HistoryCommit[]> {
  const out = await gitAsync(repo, ['log', '--topo-order', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s%x00%b%x1e', `${base}..${head}`]);
  const list = out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((r) => {
    const [sha, parents, author, email, at, committer, cemail, cat, subject, body] = r.split('\x00');
    return { sha, all: parents.split(' ').filter(Boolean), author, email, at: Number(at), committer, cemail, cat: Number(cat), subject, body: (body || '').trim().slice(0, BODY_MAX) };
  });
  const inRange = new Set(list.map((c) => c.sha));
  const commits: HistoryCommit[] = list.map((c) => ({
    sha: c.sha, leg: null, brings: null, parents: c.all.filter((p) => inRange.has(p)), outside: c.all.filter((p) => !inRange.has(p)), brought: 0,
    subject: c.subject, body: c.body, author: c.author, email: c.email, at: c.at, committer: c.committer, cemail: c.cemail, cat: c.cat, files: [], more: 0,
  }));
  // A merge from outside: the commits its other parents brought that its first parent didn't have.
  await Promise.all(commits.map(async (c, i) => {
    const all = list[i].all;
    if (all.length < 2 || !inRange.has(all[0])) return;
    const others = all.slice(1).filter((p) => !inRange.has(p));
    if (!others.length) return;
    const counts = await Promise.all(others.map((p) => gitAsync(repo, ['rev-list', '--count', `${all[0]}..${p}`]).then((x) => Number(x.trim()) || 0, () => 0)));
    c.brought = counts.reduce((a, b) => a + b, 0);
  }));
  return commits;
}

async function withLegs(repo: string, base: string, commits: HistoryCommit[], stack: StackTarget): Promise<Stack> {
  // Overwrite from the top down: the lowest head that contains a commit owns it.
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  for (const leg of stack.legs) {
    const shas = (await gitAsync(repo, ['rev-list', `${base}..${leg.head}`])).trim().split('\n');
    for (const sha of shas) {
      const c = bySha.get(sha);
      if (c) c.leg = leg.pr.number;
    }
  }
  const order = new Map(stack.legs.map((l, i) => [l.pr.number, i]));
  const parents = new Map((await gitAsync(repo, ['log', '--format=%H %P', `${base}..${stack.legs[0].head}`])).trim().split('\n').map((s) => {
    const [sha, ...all] = s.split(' ');
    return [sha, all] as const;
  }));
  for (const c of commits) {
    const parent = parents.get(c.sha)?.slice(1).map((p) => bySha.get(p)).find((p) => p?.leg != null && order.get(p.leg)! > order.get(c.leg!)!);
    c.brings = parent?.leg ?? null;
  }
  return {
    base: stack.base, above: stack.above,
    legs: stack.legs.map(({ pr, head }) => ({ number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, head, draft: !!pr.isDraft, author: pr.author ?? null, commits: commits.flatMap((c, i) => c.leg === pr.number ? [i] : []) })),
  };
}

/**
 * The files each commit changed, against its first parent, into each commit's `files`; returns
 * the paths they name. git's -z output: a commit's raw lines (":modes shas status", then its path,
 * or a rename's two), then its numstat lines ("added\tremoved\tpath", or "added\tremoved\t" and a
 * rename's two paths).
 */
async function readFiles(repo: string, base: string, head: string, commits: HistoryCommit[]): Promise<string[]> {
  const args = ['log', '--topo-order', '--format=%x1e%H', '--raw', '--numstat', '-M', '--no-abbrev', '-z'];
  // A git before 2.31 has no --diff-merges: its merges list no files.
  const out = await gitAsync(repo, [...args, '--diff-merges=first-parent', `${base}..${head}`])
    .catch(() => gitAsync(repo, [...args, `${base}..${head}`])).catch(() => '');
  const paths: string[] = [], index = new Map<string, number>();
  const at = (p: string) => { let i = index.get(p); if (i == null) { i = paths.length; paths.push(p); index.set(p, i); } return i; };
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  for (const chunk of out.split('\x1e')) {
    const nul = chunk.indexOf('\0');
    const c = nul > 0 ? bySha.get(chunk.slice(0, nul).trim()) : undefined;
    if (!c) continue;
    const toks = chunk.slice(nul + 1).replace(/^\n/, '').split('\0');
    const order: string[] = [], status = new Map<string, [string, string | null]>(), lines = new Map<string, [number, number]>();
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.startsWith(':')) {
        const s = t.slice(t.lastIndexOf(' ') + 1).charAt(0);
        const from = s === 'R' || s === 'C' ? toks[++i] : null, p = toks[++i];
        if (p == null) break;
        order.push(p);
        status.set(p, [s, from]);
        continue;
      }
      const m = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(t);
      if (!m) continue;
      const p = m[3] || toks[(i += 2)];
      lines.set(p, [m[1] === '-' ? -1 : Number(m[1]), m[2] === '-' ? -1 : Number(m[2])]);
    }
    c.files = order.slice(0, FILES_MAX).map((p): CommitFile => {
      const [s, from] = status.get(p)!, [a, d] = lines.get(p) || [0, 0];
      return from != null ? [at(p), s, a, d, at(from)] : [at(p), s, a, d];
    });
    c.more = Math.max(0, order.length - FILES_MAX);
  }
  return paths;
}

/**
 * Which commit wrote each added and removed line of the review's diff. Whitespace doesn't count:
 * a commit that only re-indents a line leaves it with the commit that wrote it.
 */
async function attribute(repo: string, base: string, head: string, commits: HistoryCommit[], files: ModelFile[]): Promise<Array<number[][] | null>> {
  const index = new Map(commits.map((c, i) => [c.sha, i]));
  // Who has a commit as a parent: the commit that removed a line is the child of the last one
  // that had it.
  const children = new Map<string, number[]>();
  commits.forEach((c, i) => [...c.parents, ...c.outside].forEach((p) => { if (!children.has(p)) children.set(p, []); children.get(p)!.push(i); }));
  const childOf = (sha: string): number => {
    const kids = children.get(sha) || [];
    const first = kids.find((k) => commits[k].parents[0] === sha || commits[k].outside[0] === sha);
    return first != null ? first : kids.length ? kids[kids.length - 1] : -1;
  };
  // A line at the head that blame traces to outside the range differs from the base only
  // through a merge from outside (main's newer version wasn't taken): the latest such merge.
  const lastMerge = commits.findIndex((c) => c.brought > 0);
  // Where the branch starts: its oldest commits.
  const start = commits.length - 1;
  // A merge from outside makes the base that side's tip, which the branch's own commits don't
  // descend from. A line they removed before the merge still exists on that side, so blame from
  // the base sees it vanish at the merge. Such lines are blamed again along the branch's first
  // parents, from the commit it started from, with each line found there through the diff from it.
  const fork = commits[start] ? commits[start].outside[0] : undefined;
  const merged = (i: number) => i >= 0 && commits[i].outside.length > 0 && commits[i].parents.length + commits[i].outside.length > 1;
  const rows: Array<number[][] | null> = files.map(() => null);
  await pool(files.map((f, fi) => ({ f, fi })), WIDTH, async ({ f, fi }) => {
    if (!f.hunks || !f.hunks.length) return;
    const adds = f.hunks.some((h) => h.rows.some((r) => r[0] === '+'));
    const dels = f.hunks.some((h) => h.rows.some((r) => r[0] === '-'));
    const blame = (args: string[]) => gitAsync(repo, ['blame', '--porcelain', '-w', ...args, '--', f.p]).then(blameLines, () => new Map<number, string>());
    const [added, removed] = await Promise.all([
      adds && f.s !== 'D' ? blame([`${base}..${head}`]) : Promise.resolve(new Map<number, string>()),
      dels && f.s !== 'A' ? blame(['--reverse', `${base}..${head}`]) : Promise.resolve(new Map<number, string>()),
    ]);
    rows[fi] = f.hunks.map((h) => {
      let o = h.o, n = h.n;
      return h.rows.map((r) => {
        let at = -1;
        if (r[0] === '+') {
          const sha = added.get(n);
          at = sha && index.has(sha) ? index.get(sha)! : sha ? lastMerge : -1;
        } else if (r[0] === '-') {
          const last = removed.get(o);
          at = last ? childOf(last) : -1;
          if (at < 0 && last && !index.has(last)) at = start;
        }
        if (r[0] !== '+') o++;
        if (r[0] !== '-') n++;
        return at;
      });
    });
    // Removed lines a merge is credited with: removed before it, on the branch's own side?
    const atMerge: Array<[number[], number, number]> = [];
    f.hunks.forEach((h, hi) => {
      let o = h.o;
      h.rows.forEach((r, ri) => {
        if (r[0] === '-' && merged(rows[fi]![hi][ri])) atMerge.push([rows[fi]![hi], ri, o]);
        if (r[0] !== '+') o++;
      });
    });
    if (!atMerge.length || !fork || fork === base) return;
    const [diff, own] = await Promise.all([
      gitAsync(repo, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', fork, base, '--', f.p]).catch(() => null),
      blame(['--reverse', '--first-parent', `${fork}..${head}`]),
    ]);
    if (diff == null) return;
    const toFork = forkLines(diff);
    atMerge.forEach(([hunkRows, ri, line]) => {
      const was = toFork(line);
      const last = was != null ? own.get(was) : undefined;
      const at = last ? childOf(last) : -1;
      if (at >= 0 && !merged(at)) hunkRows[ri] = at;
    });
  });
  return rows;
}

/**
 * From a diff of one file, from an older commit to a newer one (--unified=0): the older line a
 * newer line was, or null for a line the diff changed.
 */
function forkLines(diff: string): (line: number) => number | null {
  const hunks: Array<[number, number, number, number]> = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push([Number(m[1]), m[2] == null ? 1 : Number(m[2]), Number(m[3]), m[4] == null ? 1 : Number(m[4])]);
  }
  return (line) => {
    let delta = 0;
    for (const [, oldCount, from, count] of hunks) {
      if (count && line >= from && line < from + count) return null;
      if (line < (count ? from : from + 1)) break;
      delta += oldCount - count;
    }
    return line + delta;
  };
}

/**
 * The review's history: read from history.json in the review's folder when it holds these
 * commits, else from git (and written there).
 */
export async function readHistory(repo: string, base: string, head: string, files: ModelFile[], dir: string | null, stack: StackTarget | null = null): Promise<History> {
  const file = dir ? path.join(dir, 'history.json') : null;
  const stamp = stack ? JSON.stringify({ base: stack.base, above: stack.above, legs: stack.legs.map(({ pr, head }) => [pr.number, pr.title, pr.url, pr.headRefName, head, !!pr.isDraft, pr.author ?? null]) }) : null;
  if (file) {
    try {
      const h = JSON.parse(fs.readFileSync(file, 'utf8')) as History & { stamp?: string | null };
      if (h.version === VERSION && h.base === base && h.head === head && h.rows.length === files.length && h.stamp === stamp) {
        const { stamp: _, ...history } = h;
        return history;
      }
    } catch {
      // Not read yet.
    }
  }
  const commits = await readCommits(repo, base, head);
  const historyStack = stack ? await withLegs(repo, base, commits, stack) : null;
  const [rows, paths] = await Promise.all([attribute(repo, base, head, commits, files), readFiles(repo, base, head, commits)]);
  // Reverse blame can credit the carrying merge for a lower leg's deletion. A conflict's
  // resolution stays on the merge when the line is still present in the parent it brought.
  const index = new Map(commits.map((c, i) => [c.sha, i]));
  const inheritedDiffs = new Map<string, string>();
  for (let fi = 0; fi < rows.length; fi++) {
    const f = files[fi];
    if (!rows[fi] || !f.hunks) continue;
    for (let hi = 0; hi < f.hunks.length; hi++) {
      const h = f.hunks[hi];
      let old = h.o, line = h.n;
      for (let ri = 0; ri < h.rows.length; ri++) {
        const kind = h.rows[ri][0], at = rows[fi]![hi][ri], c = commits[at];
        if (c?.brings != null) {
          const parent = c.parents.find((p) => commits[index.get(p)!]?.leg === c.brings);
          if (parent) {
            const from = kind === '-' ? base : parent, to = kind === '-' ? parent : head, key = `${from}:${to}:${f.p}`;
            let diff = inheritedDiffs.get(key);
            if (diff === undefined) {
              diff = await gitAsync(repo, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', from, to, '--', f.p]);
              inheritedDiffs.set(key, diff);
            }
            const inherited = kind === '-' ? diffHunks(diff, 'minus').get(f.p)?.some(([from, count]) => old >= from && old < from + count) : forkLines(diff)(line) != null;
            if (inherited) rows[fi]![hi][ri] = index.get(parent)!;
          }
        }
        if (kind !== '+') old++;
        if (kind !== '-') line++;
      }
    }
  }
  const history: History = { version: VERSION, stack: historyStack, base, head, commits, paths, rows };
  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify({ ...history, stamp }));
    } catch {
      // A cache: the next run reads git again.
    }
  }
  return history;
}

/**
 * The hunks of a diff made with --unified=0, by path: the new side's lines (`plus`, under the
 * +++ path) or the old side's (`minus`, under the --- path), as [first, count] pairs. Headers are
 * read only after a "diff --git" line: inside a hunk, a removed line "-- x" reads "--- x".
 */
export function diffHunks(text: string, side: 'plus' | 'minus'): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  let file: string | null = null, header = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; file = null; continue; }
    if (header) {
      if (line.startsWith('--- ') && side === 'minus') file = line.startsWith('--- a/') ? line.slice(6) : null;
      else if (line.startsWith('+++ ')) { if (side === 'plus') file = line.startsWith('+++ b/') ? line.slice(6) : null; header = false; }
      continue;
    }
    if (!file || !line.startsWith('@@')) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const first = side === 'plus' ? Number(m[3]) : Number(m[1]);
    const count = side === 'plus' ? (m[4] == null ? 1 : Number(m[4])) : (m[2] == null ? 1 : Number(m[2]));
    if (count) { if (!out.has(file)) out.set(file, []); out.get(file)!.push([first, count]); }
  }
  return out;
}
function diffLines(text: string, side: 'plus' | 'minus'): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  diffHunks(text, side).forEach((list, file) => {
    const set = new Set<number>();
    list.forEach(([first, count]) => { for (let k = 0; k < count; k++) set.add(first + k); });
    out.set(file, set);
  });
  return out;
}

export const hasCommit = (repo: string, sha: string) => /^[0-9a-f]{7,40}$/.test(sha) && gitMaybe(repo, 'cat-file', '-e', `${sha}^{commit}`) !== null;

/**
 * The review's rows that changed since an older head: added lines that differ from it, and
 * removed lines it still had. By file (index), hunk and row; null when that head isn't here.
 */
export async function sinceRows(repo: string, base: string, head: string, from: string, files: ModelFile[]): Promise<Record<number, Record<number, number[]>> | null> {
  if (!hasCommit(repo, from)) return null;
  const opts = ['diff', '--unified=0', '--no-renames', '--no-color', '--no-ext-diff'];
  const [toHead, atFrom] = await Promise.all([gitAsync(repo, [...opts, from, head]), gitAsync(repo, [...opts, base, from])]);
  const changed = diffLines(toHead, 'plus'), gone = diffLines(atFrom, 'minus');
  const out: Record<number, Record<number, number[]>> = {};
  files.forEach((f, fi) => {
    if (!f.hunks) return;
    f.hunks.forEach((h, hi) => {
      let o = h.o, n = h.n;
      const hit: number[] = [];
      h.rows.forEach((r, ri) => {
        if (r[0] === '+' && changed.get(f.p)?.has(n)) hit.push(ri);
        if (r[0] === '-' && !gone.get(f.p)?.has(o)) hit.push(ri);
        if (r[0] !== '+') o++;
        if (r[0] !== '-') n++;
      });
      if (hit.length) (out[fi] ??= {})[hi] = hit;
    });
  });
  return out;
}

/**
 * Your last review of another head: the head the newest save of the marks recorded,
 * among the saves made before the review moved to this head.
 */
export function reviewedHead(repo: string, ref: string, head: string): { head: string; at: number } | null {
  const out = gitMaybe(repo, 'log', '-n', '5000', '--format=%ct%x09%(trailers:key=Untangle-Head,valueonly,separator=%x2C)', ref, '--');
  if (!out) return null;
  for (const line of out.split('\n')) {
    const [at, h] = line.split('\t');
    const sha = (h || '').trim();
    if (/^[0-9a-f]{40}$/.test(sha) && sha !== head) return { head: sha, at: Number(at) };
  }
  return null;
}

/** The commits a merge brought in: from its first parent to another parent, newest first. */
export async function broughtBy(repo: string, merge: string, max = 200): Promise<{ commits: Array<{ sha: string; subject: string; author: string; at: number }>; more: boolean } | null> {
  if (!hasCommit(repo, merge)) return null;
  const parents = (gitMaybe(repo, 'rev-list', '--parents', '-n', '1', merge) || '').trim().split(' ').slice(1);
  if (parents.length < 2) return { commits: [], more: false };
  const out = await gitAsync(repo, ['log', '--topo-order', `--max-count=${max + 1}`, '--format=%H%x00%an%x00%at%x00%s', ...parents.slice(1), `^${parents[0]}`]);
  const commits = out.split('\n').filter(Boolean).map((r) => { const [sha, author, at, subject] = r.split('\x00'); return { sha, author, at: Number(at), subject }; });
  return { commits: commits.slice(0, max), more: commits.length > max };
}
