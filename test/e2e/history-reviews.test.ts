import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { pullRequestGh } from '../helpers/pull-request.ts';
import type { GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { rest } from './page.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

// Each tag of the reviewed commit's row in History: what it is, and whether it shows whole, is out
// of sight, or is cut by the edge of the row's tags.
const tagsOf = `(() => {
  const x = [...document.querySelectorAll('.hs-row')].find((r) => r.querySelector('.hs-rev')).querySelector('.hs-x');
  const box = x.getBoundingClientRect();
  return [...x.children].map((c) => {
    const r = c.getBoundingClientRect();
    const where = getComputedStyle(c).display === 'none' || r.top >= box.bottom - 0.5 ? 'out of sight'
      : r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 ? 'whole' : 'cut';
    return c.className.split(' ')[0] + ' ' + where;
  });
})()`;

describe('Given a served review whose last commit writes in the chains of the two before it, and has changes requested on GitHub by someone with a long login, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let origin: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache: string | undefined;

  before(async () => {
    repo = TempRepo.create();
    origin = TempRepo.bare();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/aliases.dart', "bool accept(String email) => email.contains('@');\n");
    repo.write('lib/state.dart', 'int shared() => 1;\n');
    const base = repo.commit({ subject: 'Start the package', author: ada('2020-01-04T15:00:00Z'), committer: ada('2020-01-04T15:00:00Z') });
    repo.branch('feature');
    // Two chains, one per commit, with long names; then a commit that writes in both.
    repo.write('lib/aliases.dart', "bool accept(String email) => email.contains('+') || email.contains('@');\n");
    repo.commit({ subject: 'feat: Accept email aliases in the default email validation', author: ada('2020-01-05T15:00:00Z'), committer: ada('2020-01-05T15:00:00Z') });
    repo.write('lib/state.dart', 'int shared() => 2;\n');
    repo.commit({ subject: 'refactor: Extract the shared state into its own class', author: ada('2020-01-06T15:00:00Z'), committer: ada('2020-01-06T15:00:00Z') });
    repo.write('lib/aliases.dart', "bool accept(String email) => email.trim().contains('+') || email.contains('@');\n");
    repo.write('lib/state.dart', 'int shared() => 3;\n');
    const head = repo.commit({ subject: 'fix: Trim the email, and count from three', author: ada('2020-01-07T15:00:00Z'), committer: ada('2020-01-07T15:00:00Z') });
    repo.remoteAdd('origin', origin.dir);
    repo.push('origin', 'main');
    repo.push('origin', 'feature');
    gh = pullRequestGh({
      number: 7, title: 'Accept email aliases', url: 'https://github.com/acme/sample/pull/7',
      base: 'main', baseSha: base, head: 'feature', headSha: head,
      reviews: [{ login: 'ada-lovelace-reads-every-line', state: 'CHANGES_REQUESTED', sha: head }],
    });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, args: ['-chains', 'history'] });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await rest(page);
    await page.click('[data-act="history-open"]');
    await page.until(`!!document.querySelector('.hs-row .hs-rev')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    origin?.remove();
    gh?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('when History shows the commit, and its tags don’t all fit, then the review shows whole and first, and a chain that doesn’t fit is left out whole, never cut.', async () => {
    const tags = (await page!.eval(tagsOf)) as string[];
    assert.deepEqual([tags[0], tags.some((t) => t.endsWith(' cut')), tags.some((t) => t.endsWith(' out of sight'))], ['hs-rev whole', false, true]);
    assert.equal(await page!.eval(`document.querySelector('.hs-rev').textContent`), 'ada-lovelace-reads-every-line requested changes');
  });

  it('when History is too narrow for even the review, then its words end in an ellipsis, inside the row’s tags.', async () => {
    await page!.eval(`document.querySelector('.hist').style.width = '644px'`);
    await page!.until(`getComputedStyle(document.querySelector('.hs-chip')).display === 'none'`);
    const tags = (await page!.eval(tagsOf)) as string[];
    const said = await page!.eval(`(() => { const s = document.querySelector('.hs-rev span'); return s.scrollWidth > s.clientWidth && getComputedStyle(s).textOverflow; })()`);
    assert.deepEqual([tags[0], said], ['hs-rev whole', 'ellipsis']);
    await page!.eval(`document.querySelector('.hist').style.width = ''`);
  });
});

describe('Given a served review whose head commit has three reviews on GitHub: changes requested, a comment begun before them and posted after, then an approval, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let origin: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache: string | undefined;

  before(async () => {
    repo = TempRepo.create();
    origin = TempRepo.bare();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/aliases.dart', "bool accept(String email) => email.contains('@');\n");
    const base = repo.commit({ subject: 'Start the package', author: ada('2020-01-04T15:00:00Z'), committer: ada('2020-01-04T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/aliases.dart', "bool accept(String email) => email.contains('+') || email.contains('@');\n");
    const head = repo.commit({ subject: 'feat: Accept email aliases', author: ada('2020-01-05T15:00:00Z'), committer: ada('2020-01-05T15:00:00Z') });
    repo.remoteAdd('origin', origin.dir);
    repo.push('origin', 'main');
    repo.push('origin', 'feature');
    // As GitHub lists them: by when each began.
    gh = pullRequestGh({
      number: 7, title: 'Accept email aliases', url: 'https://github.com/acme/sample/pull/7',
      base: 'main', baseSha: base, head: 'feature', headSha: head,
      reviews: [
        { login: 'grace-hopper', state: 'COMMENTED', sha: head, at: '2020-01-06T12:00:00Z' },
        { login: 'ada-lovelace', state: 'CHANGES_REQUESTED', sha: head, at: '2020-01-06T10:00:00Z' },
        { login: 'ada-lovelace', state: 'APPROVED', sha: head, at: '2020-01-07T09:00:00Z' },
      ],
    });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, args: ['-chains', 'history'] });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await rest(page);
    await page.click('[data-act="history-open"]');
    await page.until(`!!document.querySelector('.hs-row .hs-rev')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    origin?.remove();
    gh?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('when History shows the commit, then its reviews are the newest posted first, the approval whole.', async () => {
    const said = await page!.eval(`[...document.querySelectorAll('.hs-row .hs-rev')].map((r) => r.textContent)`);
    assert.deepEqual(said, ['ada-lovelace approved', 'grace-hopper commented', 'ada-lovelace requested changes']);
    assert.equal(((await page!.eval(tagsOf)) as string[])[0], 'hs-rev whole');
  });
});
