import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const later: Person = { ...ada, date: '2020-06-02T00:00:00Z' };
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

function cliEnv(cacheDir: string, gh: GhStub): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, UNTANGLE_CACHE: cacheDir, ...gh.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  delete env.BROWSER;
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCA_')) delete env[key];
  }
  env.UNTANGLE_NO_ORCA = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`untangle did not exit\n${stdout}\n${stderr}`));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe('Given a port that was asked for and is already taken, ', () => {
  let holder: http.Server | undefined;
  let port = 0;
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';

  before(async () => {
    holder = await new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
    const address = holder.address();
    if (address == null || typeof address === 'string') throw new Error('the held port has no address');
    port = address.port;
    repo = TempRepo.create();
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    holder?.close();
  });

  describe('when untangle is started on that port, ', () => {
    let code = 0;
    let error = '';

    before(async () => {
      const ran = await runCli(['-port', String(port), '-quiet', '-no-open', repo!.dir], cliEnv(cache, gh!));
      code = ran.code;
      error = ran.stderr.replace(/\n$/, '');
    });

    it('then the command exits 1.', () => {
      assert.equal(String(code), '1');
    });

    it('then the error says it cannot listen on that port.', () => {
      assert.equal(error, `untangle: cannot listen on 127.0.0.1:${port}: listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
    });
  });
});

describe('Given a base that is its own orphan commit, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'change', author: later, committer: later });
    execFileSync('git', ['-C', repo.dir, 'checkout', '--orphan', 'other'], { stdio: 'ignore' });
    repo.write('lib/other.dart', 'void other() {}\n');
    repo.commit({ subject: 'orphan', author: later, committer: later });
    repo.checkout('feature');
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the directory is reviewed against that base, ', () => {
    let code = 0;
    let error = '';

    before(async () => {
      const ran = await runCli(['-base', 'other', '-quiet', '-no-open', '-port', '0', repo!.dir], cliEnv(cache, gh!));
      code = ran.code;
      error = ran.stderr.split('\n').find((line) => line.includes('share no history')) ?? ran.stderr;
    });

    it('then the command exits 1.', () => {
      assert.equal(String(code), '1');
    });

    it('then the error says the base and HEAD share no history.', () => {
      assert.equal(error, '  error: other and HEAD share no history');
    });
  });
});

describe('Given a served review of a branch, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let client: ReviewClient | undefined;
  let cache = '';
  let root = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'change', author: later, committer: later });
    root = fs.realpathSync(repo.dir);
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, quiet: false });
    client = reviewClient(run.url);
    await waitForReview(client);
  });

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when a refresh looks up a base that is no longer a commit, ', () => {
    let answer = '';
    let progress = '';

    before(async () => {
      execFileSync('git', ['-C', repo!.dir, 'update-ref', '-d', 'refs/heads/main'], { stdio: 'ignore' });
      const refresh = await client!.call('refresh', { method: 'POST' });
      const data = refresh.data as { state?: string; error?: string };
      answer = `${data.state ?? ''}\n${data.error ?? JSON.stringify(refresh.data)}`;
      progress = run!.output().split('\n').find((line) => line.includes('is not a commit')) ?? run!.output();
    });

    it('then the refresh answers that it failed.', () => {
      assert.equal(answer, `failed\n-base main is not a commit in ${root}`);
    });

    it('then the progress says it failed.', () => {
      assert.equal(progress, `  error: -base main is not a commit in ${root}`);
    });
  });
});
