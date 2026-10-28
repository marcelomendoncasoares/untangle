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
const twoItems = (given: string, thens: string) => `  group('${given}', () {
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

/** The outline's rows as read: indented as nested, its mark, its title ([-removed-] and {+added+} words) and its notes. */
const rowsRead = `[...document.querySelectorAll('#vw-main .ol-row, #vw-main .ol-fold, #vw-main .ol-file')].map((el) => {
  const words = (tt) => [...tt.childNodes].map((x) => (x.nodeName === 'DEL' ? '[-' + x.textContent + '-]' : x.nodeName === 'INS' ? '{+' + x.textContent + '+}' : x.nodeType === 1 ? words(x) : x.textContent)).join('').trim();
  if (el.matches('.ol-file')) return el.querySelector('.nm').textContent + ' · ' + el.querySelector('.n').textContent;
  const d = Number(el.style.getPropertyValue('--d') || 0);
  if (el.matches('.ol-fold')) return '  '.repeat(d + 1) + el.textContent.trim();
  const notes = [...el.querySelectorAll('.ol-tag, .ol-chip')].map((x) => x.textContent.trim());
  const mark = el.querySelector('.ol-mk').textContent || '·';
  return '  '.repeat(d + 1) + mark + ' ' + words(el.querySelector('.ol-tt')) + (notes.length ? ' [' + notes.join(', ') + ']' : '') + (el.classList.contains('done') ? ' (reviewed)' : '');
}).join('\\n')`;

/** Whether the first test file's mark, on its line, reads the file reviewed. */
const fileMark = `(document.querySelector('#vw-main .ol-file .ol-tick')?.getAttribute('aria-pressed') === 'true' ? 'file reviewed' : 'file to review')`;

async function openChain(page: Browser, name: string): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('.sb-row[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('.sb-row[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}`);
  await page.click(`.sb-row[data-chain="${id}"]`);
  await page.until(`!!document.querySelector('#vw-main .ol-file')`);
}

/** An opened call's code as read: each row's sign, line number and text, a folded call as its title. */
const codeRead = `[...document.querySelectorAll('#vw-main .ol-code > .ln')].map((row) => row.matches('.ol-ph')
  ? row.querySelector('.no').textContent + ' [' + row.querySelector('.ol-ph-t').textContent + ']'
  : ((row.querySelector('.sg')?.textContent || ' ') + ' ' + row.querySelector('.no').textContent + ' ' + row.querySelector('.tx').textContent).trimEnd()).join('\\n')`;

function rowSelector(page: Browser, title: string): Promise<string> {
  return read(page, `(() => { const row = [...document.querySelectorAll('#vw-main .ol-row')].find((el) => el.querySelector('.ol-tt').textContent.trim() === ${JSON.stringify(title)}); return row ? '.ol-row[data-ol="' + row.dataset.ol + '"]' : ''; })()`);
}

describe('Given a served review by commit: a discount with its tests, more tests for both scenarios, and a renamed Given, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let discountSha = '';
  let moreSha = '';
  let nameSha = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/cart.dart', cart());
    repo.write('test/cart_test.dart', cartTest(twoItems('Given a cart with two items,', '')));
    const start = ada('2020-09-01T15:00:00Z');
    repo.commit({ subject: 'Start the cart', author: start, committer: start });
    repo.branch('feature');
    repo.write('lib/cart.dart', cart('\nint discounted(List<int> prices, int off) => total(prices) - off;\n'));
    repo.write('test/cart_test.dart', cartTest(twoItems('Given a cart with two items,', '') + discount('')));
    const first = ada('2020-09-02T15:00:00Z');
    discountSha = repo.commit({ subject: 'feat: Take a discount', author: first, committer: first });
    repo.write('test/cart_test.dart', cartTest(twoItems('Given a cart with two items,', positive) + discount(nothing)));
    const second = ada('2020-09-03T15:00:00Z');
    moreSha = repo.commit({ subject: 'test: Cover more totals', author: second, committer: second });
    repo.write('test/cart_test.dart', cartTest(twoItems('Given a cart holding two items,', positive) + discount(nothing)));
    const third = ada('2020-09-04T15:00:00Z');
    nameSha = repo.commit({ subject: 'test: Name the scenario', author: third, committer: third });
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

  describe('when the chain of the commit that only adds tests is opened, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      rows = await read(page!, rowsRead);
    });

    it('then its new thens read under their Given and when, dimmed, with the commit that last wrote each Given named.', () => {
      assert.equal(rows, [
        'cart_test.dart · 2 new',
        `  · Given a cart holding two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      + then it is positive.',
        '      + 1 unchanged then',
        `  · Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        '    + when nothing is bought, then nothing comes off.',
        '    + 1 unchanged when',
      ].join('\n'));
    });
  });

  describe('when a new then is opened, ', () => {
    let code = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click(await rowSelector(page!, 'then it is positive.'));
      await page!.until(`!!document.querySelector('#vw-main .ol-code')`);
      code = await read(page!, `[...document.querySelectorAll('#vw-main .ol-code .ln')].map((row) => (row.querySelector('.sg').textContent || ' ') + ' ' + row.querySelector('.tx').textContent).join('\\n')`);
    });

    after(async () => {
      await page!.click(await rowSelector(page!, 'then it is positive.'));
    });

    it('then its code opens under it, as the diff shows it.', () => {
      assert.equal(code, [
        "+       test('then it is positive.', () {",
        '+         expect(sum > 0, isTrue);',
        '+       });',
      ].join('\n'));
    });
  });

  describe('when the file opens on a then written after a blank line, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click(`${await rowSelector(page!, 'then it is positive.')} .ol-go`);
      await page!.until(`!!document.querySelector('.code[data-p="test/cart_test.dart"] .ln[data-n="22"]') && !document.querySelector('#vw-main .ln.loading')`);
      rows = await read(page!, `['21', '22'].map((n) => { const row = document.querySelector('.code[data-p="test/cart_test.dart"] .ln[data-n="' + n + '"]'); return n + (row.classList.contains('add') ? ' added' : ' unchanged') + (row.querySelector('.tick') ? ', marked' : ''); }).join(' | ')`);
    });

    it('then the blank line is added with the then, whose mark is on its first line of code.', () => {
      assert.equal(rows, '21 added | 22 added, marked');
    });
  });

  describe('when the renamed Given and then its when open in the Tests view, ', () => {
    let given = '';
    let when = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      const renamed = await read(page!, `(() => { const row = [...document.querySelectorAll('#vw-main .ol-row')].find((el) => el.querySelector('.ol-tt ins')?.textContent === 'holding'); return '.ol-row[data-ol="' + row.dataset.ol + '"]'; })()`);
      await page!.click(renamed);
      await page!.until(`!!document.querySelector('#vw-main .ol-code') && !document.querySelector('#vw-main .ol-code .ln.loading')`);
      given = await read(page!, codeRead);
      await page!.click(renamed);
      const total = await rowSelector(page!, 'when the total is taken,');
      await page!.click(total);
      await page!.until(`!!document.querySelector('#vw-main .ol-code') && !document.querySelector('#vw-main .ol-code .ln.loading')`);
      when = await read(page!, codeRead);
      await page!.click(total);
    });

    it('then the Given\'s code shows the title line it removed beside the one it added, with its when folded.', () => {
      assert.equal(given, [
        "− 4   group('Given a cart with two items,', () {",
        "+ 4   group('Given a cart holding two items,', () {",
        '  5     late List<int> prices;',
        '  6',
        '  7     setUp(() {',
        '  8       prices = [1, 2];',
        '  9     });',
        '  10',
        '11 [when the total is taken,]',
        '+ 26   });',
      ].join('\n'));
    });

    it('then the when\'s code folds its thens, without the blank line between them.', () => {
      assert.equal(when, [
        "  11     group('when the total is taken,', () {",
        '  12       late int sum;',
        '  13',
        '  14       setUp(() {',
        '  15         sum = total(prices);',
        '  16       });',
        '  17',
        '18 [then it adds the prices.]',
        '22 [then it is positive.]',
        '+ 25     });',
      ].join('\n'));
    });
  });

  describe('when a new then is marked reviewed with its mark, ', () => {
    let rows = '';
    let pill = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click(`${await rowSelector(page!, 'then it is positive.')} .ol-tick`);
      await page!.until(`!!document.querySelector('#vw-main .ol-row.done')`);
      rows = await read(page!, rowsRead);
      pill = await read(page!, `document.querySelector('#vw-pill .pill-n')?.textContent ?? ''`);
    });

    after(async () => {
      await page!.click(`${await rowSelector(page!, 'then it is positive.')} .ol-tick`);
    });

    it('then that then reads reviewed and the pill counts the one sentence left.', () => {
      assert.equal(`${rows}\n${pill}`, [
        'cart_test.dart · 2 new',
        `  · Given a cart holding two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      + then it is positive. (reviewed)',
        '      + 1 unchanged then',
        `  · Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        '    + when nothing is bought, then nothing comes off.',
        '    + 1 unchanged when',
        '1 of 1',
      ].join('\n'));
    });
  });

  describe('when the file’s mark is clicked in the chain of the commit that only adds tests, ', () => {
    let marked = '';
    let other = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click('#vw-main .ol-file .ol-tick');
      await page!.until(`document.querySelector('#vw-main .ol-file .ol-tick').getAttribute('aria-pressed') === 'true'`);
      marked = await read(page!, `${rowsRead} + '\\n' + ${fileMark}`);
      await openChain(page!, 'Take a discount');
      other = await read(page!, `${rowsRead} + '\\n' + ${fileMark}`);
    });

    it('then the tests that commit wrote in the file read reviewed, and so does the file.', () => {
      assert.equal(marked, [
        'cart_test.dart · 2 new',
        `  · Given a cart holding two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      + then it is positive. (reviewed)',
        '      + 1 unchanged then',
        `  · Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        '    + when nothing is bought, then nothing comes off. (reviewed)',
        '    + 1 unchanged when',
        'file reviewed',
      ].join('\n'));
    });

    it('then the tests another commit wrote in the file are still to review.', () => {
      assert.equal(other, [
        'cart_test.dart · 1 new',
        '  + Given a cart with a discount of one,',
        '    + when the total is taken, then the discount comes off.',
        `    · when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
        'file to review',
      ].join('\n'));
    });
  });

  describe('when the file’s mark is clicked again, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click('#vw-main .ol-file .ol-tick');
      await page!.until(`!document.querySelector('#vw-main .ol-row.done')`);
      rows = await read(page!, `${rowsRead} + '\\n' + ${fileMark}`);
    });

    it('then its tests are to review again.', () => {
      assert.equal(rows, [
        'cart_test.dart · 2 new',
        `  · Given a cart holding two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      + then it is positive.',
        '      + 1 unchanged then',
        `  · Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        '    + when nothing is bought, then nothing comes off.',
        '    + 1 unchanged when',
        'file to review',
      ].join('\n'));
    });
  });

  describe('when the commit named on a Given is clicked, ', () => {
    let where = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click(`${await rowSelector(page!, 'Given a cart with a discount of one,')} .ol-chip`);
      await page!.until(`(document.querySelector('.fv-head .crumbs')?.textContent || '').includes('Take a discount')`);
      where = await read(page!, `document.querySelector('.fv-head .crumbs b').textContent + ' · ' + (document.querySelector('#vw-main .ol-row.flash .ol-tt')?.textContent.trim() ?? 'no row')`);
    });

    it('then the chain of that commit opens at the Given.', () => {
      assert.equal(where, 'Take a discount · Given a cart with a discount of one,');
    });
  });

  describe('when the chain of the commit that changes code and tests is opened, ', () => {
    let page1 = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Take a discount');
      page1 = await read(page!, `[...document.querySelectorAll('#vw-main .sec > .sec-h > b, #vw-main .ol-sect')].map((el) => el.textContent.trim()).join(' | ') + '\\n' + ${rowsRead}`);
    });

    it('then its tests follow its code, as their outline, with the test a later commit added to its new Given.', () => {
      assert.equal(page1, [
        'discounted | Tests',
        'cart_test.dart · 1 new',
        '  + Given a cart with a discount of one,',
        '    + when the total is taken, then the discount comes off.',
        `    · when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });

  describe('when the chain of the commit that renames a Given is opened, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Name the scenario');
      rows = await read(page!, rowsRead);
    });

    it('then the Given shows the words that changed, and its test reads reworded through it.', () => {
      assert.equal(rows, [
        'cart_test.dart · 1 reworded',
        '  ~ Given a cart [-with-]{+holding+} two items,',
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
        `      · then it is positive. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });

  describe('when the Tests view is opened from the sidebar, ', () => {
    let page1 = '';
    let notes = '';
    let filters = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      page1 = await read(page!, `document.querySelector('[data-act="tests-open"]').textContent + '\\n' + document.querySelector('.fv-head .facts').textContent + '\\n' + ${rowsRead}`);
      filters = await read(page!, `[...document.querySelectorAll('[data-act="tests-filter"]')].map((button) => button.firstChild.textContent + ' ' + button.querySelector('.dt').textContent + ' ' + button.querySelector('i').textContent + (button.disabled ? ' (off)' : '')).join(', ')`);
      notes = await read(page!, `[...document.querySelectorAll('#vw-main .ol-row')].map((row) => {
        const title = row.querySelector('.ol-tt'), words = title.cloneNode(true);
        words.querySelectorAll('del').forEach((el) => el.remove());
        return [words.textContent.trim(), row.querySelector('.ol-nosu') ? 'red dot' : '', row.querySelector('.ol-xp')?.textContent ?? '', row.querySelector('.ol-df')?.textContent ?? ''].filter(Boolean).join(' · ');
      }).join('\\n')`);
    });

    it('then it lists every sentence the tests add or reword, with the commit that wrote each one.', () => {
      assert.equal(page1, [
        'Tests4',
        '3 new · 1 reworded · 1 file',
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
        `      + then it is positive. [${moreSha.slice(0, 7)}]`,
        `  + Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        `    + when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}]`,
        `    + when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });

    it('then each filter counts the sentences it keeps, and one that keeps none is off.', () => {
      assert.equal(filters, 'All · 4, New · 3, Reworded · 1, Regrouped · 0 (off), Removed · 0 (off)');
    });

    // The lines are the diff's: git pairs the file's closing brackets as it likes (the last test's
    // with the old when's, so the two Givens' new lines run on under the first one).
    it('then the Given that shares its prices has no red dot, as the one with setUp, each test counts its expect calls, and each row knows the diff\'s lines in it.', () => {
      assert.equal(notes, [
        'Given a cart holding two items, · +7 −1',
        'when the total is taken, · +5',
        'then it adds the prices. · 1 expect',
        'then it is positive. · 1 expect · +3',
        'Given a cart with a discount of one, · +9',
        'when the total is taken, then the discount comes off. · 1 expect · +3',
        'when nothing is bought, then nothing comes off. · 1 expect · +2',
      ].join('\n'));
    });
  });

  describe('when a test in the Tests view is hovered, ', () => {
    let shown = '';
    let order = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      const row = await rowSelector(page!, 'then it is positive.');
      const other = await rowSelector(page!, 'when nothing is bought, then nothing comes off.');
      await page!.hover(row);
      shown = await read(page!, `['${row}', '${other}'].map((sel) => ['.ol-xp', '.ol-df', '.ol-chip'].map((part) => getComputedStyle(document.querySelector(sel + ' ' + part)).opacity).join(' ')).join(' | ')`);
      order = await read(page!, `[...document.querySelector('${await rowSelector(page!, 'then it adds the prices.')} .ol-meta').children].map((el) => el.classList[0]).join(' · ')`);
    });

    it('then its expect calls, its lines and the commit that wrote it show, and the other rows\' stay hidden.', () => {
      assert.equal(shown, '1 1 1 | 0 0 0');
    });

    it('then a row\'s tag sits beside its mark\'s place, after what shows on hover, so the tags line up.', () => {
      assert.equal(order, 'ol-xp · ol-go · ol-tag · ol-tick-sp');
    });
  });

  describe('when a then opens in the Tests view, then in the chain of the commit that only adds tests, ', () => {
    let shown = '';

    before(async () => {
      // After the frame the minimap draws in.
      const look = `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done((document.querySelector('#vw-mini').hidden ? 'no minimap' : 'a minimap') + ', ' + document.querySelector('#vw-main').clientWidth + ' px wide'))))`;
      const seen: string[] = [];
      const open = async (title: string) => {
        const row = await rowSelector(page!, title);
        seen.push(await read(page!, look));
        await page!.click(row);
        await page!.until(`!!document.querySelector('#vw-main .ol-code')`);
        seen.push(await read(page!, look));
        await page!.click(row);
        await page!.until(`!document.querySelector('#vw-main .ol-code')`);
      };
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      await open('then it is positive.');
      await openChain(page!, 'Cover more totals');
      await open('then it is positive.');
      shown = seen.join('\n');
    });

    it('then no minimap comes with its code, and the page keeps its width.', () => {
      const [width] = /\d+ px/.exec(shown) ?? [''];
      assert.equal(shown, Array(4).fill(`no minimap, ${width} wide`).join('\n'));
    });
  });

  describe('when a then is open in the Tests view, and another opens under it, then closes, ', () => {
    let shown = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      const first = await rowSelector(page!, 'then it is positive.');
      const second = await rowSelector(page!, 'when nothing is bought, then nothing comes off.');
      await page!.click(first);
      await page!.until(`!!document.querySelector('${first} + .ol-code')`);
      await page!.eval(`window.__code = document.querySelector('${first} + .ol-code')`);
      const look = `(() => { const code = document.querySelector('${first} + .ol-code'); return (code === window.__code ? 'its code as drawn' : 'other code') + ' at ' + Math.round(code.getBoundingClientRect().top) + ' px'; })()`;
      const seen = [await read(page!, look)];
      await page!.click(second);
      await page!.until(`!!document.querySelector('${second} + .ol-code')`);
      seen.push(await read(page!, look));
      await page!.click(second);
      await page!.until(`!document.querySelector('${second} + .ol-code')`);
      seen.push(await read(page!, look));
      await page!.click(first);
      await page!.until(`!document.querySelector('${first} + .ol-code')`);
      shown = seen.join('\n');
    });

    it('then the code open stays as it was drawn, where it was.', () => {
      const [first] = shown.split('\n');
      assert.match(first, /^its code as drawn at \d+ px$/);
      assert.equal(shown, [first, first, first].join('\n'));
    });
  });

  describe('when a then opens and closes with motion on, ', () => {
    let opening = '';
    let closing = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.reducedMotion(false);
      const row = await rowSelector(page!, 'then it is positive.');
      await page!.click(row);
      opening = await read(page!, `(() => { const grow = document.querySelector('#vw-main .grow'); return grow ? 'opens below ' + (grow.previousElementSibling?.matches('.ol-row.open') ? 'its row' : 'something else') + ' with ' + grow.querySelectorAll('.ol-code').length + ' code in it' : 'no opening'; })()`);
      await page!.until(`!document.querySelector('#vw-main .grow')`);
      await page!.click(row);
      closing = await read(page!, `(() => { const ghost = document.querySelector('#vw-main .ghost'); return ghost ? 'folds into ' + (ghost.previousElementSibling?.matches('.ol-row:not(.open)') ? 'its row' : 'something else') + ' with ' + ghost.querySelectorAll('.ol-code').length + ' code in it' : 'no folding'; })()`);
      await page!.until(`!document.querySelector('#vw-main .ghost')`);
    });

    after(async () => {
      await page!.reducedMotion(true);
    });

    it('then its code opens downward from its row, and folds back into it.', () => {
      assert.equal(`${opening}\n${closing}`, 'opens below its row with 1 code in it\nfolds into its row with 1 code in it');
    });
  });

  describe('when a test opens in its file from the scrolled Tests view, and Back is pressed, ', () => {
    let trip = '';

    before(async () => {
      await page!.setViewport(1400, 260);
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      await page!.eval(`document.querySelector('#vw-main').scrollTop = 90`);
      const top = await read(page!, `String(document.querySelector('#vw-main').scrollTop)`);
      await page!.eval(`document.querySelector('${await rowSelector(page!, 'when nothing is bought, then nothing comes off.')} .ol-go').click()`);
      await page!.until(`(document.querySelector('.fv-head .crumbs')?.textContent || '').includes('cart_test.dart')`);
      const back = await read(page!, `document.querySelector('.fv-back')?.title ?? 'no Back'`);
      await page!.click('.fv-back');
      await page!.until(`document.querySelector('.fv-head .crumbs')?.textContent === 'Tests'`);
      const there = await read(page!, `'Tests at ' + (String(document.querySelector('#vw-main').scrollTop) === '${top}' ? 'its scroll' : document.querySelector('#vw-main').scrollTop)`);
      await page!.eval('history.forward()');
      await page!.until(`(document.querySelector('.fv-head .crumbs')?.textContent || '').includes('cart_test.dart')`);
      await page!.eval('history.back()');
      await page!.until(`document.querySelector('.fv-head .crumbs')?.textContent === 'Tests'`);
      const again = await read(page!, `'Tests at ' + (String(document.querySelector('#vw-main').scrollTop) === '${top}' ? 'its scroll' : document.querySelector('#vw-main').scrollTop)`);
      trip = [back, there, again].join('\n');
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then the file offers Back to the Tests, which returns there scrolled as it was, and so does the browser\'s Back after its Forward.', () => {
      assert.equal(trip, 'Back to Tests (Alt ←)\nTests at its scroll\nTests at its scroll');
    });
  });

  describe('when the sidebar\'s tabs are read, ', () => {
    let pinned = '';
    let lines = '';

    before(async () => {
      await rest(page!);
      const pins = `[...document.querySelectorAll('#vw-side .sb-pin .sb-row')].map((row) => row.querySelector('.nm').textContent + (row.querySelector('.cnt')?.textContent ? ' ' + row.querySelector('.cnt').textContent : '')).join(', ')`;
      const diff = (sel: string, name: string) => `[...document.querySelectorAll('#vw-side ${sel}')].map((row) => ${name} + ' ' + [row.querySelector('.df')?.dataset.a, row.querySelector('.df')?.dataset.d].filter(Boolean).join(' ')).join(', ')`;
      await page!.click('[data-tab="chains"]');
      const chains = await read(page!, pins);
      const chainLines = await read(page!, diff('.sb-row[data-chain]', `row.querySelector('.nm').textContent`));
      await page!.click('[data-tab="commits"]');
      const commits = await read(page!, pins);
      const commitLines = await read(page!, diff('.cm-row[data-commit]', `row.querySelector('.cm-s').textContent`));
      await page!.click('[data-tab="files"]');
      const fileLines = await read(page!, diff('.sb-row.tr', `row.querySelector('.nm').textContent`));
      pinned = `Chains: ${chains}\nCommits: ${commits}`;
      lines = `${chainLines}\n${commitLines}\n${fileLines}`;
    });

    it('then the Chains tab pins its chain map, History and Tests above its chains, and the Commits tab History and every change above its commits.', () => {
      assert.equal(pinned, 'Chains: Chain map, History 3, Tests 4\nCommits: History, All changes 6');
    });

    // A chain's lines are its own changes' (as its tooltip says, a blank line before a change
    // included), a commit's all it changed.
    it('then each chain, commit, folder and file keeps the lines it adds and removes for its hover.', () => {
      assert.equal(lines, [
        'feat Take a discount +9, test Cover more totals +9, test Name the scenario +1 −1',
        'test Name the scenario +1 −1, test Cover more totals +8, feat Take a discount +10',
        'lib +2, cart.dart +2, test +17 −1, cart_test.dart +17 −1',
      ].join('\n'));
    });
  });

  describe('when the Tests view reads each test as its whole sentence, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.click('[data-act="tests-mode"][data-v="sentences"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-row.sent')`);
      rows = await read(page!, rowsRead);
      await page!.click('[data-act="tests-mode"][data-v="nested"]');
    });

    it('then each test reads whole, and a renamed Given shows its changed words on the first test it heads.', () => {
      assert.equal(rows, [
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, when the total is taken, then it adds the prices. [${nameSha.slice(0, 7)}]`,
        `  + Given a cart holding two items, when the total is taken, then it is positive. [${moreSha.slice(0, 7)}]`,
        `  + Given a cart with a discount of one, when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}]`,
        `  + Given a cart with a discount of one, when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });

  describe('when the Tests view keeps only the reworded sentences, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.click('[data-act="tests-filter"][data-v="reworded"]');
      await page!.until(`!document.querySelector('#vw-main .ol-row.new')`);
      rows = await read(page!, rowsRead);
      await page!.click('[data-act="tests-filter"][data-v="all"]');
    });

    it('then only the reworded test shows, with the groups that complete its sentence.', () => {
      assert.equal(rows, [
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
      ].join('\n'));
    });
  });

  describe('when a then opens in its file and the page scrolls to the line under its title, ', () => {
    let pinned = '';

    before(async () => {
      await page!.setViewport(1400, 420);
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click(`${await rowSelector(page!, 'then it is positive.')} .ol-go`);
      // The file's other lines load after it opens, and the line it opened at is placed again then,
      // and again over the three frames after (once the source is loaded, right away).
      await page!.until(`!!document.querySelector('.code[data-p="test/cart_test.dart"] [data-n="23"]') && !document.querySelector('#vw-main .ln.loading')`);
      await page!.eval(`new Promise((resolve) => { let frames = 0; const tick = () => (++frames >= 4 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })`);
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); const row = main.querySelector('.code[data-p="test/cart_test.dart"] .ln[data-n="23"]'); main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - main.querySelector('.fv-head').offsetHeight; })()`);
      await page!.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await page!.until(`!!document.querySelector('.ol-pin.on')`);
      pinned = await read(page!, `[...document.querySelectorAll('.ol-pin .ol-pin-l')].map((el) => el.textContent).join('\\n')`);
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then its Given, its when and its own title stay pinned above the code.', () => {
      assert.equal(pinned, [
        'Given a cart holding two items,',
        'when the total is taken,',
        'then it is positive.',
      ].join('\n'));
    });
  });

  describe('when a chain scrolls past its graph and the graph drops and folds back, with motion on, ', () => {
    let fold = '';
    let motion = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Take a discount');
      await page!.setViewport(1400, 360);
      await page!.reducedMotion(false);
      // Most of the way under the header, the graph shrinks toward its button; once it's gone, the
      // button pulses. (The lines between hunks load as they show: the page settles first.)
      const settle = `new Promise((resolve) => { const wait = () => (document.querySelector('#vw-main .ln.loading') ? setTimeout(wait, 50) : requestAnimationFrame(() => requestAnimationFrame(resolve))); wait(); })`;
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'), box = main.querySelector('.graph-box'); main.scrollTop += box.getBoundingClientRect().top - main.getBoundingClientRect().top - main.querySelector('.fv-head').offsetHeight + box.offsetHeight * 0.8; })()`);
      await page!.eval(settle);
      const half = await read(page!, `document.querySelector('.graph-box').style.transform.startsWith('scale(') ? 'shrinking' : 'whole'`);
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); main.scrollTop = main.scrollHeight; })()`);
      await page!.eval(settle);
      fold = `${half} · ${await read(page!, `document.querySelector('.fv-head [data-act="graph"]').classList.contains('took') ? 'the button took it' : 'no pulse'`)}`;
      // One animation drops it; folding plays that same animation back from where it is.
      motion = await read(page!, `(async () => {
        const btn = document.querySelector('.fv-head [data-act="graph"]'), gd = document.querySelector('.gd');
        btn.click();
        const down = gd.getAnimations()[0];
        const opening = down ? 'forward ' + down.playbackRate : 'no animation';
        // Folded on its way down: back from where it got to.
        while (down && down.currentTime < 80) await new Promise((resolve) => requestAnimationFrame(resolve));
        const at = down ? down.currentTime : 0;
        btn.click();
        const up = gd.getAnimations()[0];
        const closing = up === down ? 'the same one, back ' + up.playbackRate + (up.currentTime <= at ? ' from where it was' : ' from elsewhere') : 'another animation';
        await new Promise((resolve) => setTimeout(resolve, 400));
        return opening + ' · ' + closing + ' · ' + (gd.hidden ? 'folded' : 'down') + ' with ' + gd.getAnimations().length + ' animations left';
      })()`);
    });

    after(async () => {
      await page!.reducedMotion(true);
      await page!.setViewport(1400, 900);
    });

    it('then the graph shrinks into its button as it scrolls away, and its drop folds back by the same motion reversed.', () => {
      assert.equal(`${fold}\n${motion}`, 'shrinking · the button took it\nforward 1 · the same one, back -1 from where it was · folded with 0 animations left');
    });
  });

  describe('when the graph button of a test file in three chains is clicked, and a member is picked, ', () => {
    let dropped = '';
    let went = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="files"]');
      await page!.click('[data-open="test/cart_test.dart"]');
      await page!.until(`(document.querySelector('.fv-head .crumbs')?.textContent || '').includes('cart_test.dart')`);
      await page!.click('.fv-head [data-act="graph"]');
      await page!.until(`!document.querySelector('.gd').hidden`);
      dropped = await read(page!, `[...document.querySelectorAll('.gd-tabs button')].map((tab) => tab.textContent + (tab.getAttribute('aria-selected') === 'true' ? ' (shown)' : '')).join(' | ')`);
      await page!.click('.gd-tabs button[aria-selected="false"]');
      const name = await read(page!, `document.querySelector('.gd-tabs button[aria-selected="true"]').textContent`);
      await page!.click('.gd g.g-node');
      await page!.until(`!document.querySelector('.gd') || document.querySelector('.gd').hidden`);
      went = `${name} · ${await read(page!, `document.querySelector('.fv-head .crumbs b').textContent`)}`;
    });

    // The file opens at its top, on the renamed Given: the chain that renamed it shows first.
    it('then the graph drops with a tab for each of the file\'s chains, in the file\'s order, the one of the line being read shown, and a member opens its chain.', () => {
      const [picked, opened] = went.split(' · ');
      assert.equal(`${dropped}\n${picked === opened ? 'opened the picked chain' : `opened ${opened}, picked ${picked}`}`, 'Name the scenario (shown) | Cover more totals | Take a discount\nopened the picked chain');
    });
  });

  describe('when the Tests view scrolls past a Given to a test under it, ', () => {
    let pinned = '';

    before(async () => {
      await page!.setViewport(1400, 260);
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); const row = [...main.querySelectorAll('.ol-row')].find((el) => el.querySelector('.ol-tt').textContent.trim() === 'when nothing is bought, then nothing comes off.'); main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - main.querySelector('.fv-head').offsetHeight; })()`);
      await page!.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await page!.until(`!!document.querySelector('.ol-pin.on')`);
      pinned = await read(page!, `[...document.querySelectorAll('.ol-pin .ol-pin-l')].map((el) => el.textContent).join('\\n')`);
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then the Given stays pinned above the test.', () => {
      assert.equal(pinned, 'Given a cart with a discount of one,');
    });
  });

  describe('when another test opens while a peek is open in a test\'s code, with motion on, ', () => {
    let closing = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      await page!.click(await rowSelector(page!, 'then it is positive.'));
      await page!.until(`!!document.querySelector('#vw-main .ol-code')`);
      await page!.clickIn('#vw-main .ol-code .ref', 'sum', 'expect(sum > 0');
      await page!.until(`!!document.querySelector('#vw-main .peek .pk-loc')`);
      await page!.reducedMotion(false);
      await page!.click(await rowSelector(page!, 'when nothing is bought, then nothing comes off.'));
      // A moment later than anything the click set off at once.
      await page!.eval(`new Promise((resolve) => setTimeout(resolve, 60))`);
      closing = await read(page!, `[document.querySelector('#vw-main .ghost .peek') ? 'the peek folding away' : 'the peek gone at once', document.querySelectorAll('#vw-main .ol-code').length + ' tests open'].join(', ')`);
      await page!.until(`!document.querySelector('#vw-main .ghost')`);
      await page!.reducedMotion(true);
    });

    after(async () => {
      for (const title of ['then it is positive.', 'when nothing is bought, then nothing comes off.']) await page!.click(await rowSelector(page!, title));
      await page!.until(`!document.querySelector('#vw-main .ol-code')`);
    });

    it('then the peek folds away with motion, as it does when it closes alone, while the other test opens.', () => {
      assert.equal(closing, 'the peek folding away, 2 tests open');
    });
  });

  describe('when Space reviews the Tests view from its top, ', () => {
    let given = '';
    let then = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      // Space reviews from the page, not from a button left focused.
      await page!.eval(`document.querySelector('#vw-main').scrollTop = 0; document.activeElement?.blur()`);
      await page!.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await page!.key(' ');
      await page!.until(`!!document.querySelector('#vw-main .ol-row.done')`);
      given = await read(page!, `${rowsRead} + '\\n' + [...document.querySelectorAll('#vw-main .ol-tick.part')].length + ' marks part on'`);
      await page!.key(' ');
      await page!.until(`!!document.querySelector('#vw-main .ol-fold.ok')`);
      then = await read(page!, `${rowsRead} + '\\nnext: ' + (document.querySelector('#vw-main .ol-row.flash .ol-tt')?.textContent.trim() ?? 'none')`);
    });

    it('then the Given\'s own lines are reviewed first: it mutes, and its mark and the file\'s show part done, while it stays, since its tests aren\'t.', () => {
      assert.equal(given, [
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, [${nameSha.slice(0, 7)}] (reviewed)`,
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
        `      + then it is positive. [${moreSha.slice(0, 7)}]`,
        `  + Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        `    + when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}]`,
        `    + when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
        '2 marks part on',
      ].join('\n'));
    });

    it('then reviewing its last test folds the whole Given away, into a line of reviewed tests, and the next Given is next.', () => {
      assert.equal(then, [
        'cart_test.dart · 3 new · 1 reworded',
        '  2 tests reviewed',
        `  + Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        `    + when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}]`,
        `    + when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
        'next: Given a cart with a discount of one,',
      ].join('\n'));
    });
  });

  describe('when the reviewed tests\' line is clicked, ', () => {
    let shown = '';

    before(async () => {
      await page!.click('#vw-main .ol-fold.ok');
      await page!.until(`(document.querySelector('#vw-main .ol-fold.ok')?.getAttribute('aria-expanded')) === 'true'`);
      shown = await read(page!, rowsRead);
    });

    it('then they show again, muted, under a line that folds them back.', () => {
      assert.equal(shown, [
        'cart_test.dart · 3 new · 1 reworded',
        '  Fold the 2 reviewed tests',
        `  ~ Given a cart [-with-]{+holding+} two items, [${nameSha.slice(0, 7)}] (reviewed)`,
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
        `      + then it is positive. [${moreSha.slice(0, 7)}] (reviewed)`,
        `  + Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        `    + when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}]`,
        `    + when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });

  describe('when the file\'s mark is clicked, with motion on, ', () => {
    let moving = '';
    let folded = '';

    before(async () => {
      await page!.reducedMotion(false);
      await page!.click('#vw-main .ol-file .ol-tick');
      moving = await read(page!, `[document.querySelectorAll('#vw-main .ghost .ol-row').length + ' rows settling', document.querySelectorAll('#vw-main .ghost .tick.on').length + ' marks on in them'].join(', ')`);
      await page!.until(`!document.querySelector('#vw-main .ghost')`);
      await page!.reducedMotion(true);
      folded = await read(page!, `${rowsRead} + '\\n' + document.querySelector('#vw-main .ol-file .car').getAttribute('aria-expanded')`);
    });

    it('then its rows settle as reviewed and fold into its line.', () => {
      assert.equal(moving, '7 rows settling, 5 marks on in them');
    });

    it('then the file folds to that line, which says what it reviewed.', () => {
      assert.equal(folded, 'cart_test.dart · 4 tests reviewed\nfalse');
    });
  });

  describe('when the folded file is unfolded, and then its mark is clicked again, ', () => {
    let open = '';
    let undone = '';

    before(async () => {
      await page!.click('#vw-main .ol-file .car');
      await page!.until(`document.querySelector('#vw-main .ol-file .car').getAttribute('aria-expanded') === 'true'`);
      open = await read(page!, rowsRead);
      await page!.click('#vw-main .ol-file .ol-tick');
      await page!.until(`!document.querySelector('#vw-main .ol-row.done')`);
      undone = await read(page!, rowsRead);
    });

    it('then it shows every row, all reviewed, none folded.', () => {
      assert.equal(open, [
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, [${nameSha.slice(0, 7)}] (reviewed)`,
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
        `      + then it is positive. [${moreSha.slice(0, 7)}] (reviewed)`,
        `  + Given a cart with a discount of one, [${discountSha.slice(0, 7)}] (reviewed)`,
        `    + when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}] (reviewed)`,
        `    + when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}] (reviewed)`,
      ].join('\n'));
    });

    it('then nothing in it is reviewed any more, and nothing folds.', () => {
      assert.equal(undone, [
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
        `      + then it is positive. [${moreSha.slice(0, 7)}]`,
        `  + Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        `    + when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}]`,
        `    + when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });
});

// Ten tests and a helper outside them, all new in one commit: in the commit's chain the helper's
// code follows the tests' rows, which are sticky (they stay put as the pane scrolls sideways), so
// the browser would keep that code in place, rather than a row, as a test opens.
const expects = (n: number) => Array.from({ length: 24 }, (_, k) => `    expect(twice(${n} + ${k}), ${2 * n} + ${2 * k});\n`).join('');
const tenTests = Array.from({ length: 10 }, (_, i) => `  test('when ${i + 1} is doubled, then it is ${2 * (i + 1)}.', () {\n${expects(i + 1)}  });\n`).join('');
const helper = (body: string) => `\nint twice(int x) {\n${body}}\n`;
const helperLines = (n: number) => Array.from({ length: n }, (_, i) => `  // step ${i + 1}\n`).join('') + '  return x * 2;\n';

describe('Given a served review of a commit with ten tests and a helper after them, with motion on, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/cart.dart', cart());
    repo.write('test/twice_test.dart', `void main() {\n}\n${helper('  return x + x;\n')}`);
    const start = ada('2020-10-01T15:00:00Z');
    repo.commit({ subject: 'Start the doubling', author: start, committer: start });
    repo.branch('feature');
    repo.write('test/twice_test.dart', `void main() {\n${tenTests}}\n${helper(helperLines(160))}`);
    const next = ada('2020-10-02T15:00:00Z');
    repo.commit({ subject: 'test: Double ten numbers', author: next, committer: next });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, args: ['-chains', 'history'] });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser(1400, 800);
    await page.reducedMotion(false);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when a test opens with its row half under the header, the helper’s code on screen below, ', () => {
    let opening = '';
    let moved = '';

    before(async () => {
      await openChain(page!, 'Double ten numbers');
      const row = await rowSelector(page!, 'when 6 is doubled, then it is 12.');
      // Its top 10 px under the header, once the chain's graph has folded into it.
      const place = `(() => { const main = document.querySelector('#vw-main'), r = document.querySelector('${row}'); main.scrollTop += r.getBoundingClientRect().top - main.getBoundingClientRect().top - document.querySelector('.fv-head').offsetHeight + 10; return Math.round(r.getBoundingClientRect().top); })()`;
      let top = await read(page!, place);
      for (let i = 0; i < 5; i++) {
        await page!.eval(`new Promise((done) => setTimeout(done, 300))`);
        const again = await read(page!, place);
        if (again === top) break;
        top = again;
      }
      const shown = await read(page!, `(() => { const out = document.querySelector('#vw-main .ol-out .code'); const r = out.getBoundingClientRect(), m = document.querySelector('#vw-main').getBoundingClientRect(); return r.top < m.bottom && r.bottom > m.top ? 'on screen' : 'off screen'; })()`);
      await page!.clickRatio(row, 0.3, 0.8, { scroll: false });
      opening = 'the helper’s code ' + shown + ', ' + await read(page!, `(() => { const g = document.querySelector('#vw-main .grow'); if (!g) return 'no opening'; return g.getAnimations().some((a) => a.effect.getKeyframes().some((k) => k.opacity != null)) ? 'the test’s code fading in' : 'the test’s code showing as it opens'; })()`);
      await page!.until(`!document.querySelector('#vw-main .grow') && !!document.querySelector('${row}.open')`);
      moved = await read(page!, `(() => { const d = Math.round(document.querySelector('${row}').getBoundingClientRect().top) - ${top}; return d ? 'moved ' + d + ' px' : 'stays where it was'; })()`);
    });

    it('then its code shows as it opens, and the row stays where it was.', () => {
      assert.equal(`${opening}\n${moved}`, 'the helper’s code on screen, the test’s code showing as it opens\nstays where it was');
    });
  });
});
