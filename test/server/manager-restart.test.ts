import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';

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

interface Hello { pid: number; updated: boolean; busy: boolean }

describe('Given the manager serving its page, and a newer untangle installed since it started, ', { timeout: 120_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let stamp = '';
  let manager: ReviewClient;
  let first: Hello;
  let updated: Hello;
  const hello = async () => (await manager.call('hello')).data as Hello;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    // The stamp stands for untangle's build on disk.
    stamp = path.join(cache, 'built.stamp');
    fs.writeFileSync(stamp, '');
    fs.utimesSync(stamp, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir, env: { UNTANGLE_BUILT_FROM: stamp } });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
    first = await hello();
    const now = new Date(Date.now() + 5000);
    fs.utimesSync(stamp, now, now);
    updated = await hello();
  });

  after(async () => {
    if (cache) await stopRuns(cache);
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('then it says a newer untangle is installed than the one serving the page.', () => {
    assert.deepEqual([first.updated, updated.updated, updated.pid === first.pid], [false, true, true]);
  });

  describe('when it’s restarted, ', () => {
    let answer: { status: number; data: unknown };
    let next: Hello;
    let reviews = 0;

    before(async () => {
      answer = await manager.call('restart', { method: 'POST' });
      next = await until('the untangle that serves the page next', async () => {
        try {
          const h = await hello();
          return h.pid !== first.pid ? h : null;
        } catch {
          return null;
        }
      });
      reviews = (await manager.call('reviews')).status;
    });

    it('then another untangle serves the page at the same address, with the same token, and it’s up to date.', () => {
      assert.deepEqual([answer.status, answer.data], [200, { restarting: true, pid: first.pid }]);
      assert.deepEqual([next.updated, reviews], [false, 200]);
    });
  });
});
