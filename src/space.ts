// What reviews hold on disk, and giving it back. A review holds checkouts (of its base and of each
// head it showed) and analyses. An open review keeps its current base and head, so the heads it
// moved past are old checkouts, as are the checkouts and analyses of reviews from before records.
// Freeing a closed review removes what no other review keeps, and leaves its notes, its marks and
// its record, so it opens again as it did the first time. Marks live in the review's marks ref
// and, for marks on parts of a change, in its analysis's state.json, which freeing keeps.
// Forgetting a review removes those too, and its repository's clone once no review of it is left.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot, cloneDir, reviewDir, worktreeDir } from './cache.js';
import { linkOf } from './checkouts.js';
import { gitMaybe } from './exec.js';
import { notesFile } from './notes.js';
import { listRecords, readRecord, recordDirs, recordFile, recordId, writeRecord, type Listed } from './records.js';
import { listRuns, olderRuns, type RunInfo } from './runs.js';
import { dropMarks, marksRef, MARKS } from './snapshot.js';

/** A closed review's space is freed this long after its pull request merged or closed, or it closed. */
export const FREE_AFTER = 14 * 86_400_000;
/** A checkout or an analysis this young may be one a review is still making: it isn't old yet. */
const YOUNG = 10 * 60_000;
/** What's yours in an analysis's folder: marks on parts of a change, and the page's layout. */
const STATE = 'state.json';

/** The folders a review keeps: an open one its current checkouts and its analyses, a closed one all it names until it's freed. */
export function keptDirs(r: Listed): string[] {
  if (r.freed) return [];
  if (r.status === 'closed') return [...new Set(recordDirs(r))];
  return [...new Set([worktreeDir(r.repoKey, r.base), worktreeDir(r.repoKey, r.head), ...r.analyses.map(([b, h]) => reviewDir(r.repoKey, b, h))])];
}

/**
 * The folders the reviews running without a record use. An older untangle's run file names its
 * repository and head: its analyses of that head, and their bases' checkouts. Null while a review
 * is being built, or one's head isn't known: what it takes isn't named anywhere yet.
 */
export function unrecordedDirs(list: Listed[], runs: RunInfo[]): string[] | null {
  const recorded = new Set(list.filter((r) => r.status === 'running').map((r) => r.pid));
  const dirs: string[] = [];
  for (const run of runs) {
    if (recorded.has(run.pid)) continue;
    const own = olderDirs(run);
    if (!own) return null;
    dirs.push(...own);
  }
  return dirs;
}

/** The folders a review an older untangle runs uses, from its run file: null when it doesn't say. */
export function olderDirs(run: RunInfo): string[] | null {
  if (!olderRuns.has(run.pid) || !run.repoKey || !run.head) return null;
  const head = run.head.slice(0, 12), repoKey = run.repoKey;
  const analyses = subdirs(path.join(cacheRoot(), 'reviews', repoKey)).filter((d) => PAIR.test(path.basename(d)) && path.basename(d).endsWith('-' + head));
  return [...new Set([worktreeDir(repoKey, head), ...analyses, ...analyses.map((d) => worktreeDir(repoKey, path.basename(d).slice(0, 12)))])];
}

/** What the cache holds, and who keeps it. */
export interface Holdings {
  /** The folders open reviews keep, those running without a record included. */
  open: Set<string>;
  /** The folders only one closed review keeps, by its id. */
  own: Map<string, string[]>;
  /** The folders two closed reviews or more keep, with their ids: they go with the last of them freed. */
  shared: Map<string, string[]>;
  /** The checkouts and analyses no review keeps: heads open reviews moved past, and those of reviews from before records. */
  old: string[];
  /** The clones in the cache. */
  clones: string[];
}

export function holdings(list: Listed[] = listRecords(), runs: RunInfo[] = listRuns()): Holdings {
  const unrecorded = unrecordedDirs(list, runs);
  const open = new Set([...list.filter((r) => r.status !== 'closed').flatMap(keptDirs), ...(unrecorded ?? [])]);
  const by = new Map<string, string[]>();
  for (const r of list) if (r.status === 'closed') for (const d of keptDirs(r)) if (!open.has(d)) by.set(d, [...(by.get(d) ?? []), recordId(r)]);
  const own = new Map<string, string[]>(), shared = new Map<string, string[]>();
  for (const [d, ids] of by) {
    if (ids.length > 1) shared.set(d, ids);
    else own.set(ids[0], [...(own.get(ids[0]) ?? []), d]);
  }
  // While a review is built, what it makes or takes is named nowhere yet.
  const old = unrecorded == null ? [] : [...checkoutsOnDisk(), ...analysesOnDisk()].filter((d) => !open.has(d) && !by.has(d) && !young(d));
  const clones = subdirs(path.join(cacheRoot(), 'repos', 'github.com')).flatMap(subdirs).filter((d) => d.endsWith('.git'));
  return { open, own, shared, old, clones };
}

const SHA12 = /^[0-9a-f]{12}$/;
const PAIR = /^[0-9a-f]{12}-[0-9a-f]{12}$/;
const subdirs = (d: string) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
  } catch {
    return [];
  }
};
// A repository's folders, under github.com/owner/repo, or local/name.
const reposIn = (root: string) => [...subdirs(path.join(root, 'github.com')).flatMap(subdirs), ...subdirs(path.join(root, 'local'))];

/** The checkouts in the cache: a folder per commit, under its repository's. */
export function checkoutsOnDisk(): string[] {
  return reposIn(path.join(cacheRoot(), 'worktrees')).flatMap(subdirs).filter((d) => SHA12.test(path.basename(d)));
}

/** The analyses in the cache that hold more than what's yours: a folder per pair of commits, under its repository's. */
export function analysesOnDisk(): string[] {
  return reposIn(path.join(cacheRoot(), 'reviews')).flatMap(subdirs).filter((d) => {
    if (!PAIR.test(path.basename(d))) return false;
    try {
      return fs.readdirSync(d).some((f) => f !== STATE);
    } catch {
      return false;
    }
  });
}

export const isCheckout = (dir: string) => dir.startsWith(path.join(cacheRoot(), 'worktrees') + path.sep);

function young(dir: string): boolean {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs < YOUNG;
  } catch {
    return true;
  }
}

/** The repository a checkout is a worktree of, or its own. */
const ownerOf = (dir: string) => gitMaybe(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.trim() || null;

/** Removes a checkout: its folder goes, and a worktree's repository lets go of it. */
function removeCheckout(dir: string): void {
  const repo = linkOf(dir)?.common ?? null;
  if (repo) gitMaybe(repo, 'worktree', 'remove', '--force', '--force', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (repo) gitMaybe(repo, 'worktree', 'prune');
}

/** Removes an analysis but for its state.json: the marks on parts of a change come back with it. */
function removeAnalysis(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  if (!names.includes(STATE)) return void fs.rmSync(dir, { recursive: true, force: true });
  for (const n of names) if (n !== STATE) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

/** Removes a folder a review held: a checkout through its repository, an analysis but for what's yours. */
const remove = (dir: string) => (isCheckout(dir) ? removeCheckout(dir) : removeAnalysis(dir));

/** Whether a review of a repository keeps notes, recorded or from before records. */
function notesLeft(repoKey: string): boolean {
  try {
    return fs.readdirSync(path.dirname(notesFile(repoKey, 'x'))).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/** Freeing waits while a review is built: it may be taking a checkout no record names yet. */
export class Building extends Error {}

function guard(list: Listed[]): string[] {
  const unrecorded = unrecordedDirs(list, listRuns());
  if (unrecorded == null) throw new Building('a review is being built: free the space once it’s ready');
  return unrecorded;
}

/**
 * Frees closed reviews' space: the folders no other review keeps go, but for the marks in their
 * analyses, and their records say they're freed. Their ids, and the folders removed.
 */
export function free(ids: Set<string>, list: Listed[] = listRecords()): { freed: string[]; removed: string[] } {
  const unrecorded = guard(list);
  const going = list.filter((r) => r.status === 'closed' && !r.freed && ids.has(recordId(r)));
  const staying = new Set([...list.filter((r) => !going.includes(r)).flatMap(keptDirs), ...unrecorded]);
  const removed = [...new Set(going.flatMap(keptDirs))].filter((d) => !staying.has(d));
  removed.forEach(remove);
  const at = new Date().toISOString();
  for (const r of going) {
    const file = recordFile(r.repoKey, r.key), now = readRecord(file);
    // Opened again meanwhile: it keeps what it has.
    if (!now || now.pid !== r.pid || !now.closed) continue;
    // Its analyses keep their state.json: Forget removes it.
    writeRecord({ ...now, checkouts: [], freed: at, updated: at });
  }
  return { freed: going.map(recordId), removed };
}

/** Closed reviews past FREE_AFTER since their pull request merged or closed, or since they closed, are freed. Paused ones never are. */
export function freeOld(list: Listed[] = listRecords()): { freed: string[]; removed: string[] } {
  const due = list.filter((r) => r.status === 'closed' && !r.freed && Date.now() - Date.parse(r.github?.at ?? r.closed!) > FREE_AFTER);
  if (!due.length) return { freed: [], removed: [] };
  try {
    return free(new Set(due.map(recordId)), list);
  } catch (e) {
    if (e instanceof Building) return { freed: [], removed: [] };
    throw e;
  }
}

/** Removes the old checkouts and analyses: heads open reviews moved past, and what no review keeps. */
export function removeOld(list: Listed[] = listRecords()): string[] {
  const { old } = holdings(list);
  old.forEach(remove);
  return old;
}

/**
 * Forgets closed reviews: their space, notes, marks (their ref, and their analyses'
 * state.json) and records go. A clone goes too, with its checkouts, once no review of its
 * repository is left. The ids forgotten, and the folders removed.
 */
export function forget(ids: Set<string>, list: Listed[] = listRecords()): { forgot: string[]; removed: string[] } {
  const going = list.filter((r) => r.status === 'closed' && ids.has(recordId(r)));
  const { removed } = free(new Set(going.map(recordId)), list);
  // What's left of their analyses, unless another review names the same commits.
  const others = new Set(list.filter((r) => !going.includes(r)).flatMap(recordDirs));
  for (const d of new Set(going.flatMap((r) => r.analyses.map(([b, h]) => reviewDir(r.repoKey, b, h))))) {
    if (others.has(d)) continue;
    fs.rmSync(d, { recursive: true, force: true });
    removed.push(d);
  }
  for (const r of going) {
    fs.rmSync(notesFile(r.repoKey, r.key), { force: true });
    const marks = marksRef(r.repo, r.key);
    // Reviews whose name makes no ref share one: it stays.
    if (marks !== MARKS + 'review' && fs.existsSync(r.repo)) dropMarks(r.repo, marks);
    fs.rmSync(recordFile(r.repoKey, r.key), { force: true });
  }
  const left = listRecords(), runs = listRuns();
  for (const repoKey of new Set(going.map((r) => r.repoKey))) {
    const clone = cloneDir(repoKey);
    const reviewed = (run: RunInfo) => (run.repoKey ? run.repoKey === repoKey : !!run.pr && `github.com/${run.pr.replace(/#\d+$/, '')}` === repoKey.toLowerCase());
    if (!fs.existsSync(clone) || left.some((r) => r.repo === clone) || runs.some(reviewed)) continue;
    // Reviews from before records keep their marks in it, and their notes beside it.
    if (gitMaybe(clone, 'for-each-ref', '--count=1', MARKS, 'refs/heads/untangle/')?.trim() || notesLeft(repoKey)) continue;
    const real = fs.realpathSync(clone);
    for (const d of checkoutsOnDisk()) {
      if (path.dirname(d) !== path.join(cacheRoot(), 'worktrees', repoKey)) continue;
      const owner = ownerOf(d);
      if (!owner || !fs.existsSync(owner) || fs.realpathSync(owner) !== real) continue;
      fs.rmSync(d, { recursive: true, force: true });
      removed.push(d);
    }
    fs.rmSync(clone, { recursive: true, force: true });
    removed.push(clone);
  }
  return { forgot: going.map(recordId), removed };
}
