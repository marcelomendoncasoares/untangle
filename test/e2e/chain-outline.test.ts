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

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('');
const cart = `int total(List<int> prices) => prices.fold(0, (sum, price) => sum + price);\n`;
const discounted = `import 'ledger.dart';\n\n${lines(30, (i) => `/// Step ${i} of the discount.\n`)}int discounted(List<int> prices, int off) {\n${lines(30, (i) => `  final step${i} = prices.length + ${i};\n`)}  return total(prices) - off;\n}\n`;
const ledger = `class: Ledger\ntable: ledgers\nfields:\n${lines(12, (i) => `  entry${i}: int\n`)}`;
const doc = `# Discounts\n\n${lines(16, (i) => `A discount takes ${i} off the total.\n\n`)}`;
const ledgerTests = `import 'package:core/ledger.dart';\n\nvoid main() {\n  group('Given an empty ledger,', () {\n    final ledger = Ledger();\n\n${lines(4, (i) => `    test('when entry ${i} is read, then it is zero.', () {\n      expect(ledger.entry(${i}), 0);\n    });\n\n`)}  });\n}\n`;
const tests = `import 'package:sample/discount.dart';\n\nvoid main() {\n  group('Given a cart with a discount of one,', () {\n    final prices = [1, 2];\n\n${lines(6, (i) => `    test('when the total is taken ${i} times, then the discount comes off.', () {\n      expect(discounted(prices, 1), 2);\n    });\n\n`)}  });\n}\n`;

/** The rail as read: shown or not, its dashes top to bottom (amber, ok, and the one being read), and whether it sits on the minimap's edge. */
const railRead = `(() => {
  const rail = document.querySelector('#vw-rail'), mini = document.querySelector('#vw-mini');
  if (rail.hidden) return 'no rail';
  const dashes = [...rail.querySelectorAll('i')];
  const tops = dashes.map((d) => d.getBoundingClientRect().top);
  const ordered = tops.every((t, i) => i === 0 || t > tops[i - 1]);
  const paired = Math.round(rail.getBoundingClientRect().left) === Math.round(mini.getBoundingClientRect().right);
  return dashes.map((d) => (d.classList.contains('at') ? 'at' : d.classList.contains('ok') ? 'ok' : '·')).join(' ') + (ordered ? ', top to bottom' : ', out of order') + (paired ? ', on the minimap’s edge' : ', away from the minimap');
})()`;

/** The outline as read: its groups and rows, each row's mark, title, what's beside it and its count, the one being read marked. */
const outlineRead = `[...document.querySelectorAll('#vw-ol .co-g, #vw-ol .co-r')].map((el) => el.matches('.co-g')
  ? '# ' + [...el.children].map((x) => x.textContent).join(' · ')
  : (el.getAttribute('aria-current') === 'true' ? '> ' : '  ') + (el.querySelector('.mk.ok') ? '✓ ' : '• ') + el.querySelector('.nm').childNodes[0].textContent + (el.querySelector('.sn') ? ' (' + el.querySelector('.sn').textContent + ')' : '') + ' ' + el.querySelector('.cnt').textContent).join('\\n')`;

/** Where the page's right side is: how far the code stops from it, and what sits there, left to right. */
const rightRead = `(() => {
  const at = (q) => { const el = document.querySelector(q); if (!el || el.hidden || getComputedStyle(el).visibility === 'hidden') return null; const r = el.getBoundingClientRect(); return r.width ? [Math.round(r.left), Math.round(r.right)] : null; };
  const sheet = document.querySelector('.vw-sheet').getBoundingClientRect();
  const parts = [['code', at('#vw-main')], ['minimap', at('#vw-mini')], ['rail', at('#vw-rail')], ['outline', at('#vw-ol')]].filter(([, r]) => r);
  return parts.map(([name, r]) => name + ' ' + (r[1] - r[0]) + 'px').join(', ') + (Math.round(parts[parts.length - 1][1][1]) === Math.round(sheet.right) ? ', to the page’s edge' : '');
})()`;

/**
 * Arms a record of the transitions the next key or click starts on the page's right side, read
 * from window.__moves: the page's room for the column, and the outline's place and top, each from
 * what to what. Read as the action lands, it doesn't hang on how many frames a busy machine draws.
 */
const movesWatch = `void (() => {
  window.__moves = null;
  if (window.__movesOn) return;
  window.__movesOn = true;
  const record = () => {
    if (window.__moves !== null) return;
    const page = document.querySelector('#viewer'), ol = document.querySelector('#vw-ol');
    getComputedStyle(page).getPropertyValue('--col-w');
    getComputedStyle(ol).transform;
    const seen = [];
    for (const [name, el, props] of [['page', page, ['--col-w']], ['outline', ol, ['transform', 'top']]]) {
      for (const a of el.getAnimations()) {
        if (!props.includes(a.transitionProperty)) continue;
        const kf = a.effect.getKeyframes();
        seen.push(name + ' ' + a.transitionProperty + ' ' + kf[0][a.transitionProperty] + ' → ' + kf[kf.length - 1][a.transitionProperty]);
      }
    }
    window.__moves = seen.join('; ') || 'nothing moved';
  };
  document.addEventListener('keydown', record);
  document.addEventListener('click', record);
})()`;

describe('Given a served review by commit of a commit that changes a doc, a model, code and its tests, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  const openChain = async () => {
    await page!.click('[data-tab="chains"]');
    await page!.until(`!!document.querySelector('.sb-row[data-chain]')`);
    const id = await read(page!, `([...document.querySelectorAll('.sb-row[data-chain]')].find((el) => (el.textContent || '').includes('Take a discount')) || {}).dataset?.chain ?? ''`);
    await page!.click(`.sb-row[data-chain="${id}"]`);
    await page!.until(`!!document.querySelector('#vw-main .ol-sec') && !document.querySelector('#vw-rail').hidden && !!document.querySelector('#vw-rail i[style]')`);
  };

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/cart.dart', cart);
    repo.write('lib/ledger.dart', 'class Ledger {}\n');
    const start = ada('2020-09-01T15:00:00Z');
    repo.commit({ subject: 'Start the cart', author: start, committer: start });
    repo.branch('feature');
    repo.write('lib/discount.dart', discounted);
    repo.write('lib/src/models/ledger.spy.yaml', ledger);
    repo.write('docs/discounts.md', doc);
    repo.write('test/discount_test.dart', tests);
    repo.write('packages/core/test/ledger_test.dart', ledgerTests);
    const first = ada('2020-09-02T15:00:00Z');
    repo.commit({ subject: 'feat: Take a discount', author: first, committer: first });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, args: ['-chains', 'history'] });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser(1400, 900);
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

  describe('when the commit’s chain opens, ', () => {
    let rail = '';
    let right = '';

    before(async () => {
      await rest(page!);
      await openChain();
      rail = await read(page!, railRead);
      right = await read(page!, rightRead);
    });

    it('then a rail on the minimap’s edge has a dash at each part’s place, the first one being read.', () => {
      assert.equal(rail, 'at · · · ·, top to bottom, on the minimap’s edge');
    });

    it('then the code stops at the minimap, and the rail ends the page.', () => {
      assert.equal(right, 'code 1052px, minimap 64px, rail 12px, to the page’s edge');
    });
  });

  describe('when the pointer rests on the rail, ', () => {
    let rows = '';
    let right = '';

    before(async () => {
      await rest(page!);
      await openChain();
      await page!.hover('#vw-rail', { scroll: false });
      await page!.until(`document.querySelector('#viewer').classList.contains('co-open')`);
      rows = await read(page!, outlineRead);
      right = await read(page!, rightRead);
    });

    it('then the outline opens with the chain’s parts by kind: the doc, the model, the code, then the test files.', () => {
      assert.equal(rows, [
        '# Docs · 1',
        '  • discounts.md 1',
        '# Models · 1',
        '  • Ledger (ledger.spy.yaml) 1',
        '# Code · 1',
        '> • discounted (discount.dart) 2',
        '# Tests · 2',
        '  • ledger_test.dart (4 new) 6',
        '  • discount_test.dart (6 new) 8',
      ].join('\n'));
    });

    it('then it opens over the minimap and the code, which keep their places.', () => {
      assert.equal(right, 'code 1052px, minimap 64px, rail 12px, outline 300px, to the page’s edge');
    });
  });

  describe('when the pointer rests on the minimap’s edge beside the rail, and then on its middle, ', () => {
    let edge = '';
    let middle = '';

    before(async () => {
      await rest(page!);
      await openChain();
      await page!.hover('#vw-mini', { scroll: false, x: 0.9 });
      await page!.until(`document.querySelector('#viewer').classList.contains('co-open')`);
      edge = await read(page!, `document.querySelector('#viewer').classList.contains('co-open') ? 'open' : 'closed'`);
      await page!.hover('.fv-head .crumbs', { scroll: false });
      await page!.until(`!document.querySelector('#viewer').classList.contains('co-open')`);
      await page!.hover('#vw-mini', { scroll: false, x: 0.5 });
      await page!.eval(`new Promise((r) => setTimeout(r, 500))`);
      middle = await read(page!, `document.querySelector('#viewer').classList.contains('co-open') ? 'open' : 'closed'`);
    });

    it('then the edge opens the outline, as the rail does.', () => {
      assert.equal(edge, 'open');
    });

    it('then the middle is the minimap’s alone.', () => {
      assert.equal(middle, 'closed');
    });
  });

  describe('when the outline is kept, and the minimap’s edge is clicked near its bottom, ', () => {
    let clicked = '';

    before(async () => {
      await rest(page!);
      await openChain();
      await page!.key('o');
      await page!.until(`document.querySelector('#viewer').classList.contains('co-pin')`);
      await page!.eval(`document.querySelector('#vw-main').scrollTop = 0`);
      await page!.clickRatio('#vw-mini', 0.9, 0.9, { scroll: false });
      await page!.until(`document.querySelector('#vw-main').scrollTop > 0`);
      clicked = await read(page!, `(document.querySelector('#viewer').classList.contains('co-pin') ? 'kept' : 'let go') + ', the page ' + (document.querySelector('#vw-main').scrollTop > 0 ? 'moved' : 'still')`);
      await page!.click('#vw-ol [data-act="co-keep"]');
      await page!.until(`!document.querySelector('#viewer').classList.contains('co-pin')`);
    });

    it('then the click is the minimap’s: the page moves, and the outline stays a column.', () => {
      assert.equal(clicked, 'kept, the page moved');
    });
  });

  describe('when the doc’s row is clicked, and then the pointer leaves the outline, ', () => {
    let went = '';
    let left = '';

    before(async () => {
      await rest(page!);
      await openChain();
      await page!.hover('#vw-rail', { scroll: false });
      await page!.until(`document.querySelector('#viewer').classList.contains('co-open')`);
      await page!.click('#vw-ol .co-r[data-key^="sec-"]');
      await page!.until(`(document.querySelector('.fv-here')?.textContent || '').includes('discounts.md')`);
      went = await read(page!, `document.querySelector('.fv-here').textContent + ' | ' + ${railRead} + ' | ' + (document.querySelector('#viewer').classList.contains('co-open') ? 'open' : 'closed')`);
      await page!.hover('.fv-head .crumbs', { scroll: false });
      await page!.until(`!document.querySelector('#viewer').classList.contains('co-open')`);
      left = await read(page!, `document.querySelector('.fv-here').textContent + ' | ' + ${railRead}`);
    });

    it('then the page goes to the doc, the header reads it and the rail lights its dash, the outline still open.', () => {
      assert.equal(went, 'Reading discounts.md · 3 of 6 | · at · · ·, top to bottom, on the minimap’s edge | open');
    });

    it('then the outline closes, and the page stays at the doc.', () => {
      assert.equal(left, 'Reading discounts.md · 3 of 6 | · at · · ·, top to bottom, on the minimap’s edge');
    });
  });

  describe('when o is pressed, ', () => {
    let pinned = '';
    let again = '';
    let esc = '';

    before(async () => {
      await rest(page!);
      await openChain();
      await page!.key('o');
      await page!.until(`document.querySelector('#viewer').classList.contains('co-pin')`);
      pinned = await read(page!, `${rightRead} + ' | ' + (document.activeElement.closest('#vw-ol .co-r')?.querySelector('.nm').childNodes[0].textContent ?? 'focus elsewhere')`);
      await page!.goto(run!.url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openChain();
      again = await read(page!, `(document.querySelector('#viewer').classList.contains('co-pin') ? 'kept open' : 'not kept') + ' | ' + ${rightRead}`);
      await page!.eval(`document.querySelector('#vw-ol .co-r').focus()`);
      await page!.key('Escape');
      await page!.until(`!document.querySelector('#viewer').classList.contains('co-pin')`);
      esc = await read(page!, rightRead);
    });

    it('then the outline is a column at the page’s right, the code, the minimap and the rail moved over for it, and the part being read has the focus.', () => {
      assert.equal(pinned, 'code 752px, minimap 64px, rail 12px, outline 300px, to the page’s edge | discounted');
    });

    it('then it’s still a column once the page is opened again.', () => {
      assert.equal(again, 'kept open | code 752px, minimap 64px, rail 12px, outline 300px, to the page’s edge');
    });

    it('then Esc in it lets it go, and the code takes its room back.', () => {
      assert.equal(esc, 'code 1052px, minimap 64px, rail 12px, to the page’s edge');
    });
  });

  describe('with motion on, when o keeps the outline, then lets it go, and the rail’s outline is kept, then let go from its pin, ', () => {
    let kept = '';
    let letGo = '';
    let grown = '';
    let still = '';

    before(async () => {
      await rest(page!);
      await openChain();
      await page!.reducedMotion(false);
      try {
        await page!.eval(movesWatch);
        await page!.key('o');
        await page!.until(`!document.querySelector('#viewer').classList.contains('co-moving')`);
        kept = await read(page!, `window.__moves + '\\n' + ${rightRead}`);
        await page!.eval(movesWatch);
        await page!.key('o');
        await page!.until(`!document.querySelector('#viewer').classList.contains('co-moving') && getComputedStyle(document.querySelector('#vw-ol')).visibility === 'hidden'`);
        letGo = await read(page!, `window.__moves + '\\n' + ${rightRead}`);
        await page!.hover('#vw-rail', { scroll: false });
        await page!.until(`document.querySelector('#viewer').classList.contains('co-open') && getComputedStyle(document.querySelector('#vw-ol')).transform === 'none'`);
        await page!.eval(movesWatch);
        await page!.click('#vw-ol [data-act="co-keep"]');
        await page!.until(`!document.querySelector('#viewer').classList.contains('co-moving')`);
        grown = await read(page!, `window.__moves + '\\n' + ${rightRead}`);
        await page!.click('#vw-ol [data-act="co-keep"]');
        await page!.until(`!document.querySelector('#viewer').classList.contains('co-moving') && getComputedStyle(document.querySelector('#vw-ol')).visibility === 'hidden'`);
        await page!.eval(`new Promise((r) => setTimeout(r, 500))`);
        still = await read(page!, `(document.querySelector('#viewer').classList.contains('co-open') ? 'open' : 'closed') + ', the pointer on ' + (document.querySelector('#vw-rail').matches(':hover') ? 'the rail' : 'something else')`);
      } finally {
        await page!.reducedMotion(true);
      }
    });

    it('then the column slides in from the right as its room grows, the code narrowing and the minimap sliding over with it.', () => {
      assert.equal(kept, [
        'page --col-w 0px → 300px; outline transform translateX(104%) → none',
        'code 752px, minimap 64px, rail 12px, outline 300px, to the page’s edge',
      ].join('\n'));
    });

    it('then it slides back out as its room shrinks, the code widening and the minimap sliding back.', () => {
      assert.equal(letGo, [
        'page --col-w 300px → 0px; outline transform none → translateX(104%)',
        'code 1052px, minimap 64px, rail 12px, to the page’s edge',
      ].join('\n'));
    });

    it('then the outline over the code grows up into the column, in its place, as the page slides out from under it.', () => {
      assert.equal(grown, [
        'page --col-w 0px → 300px; outline top 86px → 0px',
        'code 752px, minimap 64px, rail 12px, outline 300px, to the page’s edge',
      ].join('\n'));
    });

    it('then the rail sliding back under the still pointer doesn’t open the outline again.', () => {
      assert.equal(still, 'closed, the pointer on the rail');
    });
  });

  describe('when the minimap is off, and the header’s Reading is clicked, ', () => {
    let off = '';
    let opened = '';

    before(async () => {
      await rest(page!);
      await openChain();
      await page!.click('.fv-head [data-menu="view"]');
      await page!.click('[data-act="minimap"]');
      await page!.until(`document.querySelector('#vw-mini').hidden`);
      off = await read(page!, railRead);
      await page!.click('.fv-here');
      await page!.until(`document.querySelector('#viewer').classList.contains('co-pin')`);
      opened = await read(page!, rightRead);
      await page!.click('#vw-ol [data-act="co-keep"]');
      await page!.click('.fv-head [data-menu="view"]');
      await page!.click('[data-act="minimap"]');
      await page!.until(`!document.querySelector('#vw-mini').hidden`);
    });

    it('then there’s no rail, as it goes with the minimap.', () => {
      assert.equal(off, 'no rail');
    });

    it('then the outline is a column at the page’s right.', () => {
      assert.equal(opened, 'code 828px, outline 300px, to the page’s edge');
    });
  });

  describe('when the Tests view opens, and the pointer rests on its rail, ', () => {
    let atRest = '';
    let rows = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file') && !document.querySelector('#vw-rail').hidden && !!document.querySelector('#vw-rail i[style]')`);
      atRest = await read(page!, `document.querySelector('.fv-here').textContent + ' | ' + ${railRead} + ' | ' + ${rightRead}`);
      await page!.hover('#vw-rail', { scroll: false });
      await page!.until(`document.querySelector('#viewer').classList.contains('co-open')`);
      rows = await read(page!, outlineRead);
      await page!.hover('.fv-head .crumbs', { scroll: false });
      await page!.until(`!document.querySelector('#viewer').classList.contains('co-open')`);
    });

    it('then a minimap shows the page small with the rail on its edge, and the header reads the first test file.', () => {
      assert.equal(atRest, 'Reading ledger_test.dart · 1 of 2 | at ·, top to bottom, on the minimap’s edge | code 1052px, minimap 64px, rail 12px, to the page’s edge');
    });

    it('then the outline lists its test files by package.', () => {
      assert.equal(rows, [
        '# packages/core · 1',
        '> • ledger_test.dart (4 new) 6',
        '# The repository’s package · 1',
        '  • discount_test.dart (6 new) 8',
      ].join('\n'));
    });
  });

  describe('when the page is a phone’s, and the header’s Reading is tapped, then the last test file’s row, ', () => {
    let sheet = '';
    let went = '';

    before(async () => {
      await rest(page!);
      await openChain();
      await page!.phone(390, 844);
      await page!.until(`getComputedStyle(document.querySelector('.fv-here')).display !== 'none'`);
      await page!.click('.fv-here');
      await page!.until(`document.querySelector('#viewer').classList.contains('co-open') && getComputedStyle(document.querySelector('#vw-shade')).opacity === '1'`);
      sheet = await read(page!, `(() => { const r = document.querySelector('#vw-ol').getBoundingClientRect(); return Math.round(r.left) + '–' + Math.round(r.right) + ' of ' + innerWidth + ', ' + (getComputedStyle(document.querySelector('#vw-shade')).opacity === '1' ? 'over a shade' : 'no shade'); })()`);
      await page!.click('#vw-ol .co-r[data-key^="olf:"]:last-of-type');
      await page!.until(`!document.querySelector('#viewer').classList.contains('co-open')`);
      went = await read(page!, `(() => { const el = [...document.querySelectorAll('.ol-sec[data-olf]')].pop(); const r = el.getBoundingClientRect(); return el.dataset.olf + ' at ' + (r.top >= 0 && r.top < innerHeight / 2 ? 'the top' : Math.round(r.top) + 'px'); })()`);
      await page!.setViewport(1400, 900);
    });

    it('then the outline opens as a sheet from the right, over a shade.', () => {
      assert.equal(sheet, '55–390 of 390, over a shade');
    });

    it('then the sheet closes and the page goes to the test file.', () => {
      assert.equal(went, 'test/discount_test.dart at the top');
    });
  });
});
