import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pullRequestGh } from '../helpers/pull-request.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 90_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function feature(): TempRepo {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
  repo.branch('feature');
  repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
  repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  return repo;
}

describe('Given a review that runs, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', opened = '';
  let first: UntangleRun;
  const env = (): NodeJS.ProcessEnv => ({ BROWSER: path.join(bin, 'browser.sh') });

  before(async () => {
    repo = feature();
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    opened = path.join(bin, 'opened.log');
    fs.writeFileSync(path.join(bin, 'browser.sh'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    first = await startUntangle(repo.dir, { cacheDir: cache, gh });
    await waitForReview(reviewClient(first.url));
  });

  after(async () => {
    await first.stop();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when untangle is run on it again, '
    + 'then no second one starts: it says the review is open already, opens its page, and ends.',
    async () => {
      const again = await untangleCommand(['-port', '0', repo.dir], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
      assert.equal(again.code, 0, again.err);
      assert.match(again.err, /feature against main is open already, in the browser\.\n {2}Review at http:\/\/127\.0\.0\.1:\d+\/\?token=/);
      assert.ok(again.err.includes(first.url), again.err);
      assert.equal(fs.readFileSync(opened, 'utf8').trim(), first.url);
      assert.deepEqual(runsIn(cache).map((r) => r.url), [first.url]);
    },
  );

  it(
    'when it’s run again from a file inside it, with -quiet, '
    + 'then the review’s link is all it prints.',
    async () => {
      const again = await untangleCommand(['-quiet', '-no-open', path.join(repo.dir, 'lib', 'a.dart')], { cacheDir: cache, gh, cwd: repo.dir });
      assert.equal(again.code, 0, again.err);
      assert.equal(again.out, first.url + '\n');
    },
  );

  it(
    'when two start it at once, '
    + 'then one serves it and the other gives way to it.',
    async () => {
      await first.stop();
      await until('the review to stop', () => runsIn(cache).length === 0);
      const two = await Promise.all([0, 1].map(() => startUntangle(repo.dir, { cacheDir: cache, gh })));
      try {
        const gone = await Promise.race(two.map((r) => r.exited.then((code) => ({ r, code }))));
        const stays = two.find((r) => r !== gone.r)!;
        assert.equal(gone.code, 0, gone.r.output());
        // The one that stays printed its link: the other printed it too, as the review's.
        const link = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(stays.output())![0];
        assert.ok(gone.r.output().includes(link), gone.r.output());
        await sleep(500);
        assert.deepEqual(runsIn(cache).map((r) => r.url), [link]);
        await waitForReview(reviewClient(link));
      } finally {
        await Promise.all(two.map((r) => r.stop()));
      }
    },
  );
});

describe('Given a branch whose pull request is reviewed from its directory, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '';
  let run: UntangleRun;

  before(async () => {
    repo = feature();
    gh = pullRequestGh({ number: 7, title: 'Say hello', url: 'https://github.com/acme/sample/pull/7', base: 'main', baseSha: repo.rev('main'), head: 'feature', headSha: repo.rev('HEAD') });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    await waitForReview(reviewClient(run.url));
  });

  after(async () => {
    await run.stop();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when untangle is run on the pull request’s link, '
    + 'then that review is the one: none starts from the link.',
    async () => {
      const again = await untangleCommand(['-quiet', '-no-open', 'https://github.com/acme/sample/pull/7'], { cacheDir: cache, gh, cwd: os.tmpdir() });
      assert.equal(again.code, 0, again.err);
      assert.equal(again.out, run.url + '\n');
      assert.deepEqual(runsIn(cache).map((r) => r.url), [run.url]);
    },
  );
});
