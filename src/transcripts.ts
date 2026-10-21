// The last lines of an agent's chat, read from the agent's own transcript: Claude keeps each
// session in a file under its projects folder, Codex each thread in a log under its sessions
// folder. The manager shows them in a review's open row, as each agent prints them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatLog } from './chats.js';

/** A line of a chat: what you said, a tool the agent ran, what came out of it, or its words. */
export interface TailLine { kind: 'you' | 'tool' | 'out' | 'say'; text: string }

/** A chat to read: its agent, its id, and where that agent keeps its state. */
export interface ChatRef { kind: 'claude' | 'codex'; id: string; home?: string | null; folder?: string | null }

// How far back the tail of a transcript is read: a turn's last steps fit.
const TAIL_BYTES = 256 << 10;

const first = (text: string) => text.trim().split('\n')[0].trim();
const clip = (text: string, n = 160) => (text.length > n ? text.slice(0, n - 1).trimEnd() + '…' : text);

/** The end of a file, as whole lines. */
function tailLines(file: string): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    // The first may start mid-line.
    return (start > 0 ? lines.slice(1) : lines).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

const parse = (line: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
};

// Claude names a tool and its input: the command, for Bash; the file, for the ones that read or write one.
function claudeTool(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
  if (typeof input.command === 'string') return `${name}(${first(input.command)})`;
  if (file) return `${name}(${file.split('/').slice(-3).join('/')})`;
  return name;
}

/** Claude's session file: under its projects folder, in the folder named after where it ran. */
function claudeFile(c: ChatRef): string | null {
  const projects = path.join(c.home || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  if (c.folder) {
    const named = path.join(projects, c.folder.replace(/[^A-Za-z0-9]/g, '-'), `${c.id}.jsonl`);
    if (fs.existsSync(named)) return named;
  }
  try {
    for (const dir of fs.readdirSync(projects)) {
      const file = path.join(projects, dir, `${c.id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // No projects yet.
  }
  return null;
}

function claudeTail(file: string): TailLine[] {
  const out: TailLine[] = [];
  for (const line of tailLines(file)) {
    const e = parse(line);
    if (!e || e.isSidechain || e.isMeta) continue;
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (e.type === 'user') {
      if (typeof content === 'string') { if (!content.startsWith('<')) out.push({ kind: 'you', text: first(content) }); continue; }
      for (const p of (Array.isArray(content) ? content : []) as Array<{ type?: string; text?: string; content?: unknown }>) {
        if (p.type === 'text' && p.text && !p.text.startsWith('<')) out.push({ kind: 'you', text: first(p.text) });
        if (p.type === 'tool_result') {
          const text = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? (p.content as Array<{ text?: string }>).map((x) => x.text || '').join('\n') : '';
          if (first(text)) out.push({ kind: 'out', text: first(text) });
        }
      }
    }
    if (e.type === 'assistant') {
      for (const p of (Array.isArray(content) ? content : []) as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
        if (p.type === 'text' && p.text?.trim()) out.push({ kind: 'say', text: p.text.trim().replace(/\s+/g, ' ') });
        if (p.type === 'tool_use' && p.name) out.push({ kind: 'tool', text: claudeTool(p.name, p.input || {}) });
      }
    }
  }
  return out;
}

// Codex's tool calls carry their command as arguments (a list or a string), or as code to run.
function codexTool(p: { name?: string; arguments?: string; input?: string }): string {
  let args: { command?: unknown; cmd?: unknown } = {};
  try {
    args = JSON.parse(p.arguments || '{}');
  } catch {
    // Not JSON.
  }
  const cmd = Array.isArray(args.command) ? args.command.join(' ') : typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : p.input || p.name || '';
  return `Ran ${first(cmd)}`;
}

function codexTail(file: string): TailLine[] {
  const out: TailLine[] = [];
  for (const line of tailLines(file)) {
    const e = parse(line);
    if (!e || e.type !== 'response_item') continue;
    const p = (e.payload || {}) as { type?: string; role?: string; content?: Array<{ type?: string; text?: string }>; name?: string; arguments?: string; input?: string; output?: unknown };
    if (p.type === 'message') {
      const text = (p.content || []).map((c) => c.text || '').join('\n').trim();
      if (!text || text.startsWith('<')) continue;
      out.push(p.role === 'user' ? { kind: 'you', text: first(text) } : { kind: 'say', text: text.replace(/\s+/g, ' ') });
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') out.push({ kind: 'tool', text: codexTool(p) });
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const o = p.output;
      const text = typeof o === 'string' ? o : o && typeof o === 'object' ? String((o as { output?: unknown }).output ?? '') : '';
      if (first(text)) out.push({ kind: 'out', text: first(text) });
    }
  }
  return out;
}

/** The last lines of a chat, as its agent wrote them; null when its transcript isn't found. */
export function chatTail(c: ChatRef, max = 5): TailLine[] | null {
  const file = c.kind === 'claude' ? claudeFile(c) : chatLog({ kind: 'codex', id: c.id, home: c.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex') });
  if (!file) return null;
  const lines = c.kind === 'claude' ? claudeTail(file) : codexTail(file);
  return lines.slice(-max).map((l) => ({ kind: l.kind, text: clip(l.text, l.kind === 'say' ? 280 : 160) }));
}
