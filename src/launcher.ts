// Starts untangle in the background through launch.js, which exits at once: what it starts is no
// one's child, so an agent that stops a command, or a terminal that closes, leaves it running.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDir } from './runs.js';

/** Starts `untangle <args>` in the background: its process id (0 when it didn't start), and its log. */
export function launch(args: string[], env: NodeJS.ProcessEnv = process.env): { pid: number; log: string } {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  // Logs of what started a day ago or more are no longer read.
  for (const name of fs.readdirSync(runDir())) {
    const file = path.join(runDir(), name);
    if (/^start-.*\.log$/.test(name) && Date.now() - fs.statSync(file).mtimeMs > 86_400_000) fs.rmSync(file, { force: true });
  }
  const log = path.join(runDir(), `start-${Date.now()}-${process.pid}.log`);
  const at = (name: string) => fileURLToPath(new URL(name, import.meta.url));
  const launched = spawnSync(process.execPath, [at('./launch.js'), log, at('./cli.js'), ...args], { cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true });
  return { pid: Number(launched.stdout?.trim()) || 0, log };
}

/** The last lines a process that didn't start printed. */
export const logTail = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join('\n');
  } catch {
    return '';
  }
};
