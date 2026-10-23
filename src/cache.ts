// Where untangle keeps clones, worktrees and analyses between runs.
import os from 'node:os';
import path from 'node:path';

export function cacheRoot(): string {
  if (process.env.UNTANGLE_CACHE) return path.resolve(process.env.UNTANGLE_CACHE);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'untangle');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'untangle');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'untangle');
}

/** A clone of a hosted repository, shared by every review of it. */
export const cloneDir = (repoKey: string) => path.join(cacheRoot(), 'repos', repoKey + '.git');

/** A checkout of one commit. */
export const worktreeDir = (repoKey: string, sha: string) => path.join(cacheRoot(), 'worktrees', repoKey, sha.slice(0, 12));

/** The pull request's branch, where the agent makes changes. */
export const workDir = (repoKey: string, number: number) => path.join(cacheRoot(), 'work', repoKey, String(number));

/** untangle's own clone: untangle upgrade pulls it, builds it and links it. */
export const selfDir = () => path.join(cacheRoot(), 'untangle');

/** The analysis of one pair of commits, and the review marks on it. */
export const reviewDir = (repoKey: string, base: string, head: string) => path.join(cacheRoot(), 'reviews', repoKey, `${base.slice(0, 12)}-${head.slice(0, 12)}`);

/** Shortens the home directory to ~ for display. */
export const tilde = (p: string) => (p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
