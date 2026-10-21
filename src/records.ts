// What untangle remembers of each review past the process that serves it: a record per review in
// the cache, written by the review as it runs and as it stops. `untangle reviews` lists the reviews
// from them, running, paused or closed, with what each one holds on disk.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot, reviewDir, worktreeDir } from './cache.js';
import { call, Gone } from './client.js';
import { pidAlive, removeRun, type RunInfo } from './runs.js';

/** A chat that held a review: what resumes it, and where it ran. */
export interface ChatRecord {
  /** The name it answered as: Claude, Codex, or the one it was given. */
  agent: string;
  kind: 'claude' | 'codex';
  /** Claude's session, or Codex's thread. */
  id: string;
  /** The folder it ran in: Claude finds a chat by its folder. */
  folder: string | null;
  /** Where its agent keeps its state: Claude's config folder, or Codex's home. */
  home: string | null;
  /** Its terminal in Orca, when it ran in one: the handle, and the pane that finds it again. */
  orca: { handle: string; pane: string | null } | null;
  /** When it last held the review. */
  at: string;
}

/** Why a review stopped: paused, its last page closed, untangle stop, a signal, or it ended unseen. */
export type StopReason = 'paused' | 'tab' | 'stop' | 'signal' | 'ended';

export interface ReviewRecord {
  version: 1;
  /** What a review of it is started with again: the pull request's link, or the directory. */
  target: string;
  /** owner/repo#n, as run files name a pull request. */
  pr: string | null;
  /** The repository's top level, for a review of a directory. */
  dir: string | null;
  repoKey: string;
  /** The review's name in its repository, as its notes and its marks' branch have it: pr-168, or the branch. */
  key: string;
  /** The repository its commits and checkouts belong to: the cache's clone, or the directory's. */
  repo: string;
  /** As the page's title says it: #168 fix: Own HLC clocks… */
  title: string;
  author: string | null;
  /** The pull request's page on GitHub. */
  url: string | null;
  /** Lines added and removed, and files, generated ones included. */
  size: { add: number; del: number; files: number };
  base: string;
  head: string;
  /** Changes marked reviewed, of all, as the page counts them. */
  progress: { done: number; total: number };
  /** Open notes, and those an agent had the last word on: they wait for you. */
  notes: { open: number; waiting: number };
  /** The chats that held it, the latest first. */
  chats: ChatRecord[];
  /** The process serving it now, or last. */
  pid: number | null;
  /** When it was first opened, and when this run opened it. */
  started: string;
  opened: string;
  updated: string;
  stopped: { at: string; why: StopReason } | null;
  closed: string | null;
  /** The pull request merged or closed on GitHub, as the manager last saw: then the review is closed. */
  github?: { state: 'merged' | 'closed'; at: string } | null;
  /** The commits checked out for it, and the pairs of commits it was analysed at (base, head). */
  checkouts: string[];
  analyses: Array<[string, string]>;
  /** When its space was freed: its checkouts and analyses went, and opening it again builds them. */
  freed?: string | null;
}

/** A record as it's listed: running, paused (stopped, kept to resume), or closed. */
export type Listed = ReviewRecord & { status: 'running' | 'paused' | 'closed' };

export const recordsDir = () => path.join(cacheRoot(), 'sessions');

/** A review's id where untangle lists it: its repository and its name there. */
export const recordId = (r: ReviewRecord) => `${r.repoKey}/${r.key}`;
/** A review's record: per repository, named like the review's notes. */
export const recordFile = (repoKey: string, key: string) => path.join(recordsDir(), repoKey, encodeURIComponent(key) + '.json');

export function readRecord(file: string): ReviewRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewRecord;
    return r && r.version === 1 && typeof r.target === 'string' ? r : null;
  } catch {
    return null;
  }
}

export function writeRecord(r: ReviewRecord): void {
  const file = recordFile(r.repoKey, r.key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r));
  fs.renameSync(tmp, file);
}

/** Every record file in the cache. */
function files(dir = recordsDir()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.json') ? [path.join(dir, e.name)] : []));
}

/** Whether the record's process still serves it: a review that ended without saying so is paused. */
const serving = (r: ReviewRecord) => r.pid != null && !r.stopped && pidAlive(r.pid);

export function status(r: ReviewRecord): Listed['status'] {
  if (serving(r)) return 'running';
  return r.closed ? 'closed' : 'paused';
}

/** The reviews untangle remembers: running first, then paused, then closed, the latest first in each. */
export function listRecords(): Listed[] {
  const order = { running: 0, paused: 1, closed: 2 };
  // When a review last moved: running ones by when they opened, the others by when they stopped.
  const when = (r: Listed) => (r.status === 'running' ? r.opened : r.status === 'closed' ? r.closed! : r.stopped?.at ?? r.updated);
  return files()
    .map(readRecord)
    .filter((r): r is ReviewRecord => !!r)
    .map((r) => {
      const s = status(r);
      // Ended without saying so: killed, or the machine went down.
      const stopped = s !== 'running' && !r.stopped ? { at: r.updated, why: 'ended' as const } : r.stopped;
      return { ...r, stopped, status: s };
    })
    .sort((a, b) => order[a.status] - order[b.status] || (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0));
}

/**
 * Whether a review's process is there to take what's asked of it: one that's stopping (paused or
 * closed a moment ago) is waited for, up to five seconds, and one that doesn't answer (the run file
 * of a review that was killed, whose process id another process has now) is let go.
 */
export async function serves(run: RunInfo): Promise<boolean> {
  if (listRecords().some((r) => r.pid === run.pid && r.stopped)) {
    for (let i = 0; i < 100 && pidAlive(run.pid); i++) await new Promise((r) => setTimeout(r, 50));
  }
  if (!pidAlive(run.pid)) return false;
  try {
    if ((await call(run, 'GET', 'summary')).status !== 403) return true;
  } catch (e) {
    if (!(e instanceof Gone)) throw e;
  }
  removeRun(run.pid);
  return false;
}

/** The folders a record names: its checkouts and analyses. */
export const recordDirs = (r: ReviewRecord) => [
  ...r.checkouts.map((sha) => worktreeDir(r.repoKey, sha)),
  ...r.analyses.map(([base, head]) => reviewDir(r.repoKey, base, head)),
];

/** What a folder takes on disk, in bytes, its links not followed; 0 when it isn't there. */
export function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          // What it takes on disk, as du says it, where the system tells.
          const st = fs.lstatSync(p);
          total += st.blocks != null ? st.blocks * 512 : st.size;
        } catch {
          // Gone while counting.
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** The same, without holding up the process: a folder at a time, a few files at once. */
export async function dirSizeAsync(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries.filter((e) => e.isFile());
    for (let i = 0; i < files.length; i += 64) {
      const sizes = await Promise.all(files.slice(i, i + 64).map((e) => fs.promises.lstat(path.join(d, e.name)).then((st) => (st.blocks != null ? st.blocks * 512 : st.size), () => 0)));
      total += sizes.reduce((a, b) => a + b, 0);
    }
    for (const e of entries) if (e.isDirectory()) await walk(path.join(d, e.name));
  };
  await walk(dir);
  return total;
}
