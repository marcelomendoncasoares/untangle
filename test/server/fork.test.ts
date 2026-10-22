import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

describe('Given a branch of your fork of acme/app, its upstream remote, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '';
  let run: UntangleRun;
  let client: ReviewClient;
  let manager: ReviewClient;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    repo.remoteAdd('origin', 'https://github.com/ada/app.git');
    repo.remoteAdd('upstream', 'git@github.com:acme/app.git');
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    // Against main, given: nothing is asked of GitHub, or fetched.
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main' });
    client = reviewClient(run.url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
  });

  after(async () => {
    await run?.stop();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when it’s reviewed, '
    + 'then its page and the reviews page name it acme/app, as they name the pull requests of acme/app, while the cache keeps it where it always did.',
    async () => {
      const where = ((await client.call('status')).data as { where?: string }).where ?? '';
      assert.match(where, /^acme\/app · main [0-9a-f]{7} → [0-9a-f]{7}$/);
      const rows = await until('its row', async () => ((await manager.call('reviews')).data as { reviews: Array<{ repo: string; build: unknown }> }).reviews.filter((r) => !r.build));
      assert.deepEqual(rows.map((r) => r.repo), ['acme/app']);
      // Its record, as its notes and marks, stays under the fork it was kept by.
      assert.equal(fs.existsSync(path.join(cache, 'sessions', 'github.com', 'ada', 'app', 'feature.json')), true);
    },
  );
});
