// The commands a coding agent runs to hold a review. `watch` starts the review when it isn't
// running (its page opens, in Orca's browser inside Orca), then waits for the notes and replies
// the agent hasn't read, prints them and exits: exiting is what wakes an agent that runs it in the
// background, as Claude does. A watch from Codex returns at once instead: untangle puts a line in
// its chat when there's news. `reply` answers in a note’s thread, `note` writes a note of the
// agent's own, `notes` prints the open notes, and `stop` closes the review.
import fs from 'node:fs';
import path from 'node:path';
import { chatOf, type Chat } from './chats.js';
import { launch, logTail } from './launcher.js';
import { call, failed, Gone } from './client.js';
import { isPrUrl } from './target.js';
import { openBrowser } from './open.js';
import { findRun, listRuns, pidAlive, removeRun, wantedDir, wantedUrl, type RunInfo, type Wanted } from './runs.js';
import { outdatedSkill } from './skill.js';

// The server answers a wait at least this often, so no connection sits idle for long; the command
// asks again until its own time runs out.
const ROUND = 4 * 60_000;

/** The agent's name: given, or told by its chat or its environment. */
export function agentName(given: string | null, chat: Chat | null): string {
  const name = (given ?? process.env.UNTANGLE_AGENT ?? '').trim();
  if (name) return name.slice(0, 40);
  if (chat) return chat.kind === 'claude' ? 'Claude' : 'Codex';
  if (process.env.CLAUDECODE) return 'Claude';
  if (process.env.GEMINI_CLI) return 'Gemini CLI';
  return 'Agent';
}

const say = (line: string) => process.stdout.write(`untangle: ${line}\n`);
// Quoted for a shell, when it needs to be.
const sh = (s: string) => (/^[\w./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** What a command's -review (or watch's argument) stands for. */
function wanted(target: string): Wanted {
  const byUrl = isPrUrl(target) ? wantedUrl(target) : null;
  if (byUrl) return byUrl;
  if (!fs.existsSync(target)) throw new Error(`${target} does not exist`);
  const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const w = wantedDir(dir);
  if (!w) throw new Error(`${path.resolve(dir)} is not inside a git repository`);
  return w;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => listRuns().some((r) => r.pid === pid);
// What a command run from a chat that no longer holds the review hears.
const elsewhere = (agent: string) => say(`another ${agent} chat holds this review now: untangle watch here takes it back.`);

/**
 * The review running for a target, when it answers: a run file left by a review that was killed
 * (whose process id another process now has) is removed.
 */
async function find(target: string): Promise<RunInfo | null> {
  const run = findRun(wanted(target));
  if (!run) return null;
  try {
    await call(run, 'GET', 'notes/hello');
    return run;
  } catch (e) {
    if (!(e instanceof Gone)) throw e;
    removeRun(run.pid);
    return null;
  }
}

/** The review a command is about, or an error that says how to start one. */
async function running(review: string | null): Promise<RunInfo> {
  const target = review ?? '.';
  const run = await find(target);
  if (!run) throw new Error(`no review of ${review ? target : 'this directory'} is running: untangle watch${review ? ' ' + sh(target) : ''} starts one`);
  return run;
}

/**
 * Starts a review in the background, as `untangle [flags] <target>` would, and finds its run file.
 * The launcher starts it, so the review isn't this watch's child: an agent that stops the watch
 * ends everything under it.
 */
async function start(target: string, flags: string[]): Promise<{ run: RunInfo; log: string | null }> {
  const { pid, log } = launch([...flags, '--', target], { ...process.env, UNTANGLE_FROM_AGENT: '1' });
  for (let i = 0; pid > 0 && i < 600; i++) {
    const run = listRuns().find((r) => r.pid === pid);
    if (run) return { run, log };
    if (!pidAlive(pid)) break;
    await sleep(100);
  }
  // Another untangle started it meanwhile, and this one gave way: that one.
  const other = await find(target);
  if (other) return { run: other, log: null };
  throw new Error(`the review didn’t start${logTail(log) ? ':\n' + logTail(log) : ''}`);
}

/**
 * Waits until the review is built: until then it answers 503. One that gave way to another
 * untangle of the review, started at the same moment, leads to that one.
 */
async function ready(run: RunInfo, agent: string, log: string | null, target: string): Promise<{ run: RunInfo; hello: Record<string, unknown>; log: string | null }> {
  for (;;) {
    let r;
    try {
      r = await call(run, 'GET', 'notes/hello', { query: { agent } });
    } catch (e) {
      const other = e instanceof Gone && !alive(run.pid) ? await find(target) : null;
      if (other && other.pid !== run.pid) { run = other; log = null; continue; }
      if (!(e instanceof Gone) || !alive(run.pid)) throw new Error(`the review stopped before it was ready${log && logTail(log) ? ':\n' + logTail(log) : ''}`);
      r = { status: 503, data: {} };
    }
    if (r.status !== 503) {
      const err = failed(r);
      if (err) throw new Error(err);
      return { run, hello: r.data, log };
    }
    await sleep(400);
  }
}

export async function watch(o: { target: string; given: boolean; forward: string[]; agent: string | null; timeout: number }): Promise<number> {
  const chat = chatOf();
  const agent = agentName(o.agent, chat);
  // Codex can't be woken by a watch that ends: its watch reads what's there, and untangle rings
  // its chat for the rest.
  const brief = chat?.kind === 'codex';
  let run = await find(o.target);
  let log: string | null = null;
  if (!run) {
    say(`starting the review of ${o.given ? o.target : 'this directory'}…`);
    ({ run, log } = await start(o.target, o.forward));
  }
  let hello: Record<string, unknown>;
  ({ run, hello, log } = await ready(run, agent, log, o.target));
  // Already running, with no page open: one opens, so the person can write the notes.
  let opened = log ? (hello.opened as string | null) : null;
  if (!log && !hello.pages) opened = await openBrowser(run.url);
  if (log || !hello.pages) say(`${hello.title} is open ${opened === 'orca' ? 'in Orca’s browser' : opened === 'browser' ? 'in the browser' : `at ${run.url}`}.`);

  // The commands to answer with, as this agent should type them.
  const extra = [o.agent ? `-agent ${sh(o.agent)}` : '', o.given ? `-review ${sh(o.target)}` : ''].filter(Boolean).join(' ');
  const reply = `untangle reply${extra ? ' ' + extra : ''}`;
  const again = `untangle watch${o.agent ? ` -agent ${sh(o.agent)}` : ''}${o.given ? ' ' + sh(o.target) : ''}`;
  const deadline = o.timeout > 0 && !brief ? Date.now() + o.timeout : Infinity;
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  const how = () => explain(chat, String(hello.url || run.url), reply, again);
  for (;;) {
    const wait = Math.min(ROUND, deadline - Date.now());
    let r;
    try {
      r = await call(run, 'POST', 'notes/watch', { body: { agent, wait: Math.max(0, Math.round(wait)), brief, chat, again }, signal: stop.signal });
      // A review an older untangle started knows no chats: it takes the watch as a question.
      if (r.status === 404) r = await call(run, 'GET', 'notes/watch', { query: { agent, wait: String(Math.max(0, Math.round(wait))) }, signal: stop.signal });
    } catch (e) {
      if (stop.signal.aborted) return 130;
      if (!(e instanceof Gone)) throw e;
      r = { status: 200, data: { closed: true } };
    }
    const err = failed(r);
    if (err) throw new Error(err);
    const a = r.data;
    if (a.closed) {
      say(a.paused
        ? `the review of ${hello.title} paused: its notes and this chat are kept. Resume, in untangle reviews, brings it back and says so here; there’s nothing more to watch until then.`
        : `the review of ${hello.title} is closed (its page closed, or untangle stop ran): there’s nothing more to watch.`);
      return 0;
    }
    if (a.taken) {
      say(`another ${agent} chat took over this review: there’s nothing more to watch here.`);
      return 0;
    }
    if (a.text) {
      process.stdout.write(String(a.text).replace(/\n*$/, '\n\n'));
      if (a.first) how();
      else say(`answer a note with ${reply} <N> '<text>' (add -resolve once it’s done), and ${brief ? 'untangle will put a line in this chat when there’s more' : `run ${again} again for what comes next`}.`);
      return 0;
    }
    if (brief) {
      say(`nothing to read yet: untangle will put a line in this chat when there is.`);
      if (a.first) how();
      return 0;
    }
    if (Date.now() >= deadline) {
      say(`nothing new on ${hello.title} yet. Run ${again} again to keep waiting.`);
      if (a.first) how();
      return 0;
    }
  }
}

/** The first watch from a chat says how the review works, so asking for a review is all the setup it needs. */
function explain(chat: Chat | null, url: string, reply: string, again: string) {
  say(`you hold this code review. The person reviewing writes notes on the code in its page (${url}), and your answers show under them at once.`);
  if (chat?.kind === 'codex') say(`when there are notes or replies you haven’t read, untangle puts a line in this chat: run ${again} then, and it prints them.`);
  else say(`each ${again} waits for the notes and replies you haven’t read, prints them and exits: run it again after each answer, in the background${chat ? '' : ' if you can'}.`);
  say(`answer in a note’s thread with ${reply} N2 'your answer'; add -resolve once you’ve made the change. Commit as you go: the page shows your commits, and the notes follow their lines.`);
  say(`untangle notes prints the open notes again; untangle stop closes the review.`);
  const old = chat && outdatedSkill(chat.kind);
  if (old) say(`the untangle skill in ${old} is from another untangle: untangle skill -install updates it.`);
}

export async function reply(o: { review: string | null; agent: string | null; resolve: boolean; note: number; text: string | null }): Promise<number> {
  const run = await running(o.review);
  let text = o.text;
  if (text === '-') text = fs.readFileSync(0, 'utf8');
  const chat = chatOf(), agent = agentName(o.agent, chat);
  const r = await call(run, 'POST', 'notes/agent', { body: { agent, n: o.note, body: text, resolve: o.resolve, chat: chat?.id ?? null } }).catch((e) => { throw e instanceof Gone ? new Error('the review stopped') : e; });
  const err = failed(r);
  if (err) throw new Error(err);
  say(text ? `answered N${o.note}${o.resolve ? ' and resolved it' : ''}.` : `resolved N${o.note}.`);
  if (r.data.other) elsewhere(agent);
  return 0;
}

/** A path as the review names it, from its repository's top: given from there, or from here. */
function repoPath(run: RunInfo, p: string): string {
  const named = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!run.dir) return named;
  const here = path.resolve(fs.realpathSync(process.cwd()), p);
  const rel = path.relative(run.dir, here);
  return fs.existsSync(here) && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : named;
}

export async function note(o: { review: string | null; agent: string | null; removed: boolean; path: string; line: number | null; startLine: number | null; text: string }): Promise<number> {
  const run = await running(o.review);
  const text = o.text === '-' ? fs.readFileSync(0, 'utf8') : o.text;
  const chat = chatOf(), agent = agentName(o.agent, chat);
  const body = { agent, chat: chat?.id ?? null, path: repoPath(run, o.path), side: o.removed ? 'LEFT' : 'RIGHT', line: o.line, startLine: o.startLine, file: o.line == null, body: text };
  const r = await call(run, 'POST', 'notes/note', { body }).catch((e) => { throw e instanceof Gone ? new Error('the review stopped') : e; });
  const err = failed(r);
  if (err) throw new Error(err);
  const d = r.data as { n: number; where: string; head: string; code: string[]; other: boolean };
  // The lines it's on, so the agent sees it landed where it meant.
  say(`wrote N${d.n} on ${d.where}, at ${d.head}${d.code.length ? ':' : '.'}`);
  d.code.forEach((l) => process.stdout.write(`  ${l}\n`));
  if (d.other) elsewhere(agent);
  return 0;
}

export async function notes(o: { review: string | null; agent: string | null; all: boolean }): Promise<number> {
  const run = await running(o.review);
  const chat = chatOf(), agent = agentName(o.agent, chat);
  const r = await call(run, 'GET', 'notes/export', { query: { scope: o.all ? 'all' : 'open', agent, chat: chat?.id ?? '' } }).catch((e) => { throw e instanceof Gone ? new Error('the review stopped') : e; });
  const err = failed(r);
  if (err) throw new Error(err);
  process.stdout.write(String(r.data.text));
  if (r.data.other) elsewhere(agent);
  return 0;
}

export async function stop(o: { review: string | null }): Promise<number> {
  const run = await running(o.review);
  const r = await call(run, 'POST', 'stop').catch((e) => { throw e instanceof Gone ? new Error('the review stopped already') : e; });
  const err = failed(r);
  if (err) throw new Error(err);
  say(`closed the review${run.title ? ` of ${run.title}` : ''}.`);
  return 0;
}
