// A review opened to build a change (untangle -build): before anything is built, and as its first
// commit lands.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

describe('Given a review opened with -build on a branch that adds nothing yet, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let opened = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    // Chains follow the commits, as untangle's own default: the change's chain is its commit's.
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, chains: null, args: ['-build'] });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.conv-new textarea')`, 30_000);
    opened = await read(page, `[
      document.querySelector('.crumbs').textContent,
      document.querySelector('.conv .onrev-none').textContent,
      document.querySelector('.conv-new textarea').placeholder,
      document.querySelector('.sb-prog').textContent + (document.querySelector('.sb-prog').classList.contains('all') ? ', all reviewed' : ''),
      document.querySelector('.sb-tabs [aria-selected="true"]').textContent,
    ].join('\\n')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('then it opens on the review’s thread, where a note says what to build, and the sidebar counts no changes yet.', () => {
    assert.equal(opened, [
      'Threads/The review',
      'Nothing is built yet. Say what to build in a note on the review: your agent builds it and commits, and its commits come in when you refresh.',
      'Tell your agent what to build',
      '0changes yet',
      'Threads0',
    ].join('\n'));
  });

  describe('when the chain map is opened, and then its button, ', () => {
    let map: string;
    let back: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('.sb-row.map');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '') === 'Chain map'`);
      map = await read(page!, `[document.querySelector('.fv-head .facts').textContent, document.querySelector('.fv-head [data-act="conversation"]').textContent, document.querySelector('div.empty').textContent].join('\\n')`);
      await page!.click('.fv-head [data-act="conversation"]');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('The review')`);
      back = await read(page!, `document.querySelector('.crumbs').textContent`);
    });

    it('then the map says nothing is built yet, and its button goes to the review’s thread.', () => {
      assert.equal(`${map}\n${back}`, [
        'Nothing built yet',
        'Say what to build',
        'The chains come with the commits that build the change. Say what to build in a note on the review.',
        'Threads/The review',
      ].join('\n'));
    });
  });

  describe('when a note says what to build, the change is committed, and Refresh is clicked, ', () => {
    let built: string;

    before(async () => {
      await rest(page!);
      await page!.click('.conv-new textarea');
      await page!.type('Say hello instead.');
      await page!.click('.conv-new [data-act="nt-review-add"]');
      await page!.until(`document.querySelectorAll('.conv .th').length === 1`);
      repo!.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
      const head = repo!.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
      // Back on the tab, the page asks for new commits at once.
      await page!.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
      await page!.until(`(document.querySelector('#vw-fresh')?.textContent || '').includes(${JSON.stringify(head.slice(0, 7))})`, 60_000);
      await page!.click('#vw-fresh [data-act="refresh"]');
      await page!.until(`(document.querySelector('.t-head')?.textContent || '').includes(${JSON.stringify(head.slice(0, 7))}) && !!document.querySelector('.sb-prog')`, 120_000);
      built = await read(page!, `[
        document.querySelector('.crumbs').textContent,
        document.querySelector('.sb-prog').textContent,
        [...document.querySelectorAll('.sb-row.chain .nm')].map((el) => el.textContent).join(', '),
        document.querySelector('[data-tab="comments"]').textContent,
      ].join('\\n')`);
    });

    it('then the page opens on the chain map, with the change to review, and the note is still on the review.', () => {
      assert.equal(built, ['Chain map', '1change to review', 'Say hello', 'Threads1'].join('\n'));
    });
  });
});
