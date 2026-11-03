// Checkouts of both sides for the language server, with their Dart packages resolved. A checkout
// of untangle's clone is a worktree of it. A checkout of your repository is a repository of its
// own that borrows your repository's objects (git's alternates): a worktree of it would be listed
// with its worktrees, by git and by the editors that show them.
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot, worktreeDir } from './cache.js';
import { git, gitAsync, gitMaybe, has, runAsync, runDart } from './exec.js';

/** A detached checkout of a commit, made once and reused. */
export async function worktree(repo: string, repoKey: string, sha: string): Promise<string> {
  const dir = worktreeDir(repoKey, sha);
  if (gitMaybe(dir, 'rev-parse', 'HEAD')?.trim() === sha) {
    // Made from another clone of the same repository, it borrows from this one too.
    if (ownRepository(dir) && !inCache(repo)) borrow(dir, objectsOf(repo));
    return fs.realpathSync(dir);
  }
  // A leftover of an earlier run (interrupted, say) is ours to replace.
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (!inCache(repo) && !partial(repo)) {
    try {
      fs.mkdirSync(dir);
      await init(dir);
      borrow(dir, objectsOf(repo));
      // Files kept with Git LFS stay pointers: the analysis reads none, and there's no remote to fetch them from.
      await runAsync('git', ['-C', dir, 'checkout', '--quiet', '--detach', sha], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
      // git leaves out the files it can't read, and says so, but succeeds.
      if (checkoutAt(dir, sha)) return fs.realpathSync(dir);
    } catch {
      // A worktree, then.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // --force covers a worktree whose folder is gone but which git still lists.
  await gitAsync(repo, ['worktree', 'add', '--quiet', '--force', '--detach', dir, sha]);
  return fs.realpathSync(dir);
}

/**
 * Makes the checkouts older untangles made as worktrees of your repositories checkouts of their
 * own, in place, so your repositories stop listing them: one repository's, or all of them.
 */
export async function rehomeCheckouts(repoKey?: string): Promise<void> {
  const root = path.join(cacheRoot(), 'worktrees');
  const repos = repoKey ? [path.join(root, repoKey)] : [...subdirs(path.join(root, 'github.com')).flatMap(subdirs), ...subdirs(path.join(root, 'local'))];
  for (const dir of repos.flatMap(subdirs)) {
    // What a rehoming stopped halfway left.
    if (path.basename(dir).startsWith('.own-') && !young(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (!/^[0-9a-f]{12}$/.test(path.basename(dir))) continue;
    const link = linkOf(dir);
    // untangle's clone and a partial clone keep theirs, an older untangle may be making one, and git leaves a locked one be.
    if (!link || inCache(link.common) || partial(link.common) || young(dir) || fs.existsSync(path.join(link.entry, 'locked'))) continue;
    if (!gitMaybe(dir, 'rev-parse', 'HEAD')?.startsWith(path.basename(dir))) continue;
    await rehome(dir, link).catch(() => {});
  }
}

/** The repository a worktree belongs to, and its entry there: null for a checkout of its own. */
export function linkOf(dir: string): { common: string; entry: string } | null {
  try {
    const entry = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8'))?.[1].trim();
    if (!entry) return null;
    const at = path.resolve(dir, entry);
    return { common: path.resolve(at, fs.readFileSync(path.join(at, 'commondir'), 'utf8').trim()), entry: at };
  } catch {
    return null;
  }
}

/** A worktree of your repository made a checkout of its own: its files stay as they are, and your repository lets go of it. */
async function rehome(dir: string, link: { common: string; entry: string }): Promise<void> {
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  const ours = real(path.dirname(path.resolve(link.entry, fs.readFileSync(path.join(link.entry, 'gitdir'), 'utf8').trim()))) === real(dir);
  // Its age tells an old checkout, to free: it keeps it.
  const { atime, mtime } = fs.statSync(dir);
  const tmp = fs.mkdtempSync(path.join(path.dirname(dir), '.own-'));
  try {
    await init(tmp);
    borrow(tmp, path.join(real(link.common), 'objects'));
    await gitAsync(tmp, ['update-ref', '--no-deref', 'HEAD', sha]);
    fs.rmSync(path.join(dir, '.git'));
    fs.renameSync(path.join(tmp, '.git'), path.join(dir, '.git'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The index comes from the commit; git status fills in the files' stats.
  await gitAsync(dir, ['read-tree', 'HEAD']);
  // As git worktree prune does for a worktree whose folder is gone, its entry goes.
  if (ours) fs.rmSync(link.entry, { recursive: true, force: true });
  fs.utimesSync(dir, atime, mtime);
}

/** Whether a repository is a partial clone: it fetches what it lacks from its remote, which a repository borrowing its objects can't. */
const partial = (repo: string) => !!gitMaybe(repo, 'config', '--get', 'extensions.partialclone')?.trim();

/** An empty repository, without git's sample hooks. */
const init = (dir: string) => gitAsync(dir, ['-c', 'init.defaultBranch=untangle', 'init', '--quiet', '--template=']);

/** A repository's objects, which its worktrees share. */
const objectsOf = (repo: string) => path.join(real(path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir').trim())), 'objects');

/** Makes a checkout of its own borrow a repository's objects, besides those it borrows that are still there. */
function borrow(dir: string, objects: string): void {
  const file = path.join(dir, '.git', 'objects', 'info', 'alternates');
  let was: string[] = [];
  try {
    was = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    // It borrows nothing yet.
  }
  const now = was.filter((d) => fs.existsSync(d));
  if (!now.includes(objects)) now.push(objects);
  if (now.join('\n') === was.join('\n')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, now.join('\n') + '\n');
}

const ownRepository = (dir: string) => fs.statSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isDirectory() ?? false;
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
/** Whether a path is in untangle's cache, where its clones are: nobody else lists their worktrees. */
const inCache = (p: string) => (real(p) + path.sep).startsWith(real(cacheRoot()) + path.sep);
/** A checkout made in the last minutes may still be being made. */
const young = (dir: string) => Date.now() - (fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) < 10 * 60_000;
const subdirs = (d: string) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
  } catch {
    return [];
  }
};

/**
 * The package folders the language server needs resolved: the root of a pub workspace, or else
 * each package that holds a changed Dart file.
 */
export function packageDirs(repo: string, base: string, head: string, checkout: string): string[] {
  const root = path.join(checkout, 'pubspec.yaml');
  if (fs.existsSync(root) && /^workspace:/m.test(fs.readFileSync(root, 'utf8'))) return [checkout];
  const changed = git(repo, 'diff', '--no-renames', '--name-only', base, head, '--', '*.dart').split('\n').filter(Boolean);
  const dirs = new Set<string>();
  for (const f of changed) {
    let p = path.dirname(f);
    while (p !== '.' && !fs.existsSync(path.join(checkout, p, 'pubspec.yaml'))) p = path.dirname(p);
    if (fs.existsSync(path.join(checkout, p, 'pubspec.yaml'))) dirs.add(path.join(checkout, p));
  }
  return [...dirs].sort();
}

export const resolved = (dir: string) => fs.existsSync(path.join(dir, '.dart_tool', 'package_config.json'));

/** Whether a checkout still holds exactly a commit: that commit checked out, nothing uncommitted. */
export const checkoutAt = (dir: string, sha: string) =>
  gitMaybe(dir, 'rev-parse', 'HEAD')?.trim() === sha && gitMaybe(dir, 'status', '--porcelain', '--untracked-files=no')?.trim() === '';

/** `dart pub get`, or `flutter pub get` when a package needs Flutter. Returns the folders that failed. */
export async function pubGet(dirs: string[], log: (line: string) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const dir of dirs.filter((d) => !resolved(d))) {
    try {
      await runDart(['pub', 'get'], { cwd: dir, onLine: log });
    } catch {
      try {
        if (!has('flutter')) throw new Error('no flutter');
        // On Windows flutter is flutter.bat, which only the shell starts.
        await runAsync('flutter', ['pub', 'get'], { cwd: dir, onLine: log, shell: process.platform === 'win32' });
      } catch {
        failed.push(dir);
      }
    }
  }
  return failed;
}
