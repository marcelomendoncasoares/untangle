import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { managerIn, startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';

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

interface Row {
  id: string; name: string; title: string; status: string; need: string | null; needAt: number | null;
  waiting: Array<{ n: number; path: string; line: number | null; by: string; wrote: boolean }>;
  agents: Array<{ name: string; state: string; label: string }>;
  chat: { agent: string; kind: string; id: string; orca: boolean } | null;
  memory: { untangle: number; lsp: number | null } | null; disk: number | null; progress: { done: number; total: number };
}
interface View { reviews: Row[]; memory: { manager: number }; disk: { open: number; closed: number; clones: number; measuring: boolean } }

describe('Given a review Claude holds from a chat in Orca, and the manager, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', orcaLog = '', opened = '';
  let head = '';
  let run: UntangleRun;
  let client: ReviewClient;
  let manager: ReviewClient;
  let managerUrl = '';
  const chat = 'cccccccc-0000-4000-8000-000000000007';
  const claude = () => path.join(cache, 'claude');
  // The commands' environment: the browser and Orca's CLI stand in, first on PATH.
  const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(bin, 'browser.sh'), PATH: [bin, gh.binDir, process.env.PATH].join(path.delimiter), ORCA_CLI_COMMAND: 'orca-ide', ...more });
  const reviews = () => untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
  const view = async () => (await manager.call('reviews')).data as View;
  const calls = (): string[][] => (fs.existsSync(orcaLog) ? fs.readFileSync(orcaLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    opened = path.join(bin, 'opened.log');
    fs.writeFileSync(path.join(bin, 'browser.sh'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    orcaLog = path.join(bin, 'orca.log');
    fs.writeFileSync(path.join(bin, 'orca-ide'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(orcaLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write('{"ok":true,"result":{}}');\n`, { mode: 0o755 });
    // Claude's session, in the folder it runs in, and the transcript of its chat.
    fs.mkdirSync(path.join(claude(), 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(claude(), 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: chat, cwd: '/work/app', status: 'idle', statusUpdatedAt: Date.now() }));
    fs.mkdirSync(path.join(claude(), 'projects', '-work-app'), { recursive: true });
    fs.writeFileSync(path.join(claude(), 'projects', '-work-app', `${chat}.jsonl`), [
      { type: 'user', message: { role: 'user', content: '/untangle' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'untangle watch' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'untangle: 1 note you haven’t read.\nMore below.' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answered N1 in its thread.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main', env: env() });
    client = reviewClient(run.url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    assert.equal((await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } })).status, 200);
    const watched = await untangleCommand(['watch', '-timeout', '1s'], { cacheDir: cache, gh, cwd: repo.dir, env: env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: claude(), ORCA_TERMINAL_HANDLE: 'term_a' }) });
    assert.equal(watched.code, 0, watched.err);
    assert.equal((await client.call('notes/agent', { method: 'POST', body: { agent: 'Claude', n: 1, body: 'Because it’s friendlier.', chat } })).status, 200);

    const started = await reviews();
    assert.equal(started.code, 0, started.err);
    managerUrl = /http:\/\/\S+/.exec(started.out)![0];
    manager = reviewClient(managerUrl);
    await manager.open();
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
    'when the page asks for the reviews, '
    + 'then it gets the review running, with Claude’s label, the answer that waits for you, its memory, and then what it holds on disk.',
    async () => {
      const r = await until('the chat in the row', async () => (await view()).reviews.find((x) => x.chat));
      assert.deepEqual(
        [r.name, r.title, r.status, r.need, r.needAt, r.waiting, r.agents.map((a) => a.label), r.chat, r.progress],
        [path.basename(repo.dir), 'feature against main', 'running', 'Claude answered N1', 1, [{ n: 1, path: 'lib/a.dart', line: 2, by: 'Claude', wrote: false }], ['Claude isn’t listening'], { agent: 'Claude', kind: 'claude', id: chat, orca: true }, { done: 0, total: 1 }],
      );
      assert.ok(r.memory && r.memory.untangle > 0, JSON.stringify(r.memory));
      const sized = await until('the size on disk', async () => (await view()).reviews[0].disk);
      assert.ok(sized > 0);
      const v = await view();
      assert.deepEqual([v.disk.measuring, v.disk.open > 0, v.memory.manager > 0], [false, true, true]);
    },
  );

  it(
    'when the open row asks for its chat, '
    + 'then it gets the chat’s last lines from Claude’s transcript, its thinking left out.',
    async () => {
      const id = (await view()).reviews[0].id;
      const tail = (await manager.call('tail', { query: { id } })).data as { lines: Array<{ kind: string; text: string }> };
      assert.deepEqual(tail.lines, [
        { kind: 'you', text: '/untangle' },
        { kind: 'tool', text: 'Bash(untangle watch)' },
        { kind: 'out', text: 'untangle: 1 note you haven’t read.' },
        { kind: 'say', text: 'Answered N1 in its thread.' },
      ]);
    },
  );

  it(
    'when Chat is clicked, '
    + 'then Orca brings Claude’s terminal to the front.',
    async () => {
      const id = (await view()).reviews[0].id;
      const r = await manager.call('chat', { method: 'POST', body: { id } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(calls().at(-1), ['terminal', 'switch', '--terminal', 'term_a', '--json']);
    },
  );

  it(
    'when Open review is clicked, '
    + 'then the review opens in the browser, since it never opened a tab in Orca.',
    async () => {
      const id = (await view()).reviews[0].id;
      const r = await manager.call('open', { method: 'POST', body: { id } });
      assert.deepEqual([r.status, r.data], [200, { where: 'browser' }]);
      assert.equal(fs.readFileSync(opened, 'utf8').trim().split('\n').at(-1), run.url);
    },
  );

  it(
    'when untangle reviews runs again, '
    + 'then it finds the manager running and says where it is.',
    async () => {
      const pid = managerIn(cache)!.pid;
      const again = await reviews();
      assert.deepEqual([again.code, again.out.trim(), managerIn(cache)!.pid], [0, `untangle: your reviews are at ${managerUrl}`, pid]);
    },
  );

  it(
    'when the review stops, '
    + 'then the manager lists it paused, with what it holds on disk and Claude’s chat kept.',
    async () => {
      const stopped = await untangleCommand(['stop'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
      assert.equal(stopped.code, 0, stopped.err);
      const r = await until('the review paused', async () => (await view()).reviews.find((x) => x.status === 'paused'));
      assert.deepEqual([r.memory, r.agents, r.chat && r.chat.id], [null, [], chat]);
      assert.ok(r.disk && r.disk > 0);
    },
  );
});
