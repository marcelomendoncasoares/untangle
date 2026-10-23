import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, stopRuns, untangleCommand } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 120_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

interface NotesView { notes: Array<{ n: number; resolved: { by: string | null } | null; comments: Array<{ by: string | null; body: string }> }>; agents: Array<{ name: string; state: string; chat: string | null; wake: string | null }> }

describe('Given a branch no review is running for, and an agent that watches it, ', { timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let opened = '';
  let client: ReviewClient;
  let head = '';
  let first: { code: number | null; out: string; err: string };
  // The page's browser, as the review opens it: the link goes to a file.
  const env = (): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(cache, 'browser.sh') });
  const command = (args: string[]) => untangleCommand(args, { cacheDir: cache, gh: gh!, cwd: repo!.dir, env: env() });

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
    opened = path.join(cache, 'opened.txt');
    fs.writeFileSync(path.join(cache, 'browser.sh'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    const watching = command(['watch', '-agent', 'Codex', '-no-open', '-port', '0', '-base', 'main']);
    const run = await until('the review watch starts', () => runsIn(cache)[0]);
    client = reviewClient(run.url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    await until('the agent to watch', async () => ((await client.call('notes')).data as NotesView).agents.some((a) => a.state === 'listening'));
    const added = await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
    assert.equal(added.status, 200);
    first = await watching;
  });

  after(async () => {
    if (cache) await stopRuns(cache);
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when a note is written on the review’s page, '
    + 'then the watch prints it with its code and ends, saying how to go on.',
    () => {
      const out = first.out;
      assert.deepEqual([first.code, out.split('\n').slice(0, 2)], [0, ['untangle: starting the review of this directory…', `untangle: feature against main is open at ${runsIn(cache)[0].url}.`]]);
      assert.ok(out.includes([
        `untangle: 1 note you haven’t read, on ${path.basename(repo!.dir)} at ${head.slice(0, 7)}. Line numbers are on that commit.`,
        '',
        'Where a note explicitly asks for a change, make it. Otherwise, discuss it with me before changing anything.',
        '',
        'N1 · lib/a.dart:2',
        `In the change "Say hello" (${head.slice(0, 7)})`,
        '```dart',
        "  print('hello');",
        '```',
        'Why hello?',
        '',
      ].join('\n')), out);
      assert.match(out, /\nuntangle: answer in a note’s thread with untangle reply -agent Codex N2 'the answer'\. Follow the line the notes open with: by default, change code only where a note explicitly asks for it\. After making such a change, commit it and add -resolve\./);
    },
  );

  it(
    'when the agent answers and resolves the note, '
    + 'then the page’s notes show its answer, and that it resolved the note.',
    async () => {
      const r = await command(['reply', '-agent', 'Codex', '-resolve', 'N1', 'Because', 'it', 'greets.']);
      assert.deepEqual([r.code, r.out], [0, 'untangle: answered N1 and resolved it.\n']);
      const view = (await client.call('notes')).data as NotesView;
      assert.deepEqual(view.notes.map((n) => [n.n, n.resolved?.by, n.comments.map((c) => [c.by, c.body])]), [[1, 'Codex', [[null, 'Why hello?'], ['Codex', 'Because it greets.']]]]);
    },
  );

  it(
    'when the agent asks for every note, '
    + 'then they print as Copy for agent gives them.',
    async () => {
      const r = await command(['notes', '-all']);
      assert.deepEqual([r.code, r.out.split('\n').slice(0, 5)], [0, [`My review notes on ${path.basename(repo!.dir)} (branch feature, at ${head.slice(0, 7)}). Line numbers are on that commit.`, '', 'Where a note explicitly asks for a change, make it. Otherwise, discuss it with me before changing anything.', '', 'N1 · lib/a.dart:2 (resolved)']]);
    },
  );

  it(
    'when the agent answers a note there isn’t, '
    + 'then it hears which notes there are.',
    async () => {
      const r = await command(['reply', '-agent', 'Codex', 'N7', 'Hi.']);
      assert.deepEqual([r.code, r.err], [1, 'untangle: there is no note N7 (the notes are N1)\n']);
    },
  );

  it(
    'when the agent writes a note of its own, '
    + 'then it says the lines it’s on, the page has it as the agent’s, and comments go to notes in a review an agent started.',
    async () => {
      const r = await command(['note', '-agent', 'Codex', 'lib/a.dart:2', 'Say', 'hello', 'once?']);
      const view = (await client.call('notes')).data as NotesView & { mode: string | null };
      assert.deepEqual([r.code, r.out], [0, `untangle: wrote N2 on lib/a.dart:2, at ${head.slice(0, 7)}:\n    print('hello');\n`]);
      assert.deepEqual([view.notes.find((n) => n.n === 2)?.comments.map((c) => [c.by, c.body]), view.mode], [[['Codex', 'Say hello once?']], 'local']);
    },
  );

  it(
    'when the agent writes a note past the file’s end, '
    + 'then it hears how long the file is.',
    async () => {
      const r = await command(['note', '-agent', 'Codex', 'lib/a.dart:9', 'Here?']);
      assert.deepEqual([r.code, r.err], [1, `untangle: lib/a.dart has 3 lines at ${head.slice(0, 7)}\n`]);
    },
  );

  it(
    'when the review is stopped while another watch waits, '
    + 'then the review’s page had opened for it, the watch says the review closed, and the review is gone.',
    async () => {
      const url = runsIn(cache)[0].url;
      const waiting = command(['watch', '-agent', 'Codex']);
      await until('the second watch', async () => ((await client.call('notes')).data as NotesView).agents.some((a) => a.state === 'listening'));
      const stopped = await command(['stop']);
      const w = await waiting;
      assert.deepEqual([stopped.code, stopped.out, w.code, w.out.split('\n').slice(-2)], [0, 'untangle: closed the review of feature against main.\n', 0, ['untangle: the review of feature against main is closed (its page closed, or untangle stop ran): there’s nothing more to watch.', '']]);
      assert.equal(fs.readFileSync(opened, 'utf8'), url + '\n');
      await until('the review to stop', () => runsIn(cache).length === 0, 10_000);
    },
  );

  it(
    'when a killed review left its run file, its process id now another’s, '
    + 'then the commands don’t take it for running, and the file goes.',
    async () => {
      const port = await new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
      const file = path.join(cache, 'run', `${process.pid}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/?token=gone`, token: 'gone', dir: fs.realpathSync(repo!.dir), pr: null, started: new Date().toISOString() }));
        const r = await command(['notes']);
        assert.deepEqual([r.code, r.err, fs.existsSync(file)], [1, 'untangle: no review of this directory is running: untangle watch starts one\n', false]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  );

  it(
    'when the agent answers with no review running, '
    + 'then it hears how to start one.',
    async () => {
      const r = await command(['reply', 'N1', 'Hi.']);
      assert.deepEqual([r.code, r.err], [1, 'untangle: no review of this directory is running: untangle watch starts one\n']);
    },
  );
});

/** A branch with one change, and a cache of its own, for a describe's reviews. */
function fixture() {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
  repo.branch('feature');
  repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
  const head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  const gh = stubGh();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
  fs.writeFileSync(path.join(bin, 'browser.sh'), '#!/bin/sh\n', { mode: 0o755 });
  // The commands' environment: a quick burst, a browser that opens nothing, and the stand-ins first on PATH.
  const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(bin, 'browser.sh'), PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...more });
  const note = (client: ReviewClient, line: number, body: string) => client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line, body } });
  // The review a watch started, as its page reaches it (the token traded for a cookie).
  const review = async () => {
    const client = reviewClient((await until('the review watch starts', () => runsIn(cache)[0])).url);
    await client.open();
    return client;
  };
  return {
    repo, head, gh, cache, bin, env, note, review,
    remove: async () => {
      await stopRuns(cache);
      gh.remove();
      repo.remove();
      fs.rmSync(cache, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}

/** A program on PATH that notes each call's arguments (a JSON line in <name>.log) and prints `out`. */
function standIn(bin: string, name: string, out: string): string {
  const log = path.join(bin, `${name}.log`);
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(${JSON.stringify(out)});\n`, { mode: 0o755 });
  return log;
}
const calls = (log: string): string[][] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A process's parent, as Linux says, and the processes above and below one.
const parentOf = (pid: number) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return 0;
  }
};
const ancestry = (pid: number) => { const out: number[] = []; for (let p = parentOf(pid); p > 1 && out.length < 50; p = parentOf(p)) out.push(p); return out; };
const descendants = (pid: number) => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number).filter((p) => ancestry(p).includes(pid));

describe('Given a watch that starts a review, ', { timeout: 300_000, skip: process.platform !== 'linux' && 'reads /proc' }, () => {
  let f: ReturnType<typeof fixture>;

  before(() => { f = fixture(); });
  after(() => f.remove());

  it(
    'when an agent stops the watch with every process under it, '
    + 'then the review was no child of the watch, and keeps serving.',
    async () => {
      const watching = untangleCommand(['watch', '-no-open', '-port', '0', '-base', 'main'], { cacheDir: f.cache, gh: f.gh, cwd: f.repo.dir, env: f.env() });
      const client = await f.review();
      await until('the review', async () => (await client.call('notes')).status === 200);
      const run = runsIn(f.cache)[0];
      const above = ancestry(run.pid), under = descendants(watching.pid);
      [...under, watching.pid].forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
      await watching;
      assert.deepEqual([above.includes(watching.pid), under.includes(run.pid), (await client.call('notes')).status], [false, false, 200]);
    },
  );
});

describe('Given a Codex chat that asks for a review, ', { timeout: 300_000 }, () => {
  let f: ReturnType<typeof fixture>;
  let queued = '';
  let first: { code: number | null; out: string; err: string };
  let client: ReviewClient;
  const thread = '01a15644-ffa1-75b1-8a8a-2e487db9b996';
  const command = (args: string[]) => untangleCommand(args, { cacheDir: f.cache, gh: f.gh, cwd: f.repo.dir, env: f.env({ CODEX_THREAD_ID: thread, CODEX_HOME: path.join(f.cache, 'codex') }) });

  before(async () => {
    f = fixture();
    queued = standIn(f.bin, 'codex', `Queued message for thread ${thread}.\n`);
    first = await command(['watch', '-no-open', '-port', '0', '-base', 'main']);
    client = await f.review();
  });

  after(() => f.remove());

  it(
    'when its watch has nothing to read, '
    + 'then it returns at once, saying untangle will put a line in the chat, and how the review works for Codex.',
    () => {
      const lines = first.out.split('\n');
      assert.deepEqual([first.code, lines[2], lines[4]], [0, 'untangle: nothing to read yet: untangle will put a line in this chat when there is.', 'untangle: when there are unread notes or replies, untangle puts a line in this chat; untangle watch then prints them.']);
    },
  );

  it(
    'when a note is written, '
    + 'then the review puts one line in Codex’s chat, with codex queue.',
    async () => {
      const view = (await client.call('notes')).data as NotesView;
      assert.equal((await f.note(client, 2, 'Why hello?')).status, 200);
      const line = await until('the line in Codex’s chat', () => calls(queued)[0]);
      assert.deepEqual([view.agents.map((a) => [a.name, a.state, a.chat]), line], [[['Codex', 'listening', thread]], ['queue', '--thread', thread, '--message', 'untangle: 1 new note on the review of feature. Run untangle watch to read it.']]);
    },
  );

  it(
    'when Codex runs untangle watch for it, '
    + 'then the note prints, and the watch says the next line will come.',
    async () => {
      const r = await command(['watch']);
      assert.match(r.out, /\nN1 · lib\/a\.dart:2\n[\s\S]*\nWhy hello\?\n\nuntangle: answer a note with untangle reply <N> '<text>'\. After making a change a note asked for, add -resolve\. untangle puts a line in this chat when there’s more\.\n$/);
    },
  );
});

describe('Given two Claude chats in Orca’s terminals, ', { timeout: 300_000 }, () => {
  let f: ReturnType<typeof fixture>;
  let typed = '', config = '';
  let client: ReviewClient;
  const chats = { a: 'aaaaaaaa-0000-4000-8000-000000000001', b: 'bbbbbbbb-0000-4000-8000-000000000002' };
  // Claude's word on the session its process runs (this test's, for both), and whether it's busy.
  const session = (id: string, status: 'busy' | 'idle') => fs.writeFileSync(path.join(config, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, status, statusUpdatedAt: Date.now() }));
  const command = (args: string[], chat: string) => untangleCommand(args, { cacheDir: f.cache, gh: f.gh, cwd: f.repo.dir, env: f.env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: config, ORCA_TERMINAL_HANDLE: `term_${chat}`, ORCA_CLI_COMMAND: 'orca-ide' }) });
  const view = async () => (await client.call('notes')).data as NotesView;

  before(() => {
    f = fixture();
    typed = standIn(f.bin, 'orca-ide', JSON.stringify({ ok: true, result: { accepted: true } }));
    config = path.join(f.cache, 'claude');
    fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
  });

  after(() => f.remove());

  it(
    'when the first chat’s watch brings a note, '
    + 'then the agent is Claude, told to watch in the background, and works on the note while its chat is busy.',
    async () => {
      session(chats.a, 'busy');
      const watching = command(['watch', '-no-open', '-port', '0', '-base', 'main'], chats.a);
      client = await f.review();
      await until('Claude to listen', async () => (await client.call('notes')).status === 200 && (await view()).agents.some((a) => a.state === 'listening'));
      await f.note(client, 2, 'Why hello?');
      const r = await watching;
      assert.match(r.out, /\nuntangle: each untangle watch waits for unread notes and replies, prints them and exits\. After each answer, run it again in the background\.\n/);
      assert.deepEqual((await view()).agents.map((a) => [a.name, a.state, a.chat]), [['Claude', 'working', chats.a]]);
    },
  );

  it(
    'when its turn ends with no watch, and a note comes, '
    + 'then Claude isn’t listening, and the page can wake it: the line goes into its terminal, through Orca.',
    async () => {
      session(chats.a, 'idle');
      await f.note(client, 1, 'A doc comment?');
      const line = 'untangle: 1 new note on the review of feature. Run untangle watch to read it.';
      const a = await until('Wake', async () => (await view()).agents.find((x) => x.wake));
      const woke = await client.call('notes/wake', { method: 'POST', body: { agent: 'Claude' } });
      assert.deepEqual([a.state, a.wake, woke.status, calls(typed)], ['deaf', line, 200, [['terminal', 'send', '--terminal', `term_${chats.a}`, '--text', line, '--enter', '--json']]]);
    },
  );

  it(
    'when the second chat watches, '
    + 'then the first chat’s waiting watch says another chat took over, and the second gets every open note, told how the review works.',
    async () => {
      const caught = await command(['watch'], chats.a);
      const waiting = command(['watch'], chats.a);
      await until('the first chat to wait', async () => (await view()).agents.some((a) => a.state === 'listening'));
      session(chats.b, 'busy');
      const second = await command(['watch'], chats.b);
      const first = await waiting;
      assert.match(caught.out, /\nN2 · lib\/a\.dart:1\n/);
      assert.deepEqual([first.code, first.out.trim().split('\n').pop()], [0, 'untangle: another Claude chat took over this review: there’s nothing more to watch here.']);
      assert.match(second.out, /\nuntangle: you hold this review now: another Claude chat held it\. Here are its 2 open notes, on .+ at [0-9a-f]{7}\. Line numbers are on that commit\.\n[\s\S]*\nuntangle: this chat holds the code review\./);
      assert.deepEqual((await view()).agents.map((a) => [a.name, a.chat]), [['Claude', chats.b]]);
    },
  );
});
