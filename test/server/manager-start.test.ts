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
      assert.equal(fs.readFileSync(opened, 'utf8').trim().split('\n').length, before + 1);
    },
  );
});
