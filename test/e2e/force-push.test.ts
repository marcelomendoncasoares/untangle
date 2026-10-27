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
import { read, rest } from './page.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const missing = 'd'.repeat(40);
const startApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const passedApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');
const amendedApp = ['void greet(String name) {', "  print('ada');", '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');
// Under each old head's row in History, the commits listed: "<sha> <subject>", one row per old head.
const takenOff = `[...document.querySelectorAll('.hs-row.old-head')].map((row) => { const out = []; for (let el = row.nextElementSibling; el && el.classList.contains('hs-sub'); el = el.nextElementSibling) out.push(el.querySelector('code').textContent + ' ' + el.querySelector('.hs-sub-s').textContent); return out.join(', '); }).join('\\n')`;

describe('Given a served review whose head was amended after the branch was pushed, and GitHub reports that force push plus one whose old head is gone, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let origin: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache: string | undefined;
  let oldHead = '';

  before(async () => {
    const author = ada('2020-01-04T15:00:00Z');
    repo = TempRepo.create();
    origin = TempRepo.bare();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', startApp);
    const base = repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', passedApp);
    repo.commit({ subject: 'Pass the name', author: ada('2020-01-05T15:00:00Z'), committer: ada('2020-01-05T15:00:00Z') });
    repo.remoteAdd('origin', origin.dir);
    repo.push('origin', 'main');
    repo.push('origin', 'feature');
    oldHead = repo.rev('HEAD');
    repo.write('lib/app.dart', amendedApp);
    const head = repo.amend({ subject: 'Pass the name', author: ada('2020-01-06T15:00:00Z'), committer: ada('2020-01-06T15:00:00Z') });
    repo.remoteRemove('origin');
    repo.prune();
    repo.remoteAdd('origin', origin.dir);
    if (repo.hasCommit(oldHead)) throw new Error('the amended head is still in the local repository');
    gh = pullRequestGh({
      number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7',
      base: 'main', baseSha: base, head: 'feature', headSha: head,
      pushes: [
        { actor: 'ada', before: oldHead, after: head, at: '2020-01-18T15:00:00Z' },
        { actor: 'grace', before: missing, after: head, at: '2020-01-17T15:00:00Z' },
      ],
    });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    origin?.remove();
    gh?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when History is opened, ', () => {
    let ghosts: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('button.old-head:not([disabled])')`, 30_000);
      ghosts = await read(page!, `[...document.querySelectorAll('button.old-head')].map((el) => (el.disabled ? 'disabled' : 'open') + ' ' + (el.querySelector('.dot.ghost') ? 'dashed' : 'solid') + ' ' + (el.querySelector('.hs-s, .lp-s, .cm-s')?.textContent ?? '')).join('\\n')`);
    });

    it('then the old head is a dashed row naming who force-pushed it.', () => {
      assert.equal(ghosts.split('\n').find((line) => line.startsWith('open ')), 'open dashed Force-pushed by ada');
    });

    it('then a head GitHub no longer has is disabled.', () => {
      assert.equal(ghosts.split('\n').find((line) => line.startsWith('disabled ')), 'disabled dashed Force-pushed by grace');
    });

    it('then the commit the amend replaced is listed under its force push, and none under the head GitHub no longer has.', async () => {
      assert.deepEqual((await read(page!, takenOff)).split('\n').sort(), ['', `${oldHead.slice(0, 7)} Pass the name`]);
    });
  });

  describe('when that old head is clicked, ', () => {
    let label: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('button.old-head:not([disabled])')`, 30_000);
      await page!.click('button.old-head:not([disabled])');
      await page!.until(`(document.querySelector('.t-head')?.textContent || '').includes('before the force push')`, 10_000);
      label = await read(page!, `document.querySelector('.t-head')?.textContent ?? ''`);
    });

    it('then the lens is what changed since that head.', () => {
      assert.equal(label, `Since ${oldHead.slice(0, 7)}, before the force push`);
    });
  });
});

describe('Given a served review whose branch was force-pushed back, taking two commits off, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache: string | undefined;
  const off: string[] = [];

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', startApp);
    const base = repo.commit({ subject: 'Start the package', author: ada('2020-01-04T15:00:00Z'), committer: ada('2020-01-04T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', passedApp);
    const head = repo.commit({ subject: 'Pass the name', author: ada('2020-01-05T15:00:00Z'), committer: ada('2020-01-05T15:00:00Z') });
    repo.write('lib/app.dart', amendedApp);
    off.push(repo.commit({ subject: 'Greet ada', author: ada('2020-01-06T15:00:00Z'), committer: ada('2020-01-06T15:00:00Z') }));
    repo.write('lib/app.dart', startApp);
    off.push(repo.commit({ subject: 'Greet no one', author: ada('2020-01-07T15:00:00Z'), committer: ada('2020-01-07T15:00:00Z') }));
    repo.checkout('HEAD~2');
    gh = pullRequestGh({
      number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7',
      base: 'main', baseSha: base, head: 'feature', headSha: head,
      pushes: [{ actor: 'ada', before: off[1], after: head, at: '2020-01-08T15:00:00Z' }],
    });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    gh?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when History is opened, ', () => {
    let meta: string;
    let listed: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('.hs-row.old-head + .hs-sub')`, 30_000);
      meta = await read(page!, `document.querySelector('.hs-row.old-head .hs-m').textContent`);
      listed = await read(page!, takenOff);
    });

    it('then the force push says the two commits were removed, nothing in their place.', () => {
      assert.match(meta, /· 2 commits removed$/);
    });

    it('then both are listed under it, newest first.', () => {
      assert.equal(listed, `${off[1].slice(0, 7)} Greet no one, ${off[0].slice(0, 7)} Greet ada`);
    });
  });
});
