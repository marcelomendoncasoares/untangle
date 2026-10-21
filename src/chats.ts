// The chat an agent holds a review from, and how untangle reaches it between the agent's turns.
// Claude waits with untangle watch in the background: the watch's end wakes its chat. Codex can't
// be woken that way, so the review puts a line in its chat with `codex queue`. Inside Orca,
// untangle can also type that line into a chat's terminal when you ask it to (Wake).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Chat {
  kind: 'claude' | 'codex';
  /** Claude's session, or Codex's thread. */
  id: string;
  /** The agent's process, and when it started as the system counts it: a reused pid isn't the agent. */
  pid: number | null;
  started: string | null;
  /** Where the agent keeps its state: Claude's config folder, or Codex's home. */
  home: string;
  /** Codex's own program, to queue a line with. */
  bin: string | null;
  /** The chat's terminal in Orca: Orca's command, the terminal's handle, and its pane (tab:leaf). */
  orca: { cli: string; handle: string; pane: string | null } | null;
}

/** What untangle needs from the chats it holds a review for: the page asks, Codex is rung. */
export interface Bell {
  /** Whether the chat's agent still runs; null when untangle can't tell. */
  alive(chat: Chat): boolean | null;
  /** Whether the chat is in a turn now, and since when; null when untangle can't tell. */
  busy(chat: Chat): { busy: boolean; since: number } | null;
  /** Puts a line in the chat, as Codex's queue does: an error, or null. */
  ring(chat: Chat, line: string): Promise<string | null>;
  /** Types a line into the chat's terminal, in Orca, and presses Enter: an error, or null. */
  wake(chat: Chat, line: string): Promise<string | null>;
}

interface Proc { pid: number; ppid: number; name: string; started: string }

/** A process: its parent, its name and when it started. Null when it isn't running. */
function proc(pid: number): Proc | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The name is in parentheses, and may hold spaces and parentheses of its own.
      const close = stat.lastIndexOf(')');
      const f = stat.slice(close + 2).split(' ');
      return { pid, ppid: Number(f[1]), name: stat.slice(stat.indexOf('(') + 1, close), started: f[19] };
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') return null;
  const r = spawnSync('ps', ['-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  const m = r.status === 0 ? /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(r.stdout.trim()) : null;
  return m ? { pid, ppid: Number(m[1]), name: path.basename(m[3]), started: m[2] } : null;
}

/** The processes this one runs under, nearest first. */
function ancestors(): Proc[] {
  const out: Proc[] = [];
  for (let p = proc(process.ppid); p && out.length < 40; p = p.ppid > 1 ? proc(p.ppid) : null) out.push(p);
  return out;
}

/** A command on PATH, as its full path. */
function which(cmd: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/**
 * The chat this command runs in, from what Claude and Codex give the commands they run: Claude's
 * session and process, or Codex's thread (whose process is the nearest codex above this one). An
 * agent run inside another's chat is the nearer of the two.
 */
export function chatOf(env: NodeJS.ProcessEnv = process.env): Chat | null {
  const chain = ancestors();
  const claudePid = Number(env.CLAUDE_PID) || null;
  const claudeAt = env.CLAUDE_CODE_SESSION_ID ? chain.findIndex((p) => p.pid === claudePid) : -1;
  const codexAt = env.CODEX_THREAD_ID ? chain.findIndex((p) => /^codex/i.test(p.name)) : -1;
  const kind = claudeAt >= 0 && (codexAt < 0 || claudeAt < codexAt) ? 'claude'
    : codexAt >= 0 ? 'codex'
      : env.CODEX_THREAD_ID ? 'codex' : env.CLAUDE_CODE_SESSION_ID ? 'claude' : null;
  if (!kind) return null;
  const orca = env.ORCA_TERMINAL_HANDLE && env.ORCA_CLI_COMMAND ? which(env.ORCA_CLI_COMMAND, env) : null;
  const where = { orca: orca ? { cli: orca, handle: env.ORCA_TERMINAL_HANDLE!, pane: env.ORCA_PANE_KEY || null } : null };
  if (kind === 'claude') {
    const p = claudeAt >= 0 ? chain[claudeAt] : claudePid ? proc(claudePid) : null;
    return { kind, id: env.CLAUDE_CODE_SESSION_ID!, pid: p ? p.pid : claudePid, started: p ? p.started : null, home: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), bin: null, ...where };
  }
  const p = codexAt >= 0 ? chain[codexAt] : null;
  let bin: string | null = null;
  try {
    if (p && process.platform === 'linux') bin = fs.readlinkSync(`/proc/${p.pid}/exe`);
  } catch {
    // Its program is someone else's to read.
  }
  return { kind, id: env.CODEX_THREAD_ID!, pid: p ? p.pid : null, started: p ? p.started : null, home: env.CODEX_HOME || path.join(os.homedir(), '.codex'), bin: bin || which('codex', env), ...where };
}

function alive(chat: Chat): boolean | null {
  if (!chat.pid) return null;
  try {
    process.kill(chat.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (chat.started) {
    const p = proc(chat.pid);
    if (!p || p.started !== chat.started) return false;
  }
  // Claude runs one session at a time: after /clear, or another one resumed, this chat ended.
  if (chat.kind === 'claude') {
    const s = claudeSession(chat);
    if (s?.sessionId && s.sessionId !== chat.id) return false;
  }
  return true;
}

// Codex keeps each thread's log in its home, under the day the thread began (in the id, a UUIDv7).
const logs = new Map<string, string>();
function codexLog(chat: Chat): string | null {
  const known = logs.get(chat.id);
  if (known && fs.existsSync(known)) return known;
  const ms = parseInt(chat.id.replace(/-/g, '').slice(0, 12), 16);
  if (!Number.isFinite(ms)) return null;
  for (const day of [0, -1, 1]) {
    const d = new Date(ms + day * 86_400_000);
    const dir = path.join(chat.home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try {
      const name = fs.readdirSync(dir).find((f) => f.endsWith(`-${chat.id}.jsonl`));
      if (name) {
        logs.set(chat.id, path.join(dir, name));
        return path.join(dir, name);
      }
    } catch {
      // No sessions that day.
    }
  }
  return null;
}

/** A Codex thread's log, found under its home by the day in its id. */
export const chatLog = (c: Pick<Chat, 'id' | 'home'> & { kind: 'codex' }) => codexLog({ ...c, pid: null, started: null, bin: null, orca: null });

/** The last time a turn started or ended in a Codex thread's log: busy since then, or not. */
function codexBusy(file: string): { busy: boolean; since: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    // From the end back, a chunk at a time: a line can be long.
    for (let end = size, tail = ''; end > 0 && size - end < 4 << 20;) {
      const start = Math.max(0, end - (256 << 10));
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8') + tail;
      const all = [...text.matchAll(/"type":"(task_started|task_complete|turn_aborted)"/g)];
      if (all.length) {
        const m = all[all.length - 1];
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
        const at = Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] || '');
        return { busy: m[1] === 'task_started', since: Number.isFinite(at) ? at : 0 };
      }
      tail = text.slice(0, 200);
      end = start;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Claude's own word on a running session: its id, its folder, and whether it's busy and since when. */
function claudeSession(chat: Chat): { sessionId?: string; cwd?: string; status?: string; statusUpdatedAt?: number } | null {
  if (!chat.pid) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(chat.home, 'sessions', `${chat.pid}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The folder a chat runs in: Claude's session says it while Claude runs, and a Codex thread's log
 * opens with it. Claude finds a chat to resume by its folder.
 */
export function chatFolder(chat: Chat): string | null {
  if (chat.kind === 'claude') {
    const s = claudeSession(chat);
    return s && s.sessionId === chat.id && typeof s.cwd === 'string' ? s.cwd : null;
  }
  const file = codexLog(chat);
  if (!file) return null;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    // The first line: it holds the thread's instructions too, so it can run long.
    let text = '';
    const buf = Buffer.alloc(256 << 10);
    for (let at = 0; at < 4 << 20; at += buf.length) {
      const n = fs.readSync(fd, buf, 0, buf.length, at);
      text += buf.subarray(0, n).toString('utf8');
      if (text.includes('\n') || n < buf.length) break;
    }
    const cwd = (JSON.parse(text.split('\n')[0]) as { payload?: { cwd?: unknown } }).payload?.cwd;
    return typeof cwd === 'string' ? cwd : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function busy(chat: Chat): { busy: boolean; since: number } | null {
  if (chat.kind === 'codex') {
    const file = codexLog(chat);
    return file ? codexBusy(file) : null;
  }
  // Idle, or idle with a shell of its own still running in the background (shell): not in a turn.
  const s = claudeSession(chat);
  if (!s || s.sessionId !== chat.id || !['busy', 'idle', 'shell'].includes(s.status || '')) return null;
  return { busy: s.status === 'busy', since: Number(s.statusUpdatedAt) || 0 };
}

/** Runs a command to its end: its output, or why it failed. */
function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ out: string; error: string | null }> {
  return new Promise((resolve) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ out, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ out, error: code === 0 ? null : (err.trim().split('\n').pop() || `${path.basename(cmd)} exited ${code}`).replace(/^Error:\s*/, '') }); });
  });
}

async function ring(chat: Chat, line: string): Promise<string | null> {
  // Codex's program as its chat runs it, unless an update replaced it since: then the one on PATH.
  const bin = chat.bin && fs.existsSync(chat.bin) ? chat.bin : 'codex';
  const r = await exec(bin, ['queue', '--thread', chat.id, '--message', line], { ...process.env, CODEX_HOME: chat.home });
  return r.error;
}

/** Orca's answer, as JSON: its result, or its error's code. */
function orcaSaid(r: { out: string; error: string | null }): { ok: boolean; code: string | null; result: unknown } {
  try {
    const j = JSON.parse(r.out) as { ok?: boolean; error?: { code?: string; message?: string }; result?: unknown };
    return { ok: j.ok === true, code: j.ok ? null : j.error?.code || j.error?.message || 'failed', result: j.result };
  } catch {
    return { ok: false, code: r.error || 'Orca didn’t answer', result: null };
  }
}

async function wake(chat: Chat, line: string): Promise<string | null> {
  const o = chat.orca;
  if (!o) return 'this chat isn’t in an Orca terminal';
  const send = (handle: string) => exec(o.cli, ['terminal', 'send', '--terminal', handle, '--text', line, '--enter', '--json'], process.env).then(orcaSaid);
  let r = await send(o.handle);
  // Orca gives a terminal a new handle when it restarts: its pane finds it again.
  if (!r.ok && r.code === 'terminal_handle_stale' && o.pane) {
    const list = orcaSaid(await exec(o.cli, ['terminal', 'list', '--json'], process.env));
    const terms = ((list.result as { terminals?: Array<{ handle: string; tabId?: string; leafId?: string }> } | null)?.terminals) || [];
    const t = terms.find((x) => `${x.tabId}:${x.leafId}` === o.pane);
    if (t) {
      o.handle = t.handle;
      r = await send(t.handle);
    }
  }
  return r.ok ? null : r.code === 'terminal_handle_stale' ? 'its terminal is gone' : r.code;
}

export const bell: Bell = { alive, busy, ring, wake };

/** A chat as a watch sent it, kept to what untangle makes of its own environment. */
export function chatFrom(x: unknown): Chat | null {
  const c = (x && typeof x === 'object' ? x : {}) as Partial<Chat>;
  if ((c.kind !== 'claude' && c.kind !== 'codex') || typeof c.id !== 'string' || !/^[\w-]{1,100}$/.test(c.id)) return null;
  // The programs untangle runs for a chat are Codex's and Orca's own, named so.
  const program = (p: unknown, name: RegExp) => (typeof p === 'string' && path.isAbsolute(p) && name.test(path.basename(p)) ? p : null);
  const o = (c.orca && typeof c.orca === 'object' ? c.orca : {}) as Partial<NonNullable<Chat['orca']>>;
  const cli = program(o.cli, /^orca/i);
  return {
    kind: c.kind, id: c.id,
    pid: typeof c.pid === 'number' && Number.isInteger(c.pid) && c.pid > 0 ? c.pid : null,
    started: typeof c.started === 'string' ? c.started.slice(0, 64) : null,
    home: typeof c.home === 'string' && path.isAbsolute(c.home) ? c.home : path.join(os.homedir(), c.kind === 'claude' ? '.claude' : '.codex'),
    bin: c.kind === 'codex' ? program(c.bin, /^codex/i) : null,
    orca: cli && typeof o.handle === 'string' && /^[\w-]{1,200}$/.test(o.handle) ? { cli, handle: o.handle, pane: typeof o.pane === 'string' ? o.pane.slice(0, 200) : null } : null,
  };
}
