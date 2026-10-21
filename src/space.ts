// What reviews hold on disk, and giving it back. A review holds checkouts (git worktrees of its
// base and of each head it showed) and analyses. An open review keeps its current base and head,
// so the heads it moved past are old checkouts. Freeing a closed review removes what no other
// review keeps, and leaves its notes, its marks (the review branch) and its record, so it opens
// again as it did the first time. Forgetting one removes those too, and its repository's clone
// once no review of it is left.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot, cloneDir, reviewDir, worktreeDir } from './cache.js';
import { gitMaybe } from './exec.js';
import { notesFile } from './notes.js';
import { listRecords, readRecord, recordDirs, recordFile, recordId, writeRecord, type Listed } from './records.js';
import { listRuns, type RunInfo } from './runs.js';
import { snapshotBranch } from './snapshot.js';

/** A closed review's space is freed this long after its pull request merged or closed, or it closed. */
export const FREE_AFTER = 14 * 86_400_000;
/** A checkout this young may be one a review is still making: it isn't old yet. */
const YOUNG = 10 * 60_000;

/** The folders a review keeps: an open one its current checkouts and its analyses, a closed one all it names until it's freed. */
export function keptDirs(r: Listed): string[] {
  if (r.freed) return [];
  if (r.status === 'closed') return [...new Set(recordDirs(r))];
  return [...new Set([worktreeDir(r.repoKey, r.base), worktreeDir(r.repoKey, r.head), ...r.analyses.map(([b, h]) => reviewDir(r.repoKey, b, h))])];
}

/** Reviews being built: their process runs and no record says so yet, nor names their checkouts. */
export function building(list: Listed[], runs: RunInfo[]): RunInfo[] {
  const recorded = new Set(list.filter((r) => r.status === 'running').map((r) => r.pid));
  return runs.filter((run) => !recorded.has(run.pid));
}

/** What the cache holds, and who keeps it. */
export interface Holdings {
  /** The folders open reviews keep. */
  open: Set<string>;
  /** The folders only one closed review keeps, by its id. */
  own: Map<string, string[]>;
  /** The folders two closed reviews or more keep, with their ids: they go with the last of them freed. */
  shared: Map<string, string[]>;
  /** The checkouts no review keeps: heads open reviews moved past, and those of reviews no longer listed. */
  old: string[];
  /** The clones of the repositories reviews are kept of. */
  clones: string[];
}

export function holdings(list: Listed[] = listRecords(), runs: RunInfo[] = listRuns()): Holdings {
  const open = new Set(list.filter((r) => r.status !== 'closed').flatMap(keptDirs));
  const by = new Map<string, string[]>();
  for (const r of list) if (r.status === 'closed') for (const d of keptDirs(r)) if (!open.has(d)) by.set(d, [...(by.get(d) ?? []), recordId(r)]);
  const own = new Map<string, string[]>(), shared = new Map<string, string[]>();
  for (const [d, ids] of by) {
    if (ids.length > 1) shared.set(d, ids);
    else own.set(ids[0], [...(own.get(ids[0]) ?? []), d]);
  }
  // While a review is built, the checkouts it makes or takes are named nowhere yet.
  const old = building(list, runs).length ? [] : checkoutsOnDisk().filter((d) => !open.has(d) && !by.has(d) && !young(d));
  const clones = [...new Set(list.map((r) => cloneDir(r.repoKey)).filter((c) => list.some((r) => r.repo === c)))];
  return { open, own, shared, old, clones };
}

const SHA12 = /^[0-9a-f]{12}$/;
const subdirs = (d: string) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
  } catch {
    return [];
  }
};

/** The checkouts in the cache: a folder per commit, under its repository's (github.com/owner/repo, or local/name). */
export function checkoutsOnDisk(): string[] {
  const root = path.join(cacheRoot(), 'worktrees');
  const repos = [...subdirs(path.join(root, 'github.com')).flatMap(subdirs), ...subdirs(path.join(root, 'local'))];
  return repos.flatMap(subdirs).filter((d) => SHA12.test(path.basename(d)));
}

function young(dir: string): boolean {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs < YOUNG;
  } catch {
    return true;
  }
}

/** The repository a checkout belongs to: the cache's clone, or the directory reviewed. */
const ownerOf = (dir: string) => gitMaybe(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.trim() || null;

/** Removes a checkout: its repository lets go of the worktree, and its folder goes. */
function removeCheckout(dir: string): void {
  const repo = ownerOf(dir);
  if (repo) gitMaybe(repo, 'worktree', 'remove', '--force', '--force', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (repo) gitMaybe(repo, 'worktree', 'prune');
}

/** Removes a folder a review held: a checkout through its repository, an analysis as it is. */
function remove(dir: string): void {
  if (dir.startsWith(path.join(cacheRoot(), 'worktrees') + path.sep)) removeCheckout(dir);
  else fs.rmSync(dir, { recursive: true, force: true });
}

/** Freeing waits while a review is built: it may be taking a checkout no record names yet. */
export class Building extends Error {}

/**
 * Frees closed reviews' space: the folders no other review keeps go, and their records say
 * they're freed. Their ids, and the folders removed.
 */
export function free(ids: Set<string>, list: Listed[] = listRecords()): { freed: string[]; removed: string[] } {
  const runs = listRuns();
  const b = building(list, runs);
  if (b.length) throw new Building(`${b.length === 1 ? 'a review is' : `${b.length} reviews are`} being built: free the space once ${b.length === 1 ? 'it’s' : 'they’re'} ready`);
  const going = list.filter((r) => r.status === 'closed' && !r.freed && ids.has(recordId(r)));
  const staying = new Set(list.filter((r) => !going.includes(r)).flatMap(keptDirs));
  const removed = [...new Set(going.flatMap(keptDirs))].filter((d) => !staying.has(d));
  removed.forEach(remove);
  const at = new Date().toISOString();
  for (const r of going) {
    const file = recordFile(r.repoKey, r.key), now = readRecord(file);
    // Opened again meanwhile: it keeps what it has.
    if (!now || now.pid !== r.pid || !now.closed) continue;
    writeRecord({ ...now, checkouts: [], analyses: [], freed: at, updated: at });
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

/** Removes the old checkouts: heads open reviews moved past, and checkouts no review keeps. */
export function removeOld(list: Listed[] = listRecords()): string[] {
  const { old } = holdings(list);
  old.forEach(removeCheckout);
  return old;
}

/**
 * Forgets closed reviews: their space, notes, marks (the review branch) and records go. A clone
 * goes too, with its checkouts, once no review of its repository is left. The ids forgotten, and
 * the folders removed.
 */
export function forget(ids: Set<string>, list: Listed[] = listRecords()): { forgot: string[]; removed: string[] } {
  const going = list.filter((r) => r.status === 'closed' && ids.has(recordId(r)));
  const { removed } = free(new Set(going.map(recordId)), list);
  for (const r of going) {
    fs.rmSync(notesFile(r.repoKey, r.key), { force: true });
    const branch = snapshotBranch(r.repo, r.key);
    // Reviews whose name makes no branch share one: it stays.
    if (branch !== 'untangle/review' && fs.existsSync(r.repo)) gitMaybe(r.repo, 'branch', '-D', branch);
    fs.rmSync(recordFile(r.repoKey, r.key), { force: true });
  }
  const left = listRecords(), runs = listRuns();
  for (const repoKey of new Set(going.map((r) => r.repoKey))) {
    const clone = cloneDir(repoKey);
    const reviewed = (run: RunInfo) => !!run.pr && `github.com/${run.pr.replace(/#\d+$/, '')}` === repoKey.toLowerCase();
    if (!fs.existsSync(clone) || left.some((r) => r.repo === clone) || runs.some(reviewed)) continue;
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
