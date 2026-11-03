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
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const was = 'lib/payments/money_movement_engine.dart', now = 'lib/payments/movement/engine.dart';
const engine = (op: string) => [
  'int helper() => 2;',
  '',
  ...Array.from({ length: 8 }, (_, i) => `int f${i}(int x) => x + ${i};\n`),
  'int total(int x) {',
  `  return helper() ${op} x;`,
  '}',
  '',
].join('\n');
const removed = engine('+').split('\n').indexOf('  return helper() + x;') + 1;
// The header's crumbs and facts, and the changed lines of the code under it.
const shown = `[document.querySelector('.fv-head .crumbs').textContent, document.querySelector('.fv-head .facts').textContent, ...[...document.querySelectorAll('.vw-main .code .ln.del, .vw-main .code .ln.add')].map((r) => (r.classList.contains('del') ? '- ' : '+ ') + r.querySelector('.tx').textContent)]`;

describe('Given a served review whose branch moves a Dart file and changes a call in it, and moves another as it was, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write(was, engine('+'));
    repo.write('lib/payments/rolling_text.dart', 'int rolling() => 1;\n');
    repo.commit({ subject: 'Start', author: ada('2020-08-01T15:00:00Z'), committer: ada('2020-08-01T15:00:00Z') });
    repo.branch('feature');
    repo.delete(was);
    repo.write(now, engine('*'));
    repo.delete('lib/payments/rolling_text.dart');
    repo.write('lib/common/rolling_text.dart', 'int rolling() => 1;\n');
    repo.commit({ subject: 'Move the engine', author: ada('2020-08-02T15:00:00Z'), committer: ada('2020-08-02T15:00:00Z') });
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

  it(
    'when the Files tab is opened, '
    + 'then each moved file is one row at its new path, saying where it came from, and its old path has none.',
    async () => {
      await page!.click('[data-tab="files"]');
      await page!.until(`!!document.querySelector('.vw-side [data-open="${now}"]')`);
      assert.deepEqual(await page!.eval(`[...document.querySelectorAll('.vw-side .sb-row.tr[data-open]')].map((r) => r.title)`), [
        'lib/common/rolling_text.dart: moved from lib/payments/rolling_text.dart, no changes',
        `${now}: moved from ${was}, 1 change`,
      ]);
    },
  );

  it(
    'when the file moved with a change opens, '
    + 'then its header says where it came from, and its code shows only the line that changed.',
    async () => {
      await page!.click(`.vw-side [data-open="${now}"]`);
      await page!.until(`(document.querySelector('.fv-head .crumbs') || {}).textContent?.includes('engine.dart')`);
      assert.deepEqual(await page!.eval(shown), ['Files/lib/payments/movement/engine.dart', '1 change · +1 −1 · Moved from payments/money_movement_engine.dart', '-   return helper() + x;', '+   return helper() * x;']);
    },
  );

  it(
    'when the helper the removed line calls is clicked, '
    + 'then the peek shows it where the base has it, at the file’s old path.',
    async () => {
      await page!.click(`.vw-main .ref[data-o="${removed}"][data-col="9"]`);
      await page!.until(`!!document.querySelector('.peek .pk-loc')`);
      assert.equal(await read(page!, `document.querySelector('.peek .pk-loc').textContent`), `${was}:1`);
    },
  );

  it(
    'when the file before these changes is opened from the header’s menu, '
    + 'then it’s the old path, with the removed line marked.',
    async () => {
      await page!.click('[data-act="close-peek"]');
      await page!.click('.fv-head [data-menu="view"]');
      await page!.until(`[...document.querySelectorAll('.menu [role="menuitem"], .menu button')].some((b) => b.textContent.includes('The file before these changes'))`);
      await page!.eval(`[...document.querySelectorAll('.menu [role="menuitem"], .menu button')].find((b) => b.textContent.includes('The file before these changes')).click()`);
      await page!.until(`!!document.querySelector('.code.src .ln')`);
      assert.deepEqual(await page!.eval(`[document.querySelector('.fv-head .crumbs').textContent, [...document.querySelectorAll('.code.src .ln.del')].map((r) => r.dataset.n + ' ' + r.querySelector('.tx').textContent.trim())]`), [`Files/${was}`, [`${removed} return helper() + x;`]]);
    },
  );

  it(
    'when Jump to is asked for the moved file’s old name, '
    + 'then it lists the file at its new path, saying it moved from there.',
    async () => {
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      await page!.type('money_movement');
      await page!.until(`[...document.querySelectorAll('.pal-r')].some((r) => r.textContent.includes('engine.dart'))`);
      const row = await page!.eval(`(() => { const r = [...document.querySelectorAll('.pal-r')].find((x) => x.textContent.includes('engine.dart')); return [r.querySelector('.nm').textContent, r.querySelector('.hint').textContent]; })()`);
      await page!.key('Escape');
      assert.deepEqual(row, [now, 'moved from money_movement_engine.dart']);
    },
  );

  it(
    'when the file moved as it was opens, '
    + 'then its header and the page say so, with nothing to review.',
    async () => {
      await page!.click('.vw-side [data-open="lib/common/rolling_text.dart"]');
      await page!.until(`!!document.querySelector('.vw-main > .empty, .vw-main .empty')`);
      assert.deepEqual(await page!.eval(`[document.querySelector('.fv-head .facts').textContent, document.querySelector('.vw-main .empty').textContent]`), [
        'no changes · Moved from lib/payments/rolling_text.dart',
        'The file moved here from lib/payments/rolling_text.dart as it was.',
      ]);
    },
  );
});
