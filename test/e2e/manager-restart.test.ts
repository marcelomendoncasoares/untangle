import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const fresh = `(() => { const el = document.querySelector('#fresh'); return el.hidden ? 'hidden' : el.textContent.trim(); })()`;

describe('Given the Reviews page open, and a newer untangle installed since it started, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let page: Browser;
  let cache = '';
  let stamp = '';

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
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(/http:\/\/\S+/.exec(started.out)![0]);
    await page.until(`!!document.querySelector('#counts').textContent`, 30_000);
  });

  after(async () => {
    await page?.close();
    if (cache) await stopRuns(cache);
    gh?.remove();
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
      let reloaded = '';

      before(async () => {
        await page.eval(`window.__before = true`);
        await page.click('#fresh [data-act="restart"]');
        restarting = await read(page, fresh);
        await page.until(`!window.__before && !!document.querySelector('#counts').textContent`, 60_000);
        await new Promise((r) => setTimeout(r, 3500));
        reloaded = await read(page, fresh);
      });

      it('then the manager restarts on the new untangle, and the page reloads into it.', () => {
        assert.deepEqual([restarting, reloaded], ['Restarting on the new untangle', 'hidden']);
      });
    });
  });
});
