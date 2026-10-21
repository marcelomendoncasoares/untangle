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

describe('Given the manager inside Orca, ', { timeout: 300_000 }, () => {
  let repo: TempRepo, other: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', orcaLog = '';
  let manager: ReviewClient;
  const session = 'c1a0de00-0000-4000-8000-00000000c1a0';
  // No $BROWSER: inside Orca, a review's page opens as one of its tabs.
  const env = (): NodeJS.ProcessEnv => ({ PATH: [bin, gh.binDir, process.env.PATH].join(path.delimiter), ORCA_CLI_COMMAND: 'orca-ide', ORCA_STUB_LOG: orcaLog });
  const calls = (): string[][] => (fs.existsSync(orcaLog) ? fs.readFileSync(orcaLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const branch = (r: TempRepo, said: string) => {
    r.write('pubspec.yaml', pubspec);
    r.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    r.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    r.branch('feature');
    r.write('lib/a.dart', `void greet() {\n  print('${said}');\n}\n`);
    r.commit({ subject: `Say ${said}`, author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  };

  before(async () => {
    repo = TempRepo.create();
    other = TempRepo.create();
    branch(repo, 'hello');
    branch(other, 'hey');
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    orcaLog = path.join(bin, 'orca.log');
    fs.writeFileSync(path.join(bin, 'orca-ide'), `#!/bin/sh\nexec node ${JSON.stringify(orcaStub)} "$@"\n`, { mode: 0o755 });
    // Claude and Codex, there to be found: the commands are typed into Orca's terminals, not run here.
    for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
  });

  after(async () => {
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    other.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when a review starts with Claude, '
    + 'then the Reviews workspace is added to Orca, its page opens as a tab there, and Claude starts in a terminal there, with the skill and the first message after the review.',
    async () => {
      const top = fs.realpathSync(repo.dir);
      // A quote in it stays whole through the shell.
      const message = "Do an initial review of this branch. Don't miss the tests.";
      const r = await manager.call('start', { method: 'POST', body: { target: top, agent: { kind: 'claude', resume: null, session, flags: '--model opus', message } } });
      assert.equal(r.status, 200, r.text);
      const folder = path.join(cache, 'chats', 'Reviews');
      const worktree = `repo-1::${folder}`;
      assert.deepEqual((r.data as { chat: unknown; command: unknown }).chat, { id: session, handle: 'term_1' });
      assert.equal((r.data as { command: unknown }).command, null);
      assert.ok(fs.existsSync(path.join(folder, '.git')));
      const name = `${path.basename(repo.dir)}`;
      assert.deepEqual(calls().filter((c) => c[0] !== 'tab'), [
        ['repo', 'add', '--path', folder],
        ['worktree', 'list', '--repo', 'id:repo-1'],
        ['worktree', 'set', '--worktree', `id:${worktree}`, '--display-name', 'Reviews'],
        ['terminal', 'create', '--worktree', `id:${worktree}`, '--title', `${name} · Claude`, '--command', `claude --session-id ${session} -n 'Review ${name}' --model opus '/untangle ${top} Do an initial review of this branch. Don'\\''t miss the tests.'`],
      ]);
      // The review opens its own page, as a tab of the workspace.
      const url = runsIn(cache)[0].url;
      await until('the page’s tab', () => calls().some((c) => c[0] === 'tab' && c[1] === 'create'));
      assert.deepEqual(calls().find((c) => c[0] === 'tab' && c[1] === 'create'), ['tab', 'create', '--url', url, '--worktree', `id:${worktree}`]);
    },
  );

  it(
    'when another review starts with Codex, '
    + 'then the workspace isn’t added again, and Codex starts with $untangle, as it names skills.',
    async () => {
      const before = calls().length;
      const top = fs.realpathSync(other.dir);
      const r = await manager.call('start', { method: 'POST', body: { target: top, agent: { kind: 'codex', resume: null, flags: '', message: '' } } });
      assert.equal(r.status, 200, r.text);
      const worktree = `repo-1::${path.join(cache, 'chats', 'Reviews')}`;
      assert.deepEqual(calls().slice(before).filter((c) => c[0] !== 'tab'), [
        ['worktree', 'show', '--worktree', `id:${worktree}`],
        ['terminal', 'create', '--worktree', `id:${worktree}`, '--title', `${path.basename(other.dir)} · Codex`, '--command', `codex --no-daemon '$untangle ${top}'`],
      ]);
    },
  );

  it(
    'when the start form asks, '
    + 'then it gets each agent installed with the flags it last started with, and that Orca is there.',
    async () => {
      const a = (await manager.call('agents')).data as { claude: { installed: boolean; flags: string }; codex: { installed: boolean; flags: string }; orca: boolean; chats: unknown[] };
      assert.deepEqual([a.claude, a.codex, a.orca, a.chats], [{ installed: true, flags: '--model opus' }, { installed: true, flags: '' }, true, []]);
    },
  );

  it(
    'when Claude is added to a running review, '
    + 'then only its chat starts, in the workspace.',
    async () => {
      const rows = ((await manager.call('reviews')).data as { reviews: Array<{ id: string; status: string }> }).reviews;
      const id = await until('a review built', async () => ((await manager.call('reviews')).data as { reviews: Array<{ id: string; status: string; build: unknown }> }).reviews.find((x) => x.status === 'running' && !x.build && !x.id.startsWith('run:'))?.id);
      assert.ok(rows.length >= 1);
      const before = calls().length;
      const r = await manager.call('agent', { method: 'POST', body: { id, agent: { kind: 'claude', resume: null, session, flags: '', message: '' } } });
      assert.equal(r.status, 200, r.text);
      const added = calls().slice(before).filter((c) => c[0] === 'terminal');
      assert.equal(added.length, 1);
      assert.match(added[0].at(-1)!, /^claude --session-id c1a0de00-0000-4000-8000-00000000c1a0 -n 'Review .+' '\/untangle \//);
    },
  );
});
