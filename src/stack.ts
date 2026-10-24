// The open pull requests below a review, and the branch where their stack starts.
import fs from 'node:fs';
import { workDir } from './cache.js';
import { gitAsync, runAsync } from './exec.js';
import type { PullRequest, Target } from './target.js';
import { fetchTip, followGitHub, workingCopy, type WorkingCopy } from './work.js';

export interface StackLeg {
  pr: PullRequest;
  head: string;
  /** The merge base of this leg's diff on GitHub, before M9's comparison adjustment. */
  base: string;
  work: WorkingCopy | null;
}

export interface StackTarget {
  base: { ref: string; sha: string; squashed: number | null };
  legs: StackLeg[];
  above: Array<{ number: number; title: string; url: string; branch: string }>;
}

export type StackRecord = { legs: number[]; base: string };
export const stackRecord = (stack: StackTarget | null | undefined): StackRecord | null => stack ? { legs: stack.legs.map((l) => l.pr.number), base: stack.base.ref } : null;

const OPEN_FIELDS = 'number,title,url,baseRefName,headRefName,headRefOid,isDraft,author,isCrossRepository,headRepositoryOwner';
const ancestor = (repo: string, a: string, b: string) => gitAsync(repo, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
type Merged = { number: number; headRefOid: string; mergeCommit: { oid: string } | null; mergedAt: string };

/** One list for the repository, with the public API as a fallback when gh cannot read it. */
export async function openPullRequests(owner: string, repo: string): Promise<PullRequest[]> {
  try {
    const list = JSON.parse(await runAsync('gh', ['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--limit', '200', '--json', OPEN_FIELDS]));
    return list.map((p: Omit<PullRequest, 'author' | 'headRepositoryOwner'> & { author?: { login?: string }; headRepositoryOwner?: { login?: string } }) => ({
      ...p, owner, repo, state: 'OPEN', baseRefOid: '', author: p.author?.login ?? null,
      headRepositoryOwner: p.headRepositoryOwner?.login ?? owner, headRepository: p.isCrossRepository ? null : repo,
    }));
  } catch {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'untangle' };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    const list: PullRequest[] = [];
    for (let page = 1; page <= 2; page++) {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`GitHub answered ${response.status} listing ${owner}/${repo}'s pull requests`);
      const rows = await response.json() as Array<{ number: number; title: string; html_url: string; draft: boolean; user?: { login: string }; base: { ref: string; sha: string }; head: { ref: string; sha: string; repo: { name: string; owner: { login: string } } | null } }>;
      list.push(...rows.map((p) => ({
        owner, repo, number: p.number, title: p.title, url: p.html_url, state: 'OPEN', isDraft: p.draft,
        author: p.user?.login ?? null, baseRefName: p.base.ref, baseRefOid: p.base.sha,
        headRefName: p.head.ref, headRefOid: p.head.sha, headRepository: p.head.repo?.name ?? null,
        headRepositoryOwner: p.head.repo?.owner.login ?? null,
        isCrossRepository: !p.head.repo || p.head.repo.owner.login.toLowerCase() !== owner.toLowerCase() || p.head.repo.name.toLowerCase() !== repo.toLowerCase(),
      })));
      if (rows.length < 100) break;
    }
    return list;
  }
}

/** Branch names belong to the base repository; a fork's same-named branch cannot be a lower leg. */
export function stackChain(pr: PullRequest, open: PullRequest[]): PullRequest[] {
  const legs = [pr], seen = new Set([pr.number]);
  let next = pr;
  for (;;) {
    const lower = open.find((p) => !p.isCrossRepository && (!p.headRepositoryOwner || p.headRepositoryOwner.toLowerCase() === pr.owner.toLowerCase()) && p.headRefName === next.baseRefName);
    if (!lower) return legs;
    if (seen.has(lower.number)) throw new Error(`the pull requests' base branches form a cycle at #${lower.number}`);
    seen.add(lower.number);
    legs.push(lower);
    next = lower;
  }
}

/** A squash merged below the stack is still its base until main has been merged into it. */
async function squashedBase(repo: string, list: Merged[], tip: string, head: string, remote: string): Promise<{ number: number; head: string } | null> {
  list.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  for (const p of list) {
    if (!p.headRefOid || !p.mergeCommit?.oid) continue;
    await gitAsync(repo, ['cat-file', '-e', `${p.headRefOid}^{commit}`]).catch(() => fetchTip(repo, remote, `refs/pull/${p.number}/head`, `refs/untangle/pull/${p.number}`)).catch(() => {});
    if (await ancestor(repo, p.headRefOid, head) && !await ancestor(repo, p.headRefOid, tip) && !await ancestor(repo, p.mergeCommit.oid, head)) return { number: p.number, head: p.headRefOid };
  }
  return null;
}

/** Fetches the stack into our refs; existing working copies keep their own commits. */
export async function findStack(repo: string, repoKey: string, pr: PullRequest, head: string, byUrl: boolean, remote: string, topWork: WorkingCopy | null = null, listed?: PullRequest[]): Promise<StackTarget | null> {
  if (pr.state !== 'OPEN') return null;
  const open = listed ?? await openPullRequests(pr.owner, pr.repo);
  const chain = stackChain(pr, open);
  const root = chain[chain.length - 1].baseRefName;
  const merged = await runAsync('gh', ['pr', 'list', '--repo', `${pr.owner}/${pr.repo}`, '--state', 'merged', '--base', root, '--limit', '30', '--json', 'number,headRefOid,mergeCommit,mergedAt'])
    .then((s) => JSON.parse(s) as Merged[], () => []);
  if (chain.length === 1 && !merged.length) return null;
  const tip = await fetchTip(repo, remote, `refs/heads/${root}`, `refs/untangle/base/${root}`)
    .catch(() => gitAsync(repo, ['rev-parse', '--verify', `refs/heads/${root}^{commit}`]).then((s) => s.trim()));
  const squashed = await squashedBase(repo, merged, tip, head, remote);
  if (chain.length === 1 && !squashed) return null;
  const base = { ref: root, sha: squashed?.head ?? (await gitAsync(repo, ['merge-base', tip, head])).trim(), squashed: squashed?.number ?? null };
  const legs: StackLeg[] = [];
  for (const p of chain) {
    const fetched = byUrl && p.number === pr.number ? pr.headRefOid : await fetchTip(repo, remote, `refs/pull/${p.number}/head`, `refs/untangle/pull/${p.number}`);
    let work = p.number === pr.number ? topWork : null;
    if (byUrl && !work && fs.existsSync(workDir(repoKey, p.number))) work = await workingCopy(repo, repoKey, p, () => {});
    if (work && p.number !== pr.number) {
      const tip = await fetchTip(repo, work.remote, `refs/heads/${p.headRefName}`, work.ref).catch(() => null);
      if (tip) await followGitHub(work.dir, tip).catch(() => {});
    }
    const own = p.number === pr.number ? head : work ? (await gitAsync(work.dir, ['rev-parse', 'HEAD'])).trim() : fetched;
    legs.push({ pr: { ...p, headRefOid: fetched }, head: own, base: '', work });
  }
  for (let i = 0; i < legs.length; i++) {
    legs[i].base = (await gitAsync(repo, ['merge-base', legs[i + 1]?.pr.headRefOid ?? tip, legs[i].pr.headRefOid])).trim();
  }
  const above = open.filter((p) => !pr.isCrossRepository && p.baseRefName === pr.headRefName && p.number !== pr.number)
    .map((p) => ({ number: p.number, title: p.title, url: p.url, branch: p.headRefName }));
  return { base, legs, above };
}

/** The shape that needs a rebuild even when the opened branch's head stayed still. */
export const stackIdentity = (stack: StackTarget | null | undefined): string => JSON.stringify(stack ? {
  base: stack.base,
  legs: stack.legs.map((l) => [l.pr.number, l.pr.baseRefName, l.pr.headRefName, l.head]),
} : null);

/** Lower working copies are made only for notes, never in a folder's repository. */
export function legWorkingCopies(target: Target, byUrl: boolean): (number: number) => Promise<WorkingCopy | null> {
  const pending = new Map<number, Promise<WorkingCopy | null>>();
  return (number) => {
    const leg = target.stack?.legs.find((l) => l.pr.number === number);
    if (!byUrl || !leg) return Promise.resolve(null);
    if (leg.work) return Promise.resolve(leg.work);
    let making = pending.get(number);
    if (!making) {
      making = workingCopy(target.repo, target.repoKey, leg.pr, () => {}).then((work) => (leg.work = work));
      pending.set(number, making);
      making.catch(() => pending.delete(number));
    }
    return making;
  };
}
