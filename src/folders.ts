// The folders New review offers: the worktrees of the repositories untangle knows, the folders
// below a path as it's typed, and the repository a folder is in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tilde } from './cache.js';
import { gitAsync } from './exec.js';
import { wantedDir } from './runs.js';

/** A folder the palette was given: the repository a review of it reads, by its top folder, and its branch. */
export type Folder = { dir: string; name: string; where: string; repo: string | null; branch: string | null } | { error: string };

const fromHome = (p: string, home: string) => p.replace(/^~(?=$|[\\/])/, home);

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    // Nothing there, or nothing to read.
    return false;
  }
};

/** The folder at a path pasted in the palette, ~ for your home, or why there's no review of it. */
export function folderAt(p: string, home = os.homedir()): Folder {
  const full = fromHome(p, home);
  if (!path.isAbsolute(full)) return { error: 'A folder’s whole path, from / or ~' };
  if (!isDir(full)) return { error: `There’s no folder at ${p}` };
  const w = wantedDir(full);
  if (!w?.dir) return { error: `${p} isn’t in a git repository` };
  return { dir: w.dir, name: path.basename(w.dir), where: tilde(w.dir), repo: w.repoKey ? w.repoKey.replace(/^github\.com\//, '') : null, branch: w.branch };
}

/** A folder in the one typed: its path as typed, and for a repository's top folder, where it is and its branch. */
export interface Below { name: string; path: string; dir: string | null; branch: string | null }

/** The branch a repository's top folder has checked out, from its HEAD: null when it's detached. */
function headBranch(dir: string): string | null {
  try {
    let git = path.join(dir, '.git');
    // A worktree's .git is a file that says where its own git folder is.
    if (fs.statSync(git).isFile()) {
      const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(git, 'utf8'));
      if (!m) return null;
      git = path.resolve(dir, m[1].trim());
    }
    return /^ref: refs\/heads\/(.+)$/.exec(fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What the palette shows for a path as it's typed. */
export interface PathView {
  /** The folder listed, as typed: up to the path's last separator. */
  at: string;
  /** The folders in it whose names start as the path's last part does, the first ones. */
  folders: Below[];
  more: number;
  /** The repository the folder typed is in, when it isn't one of those listed. */
  folder: Folder | null;
  error: string | null;
}

/**
 * The palette's view of a path as it's typed, for Tab to go through folders: the folders in its
 * last folder whose names start as its last part does (hidden ones only when that starts with a
 * dot), each repository's top folder with its branch; and the repository the folder typed is in,
 * which Enter reviews. A path ending in a separator lists all of its folder's.
 */
export function pathView(p: string, home = os.homedir(), most = 50): PathView {
  const q = p === '~' ? '~/' : p;
  const cut = Math.max(q.lastIndexOf('/'), q.lastIndexOf('\\'));
  const at = q.slice(0, cut + 1), part = q.slice(cut + 1);
  const dir = fromHome(at, home);
  const none = (error: string) => ({ at, folders: [], more: 0, folder: null, error });
  if (cut < 0 || !path.isAbsolute(dir)) return none('A folder’s whole path, from / or ~');
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name)))).map((e) => e.name);
  } catch {
    return none(`There’s no folder at ${at}`);
  }
  const low = part.toLowerCase();
  const all = names.filter((n) => n.toLowerCase().startsWith(low) && (part.startsWith('.') || !n.startsWith('.'))).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const folders = all.slice(0, most).map((name) => {
    const full = path.join(dir, name);
    const repo = fs.existsSync(path.join(full, '.git'));
    return { name, path: at + name, dir: repo ? fs.realpathSync(full) : null, branch: repo ? headBranch(full) : null };
  });
  // The folder typed is offered as its repository's, unless that's one of the folders listed.
  const typed = fromHome(q, home);
  const f = cut < q.length - 1 && !isDir(typed) ? null : folderAt(q, home);
  const listed = f && 'dir' in f && folders.some((b) => b.dir === f.dir);
  return { at, folders, more: all.length - folders.length, folder: f && 'dir' in f && !listed ? f : null, error: null };
}

/** A worktree New review offers: its folder, branch and repository, and when its branch last moved. */
export interface Worktree { dir: string; name: string; where: string; repo: string | null; branch: string; at: string | null }

/** owner/repo on GitHub, of a repository's remotes as git lists them: origin's first. */
function githubOf(remotes: string): string | null {
  const urls = remotes.split('\n').map((l) => /^(\S+)\t(\S+)/.exec(l)).filter((m): m is RegExpExecArray => !!m).sort((a, b) => Number(b[1] === 'origin') - Number(a[1] === 'origin'));
  for (const m of urls) {
    const g = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(m[2]);
    if (g) return `${g[1]}/${g[2]}`;
  }
  return null;
}

/**
 * The worktrees on a branch of the repositories these folders are in, the branch last moved
 * first: each repository once, whichever folder named it. Those on its default branch have
 * nothing to review, and those under skip are untangle's own: neither is offered.
 */
export async function worktreesOf(dirs: string[], skip: string | null = null): Promise<Worktree[]> {
  const seen = new Set<string>();
  const out: Worktree[] = [];
  const mine = skip && isDir(skip) ? fs.realpathSync(skip) : skip;
  await Promise.all([...new Set(dirs)].filter(isDir).map(async (d) => {
    const common = await gitAsync(d, ['rev-parse', '--git-common-dir']).then((o) => fs.realpathSync(path.resolve(d, o.trim())), () => null);
    if (!common || seen.has(common)) return;
    seen.add(common);
    const [list, head, refs, remotes] = await Promise.all([
      gitAsync(d, ['worktree', 'list', '--porcelain']).catch(() => ''),
      gitAsync(d, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => ''),
      gitAsync(d, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads']).catch(() => ''),
      gitAsync(d, ['remote', '-v']).catch(() => ''),
    ]);
    const when = new Map(refs.split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]));
    const main = head.trim().replace(/^[^/]+\//, '') || ['main', 'master'].find((b) => when.has(b)) || null;
    const repo = githubOf(remotes);
    for (const block of list.split(/\n\n+/)) {
      const at = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      if (!at || !branch || branch === main || /^(bare|prunable)/m.test(block) || !isDir(at)) continue;
      const dir = fs.realpathSync(at);
      if (mine && (dir === mine || dir.startsWith(mine + path.sep))) continue;
      out.push({ dir, name: path.basename(dir), where: tilde(dir), repo, branch, at: when.get(branch) ?? null });
    }
  }));
  return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.dir.localeCompare(b.dir));
}

/**
 * A project's folder as Orca lists it, here: in WSL, Orca on Windows names this distribution's
 * folders \\wsl.localhost\<distribution>\…, and only those are ours.
 */
export function orcaFolder(p: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const m = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i.exec(p);
  if (!m) return path.isAbsolute(p) ? p : null;
  if (process.platform !== 'linux' || (env.WSL_DISTRO_NAME && env.WSL_DISTRO_NAME.toLowerCase() !== m[1].toLowerCase())) return null;
  return (m[2] || '\\').replace(/\\/g, '/');
}
