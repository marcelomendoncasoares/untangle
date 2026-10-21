// Starts untangle on a fixture and stops only that process. The review's cache is the
// directory the caller passes, never the user's. -port 0 picks a free port.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubGh, type GhStub } from './gh.ts';

export interface UntangleRun {
  url: string;
  /** Ends the process untangle started, and the processes it started. */
  stop(): Promise<void>;
  /** Everything untangle has printed so far. */
  output(): string;
  /** Settles with untangle's exit code when it exits, by itself or stopped. */
  exited: Promise<number | null>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repoRoot, 'dist/cli.js');

// Stand-ins, first on untangle's PATH, for every command that opens the default browser (wslview,
// xdg-open and open, and from WSL Windows' powershell.exe and cmd.exe): a review whose opener
// falls through to them opens nothing real. Each one notes its call in browsers.log.
let guard = '';
function browserGuard(): string {
  if (guard) return guard;
  guard = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-guard-'));
  for (const name of ['wslview', 'xdg-open', 'open', 'powershell.exe', 'cmd.exe']) {
    fs.writeFileSync(path.join(guard, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(path.join(guard, 'browsers.log'))}\n`, { mode: 0o755 });
  }
  const dir = guard;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return guard;
}

/** The browsers that reviews of this test process tried to open, one call per line. */
export function browsersOpened(): string {
  const log = path.join(browserGuard(), 'browsers.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
}

function untangleEnv(cacheDir: string, gh: GhStub, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, UNTANGLE_CACHE: cacheDir, ...gh.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  // No user git config: marks commits stay untangle <untangle@localhost>, with no signing or hooks.
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  // A review looks up untangle's main on GitHub as it starts: here, offline, it finds none.
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'url./nonexistent/untangle.git.insteadOf';
  env.GIT_CONFIG_VALUE_0 = 'https://github.com/marcelomendoncasoares/untangle.git';
  // These tests run inside Orca. A review must not open the person's browser or a real Orca tab,
  // and untangle must not find Orca's own command on PATH either: the manager would add each
  // test's cache to the person's Orca as a project. A test that wants Orca passes its stand-in.
  delete env.BROWSER;
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCA_')) delete env[key];
  }
  env.UNTANGLE_NO_ORCA = '1';
  // And inside an agent's chat: a watch must not take that chat for the one holding the review.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX_)/.test(key) || ['AI_AGENT', 'GEMINI_CLI', 'UNTANGLE_AGENT'].includes(key)) delete env[key];
  }
  const merged = extra ? { ...env, ...extra } : env;
  merged.PATH = `${browserGuard()}${path.delimiter}${merged.PATH ?? ''}`;
  return merged;
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, name);
  } catch {
    try {
      child.kill(name);
    } catch {
      // Already gone.
    }
  }
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => signal(child, 'SIGKILL'), 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    signal(child, 'SIGTERM');
  });
}

function spawnUntangle(args: string[], cacheDir: string, gh: GhStub, extra?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [cli, ...args], {
    detached: true,
    env: untangleEnv(cacheDir, gh, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A stub the caller didn't pass: the default answer is that there is no pull request. */
function ownedGh(gh: GhStub | undefined): { gh: GhStub; release(): void } {
  if (gh) return { gh, release() {} };
  const owned = stubGh();
  return { gh: owned, release: () => owned.remove() };
}

function collect(child: ChildProcess): { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
  return { out: () => out, err: () => err };
}

function leading(base: string | null | undefined): string[] {
  return base ? ['-base', base] : [];
}

/**
 * The fixtures were drawn for chains that follow the code: a review follows it unless the test
 * passes -chains itself, or chains: null for untangle's own default (the commits).
 */
function chainsFlag(chains: 'history' | 'structure' | null | undefined, args: string[] | undefined): string[] {
  return chains === null || args?.includes('-chains') ? [] : ['-chains', chains ?? 'structure'];
}

/**
 * Tests stop the review themselves, and some leave its page for another: it keeps serving when
 * its page closes unless the test asks for autoclose, or null for untangle's own default (on).
 */
function autocloseFlag(autoclose: boolean | null | undefined): string[] {
  return autoclose === null ? [] : [`-autoclose=${autoclose ?? false}`];
}

/** Serves the directory with `-port 0 -no-open` and resolves with the printed URL. */
export async function startUntangle(dir: string, opts: { base?: string | null; cacheDir: string; gh?: GhStub; args?: string[]; chains?: 'history' | 'structure' | null; autoclose?: boolean | null; quiet?: boolean; open?: boolean; port?: number | null; env?: NodeJS.ProcessEnv }): Promise<UntangleRun> {
  const { gh, release } = ownedGh(opts.gh);
  const quiet = opts.quiet === false ? [] : ['-quiet'];
  const open = opts.open ? [] : ['-no-open'];
  const port = opts.port === null ? [] : ['-port', String(opts.port ?? 0)];
  const child = spawnUntangle([...leading(opts.base), ...open, ...port, ...quiet, ...chainsFlag(opts.chains, opts.args), ...autocloseFlag(opts.autoclose), ...(opts.args ?? []), dir], opts.cacheDir, gh, opts.env);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const text = collect(child);
  const output = () => `${text.out()}\n${text.err()}`;
  try {
    const url = await waitForUrl(child, text);
    return {
      url,
      output,
      exited,
      stop: async () => {
        await stopProcess(child);
        release();
      },
    };
  } catch (error) {
    await stopProcess(child);
    release();
    throw error;
  }
}

/** Writes the review with `-export` and resolves when untangle exits. */
export async function exportUntangle(dir: string, htmlFile: string, opts: { base?: string | null; cacheDir: string; gh?: GhStub; args?: string[]; chains?: 'history' | 'structure' | null }): Promise<void> {
  const { gh, release } = ownedGh(opts.gh);
  const child = spawnUntangle([...leading(opts.base), '-no-open', '-export', htmlFile, '-quiet', ...chainsFlag(opts.chains, opts.args), ...(opts.args ?? []), dir], opts.cacheDir, gh);
  const text = collect(child);
  const timer = setTimeout(() => signal(child, 'SIGKILL'), 180_000);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) throw new Error(`untangle export exited ${code}\n${text.err()}\n${text.out()}`);
  } finally {
    clearTimeout(timer);
    await stopProcess(child);
    release();
  }
}

function waitForUrl(child: ChildProcess, text: { out: () => string; err: () => string }): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url!);
    };
    const timer = setTimeout(() => finish(new Error(`untangle did not print a URL\n${text.err()}\n${text.out()}`)), 60_000);
    const look = () => {
      const match = /http:\/\/127\.0\.0\.\d+:\d+\/\S*/.exec(`${text.out()}\n${text.err()}`);
      if (match) finish(null, match[0].trim());
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      look();
      finish(new Error(`untangle exited ${code} before printing a URL\n${text.err()}\n${text.out()}`));
    });
  });
}

/** Runs one of the agent's commands (watch, reply, notes, stop) in `cwd`, to its end; `pid` is its process. */
export function untangleCommand(args: string[], opts: { cacheDir: string; gh: GhStub; cwd: string; env?: NodeJS.ProcessEnv; timeout?: number }): Promise<{ code: number | null; out: string; err: string }> & { pid: number } {
  const child = spawn(process.execPath, [cli, ...args], { cwd: opts.cwd, env: untangleEnv(opts.cacheDir, opts.gh, opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const text = collect(child);
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`untangle ${args.join(' ')} did not end\n${text.out()}\n${text.err()}`)); }, opts.timeout ?? 120_000);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out: text.out(), err: text.err() }); });
  });
  return Object.assign(done, { pid: child.pid ?? 0 });
}

/** The reviews running from this cache, by their run files: a watch starts them in the background. */
export function runsIn(cacheDir: string): Array<{ pid: number; url: string; token: string }> {
  const dir = path.join(cacheDir, 'run');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).flatMap((f) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))];
    } catch {
      return [];
    }
  });
}

/** The manager running from this cache: untangle reviews starts it in the background. */
export function managerIn(cacheDir: string): { pid: number; url: string; token: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'run', 'manager.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Stops the reviews running from this cache, and its manager, and waits until they're gone. */
export async function stopRuns(cacheDir: string): Promise<void> {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const manager = managerIn(cacheDir);
  for (const { pid } of [...runsIn(cacheDir), ...(manager ? [manager] : [])]) {
    if (pid === process.pid) continue;
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}
