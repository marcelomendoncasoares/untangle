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

interface Row { id: string; status: string; pausing: boolean; build: unknown; agents: Array<{ state: string }>; stopped: { why: string } | null; chat: { id: string } | null }

describe('Given a review Claude holds from a chat the manager started, and its page, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', orcaLog = '', config = '';
  let manager: ReviewClient;
  let review: ReviewClient;
  let managerUrl = '';
  let id = '';
  const chat = 'c1a0de00-0000-4000-8000-0000000000bb';
  const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', PATH: [bin, gh.binDir, process.env.PATH].join(path.delimiter), ORCA_CLI_COMMAND: 'orca-ide', ORCA_STUB_LOG: orcaLog, ...more });
  const calls = (): string[][] => (fs.existsSync(orcaLog) ? fs.readFileSync(orcaLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const rows = async () => ((await manager.call('reviews')).data as { reviews: Row[] }).reviews;
  const folder = () => path.join(cache, 'chats', 'Reviews');
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
    managerUrl = /http:\/\/\S+/.exec(started.out)![0];
    manager = reviewClient(managerUrl);
    await manager.open();
    // The manager starts the review and Claude's chat (term_1); the review's page is its tab (pg_1).
    const r = await manager.call('start', { method: 'POST', body: { target: fs.realpathSync(repo.dir), agent: { kind: 'claude', resume: null, session: chat, flags: '', message: '' } } });
    assert.equal(r.status, 200, r.text);
    review = reviewClient(runsIn(cache)[0].url);
    await review.open();
    await until('the review', async () => (await review.call('notes')).status === 200);
    // Claude holds it from that terminal, and works on a note it read.
    session('busy');
    const watching = untangleCommand(['watch'], { cacheDir: cache, gh, cwd: repo.dir, env: env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: config, ORCA_TERMINAL_HANDLE: 'term_1' }) });
    await until('Claude to listen', async () => ((await review.call('notes')).data as { agents: Array<{ state: string }> }).agents.some((a) => a.state === 'listening'));
    await review.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
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
    'when its page asks to pause it while Claude works on a note, '
    + 'then it waits for the turn, and its Reviews list says it’s pausing; once Claude goes idle, it pauses itself: its tab and Claude’s terminal close, and the chat is kept.',
    async () => {
      const r = await review.call('reviews/pause', { method: 'POST', body: {} });
      assert.deepEqual([r.status, r.data], [200, { waiting: true, reviews: managerUrl }]);
      const own = (await review.call('reviews')).data as { self: string; reviews: Row[] };
      assert.deepEqual([own.self, own.reviews.find((x) => x.id === own.self)?.pausing], [id, true]);
      await sleep(2500);
      assert.equal((await rows()).find((x) => x.id === id)!.status, 'running');
      session('idle');
      const paused = await until('the pause', async () => (await rows()).find((x) => x.id === id && x.status === 'paused'));
      assert.deepEqual([paused.stopped && paused.stopped.why, paused.chat && paused.chat.id], ['paused', chat]);
      const closes = await until('the closes', () => { const c = calls().filter((x) => x[1] === 'close'); return c.length === 2 ? c : null; });
      assert.deepEqual(closes, [['tab', 'close', '--page', 'pg_1'], ['terminal', 'close', '--terminal', 'term_1', '--tab']]);
    },
  );

  it(
    'when it’s resumed, and its page asks to pause it now, '
    + 'then it pauses at once, saying where the Reviews page is.',
    async () => {
      assert.equal((await manager.call('resume', { method: 'POST', body: { id, agent: false } })).status, 200);
      await until('the review running again', async () => (await rows()).find((x) => x.id === id && x.status === 'running' && !x.build));
      review = reviewClient(runsIn(cache).find((x) => x.url !== managerUrl)!.url);
      await review.open();
      const r = await review.call('reviews/pause', { method: 'POST', body: { now: true } });
      assert.deepEqual([r.status, r.data], [200, { paused: true, reviews: managerUrl }]);
      const paused = await until('the pause', async () => (await rows()).find((x) => x.id === id && x.status === 'paused'));
      assert.equal(paused.stopped && paused.stopped.why, 'paused');
    },
  );
});
