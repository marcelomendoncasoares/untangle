// untangle reviews' page: a small process of its own serves it. It reads the reviews' records and,
// while the page is open, asks each running review how it's doing. Reviews stay their own
// processes: the manager only reads them, and does what the page asks with them.
import fs from 'node:fs';
import path from 'node:path';
import '../viewer/core.js';
import { agentCommand, agentOptions, flagsOf, rememberStart, resumeCommand, startedHere, type AgentChoice } from './agents.js';
import { cacheRoot, cloneDir } from './cache.js';
import { call, failed, Gone } from './client.js';
import { has, runAsync } from './exec.js';
import { launch, logTail } from './launcher.js';
import { Narrator } from './narrate.js';
import { openPage } from './open.js';
import { newTerminal, orca, orcaCli, reviewsWorkspace, showTab, showTerminal } from './orca.js';
import { fonts, managerPage } from './page.js';
import { dirSizeAsync, listRecords, readRecord, recordDirs, recordFile, writeRecord, type Listed } from './records.js';
import { shortName, summaries, titleOf, type Summary } from './reviews.js';
import { findRun, listRuns, pidAlive, prKey, runDir, wantedDir, type RunInfo, type Wanted } from './runs.js';
import { ReviewServer } from './server.js';
import { isPrUrl } from './target.js';
import { chatTail } from './transcripts.js';
import { VERSION } from './version.js';

/** The manager's address, unless something else has it. */
export const MANAGER_PORT = 7777;
// With no page open and nothing asked of it for this long, the manager stops.
const IDLE_AFTER = 15 * 60_000;
// A folder's size is measured again after this long.
const SIZE_AGAIN = 10 * 60_000;

/** How untangle's commands reach the manager: its process, link and token. */
export interface ManagerRun { pid: number; url: string; token: string; started: string }

export const managerFile = () => path.join(runDir(), 'manager.json');

function readManager(): ManagerRun | null {
  try {
    return JSON.parse(fs.readFileSync(managerFile(), 'utf8')) as ManagerRun;
  } catch {
    return null;
  }
}

/** The manager running now, when it answers. */
export async function findManager(): Promise<ManagerRun | null> {
  const m = readManager();
  if (!m || !pidAlive(m.pid)) return null;
  try {
    return (await call(m, 'GET', 'hello', { timeout: 3000 })).status === 200 ? m : null;
  } catch {
    return null;
  }
}

/** The manager running now, or one started for this: its page opened, with the palette when asked. */
export async function openManager(o: { palette: boolean }): Promise<{ where: 'orca' | 'browser' | null; url: string }> {
  const m = (await findManager()) ?? (await startManager(null));
  const p = await openPage(m.url + (o.palette ? '#new' : ''));
  return { where: p?.where ?? null, url: m.url };
}

/** Starts the manager in the background, and waits until it answers. */
export async function startManager(port: number | null): Promise<ManagerRun> {
  const { pid, log } = launch(['reviews', '-serve', ...(port != null ? ['-port', String(port)] : [])]);
  for (let i = 0; pid > 0 && i < 150; i++) {
    const m = readManager();
    if (m && m.pid === pid) return m;
    if (!pidAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the manager didn’t start${logTail(log) ? ':\n' + logTail(log) : ''}`);
}

// ---- What the page shows

/** A pull request's title with its conventional type apart: feat, fix, refactor(cli)… */
export function kindOf(title: string): { kind: string | null; title: string } {
  const m = /^([a-z]+)(?:\([^)]*\))?!?: (.+)$/.exec(title);
  return m ? { kind: m[1], title: m[2] } : { kind: null, title };
}

/** A review as the page lists it. */
export interface Row {
  id: string;
  /** What starts it again: the pull request's link, or the directory. */
  target: string;
  name: string;
  title: string;
  kind: string | null;
  repo: string;
  author: string | null;
  url: string | null;
  size: { add: number; del: number; files: number };
  status: Listed['status'];
  stopped: Listed['stopped'];
  closed: string | null;
  opened: string;
  head: string;
  progress: { done: number; total: number };
  notes: { open: number; waiting: number };
  waiting: Summary['waiting'];
  agents: Array<{ name: string; kind: string | null; state: string; on: number[]; label: string }>;
  /** The latest chat that held it: the one Resume brings back. */
  chat: { agent: string; kind: 'claude' | 'codex'; id: string; orca: boolean } | null;
  memory: Summary['memory'] | null;
  /** While it's being built: the step it's on, of the steps it expects. */
  build: { phase: string; step: { label: string; count: [number, number] | null } | null; plan: string[] | null; error: string | null } | null;
  pages: number;
  /** Pausing once its agent's turn ends. */
  pausing: boolean;
  /** Merged or closed on GitHub, when it was. */
  github: { state: 'merged' | 'closed'; at: string } | null;
  /** What waits for you, in words: Claude answered N3 and N4. And the first note it's about. */
  need: string | null;
  needAt: number | null;
  /** When it was last in use: a page in front, its notes changing, an agent at work. */
  active: number | null;
  /** What it holds on disk, in bytes, once measured. */
  disk: number | null;
}

const idOf = (r: Listed) => `${r.repoKey}/${r.key}`;

/** A review that's starting: its process runs, and it has no record until it's built. */
function starting(run: RunInfo, s: Summary | undefined): Row {
  const m = run.pr ? /^([^/]+)\/([^#]+)#(\d+)$/.exec(run.pr) : null;
  const { kind, title } = kindOf((s?.title || run.title || '').replace(/^#\d+ /, '') || (m ? `#${m[3]}` : 'Starting'));
  return {
    id: `run:${run.pid}`,
    target: run.pr && m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : run.dir || '',
    name: m ? `${m[2]}#${m[3]}` : (run.dir || '').split(/[\\/]/).pop() || 'review',
    title, kind,
    repo: m ? `${m[1]}/${m[2]}` : (run.repoKey || '').replace(/^github\.com\//, ''),
    author: null, url: null, size: { add: 0, del: 0, files: 0 },
    status: 'running', stopped: null, closed: null, opened: run.started, head: run.head || '',
    progress: { done: 0, total: 0 }, notes: { open: 0, waiting: 0 }, waiting: [], agents: [], chat: null,
    memory: s?.memory ?? null,
    build: { phase: s?.phase ?? 'starting', step: s?.step ? { label: s.step.label, count: s.step.count ?? null } : null, plan: s?.plan ?? null, error: s?.error ?? null },
    pages: s?.pages ?? 0, pausing: false, github: null, need: null, needAt: null, active: s?.active ?? null, disk: null,
  };
}

/** What a review's target stands for, to find it running: a pull request, or a directory's repository and branch. */
function wanted(target: string): Wanted | null {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)/.exec(target);
  if (m) return { pr: prKey(m[1], m[2], Number(m[3])), dir: null, repoKey: `github.com/${m[1]}/${m[2]}`, branch: null };
  return fs.existsSync(target) ? wantedDir(target) : null;
}

/** What New review sent for the agent, checked: which, a chat to resume or a new one, flags, a first message. */
function agentFrom(x: unknown): AgentChoice | null {
  const a = (x && typeof x === 'object' ? x : null) as { kind?: unknown; resume?: unknown; session?: unknown; flags?: unknown; message?: unknown } | null;
  if (!a || (a.kind !== 'claude' && a.kind !== 'codex')) return null;
  const resume = typeof a.resume === 'string' && /^[\w-]{1,100}$/.test(a.resume) ? a.resume : null;
  const session = typeof a.session === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a.session) ? a.session : null;
  return { kind: a.kind, resume, session, flags: typeof a.flags === 'string' ? a.flags.slice(0, 400) : '', message: typeof a.message === 'string' ? a.message.slice(0, 8000) : '' };
}

/** A review's short name for a terminal's title: #5879, or the repository's for a branch. */
function nameOf(target: string): string {
  const m = /github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)/.exec(target);
  return m ? `${m[1]}#${m[2]}` : path.basename(target);
}

/** A pull request the palette offers: its repository, number, title and author, and when it last moved. */
export interface Pull { repo: string; number: number; title: string; author: string; url: string; updated: string; draft: boolean }

/** What waits for you, in words: Claude answered N3 and N4, Codex wrote N5. */
function need(waiting: Summary['waiting']): string | null {
  const by = new Map<string, number[]>();
  for (const w of waiting) {
    const k = `${w.by}\n${w.wrote ? 'wrote' : 'answered'}`;
    by.set(k, [...(by.get(k) || []), w.n]);
  }
  return [...by].map(([k, ns]) => `${k.replace('\n', ' ')} ${globalThis.ReviewCore.nList(ns)}`).join(', ') || null;
}

function row(r: Listed, s: Summary | undefined, disk: number | null): Row {
  const { kind, title } = kindOf(titleOf(r));
  const c = r.chats[0];
  const waiting = s?.waiting ?? [];
  return {
    id: idOf(r),
    target: r.target,
    name: shortName(r),
    title,
    kind,
    repo: r.repoKey.replace(/^github\.com\//, '').replace(/^local\/(.+)-[0-9a-f]{8}$/, '$1'),
    author: r.author,
    url: r.url,
    size: r.size,
    status: r.status,
    stopped: r.stopped,
    closed: r.closed,
    opened: r.opened,
    head: s?.head ?? r.head,
    progress: s?.progress ?? r.progress,
    notes: s?.notes ?? r.notes,
    waiting,
    agents: (s?.agents ?? []).map((a) => ({ name: a.name, kind: a.kind, state: a.state, on: a.on, label: globalThis.ReviewCore.agentLabel(a) })),
    // Pause closes the terminals of the chats the manager started.
    chat: c ? { agent: c.agent, kind: c.kind, id: c.id, orca: !!c.orca && (r.status === 'running' || !startedHere(c)) } : null,
    memory: s?.memory ?? null,
    build: s && s.phase !== 'ready' ? { phase: s.phase, step: s.step ? { label: s.step.label, count: s.step.count ?? null } : null, plan: s.plan, error: s.error } : null,
    pages: s?.pages ?? 0,
    pausing: false,
    github: r.github ?? null,
    need: need(waiting),
    needAt: waiting.length ? Math.min(...waiting.map((w) => w.n)) : null,
    active: s?.active ?? null,
    disk,
  };
}

/** Sizes of folders on disk, measured one at a time in the background and kept a while. */
class Sizes {
  private readonly known = new Map<string, { bytes: number; at: number }>();
  private readonly queue: string[] = [];
  private running = false;

  /** The folder's size, or null while it's measured: asking queues it. */
  of(dir: string): number | null {
    const k = this.known.get(dir);
    if (!k || Date.now() - k.at > SIZE_AGAIN) this.want(dir);
    return k ? k.bytes : null;
  }

  get busy(): boolean {
    return this.running || this.queue.length > 0;
  }

  private want(dir: string) {
    if (this.queue.includes(dir)) return;
    this.queue.push(dir);
    if (!this.running) void this.drain();
  }

  private async drain() {
    this.running = true;
    for (let dir = this.queue.shift(); dir; dir = this.queue.shift()) this.known.set(dir, { bytes: await dirSizeAsync(dir), at: Date.now() });
    this.running = false;
  }
}

/** The manager: what the page asks of it. */
/** The summary of each of these running reviews, by process. */
async function summariesOf(runs: RunInfo[]): Promise<Map<number, Summary>> {
  const out = new Map<number, Summary>();
  await Promise.all(runs.map(async (run) => {
    try {
      const a = await call(run, 'GET', 'summary', { timeout: 5000 });
      if (a.status === 200) out.set(run.pid, a.data as unknown as Summary);
    } catch {
      // Stopping as we asked.
    }
  }));
  return out;
}

export class Manager {
  private readonly sizes = new Sizes();
  // Reviews pausing once their agent's turn ends: Pause waits for it, Pause now doesn't.
  private readonly pausing = new Set<string>();
  private pauseTimer: NodeJS.Timeout | null = null;
  // GitHub, asked about paused reviews' pull requests: when the page opens, then hourly.
  private githubAt = 0;
  // Reviews started again from their row, by process: their row shows them starting.
  private readonly launched = new Map<number, string>();
  // GitHub's pull requests for the palette, asked at most once a minute.
  private pullsKept: { at: number; value: { asked: Pull[]; yours: Pull[]; error: string | null } } | null = null;

  /** The pull requests GitHub asks you to review, and your own, through gh. */
  async pulls(): Promise<{ asked: Pull[]; yours: Pull[]; error: string | null }> {
    if (this.pullsKept && Date.now() - this.pullsKept.at < 60_000) return this.pullsKept.value;
    if (!has('gh')) return { asked: [], yours: [], error: 'gh isn’t installed: paste a pull request’s link' };
    type Found = { number: number; title: string; url: string; updatedAt: string; isDraft: boolean; repository: { nameWithOwner: string }; author: { login: string } };
    const search = async (who: string): Promise<Pull[]> => {
      const out = await runAsync('gh', ['search', 'prs', who, '--state=open', '--sort=updated', '--limit', '30', '--json', 'number,title,url,updatedAt,isDraft,repository,author'], { timeout: 30_000 });
      return (JSON.parse(out) as Found[]).map((p) => ({ repo: p.repository.nameWithOwner, number: p.number, title: p.title, author: p.author.login, url: p.url, updated: p.updatedAt, draft: p.isDraft }));
    };
    let value: { asked: Pull[]; yours: Pull[]; error: string | null };
    try {
      const [asked, yours] = await Promise.all([search('--review-requested=@me'), search('--author=@me')]);
      value = { asked, yours, error: null };
    } catch (e) {
      value = { asked: [], yours: [], error: `gh couldn’t search GitHub: ${(e as Error).message.split('\n').pop()}` };
    }
    this.pullsKept = { at: Date.now(), value };
    return value;
  }

  /**
   * Starts a review of a pull request's link or a directory, through the launcher, so it's no one's
   * child; it opens its own page. It runs until it's paused or closed, its tab or not. A review of
   * it already running isn't started again.
   */
  async start(target: string, agent: AgentChoice | null = null, id: string | null = null): Promise<{ status?: number; data: unknown }> {
    if (!isPrUrl(target) && !(path.isAbsolute(target) && fs.existsSync(target))) return { status: 400, data: { error: `${target} is not a pull request’s link` } };
    const w = wanted(target);
    let running = w && findRun(w);
    // One that's stopping (paused or closed a moment ago) is let go first.
    if (running && listRecords().some((r) => r.pid === running!.pid && r.stopped)) {
      for (let i = 0; i < 100 && pidAlive(running.pid); i++) await new Promise((r) => setTimeout(r, 50));
      running = w && findRun(w);
    }
    if (running) return { data: { already: true, pid: running.pid } };
    // In Orca, its page opens as a tab of the Reviews workspace, and its chat runs there.
    const cli = orcaCli();
    const ws = cli ? await reviewsWorkspace(cacheRoot(), cli) : null;
    const env = ws && cli ? { ...process.env, ORCA_CLI_COMMAND: cli, ORCA_WORKTREE_ID: ws.worktree } : process.env;
    const { pid, log } = launch(['-autoclose=false', '--', target], env);
    if (id && pid > 0) this.launched.set(pid, id);
    for (let i = 0; pid > 0 && i < 300; i++) {
      if (listRuns().some((r) => r.pid === pid)) return { data: { started: true, pid, ...(agent ? await this.chat(target, agent, ws) : {}) } };
      if (!pidAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { status: 502, data: { error: `the review didn’t start${logTail(log) ? ': ' + logTail(log).split('\n').pop() : ''}` } };
  }

  /**
   * Starts an agent's chat for a review: in a terminal of the Reviews workspace, in Orca, with the
   * untangle skill. Without Orca, the command, for you to run in a terminal.
   */
  async chat(target: string, agent: AgentChoice, ws?: { worktree: string } | null): Promise<{ chat: { id: string | null; handle: string | null }; command: string | null }> {
    const name = nameOf(target);
    const { command, id } = agentCommand(agent, target, name);
    const cli = orcaCli();
    const space = ws === undefined ? (cli ? await reviewsWorkspace(cacheRoot(), cli) : null) : ws;
    const handle = space ? await newTerminal(space.worktree, `${name.replace(/^[^#]*#/, '#')} · ${agent.kind === 'claude' ? 'Claude' : 'Codex'}`, command, cli) : null;
    rememberStart(agent, { id, handle });
    return { chat: { id, handle }, command: handle ? null : command };
  }

  /** Whether the manager has something to finish: a pause waiting for a turn to end. */
  get busy(): boolean {
    return this.pausing.size > 0;
  }

  /**
   * Pauses a review: it stops, its tab closes, and so does its chat's terminal when the manager
   * started it; the chat, its notes and marks stay, to resume. While its agent is in a turn, it
   * pauses once the turn ends, unless now.
   */
  async pause(f: { record: Listed; run: RunInfo | null }, now: boolean): Promise<{ status?: number; data: unknown }> {
    if (!f.run) return { status: 409, data: { error: `${shortName(f.record)} isn’t running` } };
    if (!now) {
      const s = (await summariesOf([f.run])).get(f.run.pid);
      if (s && s.agents.some((a) => a.state === 'working')) {
        this.pausing.add(idOf(f.record));
        this.pauseTimer ??= setInterval(() => void this.pauseWhenIdle(), 2000);
        return { data: { waiting: true } };
      }
    }
    await this.pauseNow(f.record, f.run);
    return { data: { paused: true } };
  }

  private async pauseWhenIdle() {
    for (const id of [...this.pausing]) {
      const f = this.find(id);
      if (!f || !f.run) { this.pausing.delete(id); continue; }
      const s = (await summariesOf([f.run])).get(f.run.pid);
      if (!s || !s.agents.some((a) => a.state === 'working')) await this.pauseNow(f.record, f.run);
    }
    if (!this.pausing.size && this.pauseTimer) { clearInterval(this.pauseTimer); this.pauseTimer = null; }
  }

  private async pauseNow(record: Listed, run: RunInfo) {
    const id = idOf(record);
    this.pausing.delete(id);
    try {
      await call(run, 'POST', 'stop', { body: { why: 'paused' } });
    } catch (e) {
      if (!(e instanceof Gone)) throw e;
    }
    const cli = orcaCli();
    if (!cli) return;
    for (const page of [run.page, this.pages.get(run.pid)]) if (page) await orca(['tab', 'close', '--page', page], cli);
    this.pages.delete(run.pid);
    const c = record.chats[0];
    if (c?.orca && startedHere(c)) await orca(['terminal', 'close', '--terminal', c.orca.handle, '--tab'], cli);
  }

  /**
   * Resumes a paused review: it starts again, from the cache, and so does the chat that held it,
   * told the review is back. A chat the manager started comes back in a new terminal of the
   * Reviews workspace, in its own folder; one you started yourself, still open, gets the line in
   * its terminal. Without the agent, only the review.
   */
  async resume(f: { record: Listed; run: RunInfo | null }, withAgent: boolean): Promise<{ status?: number; data: unknown }> {
    const started = await this.start(f.record.target, null, idOf(f.record));
    if (started.status || !withAgent || (started.data as { already?: boolean }).already) return started;
    const c = f.record.chats[0];
    if (!c) return started;
    const line = `untangle: the review of ${shortName(f.record)} is open again. Run untangle watch to hold it.`;
    const cli = orcaCli();
    if (cli && c.orca && !startedHere(c) && (await orca(['terminal', 'send', '--terminal', c.orca.handle, '--text', line, '--enter'], cli)).ok) return { data: { ...(started.data as object), told: true } };
    const ws = cli ? await reviewsWorkspace(cacheRoot(), cli) : null;
    const command = resumeCommand(c, line, flagsOf(c.kind), ws ? ws.folder : '');
    const handle = ws ? await newTerminal(ws.worktree, `${shortName(f.record).replace(/^[^#]*#/, '#')} · ${c.agent}`, command, cli) : null;
    rememberStart({ kind: c.kind, resume: c.id, flags: flagsOf(c.kind), message: '' }, { id: c.id, handle });
    return { data: { ...(started.data as object), chat: { id: c.id, handle }, command: handle ? null : command } };
  }

  /** Paused reviews whose pull request merged or closed on GitHub are closed too. */
  private async github() {
    if (Date.now() - this.githubAt < 3600_000 || !has('gh')) return;
    this.githubAt = Date.now();
    for (const r of listRecords().filter((x) => x.status === 'paused' && x.pr)) {
      const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(r.pr!);
      if (!m) continue;
      try {
        const j = JSON.parse(await runAsync('gh', ['pr', 'view', m[3], '--repo', `${m[1]}/${m[2]}`, '--json', 'state,mergedAt,closedAt'], { timeout: 20_000 })) as { state?: string; mergedAt?: string | null; closedAt?: string | null };
        if (j.state !== 'MERGED' && j.state !== 'CLOSED') continue;
        const file = recordFile(r.repoKey, r.key);
        const now = readRecord(file);
        // Started again since: it isn't paused any more.
        if (!now || now.pid !== r.pid || !now.stopped) continue;
        const at = (j.state === 'MERGED' ? j.mergedAt : j.closedAt) || new Date().toISOString();
        writeRecord({ ...now, closed: at, github: { state: j.state === 'MERGED' ? 'merged' : 'closed', at }, updated: new Date().toISOString() });
      } catch {
        // GitHub didn't answer: next time.
      }
    }
  }

  /** Closes a review: a running one stops, saying it's closed; a paused one's record says so. */
  async close(f: { record: Listed | null; run: RunInfo | null }): Promise<{ status?: number; data: unknown }> {
    if (f.run) {
      try {
        const r = await call(f.run, 'POST', 'stop', { body: { close: true } });
        const err = failed(r);
        if (err) return { status: r.status, data: { error: err } };
      } catch (e) {
        if (!(e instanceof Gone)) throw e;
      }
      // It says so in its record, unless it was being built again: the old record does then.
      if (!f.record || f.record.pid === f.run.pid) return { data: { closed: true } };
    }
    if (!f.record) return { status: 404, data: { error: 'no such review' } };
    const file = recordFile(f.record.repoKey, f.record.key);
    const r = readRecord(file);
    if (!r) return { status: 404, data: { error: 'no such review' } };
    // Built and closed by its new process meanwhile.
    if (r.pid !== f.record.pid) return { data: { closed: true } };
    const at = new Date().toISOString();
    writeRecord({ ...r, closed: at, stopped: r.stopped ?? { at, why: 'stop' }, updated: at });
    return { data: { closed: true } };
  }
  // The tabs the manager opened for reviews whose own tab it couldn't bring back, by process.
  private readonly pages = new Map<number, string>();

  /** Brings a review's page to the front: its own tab, the one the manager opened for it, or a new one. */
  private async show(run: RunInfo): Promise<{ status?: number; data: unknown }> {
    for (const page of [run.page, this.pages.get(run.pid)]) if (page && (await showTab(page))) return { data: { where: 'orca' } };
    const p = await openPage(run.url);
    if (p?.page) this.pages.set(run.pid, p.page);
    return p ? { data: { where: p.where } } : { status: 502, data: { error: 'no browser to open it in' } };
  }

  /** The reviews, as the page shows them, with memory and disk (a review's Reviews menu skips disk). */
  async view(o: { disk: boolean } = { disk: true }) {
    const list = listRecords();
    const live = await summaries(list);
    const sizeOf = (dirs: string[]) => {
      if (!o.disk) return null;
      const known = dirs.map((d) => this.sizes.of(d));
      return known.some((b) => b == null) ? null : known.reduce((a: number, b) => a + b!, 0);
    };
    void this.github();
    const rows = list.map((r) => row(r, r.pid != null ? live.get(r.pid) : undefined, sizeOf(recordDirs(r))));
    rows.forEach((x) => { x.pausing = this.pausing.has(x.id); });
    // Reviews whose process runs and which have no record yet: they're being built.
    const recorded = new Set(list.filter((r) => r.status === 'running').map((r) => r.pid));
    const runs = listRuns();
    for (const pid of this.launched.keys()) if (recorded.has(pid) || !runs.some((run) => run.pid === pid)) this.launched.delete(pid);
    const fresh = runs.filter((run) => !recorded.has(run.pid));
    if (fresh.length) {
      const asked = await summariesOf(fresh);
      for (const run of fresh) {
        const s = starting(run, asked.get(run.pid));
        // A paused or closed review starting again keeps its row: what it knows, and how far the build is.
        const at = rows.findIndex((x) => x.status !== 'running' && (x.id === this.launched.get(run.pid) || (!!run.pr && list.find((r) => idOf(r) === x.id)?.pr === run.pr)));
        if (at < 0) rows.unshift(s);
        else rows[at] = { ...rows[at], status: 'running', stopped: null, closed: null, github: null, opened: s.opened, memory: s.memory, build: s.build, pages: s.pages, active: s.active, agents: [], waiting: [], need: null, needAt: null };
      }
    }
    // Disk, each folder once: open reviews' folders, closed ones' that no open review uses, and clones.
    const openDirs = new Set(list.filter((r) => r.status !== 'closed').flatMap(recordDirs));
    const closedDirs = new Set(list.filter((r) => r.status === 'closed').flatMap(recordDirs).filter((d) => !openDirs.has(d)));
    const clones = new Set(list.filter((r) => r.repo === cloneDir(r.repoKey)).map((r) => r.repo));
    const total = (dirs: Set<string>) => (o.disk ? [...dirs].reduce((a, d) => a + (this.sizes.of(d) ?? 0), 0) : 0);
    return {
      version: VERSION,
      reviews: rows,
      memory: { manager: process.memoryUsage().rss },
      disk: { open: total(openDirs), closed: total(closedDirs), clones: total(clones), measuring: this.sizes.busy },
      orca: !!orcaCli(),
    };
  }

  /** A review by its row's id: its record, and its process when it runs, or when it's being built again. */
  private find(id: unknown): { record: Listed; run: RunInfo | null } | null {
    const record = listRecords().find((r) => idOf(r) === id);
    if (!record) return null;
    const runs = listRuns();
    if (record.status === 'running') return { record, run: runs.find((x) => x.pid === record.pid) ?? null };
    return { record, run: runs.find((x) => this.launched.get(x.pid) === id || (!!x.pr && x.pr === record.pr)) ?? null };
  }

  /** The page's API. */
  async call(route: string, method: string, query: URLSearchParams, body: unknown): Promise<{ status?: number; data: unknown }> {
    const b = (body && typeof body === 'object' ? body : {}) as { id?: unknown };
    if (route === 'hello' && method === 'GET') return { data: { version: VERSION, pid: process.pid } };
    if (route === 'reviews' && method === 'GET') return { data: await this.view() };
    if (route === 'pulls' && method === 'GET') return { data: await this.pulls() };
    if (route === 'agents' && method === 'GET') return { data: { ...agentOptions(), orca: !!orcaCli() } };
    if (route === 'start' && method === 'POST' && typeof (b as { target?: unknown }).target === 'string') return this.start((b as { target: string }).target.trim(), agentFrom((b as { agent?: unknown }).agent));
    if (route === 'tail' && method === 'GET') {
      const f = this.find(query.get('id'));
      const c = f?.record.chats[0];
      return { data: { lines: c ? chatTail(c) : null } };
    }
    // A review being built, with no record yet: its process, to open or to close.
    const building = typeof b.id === 'string' ? /^run:(\d+)$/.exec(b.id) : null;
    if (building) {
      const run = listRuns().find((x) => x.pid === Number(building[1]));
      if (!run) return { status: 404, data: { error: 'the review stopped' } };
      if (route === 'open' && method === 'POST') return this.show(run);
      if (route === 'close' && method === 'POST') return this.close({ record: null, run });
      return { status: 409, data: { error: 'the review is being built' } };
    }
    const f = this.find(b.id);
    if (!f) return { status: 404, data: { error: 'no such review' } };
    if (route === 'open' && method === 'POST') return f.run ? this.show(f.run) : { status: 409, data: { error: `${shortName(f.record)} isn’t running` } };
    if (route === 'start' && method === 'POST') return this.start(f.record.target, agentFrom((b as { agent?: unknown }).agent), idOf(f.record));
    if (route === 'agent' && method === 'POST') {
      const agent = agentFrom((b as { agent?: unknown }).agent);
      if (!agent) return { status: 400, data: { error: 'which agent? Claude or Codex' } };
      if (!f.run) return { status: 409, data: { error: `${shortName(f.record)} isn’t running` } };
      return { data: await this.chat(f.record.target, agent) };
    }
    if (route === 'close' && method === 'POST') return this.close(f);
    if (route === 'pause' && method === 'POST') return this.pause(f, (b as { now?: unknown }).now === true);
    if (route === 'resume' && method === 'POST') return this.resume(f, (b as { agent?: unknown }).agent !== false);
    if (route === 'chat' && method === 'POST') {
      const c = f.record.chats[0];
      if (!c?.orca) return { status: 409, data: { error: c ? `${c.agent}’s chat isn’t in an Orca terminal` : 'no chat holds this review' } };
      return (await showTerminal(c.orca)) ? { data: { shown: true } } : { status: 410, data: { error: `${c.agent}’s terminal is gone` } };
    }
    if (route === 'lsp' && method === 'POST') {
      if (!f.run) return { status: 409, data: { error: `${shortName(f.record)} isn’t running` } };
      try {
        const r = await call(f.run, 'POST', 'lsp/restart');
        const err = failed(r);
        return err ? { status: r.status, data: { error: err } } : { data: { restarted: true } };
      } catch (e) {
        if (e instanceof Gone) return { status: 410, data: { error: 'the review stopped' } };
        throw e;
      }
    }
    return { status: 404, data: { error: `no such call: ${method} ${route}` } };
  }
}

/** Serves the manager's page here, until it's been idle a while; its link goes in the run folder. */
export async function serveManager(o: { port: number | null; quiet: boolean }): Promise<number> {
  const manager = new Manager();
  const progress = new Narrator({ quiet: true, verbose: false, color: false });
  let seen = Date.now();
  const page = () => managerPage({ version: VERSION });
  const server = new ReviewServer(
    { host: '127.0.0.1', port: o.port ?? MANAGER_PORT, portExplicit: o.port != null, basePath: '/' },
    progress,
    {
      page,
      asset: (name) => {
        const css = name === 'fonts.css' ? fonts() : null;
        return css && { type: 'text/css; charset=utf-8', body: css };
      },
      call: (route, method, query, body) => {
        seen = Date.now();
        return manager.call(route, method, query, body);
      },
    },
    page(),
    () => {},
  );
  const url = await server.listen();
  const own: ManagerRun = { pid: process.pid, url, token: server.token, started: new Date().toISOString() };
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(managerFile(), JSON.stringify(own), { mode: 0o600 });
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('exit', () => { if (readManager()?.pid === process.pid) fs.rmSync(managerFile(), { force: true }); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => { if (!server.pageCount && !manager.busy && Date.now() - seen > IDLE_AFTER) void stop(); }, 60_000).unref();
  if (!o.quiet) process.stdout.write(`untangle: your reviews are at ${url}\n`);
  return new Promise<number>(() => {});
}
