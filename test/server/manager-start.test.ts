import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, stopRuns, untangleCommand } from '../helpers/run.ts';
import { heldGit, type SlowGit } from '../helpers/slow-git.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 90_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

interface Row { id: string; title: string; status: string; build: { phase: string } | null }
interface Pull { repo: string; number: number; title: string; author: string; url: string; updated: string; draft: boolean }

describe('Given the manager, and GitHub asking you to review a pull request, ', { timeout: 300_000 }, () => {
  let repo: TempRepo, other: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', opened = '';
  let manager: ReviewClient;
  const env = (): NodeJS.ProcessEnv => ({ BROWSER: path.join(bin, 'browser.sh'), PATH: [bin, gh.binDir, process.env.PATH].join(path.delimiter) });
  const rows = async () => ((await manager.call('reviews')).data as { reviews: Row[] }).reviews;
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
    const found = (n: number, title: string, author: string) => ({ number: n, title, url: `https://github.com/acme/app/pull/${n}`, updatedAt: '2026-10-21T10:00:00Z', isDraft: false, repository: { nameWithOwner: 'acme/app' }, author: { login: author } });
    gh = stubGh([
      { match: ['search', 'prs', '--review-requested=@me'], stdout: [found(12, 'feat: Retry calls', 'ada')] },
      { match: ['search', 'prs', '--author=@me'], stdout: [found(7, 'fix: Keep the clock', 'me')] },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    opened = path.join(bin, 'opened.log');
    fs.writeFileSync(path.join(bin, 'browser.sh'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    // Orca's own command on PATH, as on a machine with Orca: a test must never run it.
    for (const name of ['orca-ide', 'orca']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(path.join(bin, 'orca.log'))}\necho '{"ok":false}'\n`, { mode: 0o755 });
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
    'when the palette asks for pull requests, '
    + 'then it gets the ones asked of you and your own, from gh.',
    async () => {
      const pulls = (await manager.call('pulls')).data as { asked: Pull[]; yours: Pull[]; error: string | null };
      assert.deepEqual(pulls, {
        asked: [{ repo: 'acme/app', number: 12, title: 'feat: Retry calls', author: 'ada', url: 'https://github.com/acme/app/pull/12', updated: '2026-10-21T10:00:00Z', draft: false }],
        yours: [{ repo: 'acme/app', number: 7, title: 'fix: Keep the clock', author: 'me', url: 'https://github.com/acme/app/pull/7', updated: '2026-10-21T10:00:00Z', draft: false }],
        error: null,
      });
    },
  );

  it(
    'when a review is started, '
    + 'then it runs on its own, is listed while it builds and once it’s built, and opens its page; started again, it isn’t.',
    async () => {
      const top = fs.realpathSync(repo.dir);
      const r = await manager.call('start', { method: 'POST', body: { target: top } });
      assert.equal(r.status, 200, r.text);
      const pid = (r.data as { pid: number }).pid;
      assert.ok(runsIn(cache).some((x) => x.pid === pid));
      const built = await until('the review built', async () => (await rows()).find((x) => x.status === 'running' && !x.build && !x.id.startsWith('run:')));
      assert.equal(built.title, 'feature against main');
      await until('its page to open', () => fs.existsSync(opened) && fs.readFileSync(opened, 'utf8').includes('127.0.0.1'));
      const again = await manager.call('start', { method: 'POST', body: { target: top } });
      assert.deepEqual(again.data, { already: true, pid });
    },
  );

  it(
    'when it’s closed, '
    + 'then it stops and is listed closed; reopened, it runs again.',
    async () => {
      const id = (await rows())[0].id;
      assert.equal((await manager.call('close', { method: 'POST', body: { id } })).status, 200);
      await until('the review closed', async () => (await rows()).find((x) => x.id === id && x.status === 'closed'));
      // Its process goes right after it says so.
      await until('its process to end', () => runsIn(cache).length === 0);
      assert.equal((await manager.call('start', { method: 'POST', body: { id } })).status, 200);
      await until('the review running again', async () => (await rows()).find((x) => x.id === id && x.status === 'running' && !x.build));
    },
  );

  it(
    'when a review’s page asks for the others, '
    + 'then it gets every review but itself, and can bring another to the front.',
    async () => {
      const start = await manager.call('start', { method: 'POST', body: { target: fs.realpathSync(other.dir) } });
      assert.equal(start.status, 200, start.text);
      await until('both built', async () => (await rows()).filter((x) => x.status === 'running' && !x.build && !x.id.startsWith('run:')).length === 2);
      const run = runsIn(cache).find((x) => x.pid !== (start.data as { pid: number }).pid)!;
      const review = reviewClient(run.url);
      await review.open();
      const listed = (await review.call('reviews')).data as { self: string; reviews: Row[] };
      const others = listed.reviews.filter((x) => x.id !== listed.self);
      assert.equal(others.length, 1);
      const before = fs.readFileSync(opened, 'utf8').trim().split('\n').length;
      const shown = await review.call('reviews/open', { method: 'POST', body: { id: others[0].id } });
      assert.deepEqual([shown.status, shown.data], [200, { where: 'browser' }]);
      // The browser starts on its own, after the answer: its line comes when it does.
      await until('its page to open', () => fs.readFileSync(opened, 'utf8').trim().split('\n').length === before + 1, 10_000);
    },
  );

  it(
    'when reviews have been started, closed and reopened, '
    + 'then untangle never ran the Orca on PATH: a test leaves the person’s Orca alone.',
    () => {
      const log = path.join(bin, 'orca.log');
      assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '');
    },
  );
});

describe('Given the manager, and a review it started that’s still being built, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let git: SlowGit & { release(): void };
  let cache = '', bin = '', opened = '';
  let manager: ReviewClient;
  let id = '';
  const rows = async () => ((await manager.call('reviews')).data as { reviews: Row[] }).reviews;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    // Its build waits at the base's checkout, which starts with git init, with its page up.
    git = heldGit(['init']);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    opened = path.join(bin, 'opened.log');
    fs.writeFileSync(path.join(bin, 'browser.sh'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    const env = { BROWSER: path.join(bin, 'browser.sh'), PATH: [git.dir, bin, gh.binDir, process.env.PATH].join(path.delimiter) };
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir, env });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
    const r = await manager.call('start', { method: 'POST', body: { target: fs.realpathSync(repo.dir) } });
    assert.equal(r.status, 200, r.text);
    id = (await until('its row', async () => (await rows()).find((x) => x.id.startsWith('run:'))))!.id;
  });

  after(async () => {
    git.release();
    await stopRuns(cache);
    git.remove();
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when its row is opened, '
    + 'then its page comes to the front, as a built one’s does.',
    async () => {
      // The browser starts on its own, after the answer: its line comes when it does. The review opened its page as it started.
      const url = runsIn(cache)[0].url;
      const opens = () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').trim().split('\n').filter((l) => l === url).length : 0);
      await until('its page to open as it started', () => opens() === 1);
      const r = await manager.call('open', { method: 'POST', body: { id } });
      assert.deepEqual([r.status, r.data], [200, { where: 'browser' }]);
      await until('its page to open again', () => opens() === 2, 10_000);
    },
  );

  it(
    'when it’s closed, '
    + 'then it stops before it’s built, and nothing is left of it in the list.',
    async () => {
      assert.equal((await manager.call('close', { method: 'POST', body: { id } })).status, 200);
      await until('its process to end', () => runsIn(cache).length === 0);
      assert.deepEqual(await rows(), []);
    },
  );
});

describe('Given the manager, and a pull request GitHub asks you to review, whose review starts but hasn’t heard from GitHub yet, ', { timeout: 300_000 }, () => {
  let gh: GhStub;
  let cache = '', bin = '', held = '';
  let manager: ReviewClient;
  let pid = 0;
  const rows = async () => ((await manager.call('reviews')).data as { reviews: Array<Row & { name: string; kind: string | null; repo: string; author: string | null }> }).reviews;

  before(async () => {
    const found = { number: 12, title: 'feat: Retry calls', url: 'https://github.com/Acme/App/pull/12', updatedAt: '2026-10-21T10:00:00Z', isDraft: false, repository: { nameWithOwner: 'Acme/App' }, author: { login: 'ada' } };
    gh = stubGh([
      { match: ['search', 'prs', '--review-requested=@me'], stdout: [found] },
      { match: ['search', 'prs', '--author=@me'], stdout: [] },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    fs.writeFileSync(path.join(bin, 'browser.sh'), '#!/bin/sh\n', { mode: 0o755 });
    // gh pr view waits until the test ends, so the review stays where it starts, and never asks GitHub.
    held = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-gh-'));
    fs.writeFileSync(path.join(held, 'gh'), `#!/usr/bin/env bash\nif [ "$1 $2" = "pr view" ]; then while [ -d ${JSON.stringify(held)} ]; do sleep 0.05; done; exit 1; fi\nexec ${JSON.stringify(path.join(gh.binDir, 'gh'))} "$@"\n`, { mode: 0o755 });
    const env = { BROWSER: path.join(bin, 'browser.sh'), PATH: [held, bin, gh.binDir, process.env.PATH].join(path.delimiter) };
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: os.tmpdir(), env });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
  });

  after(async () => {
    // Before gh lets go: the review would ask GitHub then.
    for (const run of runsIn(cache)) {
      if (run.pid > 0) try { process.kill(-run.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    await stopRuns(cache);
    fs.rmSync(held, { recursive: true, force: true });
    gh.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when the palette lists it and it’s started, '
    + 'then its row has the title, kind, repository and author GitHub listed, until the review says them.',
    async () => {
      await manager.call('pulls');
      const r = await manager.call('start', { method: 'POST', body: { target: 'https://github.com/Acme/App/pull/12' } });
      assert.equal(r.status, 200, r.text);
      pid = (r.data as { pid: number }).pid;
      const row = (await rows()).find((x) => x.id === `run:${pid}`);
      assert.deepEqual(row && [row.name, row.kind, row.title, row.repo, row.author, row.build?.phase], ['app#12', 'feat', 'Retry calls', 'Acme/App', 'ada', 'starting']);
    },
  );
});
