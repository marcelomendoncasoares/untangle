// untangle reviews' page: a small process of its own serves it. It reads the reviews' records and,
// while the page is open, asks each running review how it's doing. Reviews stay their own
// processes: the manager only reads them, and does what the page asks with them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../viewer/core.js';
import { agentCommand, agentOptions, flagsOf, rememberStart, resumeCommand, startedHere, type AgentChoice } from './agents.js';
import { cacheRoot, reviewDir, worktreeDir } from './cache.js';
import { rehomeCheckouts } from './checkouts.js';
import { call, failed, Gone } from './client.js';
import { has, runAsync } from './exec.js';
import { launch, logTail } from './launcher.js';
import { Narrator } from './narrate.js';
import { openPage } from './open.js';
import { newTerminal, orca, orcaCli, reviewsWorkspace, showTab, showTerminal } from './orca.js';
import { childPids, rss } from './metrics.js';
import { fonts, managerPage } from './page.js';
import { notesFile } from './notes.js';
import { dirSizeAsync, listRecords, readRecord, recordFile, recordId, serves, writeRecord, type Listed, type ReviewRecord } from './records.js';
import { shortName, summaries, titleOf, type Summary } from './reviews.js';
import { findRun, listRuns, olderRuns, pidAlive, runDir, wantedDir, wantedUrl, type RunInfo, type Wanted } from './runs.js';
import { ReviewServer } from './server.js';
import { Building, forget, free, freeOld, holdings, isCheckout, keptDirs, olderDirs, removeOld, type Holdings } from './space.js';
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

/** When the untangle this process runs was built: its newest compiled file, as it started. */
const BUILT = (() => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  try {
    return Math.max(0, ...fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
  } catch {
    return 0;
  }
})();

/**
 * The manager running now, when it answers. One an earlier build of untangle runs gives way to
 * this one, unless it's waiting to pause a review: it would forget to.
 */
export async function findManager(): Promise<ManagerRun | null> {
  const m = readManager();
  if (!m || !pidAlive(m.pid)) return null;
  let hello;
  try {
    hello = await call(m, 'GET', 'hello', { timeout: 3000 });
  } catch {
    return null;
  }
  if (hello.status !== 200) return null;
  const was = hello.data as { built?: number; busy?: boolean };
  if (was.busy || (was.built ?? 0) >= BUILT) return m;
  try {
    process.kill(m.pid, 'SIGTERM');
  } catch {
    // Gone already.
  }
  for (let i = 0; i < 60 && pidAlive(m.pid); i++) await new Promise((r) => setTimeout(r, 50));
  return null;
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
  /** What it holds on disk, in bytes, once measured: a closed one, what only it holds. */
  disk: number | null;
  /** When its space was freed: only its notes, marks and record are left. */
  freed: string | null;
  /** A closed one's checkouts and analyses, and how many of them other closed reviews hold too. */
  parts: { checkouts: number; analyses: number; shared: number } | null;
  /** Run by an untangle from before records: it can't say how it's doing, only that it runs. */
  older: boolean;
  /**
   * A second untangle of a review that runs, from before untangle checked for one: the other one
   * holds its record, and this one is to close.
   */
  twin: boolean;
}

const idOf = recordId;

/** Whether a run serves a record's review: the same pull request, or the same key in the same repository. */
const servesRecord = (run: RunInfo, r: ReviewRecord) => (!!run.pr && run.pr === r.pr) || (!!run.key && run.key === r.key && run.repoKey?.toLowerCase() === r.repoKey.toLowerCase());

/** The agents of a review at work, as its row says them. */
const agentsOf = (s: Summary | undefined): Row['agents'] => (s?.agents ?? []).map((a) => ({ name: a.name, kind: a.kind, state: a.state, on: a.on, label: globalThis.ReviewCore.agentLabel(a) }));

/**
 * A review that's starting: its process runs, and it has no record until it's built. Or one an
 * older untangle runs, which never has one: its memory is read from its processes. Until it says
 * its title, its pull request's is the one the palette listed.
 */
function starting(run: RunInfo, s: Summary | undefined, pull: Pull | null): Row {
  const old = olderRuns.has(run.pid);
  const m = run.pr ? /^([^/]+)\/([^#]+)#(\d+)$/.exec(run.pr) : null;
  const { kind, title } = kindOf((s?.title || run.title || '').replace(/^#\d+ /, '') || pull?.title || (m ? `#${m[3]}` : 'Starting'));
  const waiting = s?.waiting ?? [];
  return {
    id: `run:${run.pid}`,
    target: run.pr && m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : run.dir || '',
    name: m ? `${m[2]}#${m[3]}` : (run.dir || '').split(/[\\/]/).pop() || 'review',
    title, kind,
    repo: pull?.repo ?? (m ? `${m[1]}/${m[2]}` : (run.repoKey || '').replace(/^github\.com\//, '')),
    author: pull?.author ?? null, url: null, size: { add: 0, del: 0, files: 0 },
    status: 'running', stopped: null, closed: null, opened: run.started, head: run.head || '',
    // Once it's built, what it says of itself: how far, the notes, its agents.
    progress: s?.progress ?? { done: 0, total: 0 }, notes: s?.notes ?? { open: 0, waiting: 0 }, waiting, agents: agentsOf(s), chat: null,
    memory: old ? memoryOf(run.pid) : s?.memory ?? null,
    build: old || s?.phase === 'ready' ? null : { phase: s?.phase ?? 'starting', step: s?.step ? { label: s.step.label, count: s.step.count ?? null } : null, plan: s?.plan ?? null, error: s?.error ?? null },
    pages: s?.pages ?? 0, pausing: false, github: null, need: need(waiting), needAt: waiting.length ? Math.min(...waiting.map((w) => w.n)) : null, active: s?.active ?? null, disk: null, freed: null, parts: null, older: old, twin: false,
  };
}

/** A review's memory, from its process and its children (its language server). */
function memoryOf(pid: number): Summary['memory'] | null {
  const own = rss(pid);
  if (own == null) return null;
  const kids = childPids(pid).map(rss).filter((b): b is number => b != null);
  return { untangle: own, lsp: kids.length ? kids.reduce((a, b) => a + b, 0) : null };
}

/** What a review's target stands for, to find it running: a pull request, or a directory's repository and branch. */
function wanted(target: string): Wanted | null {
  return wantedUrl(target) ?? (fs.existsSync(target) ? wantedDir(target) : null);
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

function row(r: Listed, s: Summary | undefined, disk: number | null, h: Holdings): Row {
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
    agents: agentsOf(s),
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
    freed: r.freed ?? null,
    parts: r.status === 'closed' && !r.freed ? partsOf(r, h) : null,
    older: false,
    twin: false,
  };
}

/** The checkouts and analyses only a closed review holds, as its size counts them, and how many it shares. */
function partsOf(r: Listed, h: Holdings): Row['parts'] {
  const dirs = keptDirs(r).filter((d) => fs.existsSync(d));
  const own = dirs.filter((d) => !h.shared.has(d)), checkouts = path.join(cacheRoot(), 'worktrees') + path.sep;
  return { checkouts: own.filter((d) => d.startsWith(checkouts)).length, analyses: own.filter((d) => !d.startsWith(checkouts)).length, shared: dirs.length - own.length };
}

/** What a freed review still holds: its notes, its record, and the marks its analyses keep. */
function leftOf(r: Listed): number {
  return [notesFile(r.repoKey, r.key), recordFile(r.repoKey, r.key), ...r.analyses.map(([b, h]) => path.join(reviewDir(r.repoKey, b, h), 'state.json'))].reduce((n, f) => {
    try {
      return n + fs.statSync(f).size;
    } catch {
      return n;
    }
  }, 0);
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

  /** Folders just removed: they hold nothing now. */
  gone(dirs: string[]) {
    for (const d of dirs) this.known.set(d, { bytes: 0, at: Date.now() });
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
  // An older untangle doesn't know the summary call: it isn't asked again.
  await Promise.all(runs.filter((run) => !olderRuns.has(run.pid)).map(async (run) => {
    try {
      const a = await call(run, 'GET', 'summary', { timeout: 5000 });
      if (a.status === 200) out.set(run.pid, a.data as unknown as Summary);
      else if (a.status === 404) olderRuns.add(run.pid);
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
  // When the page opens, then hourly: GitHub, about paused reviews' pull requests, and closed reviews' space.
  private hourlyAt = 0;
  // Reviews started again from their row, by process: their row shows them starting.
  private readonly launched = new Map<number, string>();
  // Starts on their way, by what they review: one asked again meanwhile waits for it, and finds it running.
  private readonly underway = new Set<string>();
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

  /** A pull request the palette listed, by the key run files keep: owner/repo#n. */
  private pullOf(pr: string | null): Pull | null {
    const v = this.pullsKept?.value;
    return (pr && v && [...v.asked, ...v.yours].find((p) => `${p.repo}#${p.number}`.toLowerCase() === pr)) || null;
  }

  /**
   * Starts a review of a pull request's link or a directory, through the launcher, so it's no one's
   * child; it opens its own page. It runs until it's paused or closed, its tab or not. A review of
   * it already running isn't started again.
   */
  async start(target: string, agent: AgentChoice | null = null, id: string | null = null): Promise<{ status?: number; data: unknown }> {
    if (!isPrUrl(target) && !(path.isAbsolute(target) && fs.existsSync(target))) return { status: 400, data: { error: `${target} is not a pull request’s link` } };
    const w = wanted(target);
    const key = w?.pr ?? w?.dir ?? target;
    while (this.underway.has(key)) await new Promise((r) => setTimeout(r, 100));
    this.underway.add(key);
    try {
      // One of it that runs is the one; one that's stopping (paused or closed a moment ago) is let go first.
      const running = w && findRun(w);
      if (running && (await serves(running))) return { data: { already: true, pid: running.pid } };
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
      // Another untangle started it meanwhile, and this one gave way to it.
      const other = w && findRun(w);
      if (other && (await serves(other))) return { data: { already: true, pid: other.pid } };
      return { status: 502, data: { error: `the review didn’t start${logTail(log) ? ': ' + logTail(log).split('\n').pop() : ''}` } };
    } finally {
      this.underway.delete(key);
    }
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

  /** Once an hour while the page is open: GitHub's word on paused reviews, then the space of reviews closed fourteen days ago. */
  private async hourly() {
    if (Date.now() - this.hourlyAt < 3600_000) return;
    this.hourlyAt = Date.now();
    if (has('gh')) await this.github();
    this.sizes.gone(freeOld().removed);
  }

  /**
   * Paused reviews whose pull request merged or closed on GitHub are closed too; closed ones learn
   * it, for their space to be freed fourteen days on.
   */
  private async github() {
    for (const r of listRecords().filter((x) => x.pr && !x.github && (x.status === 'paused' || (x.status === 'closed' && !x.freed)))) {
      const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(r.pr!);
      if (!m) continue;
      try {
        const j = JSON.parse(await runAsync('gh', ['pr', 'view', m[3], '--repo', `${m[1]}/${m[2]}`, '--json', 'state,mergedAt,closedAt'], { timeout: 20_000 })) as { state?: string; mergedAt?: string | null; closedAt?: string | null };
        if (j.state !== 'MERGED' && j.state !== 'CLOSED') continue;
        const file = recordFile(r.repoKey, r.key);
        const now = readRecord(file);
        // Started again since: it's no longer what was asked about.
        if (!now || now.pid !== r.pid) continue;
        const at = (j.state === 'MERGED' ? j.mergedAt : j.closedAt) || new Date().toISOString();
        writeRecord({ ...now, closed: now.closed ?? at, github: { state: j.state === 'MERGED' ? 'merged' : 'closed', at }, updated: new Date().toISOString() });
      } catch {
        // GitHub didn't answer: next time.
      }
    }
  }

  /** Closes a review: a running one stops, saying it's closed; a paused one's record says so. */
  async close(f: { record: Listed | null; run: RunInfo | null }): Promise<{ status?: number; data: unknown }> {
    if (f.run) {
      // A second untangle of a review that runs writes its record as it stops: the one that holds it gets it back.
      const run = f.run;
      const twin = f.record ? null : listRecords().find((r) => r.status === 'running' && r.pid !== run.pid && servesRecord(run, r));
      const held = twin ? readRecord(recordFile(twin.repoKey, twin.key)) : null;
      try {
        const r = await call(f.run, 'POST', 'stop', { body: { close: true } });
        const err = failed(r);
        if (err) return { status: r.status, data: { error: err } };
      } catch (e) {
        if (!(e instanceof Gone)) throw e;
      }
      if (held) {
        for (let i = 0; i < 100 && pidAlive(run.pid); i++) await new Promise((r) => setTimeout(r, 50));
        if (readRecord(recordFile(held.repoKey, held.key))?.pid === run.pid) writeRecord(held);
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
    // The manager's own page: the reviews' Reviews menus leave GitHub and the cache to it.
    if (o.disk) void this.hourly();
    const runs = listRuns();
    // Reviews whose process runs and which have no record: being built, or an older untangle's.
    const recorded = new Set(list.filter((r) => r.status === 'running').map((r) => r.pid));
    for (const pid of this.launched.keys()) if (recorded.has(pid) || !runs.some((run) => run.pid === pid)) this.launched.delete(pid);
    for (const pid of olderRuns) if (!runs.some((run) => run.pid === pid)) olderRuns.delete(pid);
    const fresh = runs.filter((run) => !recorded.has(run.pid));
    const asked = fresh.length ? await summariesOf(fresh) : new Map<number, Summary>();
    const h = holdings(list, runs);
    const rows = list.map((r) => row(r, r.pid != null ? live.get(r.pid) : undefined, r.freed ? leftOf(r) : sizeOf(r.status === 'closed' ? h.own.get(idOf(r)) ?? [] : keptDirs(r)), h));
    rows.forEach((x) => { x.pausing = this.pausing.has(x.id); });
    if (fresh.length) {
      for (const run of fresh) {
        const said = asked.get(run.pid);
        const s = starting(run, said, this.pullOf(run.pr));
        if (s.older) s.disk = sizeOf(olderDirs(run) ?? []);
        // A second untangle of a review that runs, built by an untangle from before one checked: listed as itself, to close.
        const held = said?.head ? list.find((r) => r.status === 'running' && r.pid !== run.pid && servesRecord(run, r)) : undefined;
        if (held) { rows.splice(rows.findIndex((x) => x.id === idOf(held)) + 1, 0, { ...row(held, said, null, h), id: s.id, opened: s.opened, chat: null, need: null, needAt: null, twin: true }); continue; }
        // A paused or closed review starting again keeps its row: what it knows, and how far the build is.
        const of = (x: Row) => list.some((r) => idOf(r) === x.id && servesRecord(run, r));
        const at = rows.findIndex((x) => x.status !== 'running' && (x.id === this.launched.get(run.pid) || of(x)));
        if (at < 0) rows.unshift(s);
        else rows[at] = { ...rows[at], status: 'running', stopped: null, closed: null, github: null, freed: null, parts: null, opened: s.opened, memory: s.memory, build: s.build, older: s.older, pages: s.pages, active: s.active, agents: s.agents, waiting: s.waiting, need: s.need, needAt: s.needAt };
      }
    }
    return {
      version: VERSION,
      reviews: rows,
      memory: { manager: process.memoryUsage().rss },
      disk: o.disk ? this.disk(list, h) : null,
      orca: !!orcaCli(),
    };
  }

  /**
   * The cache's space, each folder once: what open reviews keep, what only one closed review
   * holds, the old checkouts, and the clones with what closed reviews share.
   */
  private disk(list: Listed[], h: Holdings) {
    const size = (d: string) => this.sizes.of(d);
    const total = (dirs: Iterable<string>) => [...dirs].reduce((a, d) => a + (size(d) ?? 0), 0);
    const all = (dirs: string[]) => (dirs.some((d) => size(d) == null) ? null : total(dirs));
    const byId = new Map(list.map((r) => [idOf(r), r]));
    // Reviews of a branch share their repository's name: their branch tells them apart.
    const label = (r: Listed) => (r.pr ? shortName(r) : r.key);
    const shares = [...h.shared].map(([dir, ids]) => {
      const rs = ids.map((id) => byId.get(id)!);
      const analysis = dir.startsWith(path.join(cacheRoot(), 'reviews') + path.sep);
      return { dir, what: analysis ? 'analysis' : rs.every((r) => worktreeDir(r.repoKey, r.base) === dir) ? 'base' : 'checkout', by: ids, names: rs.map(label), bytes: size(dir) };
    });
    // The open reviews that moved past an old checkout's commit; the others no review names.
    const movedBy = (d: string) => list.filter((r) => r.status !== 'closed' && r.checkouts.some((sha) => worktreeDir(r.repoKey, sha) === d));
    const moved = h.old.filter((d) => movedBy(d).length);
    const past = new Set(moved.flatMap((d) => movedBy(d).map(label)));
    return {
      open: total(h.open),
      closed: total([...h.own.values()].flat()),
      old: total(h.old),
      shared: total(h.shared.keys()) + total(h.clones),
      measuring: this.sizes.busy,
      clones: h.clones.map((c) => ({ repo: path.relative(path.join(cacheRoot(), 'repos'), c).replace(/^github\.com\//, '').replace(/\.git$/, ''), bytes: size(c) })),
      shares,
      // What no review keeps: checkouts (heads open reviews moved past among them) and analyses.
      leftover: { checkouts: h.old.filter(isCheckout).length, analyses: h.old.filter((d) => !isCheckout(d)).length, bytes: all(h.old), moved: moved.length, past: [...past] },
    };
  }

  /** A review by its row's id: its record, and its process when it runs, or when it's being built again. */
  private find(id: unknown): { record: Listed; run: RunInfo | null } | null {
    const record = listRecords().find((r) => idOf(r) === id);
    if (!record) return null;
    const runs = listRuns();
    if (record.status === 'running') return { record, run: runs.find((x) => x.pid === record.pid) ?? null };
    return { record, run: runs.find((x) => this.launched.get(x.pid) === id || servesRecord(x, record)) ?? null };
  }

  /** The page's API. */
  async call(route: string, method: string, query: URLSearchParams, body: unknown): Promise<{ status?: number; data: unknown }> {
    const b = (body && typeof body === 'object' ? body : {}) as { id?: unknown };
    if (route === 'hello' && method === 'GET') return { data: { version: VERSION, pid: process.pid, built: BUILT, busy: this.busy } };
    if (route === 'reviews' && method === 'GET') return { data: await this.view() };
    if (route === 'pulls' && method === 'GET') return { data: await this.pulls() };
    if (route === 'agents' && method === 'GET') return { data: { ...agentOptions(), orca: !!orcaCli() } };
    if (route === 'start' && method === 'POST' && typeof (b as { target?: unknown }).target === 'string') return this.start((b as { target: string }).target.trim(), agentFrom((b as { agent?: unknown }).agent));
    if (route === 'tail' && method === 'GET') {
      const f = this.find(query.get('id'));
      const c = f?.record.chats[0];
      return { data: { lines: c ? chatTail(c) : null } };
    }
    if ((route === 'free' || route === 'forget') && method === 'POST') {
      const ids = (b as { ids?: unknown }).ids;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return { status: 400, data: { error: 'which reviews?' } };
      try {
        if (route === 'free') {
          const r = free(new Set(ids));
          this.sizes.gone(r.removed);
          return { data: { freed: r.freed.length } };
        }
        const r = forget(new Set(ids));
        this.sizes.gone(r.removed);
        return { data: { forgot: r.forgot.length } };
      } catch (e) {
        if (e instanceof Building) return { status: 409, data: { error: e.message } };
        throw e;
      }
    }
    if (route === 'free-old' && method === 'POST') {
      const removed = removeOld();
      this.sizes.gone(removed);
      return { data: { removed: removed.length, checkouts: removed.filter(isCheckout).length } };
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
  // The checkouts older untangles made as worktrees of your repositories: they stop listing them.
  void rehomeCheckouts();
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
