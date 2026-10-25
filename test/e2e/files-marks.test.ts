import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-09-01T15:00:00Z' };
// Functions far enough apart that each change is a hunk of its own.
const dart = (names: string[], said: (name: string) => string) => names.map((n) => `int ${n}() {\n  // ${said(n)}\n  return 1;\n}\n${'\n'.repeat(8)}`).join('');
const row = (key: string) => `.sb-row[${key.endsWith('.dart') ? 'data-open' : 'data-dir'}="${key}"]`;
const state = (key: string) => `(() => { const r = document.querySelector('${row(key)}'); return [r.classList.contains('done') ? 'reviewed' : 'to review', r.getAttribute('aria-expanded') === 'false' ? 'closed' : r.getAttribute('aria-expanded') === 'true' ? 'open' : '', r.querySelector(':scope > .cnt > .mk.ok') ? 'check' : (r.querySelector(':scope > .cnt').textContent || '-')].filter(Boolean).join(' '); })()`;
const toast = `(() => { const t = document.querySelector('#vw-toast.on'); return t ? t.textContent : ''; })()`;

describe('Given a review of a folder with two changed files and a file beside it, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a/one.dart', dart(['one'], () => 'first'));
    repo.write('lib/a/two.dart', dart(['two', 'three'], () => 'first'));
    repo.write('lib/b.dart', dart(['four'], () => 'first'));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a/one.dart', dart(['one'], () => 'second'));
    repo.write('lib/a/two.dart', dart(['two', 'three'], (n) => `second ${n}`));
    repo.write('lib/b.dart', dart(['four'], () => 'second'));
    repo.commit({ subject: 'Say it again', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.until(`!!document.querySelector('${row('lib/a')}')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when a file’s dot is clicked, ', () => {
    let marked = '';
    let said = '';

    before(async () => {
      await page.click(`${row('lib/b.dart')} > .mk-b`);
      marked = await read(page, state('lib/b.dart'));
      said = await read(page, toast);
    });

    it('then the file is marked reviewed and the toast says so, with Undo.', () => {
      assert.equal(marked, 'reviewed -');
      assert.equal(said, 'Marked 1 change reviewed, in b.dartUndo');
    });

    it('then Undo puts its marks back.', async () => {
      await page.click('#vw-toast [data-undo]');
      assert.equal(await read(page, state('lib/b.dart')), 'to review 1');
    });
  });

  describe('when a folder’s row is hovered, ', () => {
    let rest = '';
    let hovered = '';

    before(async () => {
      rest = await read(page, `getComputedStyle(document.querySelector('${row('lib/a')} > .mk-b')).display`);
      await page.hover(`${row('lib/a')} > .nm`);
      hovered = await read(page, `(() => { const b = document.querySelector('${row('lib/a')} > .mk-b'), r = document.querySelector('${row('lib/a')}'); return getComputedStyle(b).display + ' ' + Math.round(r.getBoundingClientRect().right - b.getBoundingClientRect().right); })()`);
    });

    it('then its dot shows at the row’s end, and not before.', () => {
      assert.equal(rest, 'none');
      assert.equal(hovered, 'grid 8');
    });
  });

  describe('when one of its files is marked, then the folder’s dot is clicked, ', () => {
    let folded = '';
    let said = '';

    before(async () => {
      await page.click(`${row('lib/a/one.dart')} > .mk-b`);
      await page.hover(`${row('lib/a')} > .nm`);
      await page.click(`${row('lib/a')} > .mk-b`);
      folded = await read(page, state('lib/a'));
      said = await read(page, toast);
    });

    it('then it marks the rest, folds the folder, and shows a check for its count.', () => {
      assert.equal(folded, 'reviewed closed check');
      assert.equal(said, 'Marked 2 changes reviewed, in 1 file of aUndo');
    });

    it('then Undo opens it again, with the file marked before still marked.', async () => {
      await page.click('#vw-toast [data-undo]');
      assert.equal([await read(page, state('lib/a')), await read(page, state('lib/a/one.dart')), await read(page, state('lib/a/two.dart'))].join(' / '), 'to review open 2 / reviewed - / to review 2');
    });
  });

  describe('when a folder all reviewed is opened, ', () => {
    before(async () => {
      await page.hover(`${row('lib/a')} > .nm`);
      await page.click(`${row('lib/a')} > .mk-b`);
      await page.until(`document.querySelector('${row('lib/a')}').getAttribute('aria-expanded') === 'false'`);
      await page.click(`${row('lib/a')} > .nm`);
      await page.until(`document.querySelector('${row('lib/a')}').getAttribute('aria-expanded') === 'true'`);
    });

    it('then it shows no check: its files show theirs.', async () => {
      assert.equal(await read(page, state('lib/a')), 'reviewed open -');
    });
  });

  describe('when Shift+Space is pressed on a file’s row that has focus, ', () => {
    let marked = '';

    before(async () => {
      await page.eval(`document.querySelector('${row('lib/b.dart')}').focus()`);
      await page.key(' ', { shift: true });
      marked = await read(page, `[${state('lib/b.dart')}, document.activeElement.dataset.open].join(' ')`);
    });

    it('then the file is marked, and its row keeps the focus.', () => {
      assert.equal(marked, 'reviewed - lib/b.dart');
    });
  });
});
