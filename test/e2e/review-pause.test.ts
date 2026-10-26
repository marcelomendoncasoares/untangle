import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

// Every record in the cache, as untangle reviews reads them.
function records(dir: string): Array<{ stopped: { why: string } | null; closed: string | null }> {
  const out: Array<{ stopped: { why: string } | null; closed: string | null }> = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') && out.push(JSON.parse(fs.readFileSync(path.join(d, e.name), 'utf8')))));
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe('Given a review open on its page, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head') && !document.querySelector('#vw-revs').hidden`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when Pause this review is clicked in its Reviews menu, ', () => {
    let menu = '';
    let bar = '';

    before(async () => {
      await page.click('#vw-revs');
      await page.until(`!!document.querySelector('.revs-pop .rv-pause')`);
      menu = await read(page, `[...document.querySelectorAll('.revs-pop .rv-f > *')].map((el) => el.textContent.trim()).join(' | ')`);
      await page.click('.revs-pop .rv-pause');
      await page.until(`!document.querySelector('#vw-alarm').hidden && document.querySelector('#vw-alarm').classList.contains('paused')`, 15_000);
      bar = await read(page, `document.querySelector('#vw-alarm').textContent`);
    });

    it('then the menu offers it after Start a review, and with no agent at work, the review pauses at once: the top bar says so, and how it resumes.', async () => {
      assert.equal(menu, 'Start a review | Pause this review');
      assert.equal(bar, 'Paused · its notes, marks and chat are kept · untangle reviews resumes it');
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !records(path.join(cache, 'sessions')).some((r) => r.stopped)) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(records(path.join(cache, 'sessions')).map((r) => [r.stopped && r.stopped.why, r.closed]), [['paused', null]]);
    });
  });
});
