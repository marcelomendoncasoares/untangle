import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';

const skip = !has('dart') ? 'dart is not on PATH' : fs.existsSync('/usr/bin/script') ? false : 'script is not installed';
const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T15:00:00Z' };
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function signal(child: ReturnType<typeof spawn>, name: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, name);
  } catch {
    try { child.kill(name); } catch { /* Already gone. */ }
  }
}

/** SIGTERM, then SIGKILL if it is still up, resolving only after the process has exited. */
function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => signal(child, 'SIGKILL'), 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    signal(child, 'SIGTERM');
  });
}

/** Runs untangle under a pseudo-terminal until the review is ready, then stops it. */
function runTerminal(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const command = [process.execPath, cli, ...args].map(quote).join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/script', ['-qfc', command, '/dev/null'], { env, detached: true });
    let out = '';
    let stopping = false;
    const timer = setTimeout(() => {
      stopping = true;
      void stopProcess(child).then(() => reject(new Error(`untangle did not become ready\n${out}`)));
    }, 120_000);
    const take = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (!stopping && out.includes('Review at ')) {
        stopping = true;
        clearTimeout(timer);
        void stopProcess(child).then(() => resolve(out));
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      if (!stopping) {
        stopping = true;
        clearTimeout(timer);
        reject(new Error(`untangle exited before it was ready\n${out}`));
      }
    });
  });
}

describe('Given a tiny Dart package reviewed in a terminal, ', { skip }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'Change', author: ada, committer: ada });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  function env(color: 'color' | 'no-color' | 'variable'): NodeJS.ProcessEnv {
    const next: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: String(gh.env.PATH),
      UNTANGLE_CACHE: cache,
      UNTANGLE_GH_LOG: String(gh.env.UNTANGLE_GH_LOG),
      UNTANGLE_GH_CONFIG: String(gh.env.UNTANGLE_GH_CONFIG),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      // Nothing reaches the person's Orca, these tests run in it: see helpers/run.ts.
      UNTANGLE_NO_ORCA: '1',
    };
    for (const key of Object.keys(next)) if (key.startsWith('ORCA_')) delete next[key];
    delete next.NO_COLOR;
    if (color === 'variable') next.NO_COLOR = '1';
    return next;
  }

  function args(noColor: boolean): string[] {
    return ['-base', 'main', '-no-open', '-port', '0', ...(noColor ? ['-no-color'] : []), repo.dir];
  }

  describe('when the progress is printed, ', () => {
    let log = '';

    before(async () => {
      log = await runTerminal(args(false), env('color'));
    });

    it('then the progress uses ANSI color.', () => {
      assert.equal(/\x1b\[\d+m/.test(log) ? 'colored' : log, 'colored');
    });
  });

  describe('when the progress is printed with no-color, ', () => {
    let log = '';

    before(async () => {
      log = await runTerminal(args(true), env('no-color'));
    });

    it('then the progress has no ANSI color.', () => {
      assert.equal(/\x1b\[\d+m/.test(log) ? log : 'plain', 'plain');
    });
  });

  describe('when the progress is printed with NO_COLOR, ', () => {
    let log = '';

    before(async () => {
      log = await runTerminal(args(false), env('variable'));
    });

    it('then the progress has no ANSI color.', () => {
      assert.equal(/\x1b\[\d+m/.test(log) ? log : 'plain', 'plain');
    });
  });
});
