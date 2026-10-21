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
}

/** What a command looks for: a pull request, or a directory's repository and branch. */
export interface Wanted { pr: string | null; dir: string | null; repoKey: string | null; branch: string | null }

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
  return { pr: null, dir: fs.realpathSync(top), repoKey, branch: branch && branch !== 'HEAD' ? branch : null };
}

/**
 * The review running for what's wanted: of that pull request, of that directory, or of a pull
 * request on that directory's branch (reviewed from its URL, in the cache's clone).
 */
export function findRun(w: Wanted): RunInfo | null {
  const runs = listRuns();
  const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  return runs.find((r) => w.pr && r.pr === w.pr)
    || runs.find((r) => w.dir && r.dir === w.dir)
    || runs.find((r) => w.branch && same(r.repoKey, w.repoKey) && r.branch === w.branch)
    || null;
}
