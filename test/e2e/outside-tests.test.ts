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

const count = `document.querySelector('#vw-pill .pill-n')?.textContent || ''`;
const outsideFold = `[...document.querySelectorAll('#vw-main .ol-fold')].find((el) => el.textContent.startsWith('Outside the tests'))`;

// The stops Space has left in the view (other chains' changes aside), and what a press changes:
// those stops, and the marks on.
const left = `[...document.querySelectorAll('#vw-main .tick[data-block]:not(.on), #vw-main [data-nav]')].filter((el) => !el.closest('.other')).length`;
const marked = `[${left}, document.querySelectorAll('#vw-main .tick.on, #vw-main .ol-row.done').length].join()`;

// Presses Space from the top of the view while it leaves something to review.
async function spaceThrough(page: Browser): Promise<void> {
  await page.eval(`document.activeElement.blur(), document.querySelector('#vw-main').scrollTop = 0`);
  for (let i = 0; i < 12 && Number(await page.eval(left)); i += 1) {
    const before = await read(page, marked);
    await page.key(' ');
    await page.until(`(${marked}) !== ${JSON.stringify(before)}`);
  }
}

// A new test file as a formatter writes long titles: each call's title on a line of its own, its
// tests in a labelled wrapper, and a helper after main. Each change runs on to where the next one
// starts: main's own lines to the wrapper, and the last test's to the brace that closes main.
const cartTest = `import 'package:sample/cart.dart';
import 'package:test/test.dart';

void main() {
  final start = [1, 2];

  withCart(
    '[Cart]',
    (cart) {
      cart.addAll(start);

      group(
        'Given a cart with two items,',
        () {
          test(
            'then it adds the prices.',
            () {
              expect(total(cart), 3);
            },
          );

          test(
            'then the total is positive.',
            () {
              expect(total(cart) > 0, isTrue);
            },
          );
        },
      );
    },
  );
}

void withCart(String label, void Function(List<int> cart) body) => group(label, () => body([]));
`;

describe('Given a served review of a new test file whose titles sit on lines of their own, its tests in a labelled wrapper, with a helper after main, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/cart.dart', 'int total(List<int> prices) => prices.fold(0, (sum, price) => sum + price);\n');
    repo.commit({ subject: 'Start the cart', author: ada('2020-09-01T15:00:00Z'), committer: ada('2020-09-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('test/cart_test.dart', cartTest);
    repo.commit({ subject: 'test: Cover the cart', author: ada('2020-09-02T15:00:00Z'), committer: ada('2020-09-02T15:00:00Z') });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, args: ['-chains', 'history'] });
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

  describe('when the commit’s chain is opened, ', () => {
    let tests = '';
    let outside = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.until(`!!document.querySelector('.sb-row[data-chain]')`);
      await page!.click('.sb-row[data-chain]');
      await page!.until(`!!document.querySelector('#vw-main .ol-out .ln')`);
      tests = await read(page!, `[...document.querySelectorAll('#vw-main .ol-row, #vw-main .ol-fold')].map((el) => el.matches('.ol-row') ? '  '.repeat(Number(el.style.getPropertyValue('--d')) + 1) + (el.querySelector('.ol-mk').textContent || '·') + ' ' + el.querySelector('.ol-tt').textContent.trim() : el.textContent.trim()).join('\\n')`);
      outside = await read(page!, `[...document.querySelectorAll('#vw-main .ol-out .ln')].map((row) => row.querySelector('.no').textContent + ' ' + row.querySelector('.tx').textContent).join('\\n')`);
    });

    it('then the wrapper heads its tests in its outline, the last test too, and the code outside them is a line of its own.', () => {
      assert.equal(tests, [
        '  · [Cart]',
        '    + Given a cart with two items,',
        '      + then it adds the prices.',
        '      + then the total is positive.',
        'Outside the tests: withCart · +7 −0',
      ].join('\n'));
    });

    it('then the code outside the tests is the imports, main’s own lines and the helper, without the calls next to them.', () => {
      assert.equal(outside, [
        "1 import 'package:sample/cart.dart';",
        "2 import 'package:test/test.dart';",
        '3 ',
        '4 void main() {',
        '5   final start = [1, 2];',
        '6 ',
        '34 void withCart(String label, void Function(List<int> cart) body) => group(label, () => body([]));',
      ].join('\n'));
    });
  });

  describe('when the code outside the tests is folded, and Space reviews the chain from its top, ', () => {
    let open = '';
    let folded = '';
    let after = '';

    before(async () => {
      open = await read(page!, count);
      await page!.eval(`${outsideFold}.click()`);
      await page!.until(`${outsideFold}.getAttribute('aria-expanded') === 'false'`);
      folded = await read(page!, count);
      await spaceThrough(page!);
      await page!.until(`document.querySelector('#vw-pill .pill-msg')?.textContent === 'All reviewed here'`);
      after = await read(page!, `[
        ...[...document.querySelectorAll('#vw-main .ol-file')].map((el) => el.querySelector('.nm').textContent + ' · ' + el.querySelector('.n').textContent),
        ${outsideFold} ? 'the fold still there' : 'the fold gone with it',
        document.querySelector('#vw-main .ol-file').classList.contains('done') ? 'the file reviewed' : 'the file to review',
      ].join(' · ')`);
    });

    it('then the pill still counts the change the fold holds.', () => {
      assert.match(open, /^1 of \d+$/);
      assert.equal(folded, open);
    });

    it('then Space opens the fold on its change and reviews it too, so the file is reviewed whole and folds to its line.', () => {
      assert.equal(after, 'cart_test.dart · 2 tests reviewed · the fold gone with it · the file reviewed');
    });
  });

  describe('when the Tests view, which folds the code outside the tests, is reviewed with Space from its top, ', () => {
    let counted = '';
    let after = '';

    before(async () => {
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file .tick')`);
      // What the chain reviewed goes back first: the file's mark reviews what's left, then takes it all back.
      for (let i = 0; i < 2 && (await page!.eval(`!!document.querySelector('#vw-main .ol-file .tick.on, #vw-main .ol-file .tick.part')`)); i += 1) await page!.click('#vw-main .ol-file .tick');
      await page!.until(`${outsideFold}?.getAttribute('aria-expanded') === 'false' && !!document.querySelector('#vw-main .ol-row[data-nav]')`);
      counted = await read(page!, `document.querySelectorAll('#vw-main .ol-row[data-nav]').length + ' rows to review · ' + (${count})`);
      await spaceThrough(page!);
      await page!.until(`document.querySelector('#vw-pill .pill-msg')?.textContent === 'All reviewed here'`);
      after = await read(page!, `[...document.querySelectorAll('#vw-main .ol-file')].map((el) => el.querySelector('.nm').textContent + ' · ' + el.querySelector('.n').textContent).join('\\n')`);
    });

    it('then the pill counts the change outside the tests with its rows.', () => {
      assert.equal(counted, '4 rows to review · 1 of 5');
    });

    it('then Space reviews it too, and the file folds away reviewed whole.', () => {
      assert.equal(after, 'cart_test.dart · 2 tests reviewed');
    });
  });
});
