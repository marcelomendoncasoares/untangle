// What the branch has that GitHub doesn't. Local reads and network reads run independently in
// the background: an unreachable remote must not hold up either the page or the dirty flag.
import crypto from 'node:crypto';
import { gitAsync } from './exec.js';
import { fetchPr, githubRepo, latestHead, type Target } from './target.js';
import { fetchTip, followGitHub, githubUrl } from './work.js';
import { StackChanges, type LiveStack } from './stack-live.js';

export interface LocalSource {
  work: string | null;
  branch: string | null;
  ref: string | null;
}

export interface Local extends Omit<LocalSource, 'ref'> {
  github: string | null;
  unpushed: string[] | null;
  behind: number;
  dirty: boolean;
}

export type LocalSummary = Omit<Local, 'github' | 'unpushed'> & { unpushed: number | null };
export const localSummary = (s: Local | null): LocalSummary | null => s && ({ work: s.work, branch: s.branch, unpushed: s.unpushed?.length ?? null, behind: s.behind, dirty: s.dirty });

const maybe = (dir: string, args: string[]) => gitAsync(dir, args).then((s) => s.trim(), () => null);

/** Read only, with no network: used by both running and paused reviews, and before freeing work. */
export async function readLocal(dir: string, source: LocalSource): Promise<{ head: string; local: Local }> {
  const head = (await gitAsync(dir, ['rev-parse', 'HEAD'])).trim();
  const dirty = !!(await gitAsync(dir, ['--no-optional-locks', 'status', '--porcelain'])).trim();
  const github = source.ref ? await maybe(dir, ['rev-parse', '--verify', `${source.ref}^{commit}`]) : null;
  const unpushed = github ? (await gitAsync(dir, ['rev-list', `${github}..${head}`])).trim().split('\n').filter(Boolean) : null;
  const behind = github ? Number((await gitAsync(dir, ['rev-list', '--count', `${head}..${github}`])).trim()) : 0;
  return { head, local: { work: source.work, branch: source.branch, github, unpushed, behind, dirty } };
}

/** The folder's upstream, only when it is on GitHub. Reading it never fetches or changes refs. */
async function folderSource(dir: string): Promise<{ source: LocalSource; remote: string | null; from: string | null }> {
  const branch = await maybe(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const remote = branch ? await maybe(dir, ['config', `branch.${branch}.remote`]) : null;
  const from = branch ? await maybe(dir, ['config', `branch.${branch}.merge`]) : null;
  const url = remote && remote !== '.' ? await maybe(dir, ['config', `remote.${remote}.url`]) : null;
  const hosted = !!url && !!githubRepo(url);
  const ref = hosted && from ? `refs/untangle/github/${crypto.createHash('sha256').update(`${remote}:${from}`).digest('hex').slice(0, 16)}` : null;
  return { source: { work: null, branch, ref }, remote: hosted ? remote : null, from };
}

/** A record's local state, as last fetched. Old records can still report a folder's dirty flag. */
export async function recordedLocal(r: { dir: string | null; local?: LocalSource | null }): Promise<Local | null> {
  const dir = r.local?.work ?? r.dir;
  if (!dir) return null;
  try {
    const source = r.local ?? (await folderSource(dir)).source;
    return (await readLocal(dir, source)).local;
  } catch {
    return null;
  }
}

export class LocalChanges {
  private readonly stacks: StackChanges | null;
  get stack(): LiveStack | null {
    return this.stacks ? { ...this.stacks.value, legs: this.stacks.value.legs.map((l, i) => i ? l : { ...l, local: this.local }) } : null;
  }
  local: Local | null = null;
  source: LocalSource | null = null;
  latest: string | null = null;
  private localAt = 0;
  private githubAt = 0;
  private pageAt = -Infinity;
  private pageReadAt = -Infinity;
  private pageReadStarted = false;
  private pageRead: Promise<void> | null = null;
  private reading: Promise<void> | null = null;
  private fetching = false;
  private stopped = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly target: Target, private readonly byUrl: boolean, private readonly held: () => boolean, private readonly changed: () => void) {
    if (target.work) this.source = { work: target.work.dir, branch: target.work.githubBranch, ref: target.work.ref };
    this.latest = target.headSha;
    this.stacks = target.stack ? new StackChanges(target, byUrl, held, () => ({ local: this.local, head: this.latest })) : null;
    this.timer = setInterval(() => this.check(), 500);
    this.timer.unref();
    this.check();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.stacks?.stop();
  }

  /** A page gets a read started after its ask, shared with other asks for two seconds. */
  async check(pageAsked = false): Promise<void> {
    if (this.stopped) return;
    this.stacks?.check(pageAsked);
    const now = Date.now(), held = this.held();
    let pageRead: Promise<void> | null = null;

    if (pageAsked) {
      this.pageAt = now;
      // A queued page read can serve a later ask too: it has not started before either ask.
      if (!this.pageRead || (this.pageReadStarted && now - this.pageReadAt >= 2_000)) {
        this.pageReadAt = now;
        this.pageReadStarted = false;
        this.pageRead = this.queueRead(() => { this.pageReadStarted = true; });
      }
      pageRead = this.pageRead;
    } else if (!this.reading && now - this.localAt >= (held ? 2_000 : 30_000)) {
      this.queueRead();
    }

    if ((held || now - this.pageAt < 120_000) && !this.fetching && now - this.githubAt >= (held ? 15_000 : 60_000)) {
      this.githubAt = now;
      this.fetching = true;
      void this.fetch().catch(() => {}).finally(() => { this.fetching = false; });
    }

    if (pageRead) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          pageRead,
          new Promise<void>((resolve) => { timeout = setTimeout(resolve, 2_000); }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  /** Serialize local reads so an older background result cannot replace a page's newer one. */
  private queueRead(started: () => void = () => {}): Promise<void> {
    const previous = this.reading;
    const next = Promise.resolve(previous).then(async () => {
      if (this.stopped) return;
      started();
      this.localAt = Date.now();
      await this.read();
    }).catch(() => {}).finally(() => {
      if (this.reading === next) this.reading = null;
    });
    this.reading = next;
    return next;
  }

  private async read(): Promise<void> {
    if (this.byUrl && !this.target.work) return;
    const dir = this.target.work?.dir ?? this.target.repo;
    this.source ??= (await folderSource(dir)).source;
    const r = await readLocal(dir, this.source);
    if (this.stopped) return;
    this.local = r.local;
    this.latest = r.head;
    this.changed();
  }

  private async fetch(): Promise<void> {
    const t = this.target;
    if (this.byUrl && !t.work) {
      const head = await latestHead(t, true);
      if (!this.stopped) this.latest = head;
      return;
    }
    let source: LocalSource;
    if (t.work && t.pr) {
      const pr = await fetchPr(t.pr.owner, t.pr.repo, t.pr.number);
      if (this.stopped) return;
      const github = await fetchTip(t.repo, t.work.remote, `refs/heads/${pr.headRefName}`, t.work.ref);
      if (this.stopped) return;
      await followGitHub(t.work.dir, github).catch(() => {});
      source = { work: t.work.dir, branch: t.work.githubBranch, ref: t.work.ref };
    } else if (t.pr) {
      const pr = await fetchPr(t.pr.owner, t.pr.repo, t.pr.number);
      const ref = `refs/untangle/github/pr-${pr.number}`;
      await fetchTip(t.repo, await githubUrl(pr.owner, pr.repo), `refs/pull/${pr.number}/head`, ref);
      source = { work: null, branch: (await folderSource(t.repo)).source.branch, ref };
    } else {
      const folder = await folderSource(t.repo);
      source = folder.source;
      if (folder.remote && folder.from && source.ref) {
        await fetchTip(t.repo, folder.remote, folder.from, source.ref);
      }
    }
    if (this.stopped) return;
    await this.queueRead(() => { this.source = source; });
  }
}
