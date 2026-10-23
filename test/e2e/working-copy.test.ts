import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';
import { until, workingFixture } from '../server/working-fixture.ts';

const skip = e2eSkip();

// The lines whose number is marked: written by a commit GitHub doesn't have.
const marked = `[...document.querySelectorAll('.vw-main .ln[data-w], .vw-main .half[data-w]')].filter((r) => getComputedStyle(r.querySelector('.no')).boxShadow !== 'none').map((r) => r.querySelector('.tx').textContent.trim())`;
const commitShown = (sha: string) => `(document.querySelector('#vw-title .t-commit') || {}).textContent?.includes('${sha.slice(0, 7)}')`;

describe('Given a pull request opened from its link, which an agent holds, with its page open, ', { skip, timeout: 300_000 }, () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;
  let page: Browser;
  let work = '';
  let holding = true;
  // An agent waits on the review all along, so untangle looks at the working copy every 2 s and at
  // GitHub every 15 s, and the page asks every 5 s.
  const holdOn = async () => {
    while (holding) await client.call('notes/watch', { method: 'POST', body: { agent: 'Test', wait: 30_000 } }).catch(() => {});
  };
  const local = async () => ((await client.call('refresh', { query: { check: '1' } })).data as { local: { work: string } | null }).local;
  // A commit in the working copy, reviewed: its new commits' pill, then Refresh.
  const reviewCommit = async (sha: string) => {
    await page.until(`!!document.querySelector('#vw-fresh [data-act="refresh"]')`, 30_000);
    await page.click('#vw-fresh [data-act="refresh"]');
    await page.until(commitShown(sha), 120_000);
  };

  before(async () => {
    f = workingFixture();
    run = await startUntangle(f.url, { cacheDir: f.cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await client.open();
    await waitForReview(client);
    await client.call('notes', { method: 'POST', body: { action: 'settings', live: true } });
    work = (await until('its working copy', local)).work;
    void holdOn();
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    holding = false;
    await page?.close();
    await run?.stop();
    await stopRuns(f.cache);
    f?.remove();
  });

  it(
    'when the working copy has a change not committed, '
    + 'then the top bar says so, by the commit reviewed, and stops once the change is gone.',
    async () => {
      fs.writeFileSync(path.join(work, 'greeting.txt'), 'hello there\n');
      await page.until(`(document.querySelector('#vw-title .t-unc') || {}).textContent === 'Not committed'`, 30_000);
      assert.equal(await page.eval(`document.querySelector('#vw-title .t-unc').title`), 'The working copy has changes not committed: the review shows them once they’re committed.');
      f.git(work, 'checkout', '--', 'greeting.txt');
      await page.until(`!document.querySelector('#vw-title .t-unc')`, 30_000);
    },
  );

  it(
    'when the agent commits there, and the review moves to that commit, '
    + 'then the top bar counts it not pushed, the Commits tab says so, and the line it wrote is marked.',
    async () => {
      const mine = f.commit(work, 'greeting.txt', 'hello everyone\n');
      await reviewCommit(mine);
      await page.until(`(document.querySelector('#vw-title .t-np') || {}).textContent === '1 not pushed'`, 30_000);
      await page.click('[data-tab="commits"]');
      await page.until(`!!document.querySelector('.cm-row[data-commit="${mine}"] .np-tag')`);
      assert.equal(await page.eval(`document.querySelectorAll('.np-tag').length`), 1);
      await page.click('[data-tab="files"]');
      await page.until(`!!document.querySelector('[data-open="greeting.txt"]')`);
      await page.click('[data-open="greeting.txt"]');
      await page.until(`${marked}.length > 0`);
      assert.deepEqual(await page.eval(marked), ['hello everyone']);
    },
  );

  it(
    'when the count is clicked, '
    + 'then only that commit’s changes count, the lens naming itself on the commit in its place.',
    async () => {
      await page.click('#vw-title .t-np');
      await page.until(`(document.querySelector('.t-head span') || {}).textContent === 'Not pushed · 1 commit'`);
      assert.equal(await page.eval(`!!document.querySelector('#vw-title .t-np')`), false);
    },
  );

  it(
    'when the reviews page lists it, '
    + 'then its line says the commit isn’t pushed.',
    async () => {
      const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: f.cache, gh: f.gh, cwd: f.root, env: f.env });
      assert.equal(started.code, 0, started.err);
      const reviews = await launchBrowser();
      try {
        await reviews.goto(/http:\/\/\S+/.exec(started.out)![0]);
        await reviews.until(`(document.querySelector('.row.running .l2 .lc') || {}).textContent === '1 commit not pushed'`, 30_000);
      } finally {
        await reviews.close();
      }
    },
  );

  it(
    'when the agent pushes it, '
    + 'then the tag and the mark go, and so does the lens, which only had it.',
    async () => {
      f.git(work, 'push');
      await page.until(`!document.querySelector('.np-tag') && ${marked}.length === 0`, 45_000);
      await page.until(`(document.querySelector('.t-head span') || {}).textContent !== 'Not pushed · 1 commit'`);
      assert.equal(await page.eval(`!!document.querySelector('#vw-title .t-np')`), false);
    },
  );

  it(
    'when someone else pushes to the pull request while the working copy has a commit of its own, '
    + 'then the pill says GitHub has a new commit, and the working copy keeps its own.',
    async () => {
      const own = f.commit(work, 'own.txt', 'mine\n');
      await reviewCommit(own);
      const other = path.join(f.root, 'other');
      f.git(f.root, 'clone', '--branch', 'feature', f.remote, other);
      f.commit(other, 'theirs.txt', 'theirs\n');
      f.git(other, 'push', 'origin', 'feature');
      await page.until(`(document.querySelector('#vw-fresh .fr-t') || {}).textContent === '1 new commit on GitHub'`, 45_000);
      assert.equal(await page.eval(`document.querySelector('#vw-fresh').title`), 'The pull request has 1 commit the working copy doesn’t: your agent brings it in when you ask.');
      assert.equal(f.git(work, 'rev-parse', 'HEAD'), own);
    },
  );
});
