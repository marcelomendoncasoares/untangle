import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

describe('Given a large new invoice class alongside a separate receipt and two tests with the same title, ', { skip: e2eSkip(), timeout: 120_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let browser: Browser;
  let client: ReviewClient;
  let cache: string;
  let invoice: string;
  let suite: string;

  before(async () => {
    const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/existing.dart', 'void main() {}\n');
    repo.write('lib/scenario.dart', 'int scenarioValue() => 0;\n');
    repo.write('test/support.dart', 'void test(String name, void Function() body) {}\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/invoice.dart', `import 'tax.dart';

class Invoice {
  Invoice(this.amount);

  final int amount;

  int total() => Tax().total(amount);

  String label() => 'Invoice: $amount';

${Array.from({ length: 80 }, (_, i) => `  int entry${i}() => amount + ${i};\n`).join('\n')}
}

class Receipt {
  final String label = 'Paid';
}
`);
    repo.write('lib/tax.dart', 'class Tax {\n  int total(int amount) => amount * 2;\n}\n');
    repo.write('lib/scenario.dart', 'int scenarioValue() => 1;\n');
    repo.write('test/scenarios_test.dart', `import '../lib/scenario.dart';
import 'support.dart';

void main() {
  test('The same title', () {
    print('first scenario');
    print(scenarioValue());
  });

  test('The same title', () {
    print('second scenario');
    print(scenarioValue());
  });
}
`);
    repo.commit({ subject: 'Introduce invoicing', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-declarations-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    client = reviewClient(run.url);
    await waitForReview(client);
    browser = await launchBrowser();
    await browser.reducedMotion(true);
    await browser.goto(run.url);
    await browser.until(`!!document.querySelector('[data-chain]')`);
    invoice = await read(browser, `JSON.parse(document.querySelector('#d-model').textContent).compares.base.chains.find(c => c.name === 'Invoice').id`);
    suite = await read(browser, `JSON.parse(document.querySelector('#d-model').textContent).compares.base.chains.find(c => c.name === 'scenarioValue').id`);
  });

  after(async () => {
    await browser?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when its invoice chain is opened, ', () => {
    let code: string;
    let pill: string;
    let sections: number;

    before(async () => {
      await browser.click(`[data-chain="${invoice}"]`);
      await browser.until(`!!document.querySelector('.pill-n')`);
      code = await read(browser, `[...document.querySelectorAll('.sec .code .tx')].map(el => el.textContent).join(' ')`);
      pill = await read(browser, `document.querySelector('.pill-n').textContent`);
      sections = Number(await browser.eval(`document.querySelectorAll('.sec[id^="sec-"]').length`));
    });

    it('then the class is readable in source order within one section.', () => {
      assert.equal(sections, 2);
      const fragments = ['class Invoice', 'Invoice(this.amount)', 'final int amount', 'int total()', 'String label()', 'int entry79()'];
      const positions = fragments.map((fragment) => code.indexOf(fragment));
      assert.ok(positions.every((position) => position >= 0));
      assert.deepEqual(positions, positions.slice().sort((a, b) => a - b));
    });

    it('then the review pill counts each complete class once.', () => {
      assert.equal(pill, '1 of 2');
    });
  });

  describe('when the large class is folded manually, ', () => {
    let pill: string;
    let clicked: string;

    before(async () => {
      await browser.click(`[data-chain="${invoice}"]`);
      await browser.click('.sec [data-act="toggle-hunk"]');
      pill = await read(browser, `document.querySelector('.pill-n').textContent`);
      await browser.click('.hh[data-nav] .hh-at');
      clicked = await read(browser, `(document.querySelector('#vw-main .empty')?.textContent || document.querySelectorAll('.sec[id^="sec-"]').length + ' sections') + ', ' + (document.querySelector('.sec [data-act="toggle-hunk"]').getAttribute('aria-expanded') === 'true' ? 'unfolded' : 'folded')`);
      await browser.click(`[data-chain="${invoice}"]`);
    });

    it('then the folded class still counts as one task.', () => {
      assert.equal(pill, '1 of 2');
    });

    it('then a click on its divider, beside its buttons, unfolds it, leaving the chain where it is.', () => {
      assert.equal(clicked, '2 sections, unfolded');
    });
  });

  describe('when Space reviews the invoice and the page is reloaded, ', () => {
    let marked: boolean[];
    let untouched: boolean[];

    before(async () => {
      await browser.click(`[data-chain="${invoice}"]`);
      const node = await read(browser, `[...document.querySelectorAll('.graph-box g.g-node')].find(el => el.querySelector('.g-l2').textContent === 'Invoice').dataset.node`);
      await browser.click(`.graph-box g.g-node[data-node="${node}"]`);
      await browser.click('.sec-h b');
      const saves = Number(await browser.eval(`performance.getEntriesByType('resource').filter(entry => entry.name.includes('api/state')).length`));
      await browser.key('j');
      await browser.key(' ');
      await browser.until(`document.querySelector('.pill-n')?.textContent === '1 of 1'`);
      await browser.until(`performance.getEntriesByType('resource').filter(entry => entry.name.includes('api/state')).length > ${saves}`);
      await browser.goto(run.url);
      await browser.until(`!!document.querySelector('[data-chain]')`);
      await browser.click(`[data-chain="${invoice}"]`);
      marked = JSON.parse(await read(browser, `(() => {
        const model = JSON.parse(document.querySelector('#d-model').textContent).compares.base;
        const reviewed = new Set(JSON.parse(document.querySelector('#d-config').textContent).state.rev.base);
        const blocks = new Map(model.files.flatMap(file => file.blocks).map(block => [block.id, block]));
        return JSON.stringify(model.units.find(unit => unit.name === 'Invoice').blocks.map(id => blocks.get(id).edits.every(edit => reviewed.has(edit))));
      })()`));
      await browser.click('[data-open="lib/invoice.dart"]');
      untouched = JSON.parse(await read(browser, `(() => {
        const model = JSON.parse(document.querySelector('#d-model').textContent).compares.base;
        const receipt = model.units.find(unit => unit.name === 'Receipt');
        return JSON.stringify([...document.querySelectorAll('.tick[data-block]')].filter(el => receipt.blocks.includes(el.dataset.block)).map(el => el.classList.contains('on')));
      })()`));
    });

    it('then every invoice block stays reviewed after reload.', () => {
      assert.ok(marked.length > 1);
      assert.ok(marked.every(Boolean));
    });

    it('then the receipt remains available for its own review.', () => {
      assert.ok(untouched.length > 0);
      assert.ok(untouched.every((mark) => !mark));
    });
  });

  describe('when the changed function and its new scenarios are opened, ', () => {
    let titles: number;

    before(async () => {
      await browser.click(`[data-chain="${suite}"]`);
      titles = Number(await browser.eval(`[...document.querySelectorAll('.ol-row .ol-tt')].filter(el => el.textContent === 'The same title').length`));
    });

    it('then identical titles remain two separate scenarios.', () => {
      assert.equal(titles, 2);
    });
  });

  describe('when its first scenario is opened on its code, ', () => {
    let pill: string;
    let outside: number;

    before(async () => {
      await browser.click(`[data-chain="${suite}"]`);
      const key = await read(browser, `[...document.querySelectorAll('.ol-row')].find(el => el.querySelector('.ol-tt').textContent === 'The same title').dataset.ol`);
      await browser.click(`.ol-row[data-ol="${key}"]`);
      await browser.until(`!!document.querySelector('.ol-code')`);
      pill = await read(browser, `document.querySelector('.pill-n').textContent`);
      outside = Number(await browser.eval(`[...document.querySelectorAll('.ol-fold')].filter(el => el.textContent.startsWith('Outside the tests')).length`));
      await browser.click(`.ol-row[data-ol="${key}"]`);
    });

    it('then the function, the code outside the tests, and the two scenarios each count once.', () => {
      assert.equal(outside, 1);
      assert.match(pill, /^\d of 4$/);
    });
  });
});
