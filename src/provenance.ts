// The commit that started each changed line of a review, and every commit that changed it since.
//
// git blame names the last commit that wrote a line; grouping a review by commits needs the first
// one. The review's first-parent commits are replayed from where the branch started, carrying for
// every line of the files they touch its origin (the commit that first changed that spot), the
// commit that put it where it is (a move or a rename), and every commit that changed it after. An
// edited line keeps its origin: the removed and added lines of a hunk pair up by their tokens. A
// line that is only reformatted, or moved within a commit, keeps its whole history. A merge from
// the base's branch starts nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../viewer/core.js';
import { gitAsync } from './exec.js';

const C = globalThis.ReviewCore;

export interface ProvenanceCommit {
  sha: string;
  subject: string;
  body: string;
  merge: boolean;
}

export interface ProvenanceFile {
  /** Lines at the head, as the replay ends: the analysis checks it against the file it reads. */
  lines: number;
  /** The review's added lines, by head line: [origin, placed by, ...every commit that changed it], -1 for none. */
  plus: Record<number, number[]>;
  /** The review's removed lines, by base line: the commit that first changed or removed it, or -1. */
  minus: Record<number, number>;
}

export interface Provenance {
  version: string;
  base: string;
  head: string;
  /** The review's first-parent commits, oldest first. */
  commits: ProvenanceCommit[];
  /** For each commit, the lines of earlier commits it edited, moved or removed, by the index of the commit that started them. */
  revised: Array<Record<number, number>>;
  files: Record<string, ProvenanceFile>;
}

interface Line {
  /** The commit that started it, or -1. */
  o: number;
  /** The commit that moved it here, or -1. */
  p: number;
  /** Every commit that changed it, oldest first. */
  t: number[];
  /** The fork's line, unchanged: where it was there. */
  fp: string | null;
  f: number;
}

interface Hunk {
  o: number;
  k: number;
  n: number;
  m: number;
  rem: string[];
  add: string[];
}

interface FileDiff {
  from: string | null;
  to: string | null;
  binary: boolean;
  hunks: Hunk[];
}

const VERSION = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);
const WIDTH = 6;
const BODY_MAX = 4000;
// Removed and added lines pair when at least half their tokens match.
const PAIR_AT = 0.5;
// A moved line needs a neighbour that moved with it, unless it is this long.
const MOVE_ALONE = 40;
const MOVE_MIN = 12;
// Beyond this many line comparisons, a hunk's lines pair by position.
const PAIR_MAX = 250_000;

async function pool<T>(items: T[], width: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

const git = (repo: string, args: string[]) => gitAsync(repo, ['-c', 'core.quotePath=false', ...args]);

/** A patch made with --unified=0, file by file. */
export function parsePatch(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { from: m ? m[1] : null, to: m ? m[2] : null, binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) { file.from = null; continue; }
      if (line.startsWith('deleted file mode')) { file.to = null; continue; }
      if (line.startsWith('rename from ')) { file.from = line.slice(12); continue; }
      if (line.startsWith('rename to ')) { file.to = line.slice(10); continue; }
      if (line.startsWith('--- ')) { file.from = line === '--- /dev/null' ? null : line.slice(6); continue; }
      if (line.startsWith('+++ ')) { file.to = line === '+++ /dev/null' ? null : line.slice(6); continue; }
      if (line.startsWith('Binary files')) { file.binary = true; continue; }
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      hunk = { o: +m[1], k: m[2] == null ? 1 : +m[2], n: +m[3], m: m[4] == null ? 1 : +m[4], rem: [], add: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && line[0] === '-') hunk.rem.push(line.slice(1));
    else if (hunk && line[0] === '+') hunk.add.push(line.slice(1));
  }
  return files;
}

const words = (s: string) => s.match(/\w+|[^\s\w]/g) || [];
const wordy = (s: string) => /\w/.test(s);

function similarity(a: string, b: string): number {
  if (!wordy(a) || !wordy(b)) return 0;
  const x = words(a), y = words(b), left = new Map<string, number>();
  x.forEach((t) => left.set(t, (left.get(t) || 0) + 1));
  let common = 0;
  y.forEach((t) => {
    const n = left.get(t);
    if (n) { common++; left.set(t, n - 1); }
  });
  return (2 * common) / (x.length + y.length);
}

/** For each added line, the removed line it edits (in order, the most alike), or -1. */
export function pairLines(removed: string[], added: string[]): number[] {
  const k = removed.length, m = added.length, pairs = new Array<number>(m).fill(-1);
  if (!k || !m) return pairs;
  if (k * m > PAIR_MAX) {
    for (let j = 0; j < Math.min(k, m); j++) if (similarity(removed[j], added[j]) >= PAIR_AT) pairs[j] = j;
    return pairs;
  }
  const score = removed.map((r) => added.map((a) => { const s = similarity(r, a); return s >= PAIR_AT ? s : 0; }));
  const best = Array.from({ length: k + 1 }, () => new Float64Array(m + 1));
  for (let i = k - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let b = Math.max(best[i + 1][j], best[i][j + 1]);
      if (score[i][j] > 0) b = Math.max(b, score[i][j] + best[i + 1][j + 1]);
      best[i][j] = b;
    }
  }
  for (let i = 0, j = 0; i < k && j < m;) {
    if (score[i][j] > 0 && best[i][j] === score[i][j] + best[i + 1][j + 1]) { pairs[j] = i; i++; j++; }
    else if (best[i][j] === best[i + 1][j]) i++;
    else j++;
  }
  return pairs;
}

// The same code laid out differently: whitespace, line breaks and trailing commas aside.
const squash = (lines: string[]) => lines.join('').replace(/\s+/g, '').replace(/,([)\]}])/g, '$1');
const normal = (s: string) => s.trim().replace(/\s+/g, ' ');

/** A base line -> the fork's line it was, from a diff of one file from the fork to the base (--unified=0). */
function toFork(diff: string): (line: number) => number | null {
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => [+m[1], m[2] == null ? 1 : +m[2], +m[3], m[4] == null ? 1 : +m[4]]);
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

const lineCount = (text: string) => (!text ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

/**
 * The replay. `generated` tells the files to leave out: their lines are not reviewed, and a
 * regenerated file's diff is large.
 */
export async function provenance(repo: string, base: string, head: string, generated: (p: string) => boolean): Promise<Provenance> {
  const log = await git(repo, ['log', '--first-parent', '--reverse', '--format=%H%x00%P%x00%s%x00%b%x1e', `${base}..${head}`]);
  const commits = log.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((r) => {
    const [sha, parents, subject, body] = r.split('\x00');
    const all = parents.split(' ').filter(Boolean);
    return { sha, parent: all[0], merge: all.length > 1, subject, body: (body || '').trim().slice(0, BODY_MAX) };
  });
  const result: Provenance = { version: VERSION, base, head, commits: commits.map(({ sha, subject, body, merge }) => ({ sha, subject, body, merge })), revised: commits.map(() => ({})), files: {} };
  if (!commits.length || !commits[0].parent) return result;
  const fork = commits[0].parent;

  // The files the review's own commits touch, on both sides of a rename. A merge matters only there.
  const touched = new Set<string>();
  const names = await git(repo, ['log', '--first-parent', '--no-merges', '--name-status', '-M', '-z', '--format=', `${base}..${head}`]);
  for (const token of names.split('\0')) if (token && !/^[A-Z]\d*$/.test(token)) touched.add(token.replace(/^\n/, ''));
  const paths = [...touched].filter((p) => !generated(p));
  const patches: string[] = new Array(commits.length).fill('');
  if (paths.length) {
    await pool(commits, WIDTH, async (c, i) => {
      const args = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', c.parent, c.sha];
      patches[i] = await git(repo, c.merge ? [...args, '--', ...paths] : args);
    });
  }
  const diffs = patches.map((p) => parsePatch(p).filter((f) => !f.binary && !generated((f.to ?? f.from)!)));

  // Each file's lines, where a commit first touches it.
  const state = new Map<string, Line[]>();
  const first: Array<[string, string]> = [];
  const known = new Set<string>();
  commits.forEach((c, i) => diffs[i].forEach((f) => {
    if (f.from != null && !known.has(f.from)) first.push([c.parent, f.from]);
    if (f.from != null) known.add(f.from);
    if (f.to != null) known.add(f.to);
  }));
  const counts = new Map<string, number>();
  await pool(first, WIDTH * 2, async ([rev, p]) => {
    counts.set(`${rev}:${p}`, lineCount(await git(repo, ['show', `${rev}:${p}`]).catch(() => '')));
  });
  const linesOf = (rev: string, p: string): Line[] => {
    let lines = state.get(p);
    if (!lines) {
      lines = Array.from({ length: counts.get(`${rev}:${p}`) ?? 0 }, (_, i) => ({ o: -1, p: -1, t: [], fp: p, f: i + 1 }));
      state.set(p, lines);
    }
    return lines;
  };

  // The commit that first changed or removed each of the fork's lines, by path and line.
  const forkFirst = new Map<string, Map<number, number>>();
  const firstChange = (l: Line, c: number) => {
    if (l.fp == null) return;
    let m = forkFirst.get(l.fp);
    if (!m) forkFirst.set(l.fp, (m = new Map()));
    if (!m.has(l.f)) m.set(l.f, c);
  };
  const credit = (c: number, origin: number) => { const r = result.revised[c]; r[origin] = (r[origin] || 0) + 1; };
  const changed = (l: Line, c: number): number[] => (l.t.includes(c) ? l.t : [...l.t, c]);
  const started = (c: number): Line => ({ o: c, p: -1, t: [c], fp: null, f: 0 });
  const outside = (): Line => ({ o: -1, p: -1, t: [], fp: null, f: 0 });

  commits.forEach((c, ci) => {
    type Work = { file: FileDiff; lines: Line[]; parts: Array<{ hunk: Hunk; at: number; removed: Line[]; added: Array<Line | null>; used: Set<number> }> };
    const work: Work[] = [];
    for (const file of diffs[ci]) {
      const lines = file.from == null ? [] : linesOf(c.parent, file.from);
      if (file.from != null && file.to != null && file.from !== file.to && !c.merge) {
        // A rename moves the fork's lines it carries.
        lines.forEach((l) => { if (l.fp != null && l.o < 0) { firstChange(l, ci); if (l.p < 0) l.p = ci; } });
      }
      const parts = file.hunks.map((hunk) => {
        const at = hunk.k === 0 ? hunk.o : hunk.o - 1;
        const removed = lines.slice(at, at + hunk.k);
        const added: Array<Line | null> = new Array(hunk.m).fill(null);
        const used = new Set<number>();
        if (hunk.k && hunk.m && squash(hunk.rem) === squash(hunk.add)) {
          // Reformatted: each line keeps the history of the line its first character came from.
          const owner: number[] = [];
          hunk.rem.forEach((text, i) => { for (let n = text.replace(/\s+/g, '').length; n > 0; n--) owner.push(i); });
          let offset = 0;
          hunk.add.forEach((text, j) => {
            const from = removed[owner[Math.min(offset, owner.length - 1)] ?? 0];
            if (!from) added[j] = c.merge ? outside() : started(ci);
            else if (c.merge || from.o >= 0 || from.fp == null) added[j] = { ...from };
            else {
              firstChange(from, ci);
              added[j] = { ...from, p: ci };
            }
            offset += text.replace(/\s+/g, '').length;
          });
          removed.forEach((_, i) => used.add(i));
          return { hunk, at, removed, added, used };
        }
        pairLines(hunk.rem, hunk.add).forEach((i, j) => {
          if (i < 0 || !removed[i]) return;
          used.add(i);
          const from = removed[i];
          if (c.merge) added[j] = { ...from };
          else if (from.o >= 0) {
            credit(ci, from.o);
            added[j] = { o: from.o, p: from.p, t: changed(from, ci), fp: null, f: 0 };
          } else {
            firstChange(from, ci);
            added[j] = started(ci);
          }
        });
        return { hunk, at, removed, added, used };
      });
      work.push({ file, lines, parts });
    }

    // Lines moved within the commit: an added line with the text of a removed one elsewhere keeps
    // its history, when a neighbour moved with it or it is long enough to be unmistakable.
    if (!c.merge) {
      const removedByText = new Map<string, Array<{ part: Work['parts'][number]; i: number }>>();
      for (const w of work) for (const part of w.parts) part.hunk.rem.forEach((text, i) => {
        const key = normal(text);
        if (part.used.has(i) || !part.removed[i] || key.length < MOVE_MIN || !wordy(key)) return;
        if (!removedByText.has(key)) removedByText.set(key, []);
        removedByText.get(key)!.push({ part, i });
      });
      const moves = new Map<Work['parts'][number], Map<number, { part: Work['parts'][number]; i: number }>>();
      const move = (part: Work['parts'][number], j: number, at: { part: Work['parts'][number]; i: number }) => {
        at.part.used.add(at.i);
        if (!moves.has(part)) moves.set(part, new Map());
        moves.get(part)!.set(j, at);
        const from = at.part.removed[at.i];
        if (from.o >= 0) {
          if (wordy(at.part.hunk.rem[at.i])) credit(ci, from.o);
          part.added[j] = { o: from.o, p: ci, t: changed(from, ci), fp: null, f: 0 };
        } else if (from.fp != null) {
          firstChange(from, ci);
          part.added[j] = { ...from, p: ci };
        } else part.added[j] = started(ci);
      };
      // Candidates are taken before any is chosen, so a run's last line still sees the one before it.
      const options = new Map<Work['parts'][number], Array<Array<{ part: Work['parts'][number]; i: number }>>>();
      for (const w of work) for (const part of w.parts) options.set(part, part.hunk.add.map((text, j) => (part.added[j] ? [] : removedByText.get(normal(text)) || [])));
      for (const w of work) for (const part of w.parts) part.hunk.add.forEach((text, j) => {
        if (part.added[j]) return;
        const list = options.get(part)!;
        const here = list[j].filter((x) => !x.part.used.has(x.i));
        if (!here.length) return;
        const before = list[j - 1] || [], after = list[j + 1] || [];
        const pick = here.find((x) => before.some((y) => y.part === x.part && y.i === x.i - 1) || after.some((y) => y.part === x.part && y.i === x.i + 1))
          || (normal(text).length >= MOVE_ALONE ? here[0] : null);
        if (!pick) return;
        move(part, j, pick);
      });
      // A run's short lines, a closing brace say, move with it.
      for (const [part, list] of moves) {
        for (const [j, at] of [...list]) {
          for (const step of [-1, 1]) {
            for (let k = 1; ; k++) {
              const jj = j + step * k, ii = at.i + step * k;
              if (jj < 0 || jj >= part.hunk.add.length || ii < 0 || ii >= at.part.hunk.rem.length) break;
              if (part.added[jj] || at.part.used.has(ii) || !at.part.removed[ii] || normal(part.hunk.add[jj]) !== normal(at.part.hunk.rem[ii])) break;
              move(part, jj, { part: at.part, i: ii });
            }
          }
        }
      }
    }

    for (const w of work) {
      for (const part of [...w.parts].reverse()) {
        if (!c.merge) part.removed.forEach((from, i) => {
          if (part.used.has(i) || !from) return;
          if (from.o >= 0) { if (wordy(part.hunk.rem[i] ?? '')) credit(ci, from.o); }
          else firstChange(from, ci);
        });
        w.lines.splice(part.at, part.hunk.k, ...part.added.map((l) => l ?? (c.merge ? outside() : started(ci))));
      }
      const { from, to } = w.file;
      if (to == null) {
        if (!c.merge) w.lines.forEach((l) => { if (l.o >= 0) credit(ci, l.o); else firstChange(l, ci); });
        if (from != null) state.delete(from);
      } else {
        if (from != null && from !== to) state.delete(from);
        state.set(to, w.lines);
      }
    }
  });

  // The review's own diff, line by line: a moved file's, as the review shows it, from its old path.
  const review = parsePatch(await git(repo, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', base, head]));
  const forkOf = new Map<string, (line: number) => number | null>();
  for (const file of review) {
    if (file.binary) continue;
    const p = (file.to ?? file.from)!;
    if (generated(p)) continue;
    if (file.from != null && base !== fork && !forkOf.has(file.from)) {
      forkOf.set(file.from, toFork(await git(repo, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', fork, base, '--', file.from]).catch(() => '')));
    }
  }
  for (const file of review) {
    if (file.binary) continue;
    const p = (file.to ?? file.from)!;
    if (generated(p)) continue;
    const lines = file.to != null ? state.get(file.to) : undefined;
    const forkLine = file.from != null ? forkOf.get(file.from) ?? ((line: number) => line) : null;
    const out: ProvenanceFile = { lines: lines ? lines.length : -1, plus: {}, minus: {} };
    for (const hunk of file.hunks) {
      hunk.add.forEach((_, j) => {
        const l = lines?.[hunk.n - 1 + j];
        out.plus[hunk.n + j] = l ? [l.o, l.p, ...l.t] : [-1, -1];
      });
      hunk.rem.forEach((_, i) => {
        const was = forkLine ? forkLine(hunk.o + i) : null;
        out.minus[hunk.o + i] = was != null ? forkFirst.get(file.from!)?.get(was) ?? -1 : -1;
      });
    }
    result.files[p] = out;
  }
  return result;
}

/**
 * The review's provenance: read from provenance.json in the review's folder when it holds these
 * commits, else replayed (and written there).
 */
export async function readProvenance(repo: string, base: string, head: string, generated: (p: string) => boolean, dir: string | null): Promise<Provenance> {
  const file = dir ? path.join(dir, 'provenance.json') : null;
  if (file) {
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Provenance;
      if (p.version === VERSION && p.base === base && p.head === head) return p;
    } catch {
      // Not replayed yet.
    }
  }
  const p = await provenance(repo, base, head, generated);
  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify(p));
    } catch {
      // A cache: the next run replays again.
    }
  }
  return p;
}

/** Whether a path is generated, by the diff's patterns. */
export const generatedBy = (globs: string[], marked: Set<string>) => {
  const patterns = globs.map((g) => C.globToRegExp(g));
  return (p: string) => marked.has(p) || patterns.some((rx) => rx.test(p));
};
