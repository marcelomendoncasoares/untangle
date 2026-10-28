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
import { read, rest } from './page.ts';

const skip = e2eSkip();
const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-09-01T15:00:00Z' };
const invoice = 'lib/src/models/invoice.spy.yaml';
const ledger = 'lib/src/models/ledger.spy.yaml';
const thing = 'test/sample_test_server/lib/src/models/thing.spy.yaml';
const generated = (cls: string, fields: string[]) => `abstract class ${cls} {\n  ${cls}({${fields.map((f) => `required this.${f.split(' ')[1]}`).join(', ')}});\n${fields.map((f) => `  ${f};\n`).join('')}}\n`;
const card = (file: string) => `.md-card[data-model="${file}"]`;
// The Files tab's rows, folders ending in a slash, each saying whether it's faded or reviewed.
const fileRows = `[...document.querySelectorAll('.sb-row.tr')].map((r) => (r.dataset.open || r.dataset.dir + '/') + (r.classList.contains('chain-out') ? ' (faded)' : '') + (r.classList.contains('done') ? ' (reviewed)' : '')).join('\\n')`;
const filesCount = `document.querySelector('.sb-group.fs > span + span').textContent`;
// The Models view's outline: its packages (#), and its models, the lit one first (>).
const outline = `[...document.querySelectorAll('.md-ol > *')].map((e) => e.matches('.md-ol-p') ? '# ' + [...e.children].map((c) => c.textContent).join(' ')
  : (e.getAttribute('aria-current') === 'true' ? '> ' : '') + e.querySelector('.nm').textContent + (e.classList.contains('s-a') ? ' (new)' : e.classList.contains('s-d') ? ' (removed)' : '')
    + (e.classList.contains('done') ? ' (reviewed)' : '') + (e.querySelector('.cnt svg') ? ' (warning)' : '')).join('\\n')`;
const lit = `[...document.querySelectorAll('.md-ol [aria-current="true"]')].map((r) => r.textContent).join(', ')`;

describe('Given a review that changes a model and its migration, adds a long one and changes a test package’s, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write(invoice, 'class: Invoice\ntable: invoices\nfields:\n  amount: int\n');
    repo.write('lib/src/generated/invoice.dart', generated('Invoice', ['int amount']));
    repo.write('lib/src/generated/protocol.dart', "const models = [\n  'Invoice',\n];\n");
    repo.write('migrations/20240101000000/migration.json', JSON.stringify({ actions: [{ type: 'createTable', createTable: { name: 'invoices' } }], warnings: [] }));
    repo.write('test/sample_test_server/pubspec.yaml', 'name: sample_test_server\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n');
    repo.write(thing, 'class: Thing\nfields:\n  name: String\n');
    repo.write('lib/src/greeting.dart', "String greet() => 'hi';\n");
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write(invoice, 'class: Invoice\ntable: invoices\nfields:\n  amount: int\n  currency: String\n');
    repo.write('lib/src/generated/invoice.dart', generated('Invoice', ['int amount', 'String currency']));
    repo.write(ledger, `class: Ledger\nfields:\n${Array.from({ length: 60 }, (_, i) => `  entry${i}: int?\n`).join('')}`);
    repo.write('lib/src/generated/ledger.dart', generated('Ledger', ['int? entry0']));
    repo.write('lib/src/generated/protocol.dart', "const models = [\n  'Invoice',\n  'Ledger',\n];\n");
    repo.write('migrations/20240201000000/migration.json', JSON.stringify({ actions: [{ type: 'alterTable', alterTable: { name: 'invoices' } }], warnings: [] }));
    repo.write('migrations/20240201000000/migration.sql', 'BEGIN;\n\n--\n-- ACTION ALTER TABLE\n--\nALTER TABLE "invoices" ADD COLUMN "currency" text NOT NULL;\n\n--\n-- MIGRATION VERSION FOR sample\n--\nINSERT INTO "serverpod_migrations" VALUES (1);\n\nCOMMIT;\n');
    repo.write(thing, 'class: Thing\nfields:\n  name: String\n  scopeId: int\n');
    repo.write('lib/src/greeting.dart', "String greet() => 'hello';\n");
    repo.commit({ subject: 'Add a currency and a ledger', author, committer: author });
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

  describe('when Models is opened from the Chains tab, ', () => {
    before(async () => {
      await page.click('[data-act="models-open"]');
      await page.until(`!!document.querySelector('.md-card')`);
    });

    it('then its row counts the two models outside test packages.', async () => {
      assert.equal(await read(page, `document.querySelector('[data-act="models-open"] .cnt').textContent`), '2');
    });

    it('then the header says what changed, with the warning and the test package’s model apart.', async () => {
      assert.equal(await read(page, `document.querySelector('.fv-head .facts').textContent`), '2 models changed · 1 with a warning · 1 model in test packages, folded');
    });

    it('then the required field’s warning sits under its line, and that line is marked.', async () => {
      assert.match(await read(page, `document.querySelector('${card(invoice)} .code .md-w').textContent`), /^Required, with no default: Invoice data from before this change has no currency, and won’t deserialize\.$/);
      assert.equal(await read(page, `document.querySelector('${card(invoice)} .ln.md-wl').dataset.n`), '5');
    });

    it('then the model links its migration and its generated file.', async () => {
      assert.equal(await read(page, `[...document.querySelectorAll('${card(invoice)} .md-links .md-pk')].map((b) => b.textContent).join(' ')`), '20240201000000 invoice.dart');
    });

    it('then the test package folds into one line, outside the count.', async () => {
      assert.equal(await read(page, `document.querySelector('.md-tg').textContent`), '1 model, folded: Thing, + scopeIdOpen');
    });
  });

  describe('when the long model’s hunk is folded, then opened again, ', () => {
    const at = `document.querySelector('${card(ledger)} .hh .hh-at').textContent`;
    const fold = `${card(ledger)} .hh [data-act="toggle-hunk"]`;
    let open = '';
    let first = '';
    let folded = '';

    before(async () => {
      open = await read(page, at);
      first = await read(page, `document.querySelector('${card(ledger)} .ln .no').textContent`);
      await page.click(fold);
      await page.until(`document.querySelector('${fold}').getAttribute('aria-expanded') === 'false'`);
      folded = await read(page, at);
      await page.click(fold);
      await page.until(`document.querySelector('${fold}').getAttribute('aria-expanded') === 'true'`);
    });

    it('then its divider says the line it starts at only while it’s folded: open, its first row says it.', () => {
      assert.deepEqual({ open, first, folded }, { open: '', first: '1', folded: '1' });
    });
  });

  describe('when the migration is opened, ', () => {
    before(async () => {
      await page.click(`${card(invoice)} [data-kind="mig"]`);
      await page.until(`!!document.querySelector('${card(invoice)} .peek .pk-ln')`);
    });

    after(async () => {
      await page.click('[data-act="close-peek"]');
    });

    it('then a peek in the card shows the table’s statements, with the column the model adds marked.', async () => {
      assert.equal(await read(page, `[...document.querySelectorAll('${card(invoice)} .peek .pk-ln')].map((r) => r.querySelectorAll('.no')[1].textContent + (r.classList.contains('hit') ? '*' : '')).join(' ')`), '3 4 5 6*');
    });
  });

  describe('when the long model’s diff is scrolled to its middle, ', () => {
    let gap: number;

    before(async () => {
      gap = Number(await page.eval(`(() => {
        const main = document.querySelector('#vw-main'), c = document.querySelector('${card(ledger)}');
        main.scrollTop += c.getBoundingClientRect().top - main.getBoundingClientRect().top + c.offsetHeight / 2;
        const head = document.querySelector('.fv-head').getBoundingClientRect().bottom;
        return Math.round(c.querySelector('.md-h').getBoundingClientRect().top - head);
      })()`));
    });

    it('then its line stays right under the view’s header.', () => {
      assert.ok(Math.abs(gap) <= 1, `the model's line is ${gap}px from the header`);
    });
  });

  describe('when the model’s mark is clicked, with motion on, ', () => {
    let moving = '';

    before(async () => {
      await page.eval(`document.querySelector('#vw-main').scrollTop = 0`);
      await page.reducedMotion(false);
      await page.click(`${card(invoice)} .md-tick`);
      moving = await read(page, `(() => {
        const ghost = document.querySelector('${card(invoice)} > .ghost'), marks = ghost ? ghost.querySelectorAll('.tick.on').length : 0;
        return [ghost && ghost.previousElementSibling.matches('.md-h') && ghost.querySelector('.md-diff') ? 'its diff closing under its line' : 'no stand-in', marks + ' mark' + (marks === 1 ? '' : 's') + ' on in it'].join(', ');
      })()`);
      await page.until(`!document.querySelector('#vw-main .ghost') && !document.querySelector('${card(invoice)}').classList.contains('easing')`);
      await page.reducedMotion(true);
    });

    it('then its diff settles as reviewed and closes into its line.', () => {
      assert.equal(moving, 'its diff closing under its line, 1 mark on in it');
    });

    it('then it folds to its line, with what changed in short, and the row counts one left.', async () => {
      assert.equal(await read(page, `document.querySelector('${card(invoice)}').className`), 'md-card fold done');
      assert.equal(await read(page, `document.querySelector('${card(invoice)} .md-sum').textContent`), '+ currency');
      assert.equal(await read(page, `document.querySelector('[data-act="models-open"] .cnt').textContent`), '1');
    });
  });

  describe('when its line is clicked, with motion on, ', () => {
    let moving = '';

    before(async () => {
      await page.reducedMotion(false);
      await page.click(`${card(invoice)} .md-open`);
      moving = await read(page, `(() => { const grow = document.querySelector('${card(invoice)} > .grow'); return grow && grow.previousElementSibling.matches('.md-h') && grow.querySelector('.md-diff') ? 'its diff opening under its line' : 'no motion'; })()`);
      await page.until(`!document.querySelector('#vw-main .grow') && !document.querySelector('${card(invoice)}').classList.contains('easing')`);
      await page.reducedMotion(true);
    });

    it('then its diff opens down from its line.', async () => {
      assert.equal(moving, 'its diff opening under its line');
      assert.equal(await read(page, `document.querySelector('${card(invoice)}').className`), 'md-card done');
    });
  });

  describe('when the test package is opened, with motion on, then its model, ', () => {
    let moving = '';

    before(async () => {
      await page.reducedMotion(false);
      await page.click('.md-tg');
      moving = await read(page, `(() => { const grow = document.querySelector('.md-tg + .grow'); return grow && grow.querySelector('${card(thing)}') ? 'its models opening under its line' : 'no motion'; })()`);
      await page.until(`!!document.querySelector('${card(thing)}') && !document.querySelector('#vw-main .grow')`);
      await page.reducedMotion(true);
      await page.click(`${card(thing)} .md-open`);
      await page.until(`!document.querySelector('${card(thing)}').classList.contains('fold')`);
    });

    it('then its models open down from its line.', () => {
      assert.equal(moving, 'its models opening under its line');
    });

    it('then it shows its diff with no warning.', async () => {
      assert.equal(await read(page, `document.querySelectorAll('${card(thing)} .md-w').length`), '0');
      assert.equal(await read(page, `document.querySelectorAll('${card(thing)} .code .ln.add').length`), '1');
    });
  });

  describe('when the Files tab is shown with Models open, ', () => {
    let rows = '';

    before(async () => {
      await page.click('[data-tab="files"]');
      await page.until(`!!document.querySelector('.sb-row.tr[data-open]')`);
      rows = await read(page, fileRows);
    });

    it('then only the models, and the folders that hold them, stand out: the other files fade.', () => {
      assert.equal(rows, [
        'lib/src/',
        'lib/src/models/',
        `${invoice} (reviewed)`,
        `${ledger}`,
        'lib/src/greeting.dart (faded)',
        'test/sample_test_server/lib/src/models/',
        `${thing}`,
      ].join('\n'));
    });
  });

  describe('when the filter is turned on, with Models open, ', () => {
    let rows = '';
    let count = '';
    let says = '';

    before(async () => {
      await page.click('[data-act="files-hide"]');
      await page.until(`document.querySelector('[data-act="files-hide"]').getAttribute('aria-pressed') === 'true'`);
      rows = await read(page, fileRows);
      count = await read(page, filesCount);
      says = await read(page, `document.querySelector('[data-act="files-hide"]').title`);
    });

    it('then the files that faded are hidden, and the count says how many show.', () => {
      assert.equal(rows, ['lib/src/models/', `${invoice} (reviewed)`, ledger, 'test/sample_test_server/lib/src/models/', thing].join('\n'));
      assert.equal(count, '3 of 4 files · +64 −0');
    });

    it('then the filter says, under the pointer, that it shows only the files of the selected view.', () => {
      assert.equal(says, 'Show only the files of the selected view');
    });
  });

  describe('when the page is opened again, on Models, ', () => {
    let rows = '';

    before(async () => {
      await rest(page);
      await page.goto(run.url);
      await page.until(`!!document.querySelector('.t-head')`, 30_000);
      await page.click('[data-tab="chains"]');
      await page.click('[data-act="models-open"]');
      await page.until(`!!document.querySelector('.md-ol [aria-current="true"]')`);
      rows = await read(page, outline);
    });

    it('then an outline beside the cards lists the models the page shows, by package, the first one lit.', () => {
      assert.equal(rows, ['# The repository’s package', '> Invoice (reviewed) (warning)', 'Ledger (new)', '# test/sample_test_server test package', 'Thing'].join('\n'));
    });
  });

  describe('when the long model is clicked in the outline, ', () => {
    let gap = 0;
    let on = '';

    before(async () => {
      await page.click(`.md-ol [data-model="${ledger}"]`);
      await page.until(`document.querySelector('.md-ol [data-model="${ledger}"]').getAttribute('aria-current') === 'true'`);
      // Landed: the card is set in its place again over the next frames.
      await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))))');
      gap = Number(await page.eval(`Math.round(document.querySelector('${card(ledger)}').getBoundingClientRect().top - document.querySelector('.fv-head').getBoundingClientRect().bottom)`));
      on = await read(page, lit);
    });

    it('then its card comes up under the view’s header, and its row alone is lit.', () => {
      assert.ok(Math.abs(gap - 10) <= 1, `the card is ${gap}px under the header`);
      assert.equal(on, 'Ledger');
    });
  });

  describe('when the page is scrolled back to its top by hand, ', () => {
    let on = '';

    before(async () => {
      await page.eval(`(() => { const main = document.querySelector('#vw-main'); main.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); main.scrollTop = 0; })()`);
      await page.until(`document.querySelector('.md-ol [data-model="${invoice}"]').getAttribute('aria-current') === 'true'`);
      on = await read(page, lit);
    });

    it('then the model at the top is lit instead.', () => {
      assert.equal(on, 'Invoice');
    });
  });

  describe('when the test package’s model is clicked in the outline, ', () => {
    let seen = '';

    before(async () => {
      await page.click(`.md-ol [data-model="${thing}"]`);
      await page.until(`!!document.querySelector('${card(thing)} .md-diff')`);
      seen = await read(page, `(() => {
        const r = document.querySelector('${card(thing)}').getBoundingClientRect(), m = document.querySelector('#vw-main').getBoundingClientRect();
        return (r.top >= m.top && r.bottom <= m.bottom ? 'in view' : 'out of view') + ', lit: ' + ${lit};
      })()`);
    });

    it('then its package opens on it, in view, and its row stays lit though the page ends before its card reaches the top.', () => {
      assert.equal(seen, 'in view, lit: Thing');
    });
  });

  describe('when New is chosen above the cards, ', () => {
    let rows = '';

    before(async () => {
      await page.click('[data-act="models-filter"][data-v="new"]');
      await page.until(`document.querySelectorAll('.md-ol .sb-row').length === 1`);
      rows = await read(page, outline);
    });

    after(async () => {
      await page.click('[data-act="models-filter"][data-v="all"]');
    });

    it('then the outline lists only the new model, as the page shows it.', () => {
      assert.equal(rows, ['# The repository’s package', '> Ledger (new)'].join('\n'));
    });
  });

  describe('when the window is too narrow for the outline, ', () => {
    let room = '';

    before(async () => {
      await page.setViewport(1000, 900);
      await page.until(`getComputedStyle(document.querySelector('.md-ol')).display === 'none'`);
      room = await read(page, `String(Math.round(document.querySelector('#vw-main').clientWidth - 22 - document.querySelector('.md-cards').getBoundingClientRect().width))`);
    });

    after(async () => {
      await page.setViewport(1400, 900);
    });

    it('then it isn’t there, and the cards take its room.', () => {
      assert.equal(room, '22');
    });
  });
});
