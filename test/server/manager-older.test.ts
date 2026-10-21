import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A process standing in for an untangle that runs: it runs until it's stopped.
const standIn = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
const listen = (server: http.Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

interface Row { id: string; title: string; kind: string | null; status: string; build: unknown; older: boolean; memory: { untangle: number } | null; disk: number | null }
interface Disk { open: number; measuring: boolean; leftover: { checkouts: number; analyses: number } }

describe('Given a review an untangle from before the manager runs, which doesn’t know the summary call, ', { timeout: 120_000 }, () => {
  let gh: GhStub;
  let cache = '', cwd = '';
  let review: ChildProcess;
  let server: http.Server;
  let manager: ReviewClient;
  const view = async () => (await manager.call('reviews')).data as { reviews: Row[]; disk: Disk };
  const dir = (...p: string[]) => path.join(cache, ...p);
  const [head, base, gone, other] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(12));

  before(async () => {
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    // Its checkouts and its analysis, and a checkout and an analysis no review keeps.
    const then = new Date(Date.now() - 3600_000);
    for (const d of [dir('worktrees', 'github.com', 'acme', 'app', head), dir('worktrees', 'github.com', 'acme', 'app', base), dir('reviews', 'github.com', 'acme', 'app', `${base}-${head}`), dir('worktrees', 'github.com', 'acme', 'app', gone), dir('reviews', 'github.com', 'acme', 'app', `${gone}-${other}`)]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'file'), 'x'.repeat(8192));
      fs.utimesSync(d, then, then);
    }
    review = standIn();
    // It answers what it knew: stop, and nothing of the summary.
    server = http.createServer((req, res) => {
      const stop = req.method === 'POST' && req.url === '/api/stop';
      res.writeHead(stop ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(stop ? { stopping: true } : { error: `no such call: ${req.method} ${req.url}` }));
      if (stop) review.kill();
    });
    const port = await listen(server);
    fs.mkdirSync(path.join(cache, 'run'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'run', `${review.pid}.json`), JSON.stringify({
      pid: review.pid, url: `http://127.0.0.1:${port}/`, token: 't', dir: null, pr: 'acme/app#5', repoKey: 'github.com/acme/app', branch: 'retry', title: '#5 feat: Retry calls', head: 'a'.repeat(40), started: new Date(Date.now() - 7200_000).toISOString(),
    }));
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
  });

  after(async () => {
    review.kill();
    server.close();
    await stopRuns(cache);
    gh.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'when the page lists it, '
    + 'then it’s running, from an older untangle: not a review being built, its memory read from its process, and what it uses on disk kept, as an open review’s.',
    async () => {
      const v = await until('it listed and measured', async () => { const x = await view(); const r = x.reviews.find((y) => y.older); return r && r.disk != null && !x.disk.measuring ? x : null; });
      const r = v.reviews.find((x) => x.older)!;
      assert.deepEqual([r.id, r.status, r.build, r.kind, r.title], [`run:${review.pid}`, 'running', null, 'feat', 'Retry calls']);
      assert.ok(r.memory && r.memory.untangle > 0 && r.disk! > 0);
      assert.deepEqual([v.disk.open > 0, v.disk.leftover.checkouts, v.disk.leftover.analyses], [true, 1, 1]);
    },
  );

  it(
    'when the old checkouts and analyses are removed, '
    + 'then the ones no review keeps go, and the older review keeps its own.',
    async () => {
      assert.deepEqual((await manager.call('free-old', { method: 'POST', body: {} })).data, { removed: 2, checkouts: 1 });
      assert.deepEqual([head, base, gone].map((x) => fs.existsSync(dir('worktrees', 'github.com', 'acme', 'app', x))), [true, true, false]);
      assert.deepEqual([fs.existsSync(dir('reviews', 'github.com', 'acme', 'app', `${base}-${head}`)), fs.existsSync(dir('reviews', 'github.com', 'acme', 'app', `${gone}-${other}`))], [true, false]);
    },
  );

  it(
    'when it’s closed, '
    + 'then it’s asked to stop, as an older untangle can be.',
    async () => {
      assert.equal((await manager.call('close', { method: 'POST', body: { id: `run:${review.pid}` } })).status, 200);
      await until('it stopped', () => !alive(review.pid!));
    },
  );
});

describe('Given a manager an earlier build of untangle runs, ', { timeout: 120_000 }, () => {
  let gh: GhStub;
  let cache = '', cwd = '';
  let old: ChildProcess;
  let server: http.Server;
  let busy = true;
  let url = '';

  before(async () => {
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    old = standIn();
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '0.1.0', pid: old.pid, built: 1, busy }));
    });
    url = `http://127.0.0.1:${await listen(server)}/?token=t`;
    fs.mkdirSync(path.join(cache, 'run'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'run', 'manager.json'), JSON.stringify({ pid: old.pid, url, token: 't', started: new Date().toISOString() }));
  });

  after(async () => {
    old.kill();
    server.close();
    await stopRuns(cache);
    gh.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'when untangle reviews runs while it waits to pause a review, '
    + 'then it’s kept: it would forget to pause it.',
    async () => {
      const r = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
      assert.equal(r.code, 0, r.err);
      assert.equal(/http:\/\/\S+/.exec(r.out)![0], url);
      assert.ok(alive(old.pid!));
    },
  );

  it(
    'when untangle reviews runs once it waits for nothing, '
    + 'then it gives way to a manager this build runs.',
    async () => {
      busy = false;
      const r = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
      assert.equal(r.code, 0, r.err);
      assert.notEqual(/http:\/\/\S+/.exec(r.out)![0], url);
      await until('the old one gone', () => !alive(old.pid!));
      assert.notEqual(JSON.parse(fs.readFileSync(path.join(cache, 'run', 'manager.json'), 'utf8')).pid, old.pid);
    },
  );
});
