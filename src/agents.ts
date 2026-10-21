// Starting an agent's chat for a review: the command that starts Claude or Codex with the untangle
// skill (or resumes a chat by its id), the flags each starts with (as you last chose them), and
// the chats that held a review before, to resume for a new one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './cache.js';
import { has } from './exec.js';
import { listRecords } from './records.js';

export type AgentKind = 'claude' | 'codex';

/** What New review asks for: which agent, a new chat or one to resume, its flags, and a first message. */
export interface AgentChoice {
  kind: AgentKind;
  /** A chat to resume, by its id: Claude's session, or Codex's thread. Null starts a new one. */
  resume: string | null;
  /** The id a new Claude chat starts with, when the page chose it (it shows it in the command). */
  session?: string | null;
  flags: string;
  message: string;
}

/** Quoted for a POSIX shell: the terminal types it, so the skill's $ stays as it is. */
export const sh = (s: string) => (/^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The first line the agent reads: the skill, named the way each agent calls one, the review, and your message. */
export function firstLine(kind: AgentKind, target: string, message: string): string {
  return `${kind === 'claude' ? '/untangle' : '$untangle'} ${target}${message.trim() ? ' ' + message.trim() : ''}`;
}

/**
 * The command that starts the chat, and the id it'll have when untangle can give it one: Claude
 * starts with the session id untangle chose, so the review's record has it before Claude says a
 * word; Codex's thread comes from its first watch.
 */
export function agentCommand(a: AgentChoice, target: string, name: string): { command: string; id: string | null } {
  const first = sh(firstLine(a.kind, target, a.message));
  const flags = a.flags.trim();
  if (a.kind === 'claude') {
    const id = a.resume || a.session || crypto.randomUUID();
    const how = a.resume ? `--resume ${sh(a.resume)}` : `--session-id ${id} -n ${sh(`Review ${name}`)}`;
    return { command: ['claude', how, flags, first].filter(Boolean).join(' '), id };
  }
  const how = a.resume ? `resume ${sh(a.resume)}` : '--no-daemon';
  return { command: ['codex', how, flags, first].filter(Boolean).join(' '), id: a.resume };
}

/**
 * The command that resumes a chat that held a review, with one line that says the review is back.
 * Claude finds a chat by its folder, so the command starts there.
 */
export function resumeCommand(c: { kind: AgentKind; id: string; folder: string | null }, line: string, flags: string, here: string): string {
  const cd = c.kind === 'claude' && c.folder && c.folder !== here ? `cd ${sh(c.folder)} && ` : '';
  const how = c.kind === 'claude' ? `claude --resume ${sh(c.id)}` : `codex resume ${sh(c.id)}`;
  return cd + [how, flags.trim(), sh(line)].filter(Boolean).join(' ');
}

/** The flags an agent last started with. */
export const flagsOf = (kind: AgentKind) => readSettings().flags[kind] ?? '';

/** Where the manager keeps what it knows of the chats it starts. */
export const chatsDir = () => path.join(cacheRoot(), 'chats');
const settingsFile = () => path.join(chatsDir(), 'agents.json');

interface Settings {
  /** The flags each agent last started with. */
  flags: Partial<Record<AgentKind, string>>;
  /** The chats the manager started: by id, or by Orca terminal until Codex's thread is known. */
  started: Array<{ kind: AgentKind; id: string | null; handle: string | null; at: string }>;
}

function readSettings(): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>;
    return { flags: s.flags ?? {}, started: Array.isArray(s.started) ? s.started : [] };
  } catch {
    return { flags: {}, started: [] };
  }
}

function writeSettings(s: Settings): void {
  fs.mkdirSync(chatsDir(), { recursive: true });
  const file = settingsFile(), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
}

/** Remembers a start: the flags for next time, and the chat as one the manager started. */
export function rememberStart(a: AgentChoice, chat: { id: string | null; handle: string | null }): void {
  const s = readSettings();
  s.flags[a.kind] = a.flags.trim();
  // A month of starts is plenty to tell a chat the manager started.
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  s.started = [{ kind: a.kind, id: chat.id, handle: chat.handle, at: new Date().toISOString() }, ...s.started.filter((x) => x.at > cutoff)].slice(0, 200);
  writeSettings(s);
}

/** Whether the manager started this chat: by its id, or by its terminal. */
export function startedHere(c: { id: string; orca: { handle: string } | null }): boolean {
  return readSettings().started.some((x) => (x.id && x.id === c.id) || (!!x.handle && !!c.orca && x.handle === c.orca.handle));
}

/** What the start form offers: each agent, whether it's installed and its flags, and the chats to resume. */
export function agentOptions() {
  const s = readSettings();
  // Chats that held a review now closed: a new review can resume one, with what it learned there.
  const chats = listRecords()
    .filter((r) => r.status === 'closed')
    .flatMap((r) => r.chats.slice(0, 1).map((c) => ({ kind: c.kind, id: c.id, agent: c.agent, from: r.pr ? r.pr.replace(/^[^/]+\//, '') : r.title, when: r.closed })))
    .slice(0, 8);
  return {
    claude: { installed: has('claude'), flags: s.flags.claude ?? '' },
    codex: { installed: has('codex'), flags: s.flags.codex ?? '' },
    chats,
  };
}
