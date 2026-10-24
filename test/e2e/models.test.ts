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
const invoice = 'lib/src/models/invoice.spy.yaml';
const ledger = 'lib/src/models/ledger.spy.yaml';
const thing = 'test/sample_test_server/lib/src/models/thing.spy.yaml';
const generated = (cls: string, fields: string[]) => `abstract class ${cls} {\n  ${cls}({${fields.map((f) => `required this.${f.split(' ')[1]}`).join(', ')}});\n${fields.map((f) => `  ${f};\n`).join('')}}\n`;
const card = (file: string) => `.md-card[data-model="${file}"]`;

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

  describe('when the model’s mark is clicked, ', () => {
    before(async () => {
      await page.eval(`document.querySelector('#vw-main').scrollTop = 0`);
      await page.click(`${card(invoice)} .md-tick`);
      await page.until(`document.querySelector('${card(invoice)}').classList.contains('fold')`);
    });

    it('then it folds to its line, with what changed in short, and the row counts one left.', async () => {
      assert.equal(await read(page, `document.querySelector('${card(invoice)} .md-sum').textContent`), '+ currency');
      assert.equal(await read(page, `document.querySelector('[data-act="models-open"] .cnt').textContent`), '1');
    });
  });

  describe('when the test package is opened, then its model, ', () => {
    before(async () => {
      await page.click('.md-tg');
      await page.until(`!!document.querySelector('${card(thing)}')`);
      await page.click(`${card(thing)} .md-open`);
      await page.until(`!document.querySelector('${card(thing)}').classList.contains('fold')`);
    });

    it('then it shows its diff with no warning.', async () => {
      assert.equal(await read(page, `document.querySelectorAll('${card(thing)} .md-w').length`), '0');
      assert.equal(await read(page, `document.querySelectorAll('${card(thing)} .code .ln.add').length`), '1');
    });
  });
});
