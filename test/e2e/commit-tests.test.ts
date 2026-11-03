import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

const cart = (extra = '') => `int total(List<int> prices) => prices.fold(0, (sum, price) => sum + price);\n${extra}`;
const twoItems = (thens: string) => `  group('Given a cart with two items,', () {
    late List<int> prices;

    setUp(() {
      prices = [1, 2];
    });

    group('when the total is taken,', () {
      late int sum;

      setUp(() {
        sum = total(prices);
      });

      test('then it adds the prices.', () {
        expect(sum, 3);
      });
${thens}    });
  });
`;
const discount = (tests: string) => `
  group('Given a cart with a discount of one,', () {
    final prices = [1, 2];

    test('when the total is taken, then the discount comes off.', () {
      expect(discounted(prices, 1), 2);
    });
${tests}  });
`;
const positive = `
      test('then it is positive.', () {
        expect(sum > 0, isTrue);
      });
`;
const nothing = `
    test('when nothing is bought, then nothing comes off.', () {
      expect(discounted([], 0), 0);
    });
`;
const cartTest = (body: string) => `import 'package:sample/cart.dart';\n\nvoid main() {\n${body}}\n`;

// The panel under a commit's files in History: its title, then its outline's rows (indented as
// nested, with their mark, and whether they read reviewed) or how many diff lines it shows.
const panel = `(() => {
  const pk = document.querySelector('.hs-detail .peek');
  if (!pk) return 'none';
  const head = pk.querySelector('.pk-h b').textContent + ' · ' + [...pk.querySelectorAll('.pk-h button')].map((b) => b.textContent).join(' ');
  const rows = [...pk.querySelectorAll('.ol-file, .ol-row')].map((el) => (el.matches('.ol-file') ? el.querySelector('.nm').textContent + ' · ' + el.querySelector('.n').textContent
    : '  '.repeat(Number(el.style.getPropertyValue('--d') || 0) + 1) + (el.querySelector('.ol-mk').textContent || '·') + ' ' + el.querySelector('.ol-tt').textContent.trim()) + (el.classList.contains('done') ? ' (reviewed)' : ''));
  return [head, ...(rows.length ? rows : [pk.querySelectorAll('.pk-ln').length + ' diff lines'])].join('\\n');
})()`;

describe('Given a served review with a commit that adds tests to an earlier one’s, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let discountSha = '';
  let moreSha = '';
  const openCommit = async (sha: string) => {
    await rest(page!);
    await page!.click('[data-act="history-open"]');
    await page!.until(`!!document.querySelector('.hs-main[data-detail="${sha}"]')`);
    if (!(await page!.eval(`!!document.querySelector('.hs-detail[data-detail-of="${sha}"]')`))) await page!.click(`.hs-main[data-detail="${sha}"]`);
    await page!.until(`!!document.querySelector('.hs-detail[data-detail-of="${sha}"] [data-act="hd-open"]')`);
  };

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/cart.dart', cart());
    repo.write('test/cart_test.dart', cartTest(twoItems('')));
    repo.commit({ subject: 'Start the cart', author: ada('2020-09-01T15:00:00Z'), committer: ada('2020-09-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/cart.dart', cart('\nint discounted(List<int> prices, int off) => total(prices) - off;\n'));
    repo.write('test/cart_test.dart', cartTest(twoItems('') + discount('')));
    discountSha = repo.commit({ subject: 'feat: Take a discount', author: ada('2020-09-02T15:00:00Z'), committer: ada('2020-09-02T15:00:00Z') });
    repo.write('test/cart_test.dart', cartTest(twoItems(positive) + discount(nothing)));
    moreSha = repo.commit({ subject: 'test: Cover more totals', author: ada('2020-09-03T15:00:00Z'), committer: ada('2020-09-03T15:00:00Z') });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
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
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when that commit’s test file is opened from its details, ', () => {
    let shown = '';

    before(async () => {
      await openCommit(moreSha);
      await page!.click(`.hs-detail[data-detail-of="${moreSha}"] [data-act="hd-open"][data-p="test/cart_test.dart"]`);
      await page!.until(`!!document.querySelector('.hs-detail .peek .ol-file')`);
      shown = await read(page!, panel);
    });

    it('then it reads as the outline of the tests that commit wrote, as in a chain.', () => {
      assert.equal(shown, [
        'Tests · Diff Close',
        'cart_test.dart · 2 new',
        '  · Given a cart with two items,',
        '    · when the total is taken,',
        '      + then it is positive.',
        '  + Given a cart with a discount of one,',
        '    + when nothing is bought, then nothing comes off.',
      ].join('\n'));
    });
  });

  describe('when Diff is clicked, and then Tests, ', () => {
    let diff = '', back = '';

    before(async () => {
      await page!.click('.hs-detail .peek [data-act="hd-peek"][data-mode="diff"]');
      await page!.until(`!!document.querySelector('.hs-detail .peek .pk-ln')`, 30_000);
      diff = (await read(page!, panel)).split('\n')[0];
      await page!.click('.hs-detail .peek [data-act="hd-peek"][data-mode="tests"]');
      await page!.until(`!!document.querySelector('.hs-detail .peek .ol-file')`);
      back = (await read(page!, panel)).split('\n')[0];
    });

    it('then the panel shows the file’s diff at that commit, and its outline again.', () => {
      assert.deepEqual([diff, back], ['Diff · Tests Close', 'Tests · Diff Close']);
    });
  });

  describe('when a file that isn’t a test is opened from a commit’s details, ', () => {
    let shown = '';

    before(async () => {
      await openCommit(discountSha);
      await page!.click(`.hs-detail[data-detail-of="${discountSha}"] [data-act="hd-open"][data-p="lib/cart.dart"]`);
      await page!.until(`!!document.querySelector('.hs-detail .peek .pk-ln')`, 30_000);
      shown = (await read(page!, panel)).split('\n')[0];
    });

    it('then it reads as its diff, as before.', () => {
      assert.equal(shown, 'Diff · Close');
    });
  });

  describe('when the mark on the test file’s line is clicked in the panel of the commit that adds tests, ', () => {
    let marked = '';
    let other = '';
    const openTests = async (sha: string) => {
      await openCommit(sha);
      await page!.click(`.hs-detail[data-detail-of="${sha}"] [data-act="hd-open"][data-p="test/cart_test.dart"]`);
      await page!.until(`!!document.querySelector('.hs-detail .peek .ol-file')`);
    };

    before(async () => {
      await openTests(moreSha);
      await page!.click('.hs-detail .peek .ol-file .ol-tick');
      await page!.until(`!!document.querySelector('.hs-detail .peek .ol-file.done')`);
      marked = await read(page!, panel);
      await openTests(discountSha);
      other = await read(page!, panel);
    });

    it('then the tests that commit wrote read reviewed, and so does the file.', () => {
      assert.equal(marked, [
        'Tests · Diff Close',
        'cart_test.dart · 2 new (reviewed)',
        '  · Given a cart with two items,',
        '    · when the total is taken,',
        '      + then it is positive. (reviewed)',
        '  + Given a cart with a discount of one,',
        '    + when nothing is bought, then nothing comes off. (reviewed)',
      ].join('\n'));
    });

    it('then the tests the earlier commit wrote in the file are still to review, and the one the marked commit added under its Given reads reviewed there too.', () => {
      assert.equal(other, [
        'Tests · Diff Close',
        'cart_test.dart · 1 new',
        '  + Given a cart with a discount of one,',
        '    + when the total is taken, then the discount comes off.',
        '    + when nothing is bought, then nothing comes off. (reviewed)',
      ].join('\n'));
    });
  });
});
