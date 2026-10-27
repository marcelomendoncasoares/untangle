// A stack's live branches, read in the background like the opened working copy.
import fs from 'node:fs';
import { workDir } from './cache.js';
import { gitAsync } from './exec.js';
import { readLocal, type Local } from './local.js';
import { findStack, stackChain, openPullRequests } from './stack.js';
import { fetchPr, type Target } from './target.js';
import { fetchTip, followGitHub, workingCopy } from './work.js';

export interface LiveStack {
  legs: Array<{ number: number; title: string; url: string; state: string; draft: boolean; github: string; notMergedUp: number; local: Local | null }>;
  above: Array<{ number: number; title: string; url: string; branch: string }>;
  changed: boolean;
}

export class StackChanges {
  value: LiveStack;
  private pageAt = -Infinity;
  private readAt = 0;
  private fetchedAt = 0;
  private reading = false;
  private fetching = false;
  private stopped = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly target: Target, private readonly byUrl: boolean, private readonly held: () => boolean, private readonly top: () => { local: Local | null; head: string | null }) {
    const stack = target.stack!;
    this.value = {
      legs: stack.legs.map(({ pr }) => ({ number: pr.number, title: pr.title, url: pr.url, state: pr.state, draft: !!pr.isDraft, github: pr.headRefOid, notMergedUp: 0, local: null })),
      above: stack.above, changed: false,
    };
    this.timer = setInterval(() => this.check(), 500);
    this.timer.unref();
    this.check();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  check(pageAsked = false): void {
    if (this.stopped) return;
    const now = Date.now(), held = this.held();
    if (pageAsked) this.pageAt = now;
    if (!this.reading && now - this.readAt >= (held || now - this.pageAt < 120_000 ? 2_000 : 30_000)) {
      this.readAt = now;
      this.reading = true;
      void this.read().catch(() => {}).finally(() => { this.reading = false; });
    }
    if ((held || now - this.pageAt < 120_000) && !this.fetching && now - this.fetchedAt >= (held ? 15_000 : 60_000)) {
      this.fetchedAt = now;
      this.fetching = true;
      void this.fetch().catch(() => {}).finally(() => { this.fetching = false; });
    }
  }

  private async read(): Promise<void> {
    const t = this.target, heads: string[] = [], locals: Array<Local | null> = [];
    for (const [i, leg] of t.stack!.legs.entries()) {
      if (!i) {
        heads.push(this.top().head ?? leg.head);
        locals.push(this.top().local);
        continue;
      }
      if (this.byUrl && !leg.work && fs.existsSync(workDir(t.repoKey, leg.pr.number))) leg.work = await workingCopy(t.repo, t.repoKey, leg.pr, () => {});
      if (leg.work) {
        const r = await readLocal(leg.work.dir, { work: leg.work.dir, branch: leg.work.githubBranch, ref: leg.work.ref });
        heads.push(r.head);
        locals.push(r.local);
      } else {
        heads.push(this.value.legs[i].github);
        locals.push(null);
      }
    }
    const counts = await Promise.all(heads.map((head, i) => i ? gitAsync(t.repo, ['rev-list', '--count', `${heads[i - 1]}..${head}`]).then((s) => Number(s.trim())) : 0));
    if (this.stopped) return;
    this.value = { ...this.value, legs: this.value.legs.map((l, i) => ({ ...l, local: locals[i], notMergedUp: counts[i] })) };
  }

  private async fetch(): Promise<void> {
    const t = this.target, stack = t.stack!, pr = t.pr!;
    const open = await openPullRequests(pr.owner, pr.repo);
    const top = open.find((p) => p.number === pr.number) ?? await fetchPr(pr.owner, pr.repo, pr.number);
    let chain;
    try {
      chain = top.state === 'OPEN' ? stackChain(top, open) : [];
    } catch (e) {
      if (!this.stopped) this.value = { ...this.value, changed: true };
      throw e;
    }
    const structural = chain.length !== stack.legs.length || chain.some((p, i) => p.number !== stack.legs[i]?.pr.number || p.baseRefName !== stack.legs[i].pr.baseRefName || p.headRefName !== stack.legs[i].pr.headRefName);
    const legs: LiveStack['legs'] = [];
    const remote = this.byUrl ? 'origin' : `https://github.com/${pr.owner}/${pr.repo}.git`;
    for (const [i, leg] of stack.legs.entries()) {
      const p = open.find((p) => p.number === leg.pr.number) ?? await fetchPr(pr.owner, pr.repo, leg.pr.number);
      const github = await fetchTip(t.repo, remote, `refs/pull/${p.number}/head`, `refs/untangle/pull/${p.number}`);
      if (leg.work && p.state === 'OPEN') {
        const tip = await fetchTip(t.repo, leg.work.remote, `refs/heads/${p.headRefName}`, leg.work.ref).catch(() => null);
        if (tip && !this.stopped) await followGitHub(leg.work, tip, p).catch(() => {});
      }
      legs.push({ ...this.value.legs[i], number: p.number, title: p.title, url: p.url, state: p.state, draft: !!p.isDraft, github });
    }
    // M9 also changes when main reaches the opened branch, with no retargeting on GitHub.
    const fresh = structural ? null : await findStack(t.repo, t.repoKey, top, this.top().head ?? t.headSha, this.byUrl, remote, t.work ?? null, open);
    const changed = structural || !fresh || JSON.stringify(fresh.base) !== JSON.stringify(stack.base);
    if (this.stopped) return;
    this.value = {
      legs, changed,
      above: open.filter((p) => !top.isCrossRepository && p.number !== top.number && p.baseRefName === top.headRefName).map((p) => ({ number: p.number, title: p.title, url: p.url, branch: p.headRefName })),
    };
    this.readAt = 0;
    this.check();
  }
}
