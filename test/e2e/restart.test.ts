import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { TempRepo } from '../helpers/repo.ts';
import { runsIn, startUntangle, stopRuns, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-09-01T15:00:00Z' };
const sdk = 'environment:\n  sdk: ^3.6.0\n';
const member = (name: string, version: string, rest = '') => `name: ${name}\nversion: ${version}\n${sdk}resolution: workspace\n${rest}`;
const fresh = `(() => { const el = document.querySelector('#vw-fresh'); return el.hidden ? 'hidden' : el.textContent.trim(); })()`;

describe('Given a review open on its Dependencies page, and a newer untangle installed since it started, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache = '';
  let stamp = '';
  let pid = 0;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', `name: ws\n${sdk}workspace:\n  - packages/core\n  - packages/server\n`);
    repo.write('packages/core/pubspec.yaml', member('core', '1.0.0'));
    repo.write('packages/server/pubspec.yaml', member('server', '1.0.0', 'dependencies:\n  core: 1.0.0\n'));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('packages/core/pubspec.yaml', member('core', '1.1.0'));
    repo.write('packages/server/pubspec.yaml', member('server', '1.1.0', 'dependencies:\n  core: 1.1.0\n'));
    repo.commit({ subject: 'Release 1.1.0', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    // The stamp stands for untangle's build on disk.
    stamp = path.join(cache, 'built.stamp');
    fs.writeFileSync(stamp, '');
    fs.utimesSync(stamp, new Date(2020, 0, 1), new Date(2020, 0, 1));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, env: { UNTANGLE_BUILT_FROM: stamp } });
    await waitForReview(reviewClient(run.url));
    pid = runsIn(cache)[0].pid;
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-act="deps-open"]');
    await page.until(`!!document.querySelector('.dp-by')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    if (cache) await stopRuns(cache);
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when untangle is built again, and the page is shown, ', () => {
    let pill = '';

    before(async () => {
      const now = new Date(Date.now() + 5000);
      fs.utimesSync(stamp, now, now);
      await page.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
      await page.until(`${fresh} !== 'hidden'`, 10_000);
      pill = await read(page, fresh);
    });

    it('then the top bar says so, with Refresh.', () => {
      assert.equal(pill, 'untangle was updatedRefresh');
    });

    describe('and Refresh is clicked, ', () => {
      let restarting = '';
      let after0 = '';

      before(async () => {
        await page.eval(`window.__before = true`);
        await page.click('#vw-fresh [data-act="refresh"]');
        restarting = await read(page, fresh);
        await page.until(`!window.__before && !!document.querySelector('.dp-by')`, 120_000);
        after0 = [await read(page, fresh), String(runsIn(cache).map((r) => r.pid).filter((p) => p !== pid).length)].join(' | ');
      });

      it('then the review restarts on the new untangle, and the page reloads into it, on the same page.', () => {
        assert.deepEqual([restarting, after0], ['Restarting on the new untangle', 'hidden | 1']);
      });
    });
  });
});
