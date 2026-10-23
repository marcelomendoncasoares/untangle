// The branch an agent can change, beside the review's read-only checkouts. Its objects belong to
// the clone too, so a commit made here can be reviewed without ever pushing it.
import fs from 'node:fs';
import path from 'node:path';
import { workDir } from './cache.js';
import { linkOf } from './checkouts.js';
import { CommandError, gitAsync, runAsync } from './exec.js';
import type { PullRequest } from './target.js';

export interface WorkingCopy {
  dir: string;
  branch: string;
  remote: string;
  ref: string;
  githubBranch: string;
}

/** gh's protocol, so pushes use the credentials the user already has. */
export async function githubUrl(owner: string, repo: string): Promise<string> {
  const protocol = await runAsync('gh', ['config', 'get', 'git_protocol', '--host', 'github.com']).catch(() => 'https');
  return protocol.trim() === 'ssh' ? `git@github.com:${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
}

/** Fetch into our ref alone, leaving the user's branches and remote-tracking refs as they were. */
export async function fetchTip(repo: string, remote: string, from: string, ref: string): Promise<string> {
  try {
    await gitAsync(repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', remote, `+${from}:${ref}`]);
  } catch (e) {
    // A branch GitHub no longer has is unknown, not evidence that its old commits are pushed.
    if (e instanceof CommandError && /couldn't find remote ref/.test(e.stderr)) await gitAsync(repo, ['update-ref', '-d', ref]);
    throw e;
  }
  return (await gitAsync(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** Only a clean branch with no commits of its own may follow GitHub automatically. */
export async function followGitHub(dir: string, github: string): Promise<void> {
  if ((await gitAsync(dir, ['--no-optional-locks', 'status', '--porcelain'])).trim()) return;
  const head = (await gitAsync(dir, ['rev-parse', 'HEAD'])).trim();
  if (head === github) return;
  if (await gitAsync(dir, ['merge-base', '--is-ancestor', head, github]).then(() => true, () => false)) {
    // Git still checks the index and files if the agent changed them while we were looking.
    await gitAsync(dir, ['merge', '--ff-only', '--no-edit', github]);
  }
}

/** Makes it once, or reuses it without checking out over anything the agent has done. */
export async function workingCopy(repo: string, repoKey: string, pr: PullRequest, say: (line: string) => void): Promise<WorkingCopy | null> {
  const dir = workDir(repoKey, pr.number);
  if (!fs.existsSync(dir) && (pr.state !== 'OPEN' || !pr.headRepository || !pr.headRepositoryOwner)) return null;
  const remote = `untangle-pr-${pr.number}`;
  const ref = `refs/remotes/${remote}/${pr.headRefName}`;
  const githubBranch = pr.isCrossRepository ? `${pr.headRepositoryOwner}:${pr.headRefName}` : pr.headRefName;
  if (fs.existsSync(dir)) {
    const link = linkOf(dir);
    if (!link || fs.realpathSync(link.common) !== fs.realpathSync(repo)) throw new Error('the working copy belongs to another repository');
    const branch = (await gitAsync(dir, ['symbolic-ref', '--short', 'HEAD'])).trim();
    return { dir, branch, remote, ref, githubBranch };
  }

  const url = await githubUrl(pr.headRepositoryOwner!, pr.headRepository!);
  await gitAsync(repo, ['config', `remote.${remote}.url`, url]);
  await gitAsync(repo, ['config', `remote.${remote}.fetch`, `+refs/heads/${pr.headRefName}:${ref}`]);
  const head = await fetchTip(repo, remote, `refs/heads/${pr.headRefName}`, ref);
  // A bare clone starts with local branches. Reuse one only when it has no work GitHub lacks
  // and no checkout, otherwise pick a new name, including for two forks with the same branch.
  await gitAsync(repo, ['worktree', 'prune']);
  const occupied = (await gitAsync(repo, ['worktree', 'list', '--porcelain'])).split('\n');
  let branch = pr.headRefName;
  for (let n = 0; ; n++) {
    branch = n ? `${pr.headRefName}-pr-${pr.number}${n > 1 ? `-${n}` : ''}` : pr.headRefName;
    const old = await gitAsync(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]).then((s) => s.trim(), () => null);
    if (occupied.includes(`branch refs/heads/${branch}`)) continue;
    if (old && !(await gitAsync(repo, ['merge-base', '--is-ancestor', old, head]).then(() => true, () => false))) continue;
    // The expected value prevents two reviews claiming a branch at once.
    await gitAsync(repo, ['update-ref', `refs/heads/${branch}`, head, old ?? '0'.repeat(40)]);
    break;
  }
  await gitAsync(repo, ['config', `branch.${branch}.remote`, remote]);
  await gitAsync(repo, ['config', `branch.${branch}.merge`, `refs/heads/${pr.headRefName}`]);
  await gitAsync(repo, ['config', `branch.${branch}.pushRemote`, remote]);
  await gitAsync(repo, ['config', `remote.${remote}.push`, `refs/heads/${branch}:refs/heads/${pr.headRefName}`]);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  say('checking out the working copy');
  await gitAsync(repo, ['worktree', 'add', '--quiet', dir, branch]);
  return { dir, branch, remote, ref, githubBranch };
}
