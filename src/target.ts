// What to review: a pull request URL (cloned into the cache), or a directory whose branch has a
// pull request (or else whatever it adds to the default branch).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cloneDir } from './cache.js';
import { CommandError, git, gitAsync, gitMaybe, has, run, runAsync } from './exec.js';
import { fetchTip, followGitHub, workingCopy, type WorkingCopy } from './work.js';
import { findStack, type StackTarget } from './stack.js';

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  baseRefName: string;
  /** The base branch's commit GitHub compares with: for a merged pull request, the one it was merged into. */
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  /** The head repository and its owner, null when the repository was deleted. */
  headRepository?: string | null;
  headRepositoryOwner?: string | null;
  isCrossRepository?: boolean;
  /** Who opened it: GitHub's login. */
  author?: string | null;
  isDraft?: boolean;
}

export interface Target {
  /** The git repository the commits live in. */
  repo: string;
  /** github.com/owner/name, or local/<name>-<hash> for a repository without a GitHub remote. */
  repoKey: string;
  pr: PullRequest | null;
  stack?: StackTarget | null;
  /** A branch in the cache for changes, only when opened from a link. */
  work?: WorkingCopy | null;
  /** The branch the review compares with, and the commit it starts from (the merge base). */
  baseRef: string;
  /** The remote whose branch was selected as the base, or null for a local branch. */
  baseRemote?: string | null;
  baseSha: string;
  headSha: string;
  /** A clean checkout of the head commit that can be used as is: the directory itself. */
  headDir: string | null;
  /** Notes for the narration: why the head or base is what it is. */
  notes: string[];
}

const PR_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)(?:[/?#].*)?$/;

export const isPrUrl = (arg: string) => PR_URL.test(arg);

/** owner/name of a GitHub remote URL, or null. */
export function githubRepo(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The repository a fork came from, as people name it: its upstream remote's owner/repo on GitHub.
 * Null when the directory has no such remote.
 */
export function upstreamOf(dir: string): string | null {
  const url = gitMaybe(dir, 'remote', 'get-url', 'upstream');
  const g = url ? githubRepo(url) : null;
  return g ? `${g.owner}/${g.repo}` : null;
}

const GH_FIELDS = 'number,title,url,state,baseRefName,baseRefOid,headRefName,headRefOid,author,headRepository,headRepositoryOwner,isCrossRepository,isDraft';
// gh says who opened it as { login }.
const fromGh = (j: Omit<PullRequest, 'owner' | 'repo' | 'author' | 'headRepository' | 'headRepositoryOwner'> & {
  author?: { login?: string } | null;
  headRepository?: { name: string } | null;
  headRepositoryOwner?: { login: string } | null;
}) => ({ ...j, author: j.author?.login ?? null, headRepository: j.headRepository?.name ?? null, headRepositoryOwner: j.headRepositoryOwner?.login ?? null });

async function prFromApi(owner: string, repo: string, number: number, ghError: string | null): Promise<PullRequest> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'untangle' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, { headers });
  if (res.status === 404) throw new Error(`cannot find ${owner}/${repo}#${number}${ghError ? `: ${ghError}` : ' (for a private repository, log in with gh or set GITHUB_TOKEN)'}`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${owner}/${repo}#${number}${ghError ? ` (gh: ${ghError})` : ''}`);
  const j = (await res.json()) as { number: number; title: string; html_url: string; state: string; draft?: boolean; merged_at: string | null; base: { ref: string; sha: string }; head: { ref: string; sha: string; repo: { name: string; owner: { login: string } } | null }; user?: { login?: string } | null };
  return { owner, repo, number: j.number, title: j.title, url: j.html_url, state: j.merged_at ? 'MERGED' : j.state.toUpperCase(), isDraft: !!j.draft, baseRefName: j.base.ref, baseRefOid: j.base.sha, headRefName: j.head.ref, headRefOid: j.head.sha, author: j.user?.login ?? null, headRepository: j.head.repo?.name ?? null, headRepositoryOwner: j.head.repo?.owner.login ?? null, isCrossRepository: !!j.head.repo && (j.head.repo.owner.login !== owner || j.head.repo.name !== repo) };
}

/** A pull request by owner, name and number: through gh when it's there, else the REST API. */
export async function fetchPr(owner: string, repo: string, number: number): Promise<PullRequest> {
  let ghError: string | null = null;
  try {
    const j = JSON.parse(await runAsync('gh', ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', GH_FIELDS]));
    return { owner, repo, ...fromGh(j) };
  } catch (e) {
    // Not installed or logged in, say: the public API may still answer.
    ghError = e instanceof CommandError ? e.stderr.trim().split('\n')[0] || null : null;
  }
  return prFromApi(owner, repo, number, ghError);
}

/** The pull request of a directory's current branch, or null. */
function branchPr(dir: string): PullRequest | null {
  if (!has('gh')) return null;
  try {
    const j = JSON.parse(run('gh', ['pr', 'view', '--json', GH_FIELDS], { cwd: dir }));
    const r = githubRepo(j.url.replace(/\/pull\/\d+$/, ''));
    return r ? { ...r, ...fromGh(j) } : null;
  } catch {
    return null;
  }
}

/**
 * The head a review of this target would have now, without fetching it: the pull request's
 * (through gh, else GitHub's API), or the directory's HEAD.
 */
export async function latestHead(t: Target, byUrl: boolean): Promise<string | null> {
  if (t.work || !byUrl) return gitAsync(t.work?.dir ?? t.repo, ['rev-parse', 'HEAD']).then((s) => s.trim(), () => null);
  if (!t.pr) return null;
  return (await fetchPr(t.pr.owner, t.pr.repo, t.pr.number)).headRefOid;
}

const hasCommit = (repo: string, sha: string) => gitMaybe(repo, 'cat-file', '-e', `${sha}^{commit}`) !== null;
const tipOf = (repo: string, ref: string) => gitMaybe(repo, 'rev-parse', '--verify', `${ref}^{commit}`)?.trim() || null;

/**
 * Of a branch's copies, the one HEAD adds the fewest commits to: the copy HEAD left last. One that
 * holds HEAD already counts only when all do, and the first wins a tie.
 */
function nearestCopy<T extends { tip: string | null }>(repo: string, head: string, copies: Array<T | null>): T | null {
  let nearest: T | null = null;
  let fewest = Infinity;
  for (const copy of copies) {
    if (!copy?.tip) continue;
    const adds = Number(gitMaybe(repo, 'rev-list', '--count', `${copy.tip}..${head}`)) || Infinity;
    if (nearest && adds >= fewest) continue;
    nearest = copy;
    fewest = adds;
  }
  return nearest;
}

/**
 * Where the comparison starts for a pull request: an open one compares with its base branch as
 * it is now, a merged or closed one with the base commit GitHub recorded (the branch has moved
 * on, and may hold the pull request itself).
 */
async function prBaseTip(repo: string, remote: string, pr: PullRequest, branchTip: () => Promise<string | null>): Promise<string> {
  if (pr.state === 'OPEN') {
    const tip = await branchTip();
    if (tip) return tip;
  }
  if (!hasCommit(repo, pr.baseRefOid)) await gitAsync(repo, ['fetch', '--quiet', '--no-tags', remote, pr.baseRefOid]).catch(() => branchTip());
  if (hasCommit(repo, pr.baseRefOid)) return pr.baseRefOid;
  throw new Error(`cannot fetch ${pr.baseRefName} (${pr.baseRefOid.slice(0, 7)}), the base of #${pr.number}`);
}

/** Fetches a branch, keeping the user's refs as they are: the tip comes back from FETCH_HEAD. */
async function fetchBranch(repo: string, remote: string, branch: string): Promise<string | null> {
  try {
    await gitAsync(repo, ['fetch', '--quiet', '--no-tags', remote, `refs/heads/${branch}`]);
    return git(repo, 'rev-parse', 'FETCH_HEAD').trim();
  } catch {
    return null;
  }
}

export async function resolveUrl(url: string, say: (line: string) => void, baseOverride: string | null = null): Promise<Target> {
  const [, owner, name, num] = PR_URL.exec(url)!;
  say(`looking up ${owner}/${name}#${num}`);
  const pr = await fetchPr(owner, name, +num);
  const repoKey = `github.com/${owner}/${name}`;
  const repo = cloneDir(repoKey);
  if (!fs.existsSync(path.join(repo, 'HEAD'))) {
    say(`cloning ${owner}/${name} (blobs on demand)`);
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    await runAsync('git', ['clone', '--quiet', '--bare', '--filter=blob:none', `https://github.com/${owner}/${name}.git`, repo]);
  }
  say(`fetching #${pr.number}`);
  await gitAsync(repo, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/pull/${pr.number}/head:refs/untangle/pull/${pr.number}`]);
  let headSha = (await gitAsync(repo, ['rev-parse', `refs/untangle/pull/${pr.number}`])).trim();
  const notes: string[] = [];
  if (pr.state !== 'OPEN') notes.push(`#${pr.number} is ${pr.state.toLowerCase()}: comparing with ${pr.baseRefName} as it was then`);
  if (headSha !== pr.headRefOid) notes.push(`GitHub reports ${pr.headRefOid.slice(0, 7)} as the head; the fetched head is ${headSha.slice(0, 7)}`);
  let work: WorkingCopy | null = null;
  try {
    work = await workingCopy(repo, repoKey, pr, say);
    if (work) {
      const github = await fetchTip(repo, work.remote, `refs/heads/${pr.headRefName}`, work.ref).catch(() => null);
      if (github) await followGitHub(work.dir, github).catch(() => {});
      headSha = (await gitAsync(work.dir, ['rev-parse', 'HEAD'])).trim();
    }
  } catch (e) {
    work = null;
    notes.push(`could not open the working copy: ${(e as Error).message.split('\n')[0]}`);
  }
  if (baseOverride) {
    const tip = tipOf(repo, baseOverride) ?? await fetchBranch(repo, 'origin', baseOverride);
    if (!tip) throw new Error(`cannot find -base ${baseOverride} in ${repo}`);
    const baseSha = (await gitAsync(repo, ['merge-base', tip, headSha])).trim();
    if (baseSha === headSha) throw new Error(`#${pr.number} adds nothing to ${baseOverride}: there is nothing to review`);
    return { repo, repoKey, pr, work, stack: null, baseRef: baseOverride, baseSha, headSha, headDir: null, notes };
  }
  const stack = await findStack(repo, repoKey, pr, headSha, true, 'origin', work);
  if (stack) return { repo, repoKey, pr, work, stack, baseRef: stack.base.ref, baseSha: stack.base.sha, headSha, headDir: null, notes };
  say(`fetching ${pr.baseRefName}`);
  const ref = `refs/untangle/base/${pr.baseRefName}`;
  const tip = await prBaseTip(repo, 'origin', pr, () => gitAsync(repo, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${pr.baseRefName}:${ref}`]).then(() => git(repo, 'rev-parse', ref).trim(), () => null));
  const baseSha = git(repo, 'merge-base', tip, headSha).trim();
  if (baseSha === headSha) throw new Error(`#${pr.number} adds nothing to ${pr.baseRefName}: there is nothing to review`);
  return { repo, repoKey, pr, work, stack: null, baseRef: pr.baseRefName, baseSha, headSha, headDir: null, notes };
}

export async function resolveDirectory(dir: string, baseOverride: string | null, say: (line: string) => void): Promise<Target> {
  const top = gitMaybe(dir, 'rev-parse', '--show-toplevel')?.trim();
  if (!top) throw new Error(`${dir} is not inside a git repository`);
  const repo = fs.realpathSync(top);
  const headSha = git(repo, 'rev-parse', 'HEAD').trim();
  const remotes = (gitMaybe(repo, 'remote') || '').split('\n').filter(Boolean);
  const remoteUrl = (r: string) => gitMaybe(repo, 'remote', 'get-url', r)?.trim() || '';
  const notes: string[] = [];
  if (!baseOverride) say('looking for the branch’s pull request');
  const pr = baseOverride ? null : branchPr(repo);
  // The remote the base branch comes from: the pull request's repository, else origin.
  const remote = (pr && remotes.find((r) => { const g = githubRepo(remoteUrl(r)); return g && g.owner.toLowerCase() === pr.owner.toLowerCase() && g.repo.toLowerCase() === pr.repo.toLowerCase(); }))
    || (remotes.includes('origin') ? 'origin' : remotes[0]) || null;
  const gh = remote ? githubRepo(remoteUrl(remote)) : null;
  const repoKey = pr ? `github.com/${pr.owner}/${pr.repo}` : gh ? `github.com/${gh.owner}/${gh.repo}` : `local/${path.basename(repo)}-${crypto.createHash('sha256').update(repo).digest('hex').slice(0, 8)}`;

  const stack = pr ? await findStack(repo, repoKey, pr, headSha, false, remote && (!gh || gh.owner.toLowerCase() === pr.owner.toLowerCase() && gh.repo.toLowerCase() === pr.repo.toLowerCase()) ? remote : `https://github.com/${pr.owner}/${pr.repo}.git`) : null;
  if (stack) {
    const dirty = !!gitMaybe(repo, 'status', '--porcelain', '--untracked-files=no')?.trim();
    if (dirty) notes.push('uncommitted changes are not part of the review');
    return { repo, repoKey, pr, stack, baseRef: stack.base.ref, baseRemote: remote, baseSha: stack.base.sha, headSha, headDir: dirty ? null : repo, notes };
  }

  let baseRef: string, baseTip: string | null = null;
  let baseRemote: string | null = null;
  if (baseOverride) {
    baseRef = baseOverride;
    baseTip = gitMaybe(repo, 'rev-parse', '--verify', `${baseOverride}^{commit}`)?.trim() || null;
    if (!baseTip) throw new Error(`-base ${baseOverride} is not a commit in ${repo}`);
  } else {
    if (pr) {
      baseRemote = remote;
      baseRef = pr.baseRefName;
      if (pr.state !== 'OPEN') notes.push(`#${pr.number} is ${pr.state.toLowerCase()}: comparing with ${baseRef} as it was then`);
      if (pr.headRefOid !== headSha) notes.push(`reviewing your checkout at ${headSha.slice(0, 7)}; the pull request’s head is ${pr.headRefOid.slice(0, 7)}`);
      if (remote) {
        say(`fetching ${remote}/${baseRef}`);
        baseTip = await prBaseTip(repo, remote, pr, () => fetchBranch(repo, remote, baseRef)).catch(() => null);
        if (!baseTip) notes.push(`could not fetch ${remote}/${baseRef}; using the local copy`);
      }
    } else {
      const def = remote && gitMaybe(repo, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`)?.trim();
      const branch = def ? def.slice(remote!.length + 1) : ['main', 'master'].find((b) => gitMaybe(repo, 'rev-parse', '--verify', `${b}^{commit}`)) || '';
      if (!branch) throw new Error('no pull request for this branch and no default branch to compare with; pass -base <branch>');
      let fetched: string | null = null;
      if (remote) {
        say(`fetching ${remote}/${branch}`);
        fetched = await fetchBranch(repo, remote, branch);
      }
      // A fork's origin can lag the repository it came from: of origin's main, yours and the other
      // remotes' (upstream first), compare with the one the branch left last.
      const own = remote ? { ref: branch, tip: fetched ?? tipOf(repo, `refs/remotes/${remote}/${branch}`) } : null;
      const others = remotes.filter((r) => r !== remote).sort((a, b) => Number(b === 'upstream') - Number(a === 'upstream'));
      const nearest = nearestCopy(repo, headSha, [own, { ref: branch, tip: tipOf(repo, `refs/heads/${branch}`) }, ...others.map((r) => ({ ref: `${r}/${branch}`, tip: tipOf(repo, `refs/remotes/${r}/${branch}`) }))]);
      baseRef = nearest?.ref ?? branch;
      baseRemote = nearest === own ? remote : nearest?.ref.includes('/') ? others.find((r) => nearest.ref.startsWith(r + '/')) ?? null : null;
      baseTip = nearest?.tip ?? null;
      notes.push(`no pull request for this branch: comparing with ${baseRef}`);
      if (own && nearest === own && !fetched) notes.push(`could not fetch ${remote}/${branch}; using the local copy`);
    }
    baseTip ??= gitMaybe(repo, 'rev-parse', '--verify', `${remote}/${baseRef}^{commit}`)?.trim() || gitMaybe(repo, 'rev-parse', '--verify', `${baseRef}^{commit}`)?.trim() || null;
    if (!baseTip) throw new Error(`cannot find ${baseRef} in ${repo}`);
  }
  let baseSha: string;
  try {
    baseSha = git(repo, 'merge-base', baseTip, headSha).trim();
  } catch (e) {
    throw e instanceof CommandError ? new Error(`${baseRef} and HEAD share no history`) : e;
  }
  if (baseSha === headSha) throw new Error(`HEAD adds nothing to ${baseRef}: there is nothing to review`);
  // The directory itself is the head checkout when nothing in it is uncommitted.
  const dirty = (gitMaybe(repo, 'status', '--porcelain', '--untracked-files=no') || '').trim() !== '';
  if (dirty) notes.push('uncommitted changes are not part of the review');
  return { repo, repoKey, pr, stack: null, baseRef, baseRemote, baseSha, headSha, headDir: dirty ? null : repo, notes };
}
