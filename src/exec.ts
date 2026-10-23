import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`${command} failed${code != null ? ` (exit ${code})` : ''}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
  }
}

/** Runs a command and returns its stdout. Throws CommandError when it fails. */
export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const input = opts.input === undefined ? null : inputFile(opts.input);
  try {
    return execFileSync(cmd, args, { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : undefined, encoding: 'utf8', maxBuffer: 1 << 30, stdio: [input ? input.fd : 'pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string };
    throw new CommandError([cmd, ...args].join(' '), err.status ?? null, String(err.stderr ?? ''));
  } finally {
    input?.close();
  }
}

/**
 * The input of a command run synchronously, as a file it reads to its end. Through a pipe, on
 * macOS, the command can read all of it and then wait for the pipe to close, which it never does,
 * while untangle waits for the command: everything it serves stops answering.
 */
export function inputFile(text: string): { fd: number; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-input-'));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const file = path.join(dir, 'input');
    fs.writeFileSync(file, text);
    const fd = fs.openSync(file, 'r');
    return { fd, close: () => { fs.closeSync(fd); remove(); } };
  } catch (e) {
    remove();
    throw e;
  }
}

/** Runs a command without blocking. Resolves with its output, or rejects with CommandError. */
export function runAsync(cmd: string, args: string[], opts: { cwd?: string; onLine?: (line: string) => void; shell?: boolean; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: opts.shell, env: opts.env ? { ...process.env, ...opts.env } : undefined, timeout: opts.timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const lines = (chunk: string) => opts.onLine && chunk.split(/\r?\n|\r/).filter(Boolean).forEach(opts.onLine);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; lines(d); });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; lines(d); });
    child.on('error', (e) => reject(new CommandError([cmd, ...args].join(' '), null, e.message)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new CommandError([cmd, ...args].join(' '), code, err || out))));
  });
}

/** Whether a command exists on PATH. */
export function has(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]);
export const gitAsync = (cwd: string, args: string[], onLine?: (line: string) => void) => runAsync('git', ['-C', cwd, ...args], { onLine });

/** git, or null when it fails. */
export function gitMaybe(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}
