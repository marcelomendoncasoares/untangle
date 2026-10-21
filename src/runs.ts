// The reviews this machine serves: each running untangle keeps a file in the cache with how to
// reach it, so `untangle watch`, `reply`, `notes` and `stop`, run from another terminal, find the
// review of a directory or a pull request.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './cache.js';
import { gitMaybe } from './exec.js';

export interface RunInfo {
  pid: number;
  /** The review's link, with its token. */
  url: string;
  token: string;
  /** What it reviews: a directory's repository (its top level), or a pull request (owner/repo#n). */
  dir: string | null;
  pr: string | null;
  /** Once the review is built: its repository, the branch it reviews, its title and head. */
  repoKey?: string;
  branch?: string | null;
  title?: string;
  head?: string;
  started: string;
  /** The page's tab in Orca, when the review opened it there. */
  page?: string | null;
  /**
   * Once its target is known: the review's key, which with its repository names its record and its
   * notes, and when this process took it. One untangle serves a review: of two that start it at
   * once, the later one gives way.
   */
  key?: string;
  claimed?: string;
}

/**
 * Reviews an untangle from before records runs, by process: they don't know the summary call,
 * and their run file is all there is of them. The manager learns them as it asks.
 */
export const olderRuns = new Set<number>();

/** What a command looks for: a pull request (and its review's key), or a directory's repository and branch. */
export interface Wanted { pr: string | null; dir: string | null; repoKey: string | null; branch: string | null; key: string | null }

export const runDir = () => path.join(cacheRoot(), 'run');
const runFile = (pid: number) => path.join(runDir(), `${pid}.json`);

/** Writes this process's run file: it holds the token, so only you can read it. */
export function writeRun(info: RunInfo): void {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const file = runFile(info.pid), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeRun(pid: number): void {
  try {
    fs.rmSync(runFile(pid), { force: true });
  } catch {
    // Gone already.
  }
}

/** Whether a process runs. */
export const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The reviews running now, newest first. A file whose process is gone is removed. */
export function listRuns(): RunInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(runDir());
  } catch {
    return [];
  }
  const out: RunInfo[] = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    if (!pidAlive(Number(m[1]))) { removeRun(Number(m[1])); continue; }
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(runDir(), name), 'utf8')));
    } catch {
      // Being written.
    }
  }
  return out.sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
}

/** owner/repo#n of a pull request URL, as run files keep it. */
export const prKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`.toLowerCase();

/** What a directory stands for: its repository's top level, its GitHub repository and its branch. */
export function wantedDir(dir: string): Wanted | null {
  const top = gitMaybe(dir, 'rev-parse', '--show-toplevel')?.trim();
  if (!top) return null;
  const branch = gitMaybe(top, 'rev-parse', '--abbrev-ref', 'HEAD')?.trim() || null;
  const remotes = (gitMaybe(top, 'remote') || '').split('\n').filter(Boolean).sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  let repoKey: string | null = null;
  for (const r of remotes) {
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(gitMaybe(top, 'remote', 'get-url', r)?.trim() || '');
    if (m) { repoKey = `github.com/${m[1]}/${m[2]}`; break; }
  }
  return { pr: null, dir: fs.realpathSync(top), repoKey, branch: branch && branch !== 'HEAD' ? branch : null, key: null };
}

/** What a pull request's link stands for: its review is keyed by its number. */
export function wantedUrl(url: string): Wanted | null {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)/.exec(url);
  return m ? { pr: prKey(m[1], m[2], Number(m[3])), dir: null, repoKey: `github.com/${m[1]}/${m[2]}`, branch: null, key: `pr-${Number(m[3])}` } : null;
}

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The review running for what's wanted: of that pull request (from its link, or from a directory
 * on its branch), of that directory, or of a pull request on that directory's branch (reviewed
 * from its URL, in the cache's clone).
 */
export function findRun(w: Wanted): RunInfo | null {
  const runs = listRuns();
  return runs.find((r) => w.pr && r.pr === w.pr)
    || runs.find((r) => w.key && r.key === w.key && same(r.repoKey, w.repoKey))
    || runs.find((r) => w.dir && r.dir === w.dir)
    || runs.find((r) => w.branch && same(r.repoKey, w.repoKey) && r.branch === w.branch)
    || null;
}

/**
 * The untangle that serves the review this process took, when another one does: one that took it
 * first, or one built by an untangle from before run files said which review they serve, of the
 * same pull request or directory. Null when it's this process's to serve.
 */
export function holder(me: RunInfo, pr: string | null, runs = listRuns()): RunInfo | null {
  const at = (r: RunInfo) => r.claimed ?? r.started;
  const first = (r: RunInfo) => at(r) < at(me) || (at(r) === at(me) && r.pid < me.pid);
  return runs.find((r) => r.pid !== me.pid && (r.key
    ? r.key === me.key && same(r.repoKey, me.repoKey) && first(r)
    : !!r.head && ((!!pr && r.pr === pr) || (!!me.dir && r.dir === me.dir)))) ?? null;
}
