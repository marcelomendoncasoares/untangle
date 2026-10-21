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

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A process standing in for an untangle that runs: it runs until it's stopped.
const standIn = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
const listen = (server: http.Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));

interface Row { id: string; status: string; twin: boolean; need: string | null; progress: { done: number; total: number }; build: unknown }

// What a review that's built says of itself.
const summary = (done: number, waiting: unknown[]) => ({
  title: '#5 feat: Retry calls', phase: 'ready', step: { label: 'history', state: 'done', notes: [] }, plan: ['pull request', 'history'], error: null,
  head: 'a'.repeat(40), progress: { done, total: 301 }, notes: { open: 5, waiting: waiting.length }, waiting, agents: [],
  memory: { untangle: 100e6, lsp: 500e6 }, pages: 0, active: Date.now(), refreshing: null,
});

describe('Given a review two untangles serve, started before untangle checked for one, ', { timeout: 120_000 }, () => {
  let gh: GhStub;
  let cache = '', cwd = '', file = '';
  let holder: ChildProcess, twin: ChildProcess;
  const servers: http.Server[] = [];
  let manager: ReviewClient;
  const rows = async () => ((await manager.call('reviews')).data as { reviews: Row[] }).reviews;
  const record = (pid: number) => ({
    version: 1, target: 'https://github.com/acme/app/pull/5', pr: 'acme/app#5', dir: null, repoKey: 'github.com/acme/app', key: 'pr-5', repo: '/repo',
    title: '#5 feat: Retry calls', author: 'ada', url: 'https://github.com/acme/app/pull/5', size: { add: 9, del: 2, files: 3 }, base: 'b'.repeat(40), head: 'a'.repeat(40),
    progress: { done: 42, total: 301 }, notes: { open: 5, waiting: 1 }, chats: [], pid,
    started: '2026-10-21T10:00:00.000Z', opened: '2026-10-21T10:00:00.000Z', updated: '2026-10-21T10:05:00.000Z',
    stopped: null, closed: null, github: null, checkouts: [], analyses: [], freed: null,
  });

  // Its run file, and its answers: a summary, and stop, which writes its record as untangle did then.
  async function serve(child: ChildProcess, said: unknown, started: string) {
    const server = http.createServer((req, res) => {
      const stop = req.method === 'POST' && req.url === '/api/stop';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(stop ? { stopping: true } : said));
      if (stop) {
        const at = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify({ ...record(child.pid!), stopped: { at, why: 'stop' }, closed: at, updated: at }));
        setTimeout(() => child.kill(), 100);
      }
    });
    servers.push(server);
    const port = await listen(server);
    fs.writeFileSync(path.join(cache, 'run', `${child.pid}.json`), JSON.stringify({
      pid: child.pid, url: `http://127.0.0.1:${port}/`, token: 't', dir: null, pr: 'acme/app#5', repoKey: 'github.com/acme/app', branch: 'retry', title: '#5 feat: Retry calls', head: 'a'.repeat(40), started,
    }));
  }

  before(async () => {
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    fs.mkdirSync(path.join(cache, 'run'), { recursive: true });
    file = path.join(cache, 'sessions', 'github.com', 'acme', 'app', 'pr-5.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The first one started it; the second, started after, took its record.
    twin = standIn();
    holder = standIn();
    await serve(twin, summary(40, []), '2026-10-21T09:00:00.000Z');
    await serve(holder, summary(42, [{ n: 6, path: 'lib/a.dart', line: 3, by: 'Codex', wrote: false }]), '2026-10-21T10:00:00.000Z');
    fs.writeFileSync(file, JSON.stringify(record(holder.pid!)));
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
  });

  after(async () => {
    holder.kill();
    twin.kill();
    servers.forEach((s) => s.close());
    await stopRuns(cache);
    gh.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'when the reviews are listed, '
    + 'then the review is listed with what its record’s untangle says, and the second one right after it, as open twice, with what it says.',
    async () => {
      assert.deepEqual((await rows()).map((r) => [r.id, r.status, r.twin ? 'open twice' : '', r.need ?? '', `${r.progress.done} of ${r.progress.total}`, r.build ? 'building' : 'built'].join(' | ')), [
        'github.com/acme/app/pr-5 | running |  | Codex answered N6 | 42 of 301 | built',
        `run:${twin.pid} | running | open twice |  | 40 of 301 | built`,
      ]);
    },
  );

  it(
    'when the second one is closed, '
    + 'then it stops, and the review keeps its record: it runs, in the untangle that holds it.',
    async () => {
      const r = await manager.call('close', { method: 'POST', body: { id: `run:${twin.pid}` } });
      assert.equal(r.status, 200, r.text);
      assert.equal(alive(twin.pid!), false);
      const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual([kept.pid, kept.stopped, kept.closed], [holder.pid, null, null]);
      assert.deepEqual((await rows()).map((x) => [x.id, x.status, x.twin].join(' | ')), ['github.com/acme/app/pr-5 | running | false']);
    },
  );
});
