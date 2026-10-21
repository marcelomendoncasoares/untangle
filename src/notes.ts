// Local notes: comments kept on this machine, for a coding agent, instead of on GitHub. One file
// per review in the cache, keyed like the review's marks (pr-168), so they outlive
// pushes. Each note moves with its lines when the review moves to newer commits. An agent reads
// them with `untangle watch`, answers in their threads with `untangle reply`, may resolve them,
// and writes notes of its own with `untangle note`; what each agent has read is kept with the
// notes. An agent holds the review from one chat at a time: the page says where that chat is, and
// a Codex chat hears of new notes in a line untangle puts in it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './cache.js';
import { bell as chatBell, type Bell, type Chat } from './chats.js';
import { gitMaybe } from './exec.js';
import { writeAtomic } from './server.js';

export type Side = 'LEFT' | 'RIGHT';
/** Which notes a copy takes: the open ones, the open ones not copied yet, or all of them. */
export type Scope = 'open' | 'new' | 'all';
/** Who wrote a comment or resolved a note: null for you, else the agent's name. */
export type By = string | null;

export interface NoteComment {
  id: string;
  by: By;
  body: string;
  at: string;
  edited: string | null;
  /** When it reached the agents (the notes' sequence then); null while held. */
  sent: number | null;
}

export interface Note {
  n: number;
  path: string;
  /** On the whole file, not on lines. */
  file: boolean;
  side: Side;
  line: number | null;
  startSide: Side | null;
  startLine: number | null;
  /** The lines' text, on the review's commits. */
  code: string[];
  /** Where it was written: the commit, the lines and their text then. */
  wrote: { head: string; path: string; line: number | null; startLine: number | null; code: string[] };
  /** Commits since it was written changed its lines (it sits on the lines that replaced them), or removed them. */
  changed: boolean;
  gone: boolean;
  resolved: { by: By; at: string } | null;
  /** In a copy for the agent already. */
  copied: boolean;
  /** The GitHub thread it answers, quoted. */
  quote: { thread: string; author: string; body: string; url: string } | null;
  comments: NoteComment[];
}

/** What changed besides new comments, for the agents: by the notes' sequence. */
interface NoteEvent { seq: number; type: 'edit' | 'resolve' | 'reopen' | 'delete' | 'post'; n: number; by: By; id?: string; sent?: number | null }

interface Stored {
  version: 1;
  /** Where new comments go, once chosen. */
  mode: 'local' | 'github' | null;
  /** Live review: notes and replies reach agents as they're written; else when they're sent. */
  live: boolean;
  /** The line a copy for the agent opens with. */
  opening: string;
  scope: Scope;
  /** The commits the notes' lines are on. */
  base: string | null;
  head: string | null;
  next: number;
  seq: number;
  notes: Note[];
  events: NoteEvent[];
  /** What each agent has read, whether it heard how the review works, and the chat it holds it from. */
  agents: Record<string, { seen: number; first: string; told: boolean; chat?: string | null }>;
}

/** The review the notes are on, as they need it. */
export interface NotesContext {
  repo: string;
  base: string;
  head: string;
  /** owner/repo#168, or the repository's name. */
  name: string;
  branch: string | null;
  /** The head's checkout untangle made, reviewing a pull request from its link: an agent reads the code there. */
  checkout: string | null;
  /** The change a line is in: its chain's name and the commit that started it. */
  change(path: string, side: Side, line: number): { name: string; sha: string | null } | null;
  /** Posts into the pending review on GitHub: a thread on lines or a file, or a reply. Null without GitHub. */
  post: ((p: Post) => Promise<unknown>) | null;
}
export type Post = { thread: string; body: string } | { path: string; body: string; line?: number; side?: Side; startLine?: number; startSide?: Side };

export type NoteAction =
  | { action: 'add'; path: string; body: string; file?: boolean; side?: Side; line?: number; startSide?: Side; startLine?: number; quote?: { thread: string; author: string; body: string; url: string } }
  | { action: 'reply'; n: number; body: string }
  | { action: 'edit'; n: number; id: string; body: string }
  | { action: 'delete'; n: number; id?: string }
  | { action: 'resolve'; n: number; resolved: boolean }
  | { action: 'settings'; mode?: 'local' | 'github'; live?: boolean; opening?: string; scope?: Scope }
  | { action: 'copied'; ns: number[] }
  | { action: 'send' }
  | { action: 'post'; ns: number[] };

export class NoteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Where an agent's chat is, as the page says: a watch waits in it (or untangle rings it), it works
 * on notes it read, a line from untangle waits for its turn, nothing in it listens, or it ended.
 */
export type AgentState = 'listening' | 'working' | 'queued' | 'deaf' | 'left';

export interface AgentView {
  name: string;
  kind: Chat['kind'] | null;
  /** The chat holding the review for this agent. */
  chat: string | null;
  state: AgentState;
  /** The notes it works on, or that wait for its turn. */
  on: number[];
  /** Whether its chat is in a turn now, when untangle can tell. */
  busy: boolean | null;
  /** Its chat runs in an Orca terminal, which untangle can type into. */
  orca: boolean;
  /** The line Wake types into its chat: while it's idle, nothing listens and there's news for it. */
  wake: string | null;
  /** Why untangle couldn't reach its chat, last time it tried. */
  error: string | null;
}

export type WatchAnswer =
  | { text: string; notes: number; replies: number; first: boolean }
  | { idle: true; first: boolean }
  | { closed: true; paused?: true }
  | { taken: true };

/** An agent holding the review in this run: the chat it holds it from, and what it read last. */
interface Holder {
  chat: Chat | null;
  /** The command that reads what's new, as the agent types it. */
  again: string;
  watches: number;
  /** The notes its last watch brought that wait for its answer, the ones it answered since, and when. */
  on: number[];
  answered: Set<number>;
  read: number;
  /** When its chat last went idle, as far as untangle saw. */
  idle: number;
  /** The notes a line in its chat told it of, until it reads them, and when the line went in. */
  rung: number[] | null;
  rungAt: number;
  /** When the last note or reply had been sent as untangle last tried to ring its chat. */
  tried: number;
  error: string | null;
  /** A new chat took the review over: its first watch gets every open note. */
  fresh: boolean;
}

export const DEFAULT_OPENING = 'Discuss these with me before changing anything.';
// A burst of notes reaches a waiting agent together: this long after the last one.
const QUIET = Number(process.env.UNTANGLE_NOTES_QUIET) >= 0 && process.env.UNTANGLE_NOTES_QUIET ? Number(process.env.UNTANGLE_NOTES_QUIET) : 3000;
const MAX_BODY = 64 << 10;
const MAX_EVENTS = 500;

/** The notes file of a review: per repository, named like the review's marks. */
export const notesFile = (repoKey: string, key: string) => path.join(cacheRoot(), 'notes', repoKey, encodeURIComponent(key) + '.json');

const short = (sha: string) => sha.slice(0, 7);
const range = (from: number | null, to: number | null) => (to == null ? '' : from != null && from !== to ? `${from}-${to}` : String(to));
// A fence longer than any run of backticks in the code, so the code can't close it.
const fence = (code: string[]) => '`'.repeat(Math.max(3, ...code.map((l) => Math.max(0, ...(l.match(/`+/g) || []).map((r) => r.length + 1)))));
const FENCE_LANG: Record<string, string> = { dart: 'dart', yaml: 'yaml', yml: 'yaml', json: 'json', sql: 'sql', md: 'markdown', ts: 'ts', js: 'js', mjs: 'js', sh: 'sh', py: 'python', kt: 'kotlin', swift: 'swift', java: 'java', go: 'go', rs: 'rust', html: 'html', css: 'css', proto: 'proto' };
const langOf = (p: string) => FENCE_LANG[path.extname(p).slice(1).toLowerCase()] || '';
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
// "a", "a and b", "a, b and c".
const and = (parts: Array<string | number | false>) => {
  const p = parts.filter((x): x is string => typeof x === 'string' && x !== '');
  return p.length > 1 ? `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}` : p[0] || '';
};

/** A file's hunks between two commits, from `git diff -U0`: [old start, old count, new start, new count]. */
type Hunk = [number, number, number, number];
interface FileDiff { to: string | null; hunks: Hunk[]; binary: boolean }

// A path as git prints it in a diff's header: as it is, or quoted with C escapes.
const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(["\\tn])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c)) : s);

/** The files a diff changes, by their old path: where each went, and its hunks. */
export function parseDiff(text: string): Map<string, FileDiff> {
  const out = new Map<string, FileDiff>();
  let cur: { from: string | null; to: string | null; hunks: Hunk[]; binary: boolean; deleted: boolean; added: boolean; header: string } | null = null;
  let body = false;
  const flush = () => {
    // A new file was nowhere before.
    if (!cur || cur.added) return;
    // A file with no ---/+++ lines (a rename alone, a binary file) is named by its header.
    if (!cur.from) { const m = /^diff --git a\/(.*) b\/(.*)$/.exec(cur.header); if (m) { cur.from = m[1]; cur.to ??= m[2]; } }
    if (cur.from) out.set(cur.from, { to: cur.deleted ? null : cur.to, hunks: cur.hunks, binary: cur.binary });
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); cur = { from: null, to: null, hunks: [], binary: false, deleted: false, added: false, header: line }; body = false; continue; }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      body = true;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) cur.hunks.push([+m[1], m[2] == null ? 1 : +m[2], +m[3], m[4] == null ? 1 : +m[4]]);
      continue;
    }
    // Past the first hunk, every line is the file's own, whatever it starts with.
    if (body) continue;
    if (line.startsWith('deleted file mode')) cur.deleted = true;
    else if (line.startsWith('new file mode')) cur.added = true;
    else if (line.startsWith('rename from ')) cur.from = unquote(line.slice(12));
    else if (line.startsWith('rename to ')) cur.to = unquote(line.slice(10));
    else if (line.startsWith('--- ')) { const p = unquote(line.slice(4)); if (p !== '/dev/null') cur.from = p.replace(/^a\//, ''); }
    else if (line.startsWith('+++ ')) { const p = unquote(line.slice(4)); if (p === '/dev/null') cur.deleted = true; else cur.to = p.replace(/^b\//, ''); }
    else if (line.startsWith('Binary files ')) cur.binary = true;
  }
  flush();
  return out;
}

/** Where line `l` went through the hunks, or null when they changed it. */
export function mapLine(hunks: Hunk[], l: number): number | null {
  let off = 0;
  for (const [os, oc, , nc] of hunks) {
    if (oc && l >= os && l < os + oc) return null;
    // A pure insertion follows line os.
    if (oc ? os + oc - 1 < l : os < l) off += nc - oc;
  }
  return l + off;
}

/**
 * Where the lines from `from` to `to` went: unchanged lines shift, and an end the hunks changed
 * lands on the lines that replaced it. Null when they're gone, with nothing in their place.
 */
export function follow(hunks: Hunk[], from: number, to: number): { from: number; to: number; changed: boolean } | null {
  const changed = hunks.some(([os, oc]) => (oc ? os <= to && os + oc - 1 >= from : os >= from && os < to));
  const at = (l: number) => hunks.find(([os, oc]) => oc && l >= os && l < os + oc)!;
  let a = mapLine(hunks, from), b = mapLine(hunks, to);
  if (a == null) { const h = at(from); a = h[3] ? h[2] : null; }
  if (b == null) { const h = at(to); b = h[3] ? h[2] + h[3] - 1 : null; }
  if (a == null && b == null) return null;
  const [x, y] = [a ?? b!, b ?? a!];
  return { from: Math.min(x, y), to: Math.max(x, y), changed };
}

export class Notes {
  private data: Stored;
  private ctx: NotesContext | null = null;
  // Bumped on every change, the agents' coming and going included: pages ask again when it moves.
  private rev = 0;
  private closed = false;
  // Closed by a pause: its chats hear it'll be back.
  private paused = false;
  private lastSent = 0;
  private readonly waiters = new Set<() => void>();
  // The agents holding the review in this run, and the watches waiting now (each from a chat).
  private readonly holders = new Map<string, Holder>();
  private readonly watches = new Set<{ agent: string; chat: string | null; end(answer: WatchAnswer): void }>();
  private readonly lines = new Map<string, string[] | null>();
  // Looking at the chats now and then, so the page hears when one goes idle or ends; and the next
  // line for Codex's chats.
  private pulse: NodeJS.Timeout | null = null;
  private shown = '';
  private ringing: NodeJS.Timeout | null = null;

  constructor(
    readonly file: string,
    /** Told after each change: the pages hear of it. */
    private readonly changed: () => void = () => {},
    /** How untangle learns about the chats, and reaches them. */
    private readonly bell: Bell = chatBell,
    /** An agent's session started the review: its comments start as notes, for the agent. */
    private readonly byAgent = false,
  ) {
    this.data = { version: 1, mode: null, live: true, opening: DEFAULT_OPENING, scope: 'open', base: null, head: null, next: 1, seq: 0, notes: [], events: [], agents: {} };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Stored>;
      if (saved && saved.version === 1 && Array.isArray(saved.notes)) this.data = { ...this.data, ...saved };
    } catch {
      // No notes yet.
    }
  }

  /** The review the notes are on now: they move there from the commits they were on. */
  attach(ctx: NotesContext): void {
    this.ctx = ctx;
    this.lines.clear();
    const d = this.data;
    if (d.notes.length && d.head && (d.head !== ctx.head || d.base !== ctx.base)) this.move({ base: d.base || ctx.base, head: d.head }, ctx);
    d.base = ctx.base;
    d.head = ctx.head;
    if (d.notes.length) this.save();
    this.touch();
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.data));
  }

  private touch() {
    this.rev++;
    if (this.holders.size) this.shown = JSON.stringify(this.agents());
    this.changed();
    this.waiters.forEach((w) => w());
    this.ringLater();
  }

  /** The text of a file at a commit, by line; null when it isn't there. */
  private fileAt(sha: string, p: string): string[] | null {
    const key = sha + ':' + p;
    if (!this.lines.has(key)) {
      if (this.lines.size > 200) this.lines.clear();
      const text = this.ctx ? gitMaybe(this.ctx.repo, 'show', `${sha}:${p}`) : null;
      this.lines.set(key, text == null ? null : text.replace(/\n$/, '').split('\n'));
    }
    return this.lines.get(key)!;
  }

  private codeOf(sha: string, p: string, from: number | null, to: number | null): string[] {
    if (to == null) return [];
    const all = this.fileAt(sha, p) || [];
    return all.slice((from ?? to) - 1, to);
  }

  /** Moves every note from the commits it's on to the review's, through the diffs between them. */
  private move(from: { base: string; head: string }, ctx: NotesContext) {
    const diff = (a: string, b: string) => {
      if (a === b) return new Map<string, FileDiff>();
      // An old head this clone doesn't have may still be on GitHub.
      if (gitMaybe(ctx.repo, 'cat-file', '-e', `${a}^{commit}`) === null) gitMaybe(ctx.repo, 'fetch', '--quiet', '--no-tags', 'origin', a);
      const text = gitMaybe(ctx.repo, '-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', a, b, '--');
      return text == null ? null : parseDiff(text);
    };
    const diffs = { RIGHT: diff(from.head, ctx.head), LEFT: diff(from.base, ctx.base) };
    for (const note of this.data.notes) {
      if (note.gone) continue;
      const sha = note.side === 'LEFT' ? ctx.base : ctx.head;
      const d = diffs[note.side];
      if (!d) {
        // Without the old commit, the lines stay where they were: changed if their text did.
        const now = this.codeOf(sha, note.path, note.startLine, note.line);
        if (now.join('\n') !== note.code.join('\n')) note.changed = true;
        note.code = now;
        continue;
      }
      const f = d.get(note.path);
      if (f && f.to === null) { note.gone = true; continue; }
      if (f) note.path = f.to!;
      if (f && !note.file) {
        const r = f.binary ? null : follow(f.hunks, note.startLine ?? note.line!, note.line!);
        if (!r) { note.gone = true; continue; }
        note.changed ||= r.changed;
        // A line replaced by several leaves its note on all of them.
        note.line = r.to;
        note.startLine = r.from !== r.to ? r.from : null;
        note.startSide = note.startLine == null ? null : note.side;
      } else if (f && (f.hunks.length || f.binary)) note.changed = true;
      note.code = this.codeOf(sha, note.path, note.startLine, note.line);
    }
  }

  private note(n: number): Note {
    const note = this.data.notes.find((x) => x.n === n);
    if (!note) throw new NoteError(`there is no note N${n}${this.data.notes.length ? ` (the notes are ${this.data.notes.map((x) => 'N' + x.n).join(', ')})` : ''}`, 404);
    return note;
  }

  private body(text: unknown): string {
    const body = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
    if (!body) throw new NoteError('a note needs some text');
    if (body.length > MAX_BODY) throw new NoteError('that is too long for a note');
    return body;
  }

  /** A comment, sent to the agents now, or held for later when live review is off (yours only). */
  private comment(by: By, body: string): NoteComment {
    const held = by === null && !this.data.live;
    const c: NoteComment = { id: crypto.randomBytes(6).toString('hex'), by, body, at: new Date().toISOString(), edited: null, sent: held ? null : ++this.data.seq };
    if (!held) this.lastSent = Date.now();
    return c;
  }

  /** A new note, on lines of the review's commits or on a whole file: yours (by null), or an agent's. */
  private newNote(by: By, a: Extract<NoteAction, { action: 'add' }>): Note {
    const ctx = this.ctx!;
    const d = this.data;
    const body = this.body(a.body);
    const file = !!a.file || a.line == null;
    if (typeof a.path !== 'string') throw new NoteError('which file?');
    // A note on a deleted file is on the base's.
    const side: Side = a.side === 'LEFT' || (file && !this.fileAt(ctx.head, a.path)) ? 'LEFT' : 'RIGHT';
    const sha = side === 'LEFT' ? ctx.base : ctx.head;
    const text = this.fileAt(sha, a.path);
    if (!text) throw new NoteError(`${a.path} is not a file of this review${side === 'LEFT' ? ' on its base' : ''}`);
    const line = file ? null : Number(a.line);
    // A note's lines are on one side: the page sends a range across both as its new lines.
    const startLine = file || a.startLine == null || Number(a.startLine) === line ? null : Number(a.startLine);
    if (!file && (!Number.isInteger(line) || line! < 1 || (startLine != null && (!Number.isInteger(startLine) || startLine < 1 || startLine > line!)))) throw new NoteError('which lines?');
    if (line != null && line > text.length) throw new NoteError(`${a.path} has ${plural(text.length, 'line', 'lines')} at ${short(sha)}`);
    const startSide = startLine == null ? null : side;
    const code = this.codeOf(sha, a.path, startLine, line);
    const q = a.quote && typeof a.quote.thread === 'string' ? { thread: a.quote.thread, author: String(a.quote.author || ''), body: String(a.quote.body || '').slice(0, 4000), url: String(a.quote.url || '') } : null;
    const note: Note = {
      n: d.next++, path: a.path, file, side, line, startSide, startLine, code,
      wrote: { head: ctx.head, path: a.path, line, startLine, code }, changed: false, gone: false,
      resolved: null, copied: false, quote: q, comments: [this.comment(by, body)],
    };
    d.notes.push(note);
    return note;
  }

  private event(e: Omit<NoteEvent, 'seq'>) {
    this.data.events.push({ ...e, seq: ++this.data.seq });
    if (this.data.events.length > MAX_EVENTS) this.data.events.splice(0, this.data.events.length - MAX_EVENTS);
    this.lastSent = Date.now();
  }

  // ---- What the agent reads: the same text for the copy, `untangle notes` and `untangle watch`.

  private where(note: Note): string {
    if (note.file) return `${note.path} (the whole file)`;
    const at = `${note.path}:${range(note.startLine, note.line)}`;
    return note.side === 'LEFT' ? `${at}, removed lines (numbered as on the base)` : at;
  }

  /** The head of a copy: what the notes are on. */
  header(): string {
    const ctx = this.ctx;
    if (!ctx) return 'My review notes.';
    return `My review notes on ${ctx.name}${ctx.branch ? ` (branch ${ctx.branch}, at ${short(ctx.head)})` : ` (at ${short(ctx.head)})`}. Line numbers are on that commit.${this.checkedOut()}`;
  }

  // Where that commit's code is, when untangle cloned it for a pull request's link: an agent with
  // no copy of the repository reads and searches it there, instead of through GitHub.
  private checkedOut(): string {
    const at = this.ctx?.checkout;
    return at ? ` That commit is checked out at ${at}: read and search its code there, and change nothing (untangle uses it).` : '';
  }

  /** One note for the agent: where it is, the change it's in, its code and its thread. */
  noteText(note: Note): string {
    const lines = [`N${note.n} · ${this.where(note)}${note.resolved ? ' (resolved)' : ''}`];
    const change = !note.file && note.line != null && !note.gone && this.ctx ? this.ctx.change(note.path, note.side, note.line) : null;
    if (change) lines.push(`In the change "${change.name}"${change.sha ? ` (${short(change.sha)})` : ''}`);
    if (note.quote) lines.push(`Answering ${note.quote.author} on GitHub (${note.quote.url}):`, ...note.quote.body.split('\n').map((l) => '> ' + l));
    if (note.gone) lines.push(`Gone since ${short(note.wrote.head)}, where I wrote this. The lines below are the ones it was on then.`);
    else if (note.changed) lines.push(`Changed since ${short(note.wrote.head)}, where I wrote this. The lines below are the new ones.`);
    const code = note.gone ? note.wrote.code : note.code;
    if (code.length) { const f = fence(code); lines.push(f + langOf(note.path), ...code, f); }
    const [first, ...replies] = note.comments;
    lines.push(first.by ? `${first.by}: ${first.body}` : first.body, ...replies.map((c) => `${c.by ?? 'You'}: ${c.body}`));
    return lines.join('\n') + '\n';
  }

  private inScope(scope: Scope): Note[] {
    const open = (n: Note) => !n.resolved;
    return this.data.notes.filter(scope === 'all' ? () => true : scope === 'new' ? (n) => open(n) && !n.copied : open);
  }

  /** The copy for the agent: the head, the opening line, then the notes. */
  exportText(scope: Scope, opening = this.data.opening): string {
    const list = this.inScope(scope);
    return [this.header() + '\n', opening.trim() && opening.trim() + '\n', ...(list.length ? list.map((n) => this.noteText(n)) : ['No notes to send.\n'])].filter(Boolean).join('\n');
  }

  // ---- The page

  /** What the page shows: the settings, the notes with their text, and the agents. */
  view() {
    const d = this.data;
    const agents = this.agents();
    // A note no agent has read waits for one: unless every agent holding the review is deaf or gone.
    const nobody = agents.length > 0 && agents.every((a) => a.state === 'deaf' || a.state === 'left');
    const read = (note: Note) => {
      const sent = note.comments[0].sent;
      if (note.comments[0].by !== null) return null;
      if (sent == null) return 'held';
      const by = Object.entries(d.agents).find(([, a]) => a.seen >= sent);
      return by ? { read: by[0] } : nobody ? 'nobody' : Object.keys(d.agents).length ? 'queued' : null;
    };
    return {
      // Where comments go, until you choose: notes, for a review an agent started or one that has some.
      rev: this.rev, mode: d.mode ?? (this.byAgent || d.notes.length ? 'local' : null), live: d.live, opening: d.opening, scope: d.scope, head: d.head, header: this.header(),
      held: d.notes.reduce((k, n) => k + n.comments.filter((c) => c.by === null && c.sent == null).length, 0),
      notes: d.notes.map((n) => ({ ...n, text: this.noteText(n), status: read(n) })),
      agents,
    };
  }

  /** Whether a note waits for an agent's answer: it's open, and the agent didn't have the last word. */
  private awaits(agent: string, n: number): boolean {
    const note = this.data.notes.find((x) => x.n === n);
    return !!note && !note.resolved && note.comments[note.comments.length - 1].by !== agent;
  }

  /**
   * The agents holding the review in this run, and where each one's chat is, from what untangle
   * sees: a watch waiting, whether the agent's process runs, and whether its chat is in a turn.
   */
  agents(): AgentView[] {
    return [...this.holders].map(([name, h]) => {
      const chat = h.chat;
      const alive = chat ? this.bell.alive(chat) : null;
      const turn = chat && alive !== false ? this.bell.busy(chat) : null;
      if (turn && !turn.busy) h.idle = Math.max(h.idle, turn.since);
      // A line Wake typed into Claude's chat that its turn ended without reading.
      if (h.rung && chat?.kind === 'claude' && h.idle > h.rungAt) h.rung = null;
      // Working: in a turn that its last watch's notes started or came into, or, when untangle
      // can't tell, until it answers them.
      const pending = h.on.filter((n) => !h.answered.has(n) && this.awaits(name, n));
      const working = turn ? turn.busy && h.read > h.idle : pending.length > 0;
      const state: AgentState = h.watches ? 'listening'
        : alive === false ? 'left'
          : h.rung ? 'queued'
            : working ? 'working'
              : chat?.kind === 'codex' ? 'listening' : 'deaf';
      const news = state === 'deaf' && chat?.orca && turn && !turn.busy ? this.unseen(name) : null;
      return {
        name, kind: chat?.kind ?? null, chat: chat?.id ?? null, state,
        on: state === 'queued' ? h.rung! : state === 'working' ? (pending.length ? pending : h.on) : [],
        busy: turn ? turn.busy : null, orca: !!chat?.orca, wake: news && news.count ? this.line(name, news) : null, error: h.error,
      };
    });
  }

  /** The chats holding the review in this run, with the name each one's agent answers as. */
  chats(): Array<{ agent: string; chat: Chat }> {
    return [...this.holders].flatMap(([agent, h]) => (h.chat ? [{ agent, chat: h.chat }] : []));
  }

  /** The open notes an agent had the last word on: where they are, who, and whether it wrote them. */
  waiting(): Array<{ n: number; path: string; line: number | null; by: string; wrote: boolean }> {
    return this.data.notes
      .filter((n) => !n.resolved && n.comments[n.comments.length - 1].by !== null)
      .map((n) => ({ n: n.n, path: n.path, line: n.line, by: n.comments[n.comments.length - 1].by!, wrote: n.comments[0].by !== null }));
  }

  /** Open notes, and those an agent had the last word on: they wait for your answer. */
  counts(): { open: number; waiting: number } {
    const open = this.data.notes.filter((n) => !n.resolved);
    return { open: open.length, waiting: open.filter((n) => n.comments[n.comments.length - 1].by !== null).length };
  }

  /** Whether an agent holds the review now: untangle then looks for its commits more often. */
  watched(): boolean {
    return this.agents().some((a) => a.state === 'listening' || a.state === 'working' || a.state === 'queued');
  }

  async act(a: NoteAction): Promise<ReturnType<Notes['view']> & { conversation?: unknown }> {
    const d = this.data;
    const ctx = this.ctx;
    if (!ctx) throw new NoteError('the review is still being built', 503);
    let conversation: unknown;
    switch (a.action) {
      case 'add':
        this.newNote(null, a);
        break;
      case 'reply':
        this.note(a.n).comments.push(this.comment(null, this.body(a.body)));
        break;
      case 'edit': {
        const note = this.note(a.n);
        const c = note.comments.find((x) => x.id === a.id);
        if (!c || c.by !== null) throw new NoteError('only your own comments can be edited');
        c.body = this.body(a.body);
        c.edited = new Date().toISOString();
        if (c.sent != null) this.event({ type: 'edit', n: note.n, by: null, id: c.id });
        break;
      }
      case 'delete': {
        const note = this.note(a.n);
        if (a.id && a.id !== note.comments[0].id) {
          const i = note.comments.findIndex((x) => x.id === a.id && x.by === null);
          if (i < 0) throw new NoteError('only your own comments can be deleted');
          note.comments.splice(i, 1);
          break;
        }
        d.notes.splice(d.notes.indexOf(note), 1);
        if (note.comments[0].sent != null) this.event({ type: 'delete', n: note.n, by: null, sent: note.comments[0].sent });
        break;
      }
      case 'resolve': {
        const note = this.note(a.n);
        if (!!note.resolved === !!a.resolved) break;
        note.resolved = a.resolved ? { by: null, at: new Date().toISOString() } : null;
        if (note.comments[0].sent != null) this.event({ type: a.resolved ? 'resolve' : 'reopen', n: note.n, by: null });
        break;
      }
      case 'settings': {
        if (a.mode === 'local' || a.mode === 'github') d.mode = a.mode;
        if (typeof a.opening === 'string') d.opening = a.opening.slice(0, 4000);
        if (a.scope === 'open' || a.scope === 'new' || a.scope === 'all') d.scope = a.scope;
        if (typeof a.live === 'boolean' && a.live !== d.live) {
          d.live = a.live;
          // Back to live, what was held goes now.
          if (a.live) this.release();
        }
        break;
      }
      case 'copied':
        (Array.isArray(a.ns) ? a.ns : []).forEach((n) => { const note = d.notes.find((x) => x.n === n); if (note) note.copied = true; });
        break;
      case 'send':
        this.release();
        break;
      case 'post': {
        if (!ctx.post) throw new NoteError('Posting needs the pull request on GitHub, through gh (gh auth login).');
        const list = (Array.isArray(a.ns) ? a.ns : []).map((n) => this.note(n)).filter((n) => !n.resolved && !n.gone);
        if (!list.length) throw new NoteError('no open notes to post');
        for (const note of list) {
          const body = note.comments[0].body;
          const p: Post = note.quote ? { thread: note.quote.thread, body }
            : note.file ? { path: note.path, body }
              : { path: note.path, body, line: note.line!, side: note.side, ...(note.startLine != null ? { startLine: note.startLine, startSide: note.startSide || note.side } : {}) };
          try {
            conversation = await ctx.post(p);
          } catch (e) {
            // The ones posted so far have left the notes.
            this.save();
            this.touch();
            throw new NoteError(`N${note.n} could not be posted: ${(e as Error).message}`, 502);
          }
          d.notes.splice(d.notes.indexOf(note), 1);
          if (note.comments[0].sent != null) this.event({ type: 'post', n: note.n, by: null, sent: note.comments[0].sent });
        }
        break;
      }
      default:
        throw new NoteError('no such action');
    }
    this.save();
    this.touch();
    return conversation === undefined ? this.view() : { ...this.view(), conversation };
  }

  /** Sends what live review held: your notes and replies, in the order they were written. */
  private release() {
    const held = this.data.notes.flatMap((n) => n.comments.filter((c) => c.by === null && c.sent == null)).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    held.forEach((c) => { c.sent = ++this.data.seq; });
    if (held.length) this.lastSent = Date.now();
  }

  // ---- The agents

  /** The agent's holder in this run, made when it first asks. */
  private holder(agent: string): Holder {
    let h = this.holders.get(agent);
    if (!h) {
      h = { chat: null, again: 'untangle watch', watches: 0, on: [], answered: new Set(), read: 0, idle: 0, rung: null, rungAt: 0, tried: 0, error: null, fresh: false };
      this.holders.set(agent, h);
      this.watchChats();
    }
    return h;
  }

  /**
   * A note an agent writes, from its own review of the change: a thread on its lines for you to
   * answer, as you answer each other on GitHub.
   */
  write(agent: string, a: Omit<Extract<NoteAction, { action: 'add' }>, 'action' | 'quote'>, chat: string | null = null): { n: number; where: string; head: string; code: string[]; other: boolean } {
    if (!this.ctx) throw new NoteError('the review is still being built', 503);
    const note = this.newNote(agent, { ...a, action: 'add' });
    this.save();
    this.touch();
    return { n: note.n, where: this.where(note), head: short(note.side === 'LEFT' ? this.ctx.base : this.ctx.head), code: note.code, other: this.other(agent, chat) };
  }

  /** Whether another chat of the agent holds the review than the one asking. */
  other(agent: string, chat: string | null): boolean {
    const held = this.data.agents[agent]?.chat;
    return !!chat && !!held && held !== chat;
  }

  /** An agent's answer in a note's thread, and its resolving the note when it's done. */
  reply(agent: string, n: number, body: string | null, resolve: boolean, chat: string | null = null): { n: number; resolved: boolean; other: boolean } {
    const note = this.note(n);
    if (body != null) note.comments.push(this.comment(agent, this.body(body)));
    if (resolve && !note.resolved) {
      note.resolved = { by: agent, at: new Date().toISOString() };
      this.event({ type: 'resolve', n, by: agent });
    }
    this.holders.get(agent)?.answered.add(n);
    this.save();
    this.touch();
    return { n, resolved: !!note.resolved, other: this.other(agent, chat) };
  }

  /** What an agent hasn't read: comments by others, and what changed on notes it has read. */
  private unseen(agent: string) {
    const seen = this.data.agents[agent]?.seen ?? 0;
    const fresh = (c: NoteComment) => c.sent != null && c.sent > seen && c.by !== agent;
    const knew = (note: Note) => note.comments[0].sent != null && note.comments[0].sent <= seen;
    const notes: Note[] = [], threads: Note[] = [], lines: string[] = [];
    let closed = 0;
    this.data.notes.forEach((note) => {
      if (fresh(note.comments[0])) notes.push(note);
      else if (note.comments.slice(1).some(fresh)) threads.push(note);
    });
    const told = new Set([...notes, ...threads].map((x) => x.n));
    // A thread told in full shows its edits, and says itself who last resolved or reopened its note.
    const states = new Map<number, string>();
    this.data.events.filter((e) => e.seq > seen && e.by !== agent).forEach((e) => {
      const note = this.data.notes.find((x) => x.n === e.n);
      if (e.type === 'delete' || e.type === 'post') { if (e.sent != null && e.sent <= seen) lines.push(`N${e.n} · ${e.type === 'post' ? 'posted to GitHub: it left the notes.' : `${e.by ?? 'you'} deleted it.`}`); return; }
      if (!note || !knew(note)) return;
      if (e.type === 'edit') { const c = told.has(note.n) ? null : note.comments.find((x) => x.id === e.id); if (c) lines.push(`N${note.n} · ${this.where(note)} · ${e.by ?? 'you'} edited ${c === note.comments[0] ? 'the note' : 'a reply'}:\n${c.body}`); return; }
      const state = `${e.type === 'resolve' ? 'resolved' : 'reopened'} by ${e.by ?? 'you'}`;
      if (told.has(note.n)) states.set(note.n, state);
      else { lines.push(`N${note.n} · ${this.where(note)} · ${state}.`); if (e.type === 'resolve') closed++; }
    });
    const replies = threads.reduce((k, note) => k + note.comments.slice(1).filter(fresh).length, 0);
    // A note resolved only ends the talk on it: it comes with the next news, and wakes no one.
    return { notes, threads, lines, states, replies, count: notes.length + replies + lines.length - closed };
  }

  private threadText(note: Note, state?: string): string {
    const [first, ...rest] = note.comments;
    return [`N${note.n} · ${this.where(note)} · ${rest.length === 1 ? 'a reply' : 'replies'} in its thread${state ? ` · ${state}` : ''}`, ...(first.by ? `${first.by}: ${first.body}` : first.body).split('\n').map((l) => '> ' + l), ...rest.map((c) => `${c.by ?? 'You'}: ${c.body}`)].join('\n') + '\n';
  }

  /**
   * Delivers what's new to an agent, as text, and remembers that it read it. A chat that took the
   * review over gets every open note with its thread instead: it knows none of them.
   */
  private deliver(agent: string) {
    const h = this.holder(agent);
    const a = this.data.agents[agent];
    const ctx = this.ctx!;
    const opening = this.data.opening.trim();
    const at = `on ${ctx.name} at ${short(ctx.head)}. Line numbers are on that commit.${this.checkedOut()}`;
    let text: string, notes: Note[], replies = 0, read: Note[];
    if (h.fresh) {
      notes = read = this.data.notes.filter((n) => !n.resolved);
      text = `untangle: you hold this review now: another ${agent} chat held it. Here ${notes.length === 1 ? 'is its open note' : `are its ${notes.length} open notes`}, ${at}\n\n`
        + [opening && opening + '\n', ...notes.map((n) => this.noteText(n))].filter(Boolean).join('\n');
    } else {
      const u = this.unseen(agent);
      ({ notes, replies } = u);
      read = [...u.notes, ...u.threads];
      const parts: string[] = [];
      if (notes.length) {
        if (opening) parts.push(opening + '\n');
        parts.push(...notes.map((n) => this.noteText(n)));
      }
      parts.push(...u.threads.map((n) => this.threadText(n, u.states.get(n.n))), ...u.lines.map((l) => l + '\n'));
      text = `untangle: ${and([notes.length && plural(notes.length, 'note', 'notes'), replies && plural(replies, 'reply', 'replies'), u.lines.length && plural(u.lines.length, 'change', 'changes')])} you haven’t read, ${at}\n\n${parts.join('\n')}`;
    }
    const first = !a.told;
    a.seen = this.data.seq;
    a.told = true;
    Object.assign(h, { fresh: false, on: read.map((n) => n.n).filter((n) => this.awaits(agent, n)).sort((x, y) => x - y), answered: new Set(), read: Date.now(), rung: null, error: null });
    this.save();
    return { text, notes: notes.length, replies, first };
  }

  /**
   * Waits for what an agent hasn't read, a moment after the last of it, then delivers it. Settles
   * early when the review closes, when the wait runs out, when the agent stops asking, or when
   * another chat of the agent takes the review over. A brief watch doesn't wait for news: Codex
   * hears of it from untangle instead.
   */
  watch(agent: string, opts: { timeout: number; signal?: AbortSignal; chat?: Chat | null; again?: string; brief?: boolean }): Promise<WatchAnswer> {
    const d = this.data;
    const a = (d.agents[agent] ??= { seen: 0, first: new Date().toISOString(), told: false });
    const h = this.holder(agent);
    const chat = opts.chat ?? null;
    if (chat) {
      // Another chat of the agent takes the review over: the one that held it hears so, and this
      // one hears how the review works, with every open note.
      if (a.told && a.chat !== chat.id) {
        this.watches.forEach((w) => { if (w.agent === agent && w.chat !== chat.id) w.end({ taken: true }); });
        a.told = false;
        Object.assign(h, { fresh: d.notes.some((n) => !n.resolved), on: [], answered: new Set(), rung: null, error: null });
      }
      a.chat = chat.id;
      h.chat = chat;
    }
    if (opts.again) h.again = opts.again;
    this.save();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null, quiet: NodeJS.Timeout | null = null;
      const w = { agent, chat: chat?.id ?? null, end: (answer: WatchAnswer) => done(answer) };
      const done = (answer: WatchAnswer | null) => {
        if (!this.watches.delete(w)) return;
        this.waiters.delete(check);
        if (timer) clearTimeout(timer);
        if (quiet) clearTimeout(quiet);
        opts.signal?.removeEventListener('abort', aborted);
        h.watches--;
        this.touch();
        if (answer) resolve(answer);
      };
      const idle = (): WatchAnswer => { const first = !a.told; a.told = true; this.save(); return { idle: true, first }; };
      const check = () => {
        if (this.closed) return done(this.paused ? { closed: true, paused: true } : { closed: true });
        if (!this.ctx) return;
        if (h.fresh) return done(this.deliver(agent));
        if (!this.unseen(agent).count) { if (opts.brief) done(idle()); return; }
        const wait = QUIET - (Date.now() - this.lastSent);
        if (wait > 0) { if (!quiet) quiet = setTimeout(() => { quiet = null; check(); }, wait); return; }
        done(this.deliver(agent));
      };
      const aborted = () => done(null);
      this.watches.add(w);
      h.watches++;
      if (opts.signal?.aborted) return aborted();
      opts.signal?.addEventListener('abort', aborted);
      if (opts.timeout > 0) timer = setTimeout(() => done(idle()), opts.timeout);
      this.waiters.add(check);
      this.touch();
      check();
    });
  }

  /** The line untangle puts in an agent's chat: what's new, and the command that reads it. */
  private line(agent: string, u: { notes: Note[]; replies: number; lines: string[]; count: number }): string {
    const ctx = this.ctx!;
    const what = and([u.notes.length && plural(u.notes.length, 'new note', 'new notes'), u.replies && plural(u.replies, 'new reply', 'new replies'), u.lines.length && plural(u.lines.length, 'change', 'changes')]);
    const title = /#\d+$/.exec(ctx.name)?.[0] ?? ctx.branch ?? ctx.name;
    return `untangle: ${what} on the review of ${title}. Run ${this.holders.get(agent)?.again || 'untangle watch'} to read ${u.count === 1 ? 'it' : 'them'}.`;
  }

  // A Codex chat with news since untangle last tried it, no line from untangle unread there, and
  // no watch of its own reading now.
  private ringable(name: string, h: Holder): boolean {
    return h.chat?.kind === 'codex' && !h.rung && !h.watches && !h.fresh && this.lastSent > h.tried && this.unseen(name).count > 0;
  }

  /** A Codex chat holding the review hears of what's new, a moment after the last of it. */
  private ringLater() {
    if (this.ringing || this.closed || !this.ctx || ![...this.holders].some(([name, h]) => this.ringable(name, h))) return;
    this.ringing = setTimeout(() => { this.ringing = null; this.ring(); }, Math.max(0, QUIET - (Date.now() - this.lastSent)));
    this.ringing.unref();
  }

  /** One line in each Codex chat with news: no second one while that one waits unread. */
  private ring() {
    if (Date.now() - this.lastSent < QUIET) return this.ringLater();
    let rang = false;
    for (const [name, h] of this.holders) {
      if (!this.ringable(name, h)) continue;
      h.tried = this.lastSent;
      const chat = h.chat!;
      if (this.bell.alive(chat) === false) continue;
      const u = this.unseen(name);
      Object.assign(h, { rung: [...u.notes, ...u.threads].map((n) => n.n).sort((x, y) => x - y), rungAt: Date.now(), error: null });
      rang = true;
      void this.bell.ring(chat, this.line(name, u)).then((err) => {
        if (!err || h.chat !== chat || !h.rung) return;
        Object.assign(h, { rung: null, error: `untangle couldn’t put a line in ${name}’s chat: ${err}` });
        this.touch();
      });
    }
    if (rang) this.touch();
  }

  /** Types the line into an idle Claude chat that nothing in listens, in Orca: Wake, on the page. */
  async wake(agent: string): Promise<ReturnType<Notes['view']>> {
    const h = this.holders.get(agent), a = this.agents().find((x) => x.name === agent);
    if (!h?.chat || !a?.wake) throw new NoteError(a && a.state !== 'deaf' ? `${agent} ${a.state === 'left' ? 'left' : 'is listening'}` : `untangle can’t type into ${agent}’s chat now`, 409);
    const err = await this.bell.wake(h.chat, a.wake);
    if (err) throw new NoteError(`untangle couldn’t type into ${agent}’s chat: ${err}`, 502);
    const u = this.unseen(agent);
    Object.assign(h, { rung: [...u.notes, ...u.threads].map((n) => n.n).sort((x, y) => x - y), rungAt: Date.now() });
    this.touch();
    return this.view();
  }

  /** Looks at the chats every few seconds, so the page hears when one goes idle, or ends. */
  private watchChats() {
    if (this.pulse || this.closed) return;
    this.pulse = setInterval(() => {
      const now = JSON.stringify(this.agents());
      if (now !== this.shown) this.touch();
    }, 2000);
    this.pulse.unref();
  }

  /** The review is closing, or pausing: waiting agents hear so. */
  close(paused = false): void {
    this.closed = true;
    this.paused = paused;
    this.waiters.forEach((w) => w());
    if (this.pulse) clearInterval(this.pulse);
    if (this.ringing) clearTimeout(this.ringing);
    this.pulse = this.ringing = null;
  }

  /** Changes so far: a page whose notes are older asks again. */
  get revision(): number { return this.rev; }
}
