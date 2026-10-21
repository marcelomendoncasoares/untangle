import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

interface Record {
  target: string; dir: string | null; pr: string | null; key: string; title: string;
  size: { add: number; del: number; files: number };
  progress: { done: number; total: number };
  notes: { open: number; waiting: number };
  chats: Array<{ agent: string; kind: string; id: string; folder: string | null; orca: { handle: string } | null }>;
  pid: number | null; started: string; opened: string;
  stopped: { why: string } | null; closed: string | null;
  checkouts: string[]; analyses: string[][];
}

describe('Given a branch under review, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '';
  let bin = '';
  let head = '';
  let run: UntangleRun | null = null;
  let client: ReviewClient;
  // The review's record: one file, named like the branch.
  const recordPath = () => {
    const dir = path.join(cache, 'sessions');
    const found = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json')) : [];
    return found.length ? path.join(dir, found[0]) : null;
  };
  const record = (): Record => JSON.parse(fs.readFileSync(recordPath()!, 'utf8'));
  const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(bin, 'browser.sh'), ...more });
  const reviews = () => untangleCommand(['reviews', '-list'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
  const start = async () => {
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main', env: env() });
    client = reviewClient(run.url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
  };

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n\nvoid wave() {}\n");
    head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    fs.writeFileSync(path.join(bin, 'browser.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await start();
  });

  after(async () => {
    await run?.stop();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when it opens, '
    + 'then its record says it runs, with its title, size and progress, and untangle reviews lists it with the memory it holds.',
    async () => {
      const r = await until('the record', () => (recordPath() ? record() : null));
      const top = fs.realpathSync(repo.dir);
      assert.deepEqual(
        [r.target, r.dir, r.pr, r.key, r.title, r.size, r.progress, r.notes, r.chats, r.pid, r.stopped, r.closed, r.checkouts.length, r.analyses.map((p) => p[1])],
        [top, top, null, 'feature', 'feature against main', { add: 3, del: 1, files: 1 }, { done: 0, total: 2 }, { open: 0, waiting: 0 }, [], runsIn(cache)[0].pid, null, null, 2, [head]],
      );
      const listed = await reviews();
      const lines = listed.out.trim().split('\n');
      assert.deepEqual([listed.code, lines[0], lines.length], [0, 'untangle: 1 running, 0 paused, 0 closed.', 3]);
      assert.match(lines[2], new RegExp(`^running  ${path.basename(repo.dir)}  feature against main  0/2  no agent  \\d+ MB$`));
    },
  );

  it(
    'when a note is written and an agent answers it, '
    + 'then the record counts the note, as waiting for you.',
    async () => {
      const added = await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
      assert.equal(added.status, 200);
      await until('the note in the record', () => record().notes.open === 1);
      assert.deepEqual(record().notes, { open: 1, waiting: 0 });
      const answered = await client.call('notes/agent', { method: 'POST', body: { agent: 'Claude', n: 1, body: 'Because it’s friendlier.' } });
      assert.equal(answered.status, 200);
      await until('the answer in the record', () => record().notes.waiting === 1);
    },
  );

  it(
    'when Claude holds it from a chat, '
    + 'then the record keeps the chat: its session, the folder Claude runs in, and its terminal in Orca.',
    async () => {
      const config = path.join(cache, 'claude');
      fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(config, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'chat-a', cwd: '/work/serverpod', status: 'idle', statusUpdatedAt: Date.now() }));
      const watched = await untangleCommand(['watch', '-timeout', '1s'], {
        cacheDir: cache, gh, cwd: repo.dir,
        env: env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'chat-a', CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: config, ORCA_TERMINAL_HANDLE: 'term_a', ORCA_CLI_COMMAND: 'orca-ide' }),
      });
      assert.equal(watched.code, 0, watched.err);
      const r = await until('the chat in the record', () => record().chats[0]);
      assert.deepEqual([r.agent, r.kind, r.id, r.folder, r.orca && r.orca.handle], ['Claude', 'claude', 'chat-a', '/work/serverpod', 'term_a']);
    },
  );

  it(
    'when untangle stop closes it, '
    + 'then it’s paused: the record says why, and the list says what it holds on disk and that the chat is kept.',
    async () => {
      const stopped = await untangleCommand(['stop'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
      assert.equal(stopped.code, 0, stopped.err);
      await run!.exited;
      const r = record();
      assert.deepEqual([r.stopped && r.stopped.why, r.closed, r.notes], ['stop', null, { open: 1, waiting: 1 }]);
      const lines = (await reviews()).out.trim().split('\n');
      assert.equal(lines[0], 'untangle: 0 running, 1 paused, 0 closed.');
      assert.match(lines[2], new RegExp(`^paused  ${path.basename(repo.dir)}  feature against main  0/2  Claude’s chat, kept  \\d+ KB on disk$`));
    },
  );

  it(
    'when it opens again, '
    + 'then it runs again, keeping when it first started and the chat that held it.',
    async () => {
      const first = record();
      await start();
      await until('the record to say it runs', () => record().pid === runsIn(cache)[0]?.pid && !record().stopped);
      const r = record();
      assert.deepEqual([r.started, r.opened > first.opened, r.chats.map((c) => c.id), r.stopped], [first.started, true, ['chat-a'], null]);
      assert.equal((await reviews()).out.split('\n')[0], 'untangle: 1 running, 0 paused, 0 closed.');
    },
  );
});
