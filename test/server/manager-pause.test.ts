import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, stopRuns, untangleCommand } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const orcaStub = path.join(path.dirname(fileURLToPath(import.meta.url)), '../helpers/orca-stub.mjs');

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

interface Row { id: string; status: string; pausing: boolean; build: unknown; agents: Array<{ state: string }>; stopped: { why: string } | null; github: { state: string; at: string } | null; chat: { id: string } | null }

describe('Given a review Claude holds from a chat the manager started, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', orcaLog = '', config = '';
  let manager: ReviewClient;
  let id = '';
  const chat = 'c1a0de00-0000-4000-8000-0000000000aa';
  const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', PATH: [bin, gh.binDir, process.env.PATH].join(path.delimiter), ORCA_CLI_COMMAND: 'orca-ide', ORCA_STUB_LOG: orcaLog, ...more });
  const calls = (): string[][] => (fs.existsSync(orcaLog) ? fs.readFileSync(orcaLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const rows = async () => ((await manager.call('reviews')).data as { reviews: Row[] }).reviews;
  const folder = () => path.join(cache, 'chats', 'Reviews');
  // Claude's word on its session: in the Reviews workspace's folder, busy or idle.
  const session = (status: 'busy' | 'idle') => fs.writeFileSync(path.join(config, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: chat, cwd: folder(), status, statusUpdatedAt: Date.now() }));

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    const head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    orcaLog = path.join(bin, 'orca.log');
    config = path.join(cache, 'claude');
    fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'orca-ide'), `#!/bin/sh\nexec node ${JSON.stringify(orcaStub)} "$@"\n`, { mode: 0o755 });
    for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
    // The manager starts the review and Claude's chat (term_1); the review's page is its tab (pg_1).
    const r = await manager.call('start', { method: 'POST', body: { target: fs.realpathSync(repo.dir), agent: { kind: 'claude', resume: null, session: chat, flags: '', message: '' } } });
    assert.equal(r.status, 200, r.text);
    const client = reviewClient(runsIn(cache)[0].url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    // Claude holds it from that terminal, and works on a note it read.
    session('busy');
    const watching = untangleCommand(['watch'], { cacheDir: cache, gh, cwd: repo.dir, env: env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: config, ORCA_TERMINAL_HANDLE: 'term_1' }) });
    await until('Claude to listen', async () => ((await client.call('notes')).data as { agents: Array<{ state: string }> }).agents.some((a) => a.state === 'listening'));
    await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
    assert.equal((await watching).code, 0);
    id = (await until('the review built, held', async () => (await rows()).find((x) => x.status === 'running' && !x.build && x.chat?.id === chat && x.agents[0]?.state === 'working')))!.id;
  });

  after(async () => {
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when Pause is clicked while Claude works on a note, '
    + 'then it waits for the turn; once Claude goes idle, the review stops, its tab and Claude’s terminal close, and the chat is kept.',
    async () => {
      const r = await manager.call('pause', { method: 'POST', body: { id } });
      assert.deepEqual(r.data, { waiting: true });
      assert.equal((await rows()).find((x) => x.id === id)!.pausing, true);
      await sleep(2500);
      assert.equal((await rows()).find((x) => x.id === id)!.status, 'running');
      session('idle');
      const paused = await until('the pause', async () => (await rows()).find((x) => x.id === id && x.status === 'paused'));
      assert.deepEqual([paused.stopped && paused.stopped.why, paused.chat && paused.chat.id], ['paused', chat]);
      // Its tab and Claude's terminal close as it stops.
      const closes = await until('the closes', () => { const c = calls().filter((x) => x[1] === 'close'); return c.length === 2 ? c : null; });
      assert.deepEqual(closes, [['tab', 'close', '--page', 'pg_1'], ['terminal', 'close', '--terminal', 'term_1', '--tab']]);
    },
  );

  it(
    'when Resume is clicked, '
    + 'then the review starts again, and Claude’s chat resumes by its id in a new terminal of the Reviews workspace, told the review is back.',
    async () => {
      const before = calls().length;
      const r = await manager.call('resume', { method: 'POST', body: { id } });
      assert.equal(r.status, 200, r.text);
      const name = path.basename(repo.dir);
      const created = calls().slice(before).filter((c) => c[0] === 'terminal');
      assert.deepEqual(created, [['terminal', 'create', '--worktree', `id:repo-1::${folder()}`, '--title', `${name} · Claude`, '--command', `claude --resume ${chat} 'untangle: the review of ${name} is open again. Run untangle watch to hold it.'`]]);
      // It keeps its row while it's built again.
      const now = await rows();
      assert.deepEqual([now.length, now[0].id, now[0].status], [1, id, 'running']);
      await until('the review running again', async () => (await rows()).find((x) => x.id === id && x.status === 'running' && !x.build));
      // Resumed twice, its chat starts once.
      const again = await manager.call('resume', { method: 'POST', body: { id } });
      assert.equal((again.data as { already?: boolean }).already, true);
      assert.equal(calls().filter((c) => c[0] === 'terminal' && c[1] === 'create').length, created.length + 1);
    },
  );

  it(
    'when Pause now is clicked while Claude’s chat watches, '
    + 'then the review stops at once, and the watch says it paused and that Resume brings it back.',
    async () => {
      const watching = untangleCommand(['watch'], { cacheDir: cache, gh, cwd: repo.dir, env: env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: config, ORCA_TERMINAL_HANDLE: 'term_2' }) });
      await until('Claude to listen', async () => (await rows()).find((x) => x.id === id && x.agents[0]?.state === 'listening'));
      const r = await manager.call('pause', { method: 'POST', body: { id, now: true } });
      assert.deepEqual(r.data, { paused: true });
      const w = await watching;
      assert.equal(w.code, 0, w.err);
      assert.match(w.out, /untangle: the review of .+ paused: its notes and this chat are kept\. Resume, in untangle reviews, brings it back and says so here/);
      await until('the pause', async () => (await rows()).find((x) => x.id === id && x.status === 'paused'));
    },
  );
});

describe('Given a paused review whose pull request merged on GitHub, and a closed one’s that merged too, ', { timeout: 120_000 }, () => {
  let gh: GhStub;
  let cache = '', cwd = '';
  let manager: ReviewClient;

  before(async () => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    gh = stubGh([
      { match: ['pr', 'view', '12', '--repo', 'acme/app'], stdout: { state: 'MERGED', mergedAt: '2026-10-14T12:00:00Z', closedAt: '2026-10-14T12:00:00Z' } },
      { match: ['pr', 'view', '13', '--repo', 'acme/app'], stdout: { state: 'MERGED', mergedAt: '2026-10-15T12:00:00Z', closedAt: '2026-10-15T12:00:00Z' } },
    ]);
    // Its record, as a review that paused left it: its process gone.
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    const dir = path.join(cache, 'sessions', 'github.com', 'acme', 'app');
    fs.mkdirSync(dir, { recursive: true });
    const write = (n: number, o: Record<string, unknown>) => fs.writeFileSync(path.join(dir, `pr-${n}.json`), JSON.stringify({
      version: 1, target: `https://github.com/acme/app/pull/${n}`, pr: `acme/app#${n}`, dir: null, repoKey: 'github.com/acme/app', key: `pr-${n}`, repo: path.join(cache, 'repos', 'github.com', 'acme', 'app.git'),
      title: `#${n} feat: Retry calls`, author: 'ada', url: `https://github.com/acme/app/pull/${n}`, size: { add: 10, del: 2, files: 1 }, base: 'b'.repeat(40), head: 'h'.repeat(40),
      progress: { done: 3, total: 5 }, notes: { open: 0, waiting: 0 }, chats: [], pid: gone,
      started: '2026-10-10T10:00:00.000Z', opened: '2026-10-10T10:00:00.000Z', updated: '2026-10-10T12:00:00.000Z',
      stopped: { at: '2026-10-10T12:00:00.000Z', why: 'paused' }, closed: null, checkouts: [], analyses: [], ...o,
    }));
    write(12, {});
    write(13, { stopped: { at: '2026-10-11T12:00:00.000Z', why: 'stop' }, closed: '2026-10-11T12:00:00.000Z' });
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
  });

  after(async () => {
    await stopRuns(cache);
    gh.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'when the manager’s page opens, '
    + 'then it asks GitHub: the paused review is closed, as merged when it merged, and the closed one says it merged, still closed when you closed it.',
    async () => {
      const rows = await until('both merged', async () => { const x = ((await manager.call('reviews')).data as { reviews: Array<Row & { closed: string }> }).reviews; return x.every((r) => r.github) ? x : null; });
      const by = (n: number) => rows.find((x) => x.id === `github.com/acme/app/pr-${n}`)!;
      assert.deepEqual([by(12).status, by(12).github, by(12).closed], ['closed', { state: 'merged', at: '2026-10-14T12:00:00Z' }, '2026-10-14T12:00:00Z']);
      assert.deepEqual([by(13).status, by(13).github, by(13).closed], ['closed', { state: 'merged', at: '2026-10-15T12:00:00Z' }, '2026-10-11T12:00:00.000Z']);
    },
  );
});
