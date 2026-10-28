import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest, waitForSave } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const pads = '  print(0);\n'.repeat(20);

const beforeApp = [
  'void greet() {',
  "  print('hi');",
  '}',
  '',
  'void gone() {',
  "  print('bye');",
  '}',
  '',
  'void one() {',
  "  print('hi');",
  '}',
  '',
  'void two() {',
  "  print('hi');",
  '}',
  '',
  'void main() {',
  "  var name = 'a';",
  '  print(name);',
  pads.trimEnd(),
  '  print(name);',
  '}',
  '',
].join('\n');

const afterApp = [
  'void one() {',
  "  print('hello');",
  '}',
  '',
  'void two() {',
  "  print('hello');",
  '}',
  '',
  'void main() {',
  "  var title = 'a';",
  '  print(title);',
  pads.trimEnd(),
  '  print(title);',
  '}',
  '',
].join('\n');

const beforeTest = [
  'void helper(String name) {',
  '  print(name);',
  '}',
  '',
  'void main() {',
  "  group('names', () {",
  "    test('one', () {",
  "      helper('a');",
  '    });',
  '  });',
  '}',
  '',
].join('\n');

const afterTest = [
  'void helper(String title) {',
  '  print(title);',
  '}',
  '',
  'void main() {',
  "  group('names', () {",
  "    test('one', () {",
  "      helper('b');",
  '    });',
  '  });',
  '}',
  '',
].join('\n');

const beforeUsed = "void used(String name) {\n  print(name);\n}\n\nvoid caller() {\n  used('z');\n}\n";
const afterUsed = "void used(String title) {\n  print(title);\n}\n\nvoid caller() {\n  used('y');\n}\n";

async function openChain(page: Browser, name: string): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}\n${await read(page, `document.querySelector('#vw-side')?.textContent ?? ''`)}`);
  await page.click(`[data-chain="${id}"]`);
  await page.until(`!!document.querySelector('.fv-head')`);
}

describe('Given a served review of a moved function, a deletion, a repeated edit, a local rename, a test and a generated file, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient | undefined;
  let cache = '';
  let url = '';

  before(async () => {
    const author = ada('2020-03-01T15:00:00Z');
    const later = ada('2020-03-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', beforeApp);
    repo.write('lib/app.g.dart', 'const generated = 1;\n');
    repo.write('test/app_test.dart', beforeTest);
    repo.write('lib/c.dart', beforeUsed);
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a.dart', afterApp);
    repo.write('lib/b.dart', "void greet() {\n  print('hello');\n}\n");
    repo.write('lib/app.g.dart', 'const generated = 2;\n');
    repo.write('test/app_test.dart', afterTest);
    repo.write('lib/c.dart', afterUsed);
    repo.commit({ subject: 'Change', author: later, committer: later });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    url = run.url;
    client = reviewClient(url);
    await waitForReview(client);
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openFile(file: string): Promise<void> {
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector(${JSON.stringify(`[data-open="${file}"]`)})`);
    await page!.click(`[data-open="${file}"]`);
    await page!.until(`!!document.querySelector(${JSON.stringify(`.code[data-p="${file}"]`)})`);
  }

  // The page is reloaded first: a save it still had waiting lands before the reset, not after.
  async function startOver(layout: 'unified' | 'split'): Promise<void> {
    await page!.goto(url);
    await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout, showReviewedDiff: false } });
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
  }

  /** Each header's parts: its name, its counts and its buttons, apart. */
  const headerParts = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].map((head) => [...head.querySelectorAll(':scope > b, :scope > span:not(.sp):not(.hov):not(.bdgs), :scope > .hov > *, :scope > .bdgs > *')].map((part) => (part.textContent || '').trim()).filter(Boolean).join(' | ')).join('\\n')`;

  describe('when the old file is opened, ', () => {
    let moved: string;

    before(async () => {
      await rest(page!);
      await openFile('lib/a.dart');
      moved = await read(page!, `document.querySelector('.mv-away')?.textContent ?? ''`);
    });

    it('then the removed copy points at where the function moved.', () => {
      assert.equal(moved, '↦4 lines moved to b.dart:1, with 1 change · Old lines 1–4');
    });
  });

  describe('when the moved function is shown side by side, ', () => {
    let head: string;
    let rows: string;

    before(async () => {
      await rest(page!);
      await startOver('split');
      await openFile('lib/b.dart');
      await page!.until(`!!document.querySelector('.mv-head')`);
      head = await read(page!, headerParts('.mv-head'));
      rows = await read(page!, `[...document.querySelectorAll('.code[data-p="lib/b.dart"] .ln:not(.mv-head)')].map((row) => [row.className, row.querySelector('.sg')?.textContent ?? '', row.querySelector('.tx')?.textContent ?? ''].join(' | ')).join('\\n')`);
    });

    after(async () => {
      await startOver('unified');
    });

    it('then its header says where it moved from.', () => {
      assert.equal(head, '↤ | Moved from a.dart:1 · Lines 1–3 · 1 change | same change ×3 | show the moved lines');
    });

    it('then its body\'s diff stays in one column, under that header.', () => {
      assert.equal(rows, [
        'ln mv |  | void greet() {',
        "ln del | − |   print('hi');",
        "ln add | + |   print('hello');",
        'ln mv |  | }',
        'ln del | − | ',
      ].join('\n'));
    });
  });

  describe('when a reviewed deletion is shown side by side, ', () => {
    let gone: string;

    before(async () => {
      await rest(page!);
      await startOver('unified');
      await openFile('lib/a.dart');
      const block = await read(page!, `[...document.querySelectorAll('.code[data-p="lib/a.dart"] .ln.del')].find((row) => (row.textContent || '').includes('void gone() {'))?.querySelector('.tick')?.dataset.block ?? ''`);
      await page!.click(`.tick[data-block="${block}"]`);
      await waitForSave(page!);
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="layout"]')`);
      await page!.click('[data-act="layout"]');
      await waitForSave(page!);
      await page!.until(`!!document.querySelector('.code[data-p="lib/a.dart"] .sl.gone')`);
      gone = await read(page!, `[...document.querySelector('.code[data-p="lib/a.dart"] .sl.gone').querySelectorAll('.tick, .tx, .bdgs')].map((el) => el.matches('.tick') ? 'mark ' + el.getAttribute('aria-pressed') : el.textContent).join(' | ')`);
    });

    after(async () => {
      await startOver('unified');
    });

    it('then the removed lines are one reviewed row.', () => {
      assert.equal(gone, 'mark true | 4 removed lines, reviewed | show diff');
    });
  });

  describe('when the same change is opened, ', () => {
    let head: string;
    let places: string;

    before(async () => {
      await rest(page!);
      await openFile('lib/a.dart');
      await page!.until(`!!document.querySelector('[data-group]')`);
      await page!.click('[data-group]');
      await page!.until(`(document.querySelector('.fv-head')?.textContent || '').includes('Same change')`);
      head = await read(page!, `[document.querySelector('.fv-head .crumbs')?.textContent, document.querySelector('.fv-head .facts')?.textContent].join('\\n')`);
      places = await read(page!, `[...document.querySelectorAll('.code.inst > .inst-file, .code.inst .ln.add')].map((el) => el.matches('.inst-file') ? el.textContent : '  ' + el.dataset.n + ' ' + (el.querySelector('.tx')?.textContent ?? '').trim()).join('\\n')`);
    });

    it('then the header names the change and counts its places.', () => {
      assert.equal(head, "Same change/'hi' → 'hello'\n3 places · 2 files");
    });

    it('then its places are listed by file.', () => {
      assert.equal(places, [
        'lib/a.dart',
        "  2 print('hello');",
        "  6 print('hello');",
        'lib/b.dart',
        "  2 print('hello');",
      ].join('\n'));
    });
  });

  describe('when Not in a chain is opened, ', () => {
    let head: string;
    let changes: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.until(`!!document.querySelector('[data-standalone]')`);
      await page!.click('[data-standalone]');
      await page!.until(`(document.querySelector('.fv-head')?.textContent || '').includes('Not in a chain')`);
      head = await read(page!, `[document.querySelector('.fv-head .crumbs')?.textContent, document.querySelector('.fv-head .facts')?.textContent].join('\\n')`);
      changes = await read(page!, `[...document.querySelectorAll('#vw-main .code[data-p]')].map((code) => code.dataset.p + '\\n' + [...code.querySelectorAll('.ln.add, .ln.del, .mv-away')].map((row) => '  ' + (row.matches('.mv-away') ? row.textContent : (row.matches('.add') ? '+ ' : '− ') + (row.querySelector('.tx')?.textContent ?? ''))).join('\\n')).join('\\n')`);
    });

    it('then its header names it and counts its changes.', () => {
      assert.equal(head, 'Map/Not in a chain\n4 changes · +3 −8');
    });

    it('then the changes outside chains are shown, by file.', () => {
      assert.equal(changes, [
        'lib/a.dart',
        '  ↦4 lines moved to b.dart:1, with 1 change · Old lines 1–4',
        '  − void gone() {',
        "  −   print('bye');",
        '  − }',
        '  − ',
        "  −   print('hi');",
        "  +   print('hello');",
        "  −   print('hi');",
        "  +   print('hello');",
        'lib/b.dart',
        "  −   print('hi');",
        "  +   print('hello');",
        '  − ',
      ].join('\n'));
    });
  });

  describe('when the test chain is opened, ', () => {
    let list: string;

    before(async () => {
      await rest(page!);
      await openChain(page!, 'helper');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      list = await read(page!, `[...document.querySelectorAll('#vw-main .ol-file, #vw-main .ol-row, #vw-main .ol-fold')].map((el) => (el.matches('.ol-row') ? '  '.repeat(Number(el.style.getPropertyValue('--d')) + 1) + el.querySelector('.ol-tt').textContent.trim() + [...el.querySelectorAll('.ol-tag')].map((tag) => ' [' + tag.textContent.trim() + ']').join('') : el.matches('.ol-file') ? el.querySelector('.nm').textContent + ' · ' + el.querySelector('.n').textContent : el.textContent.trim())).join('\\n')`);
    });

    it('then its test file reads as an outline: the test whose body changed, under its group, then the helper outside the tests.', () => {
      assert.equal(list, [
        'app_test.dart · no sentence changes',
        'Code edited under 1 call whose sentence stays · +1 −1',
        '  names',
        '    one [body +1 −1]',
        'Outside the tests: helper · +2 −2',
      ].join('\n'));
    });
  });

  describe('when the Tests view is opened, ', () => {
    let shown = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file.fold')`);
      shown = await read(page!, `[...document.querySelectorAll('#vw-main .empty, #vw-main .ol-sect, #vw-main .ol-fold, #vw-main .ol-file')].map((el) => el.matches('.ol-file') ? el.querySelector('.nm').textContent + ' · ' + el.querySelector('.n').textContent : el.textContent.trim() + (el.matches('.ol-fold') ? (el.getAttribute('aria-expanded') === 'true' ? ' (open)' : ' (folded)') : '')).join('\\n')`);
    });

    it('then it says no sentence changes, and the files whose tests change only code show already, as they\'re all there is.', () => {
      assert.equal(shown, [
        'No sentence changes in this comparison.',
        'Code under sentences that stay',
        '1 file changes no sentence: 1 call with edited setup or bodies (open)',
        'app_test.dart · 1 call edited · +3 −3',
      ].join('\n'));
    });
  });

  describe('when the test file is marked from its line in the Tests view, ', () => {
    let line = '';
    let rows = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file.fold .ol-tick')`);
      await page!.click('#vw-main .ol-file.fold .ol-tick');
      await page!.until(`!!document.querySelector('#vw-main .ol-file.fold.done')`);
      line = await read(page!, `(() => { const el = document.querySelector('#vw-main .ol-file.fold'); return [el.querySelector('.nm').textContent, el.querySelector('.n').textContent, el.getAttribute('aria-expanded') === 'true' ? 'open' : 'folded', el.querySelector('.ol-tick').title].join(' · '); })()`);
      await page!.click('#vw-main .ol-file.fold .car');
      await page!.until(`!!document.querySelector('#vw-main .ol-row')`);
      rows = await read(page!, `[...document.querySelectorAll('#vw-main .ol-row')].map((el) => '  '.repeat(Number(el.style.getPropertyValue('--d')) + 1) + el.querySelector('.ol-tt').textContent.trim() + (el.classList.contains('done') ? ' (reviewed)' : '')).join('\\n')`);
      await page!.click('#vw-main .ol-file.fold .ol-tick');
      await page!.until(`!document.querySelector('#vw-main .ol-file.fold.done')`);
    });

    it('then its line reads reviewed, still folded.', () => {
      assert.equal(line, 'app_test.dart · 1 call edited · +3 −3 · folded · Mark unreviewed');
    });

    it('then the call whose body it edited reads reviewed once it unfolds.', () => {
      assert.equal(rows, ['  names', '    one (reviewed)'].join('\n'));
    });
  });

  describe('when that file’s name is clicked in the Tests view, ', () => {
    let opened = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file.fold .nm')`);
      await page!.click('#vw-main .ol-file.fold .nm');
      await page!.until(`!document.querySelector('#vw-main .ol-file') && !!document.querySelector('#vw-main .code[data-p="test/app_test.dart"] .ln')`);
      opened = await read(page!, `[...document.querySelectorAll('#vw-main .code[data-p="test/app_test.dart"] .ln.add, #vw-main .code[data-p="test/app_test.dart"] .ln.del')].map((row) => (row.matches('.add') ? '+ ' : '- ') + row.querySelector('.tx').textContent.trim()).join('\\n')`);
    });

    it('then the file opens on its diff.', () => {
      assert.equal(opened, [
        '- void helper(String name) {',
        '- print(name);',
        '+ void helper(String title) {',
        '+ print(title);',
        "- helper('a');",
        "+ helper('b');",
      ].join('\n'));
    });
  });

  describe('when the generated file is opened, ', () => {
    let facts: string;
    let rows: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="files"]');
      await page!.click('[data-section="generated"]');
      await page!.until(`!!document.querySelector('[data-open="lib/app.g.dart"]')`);
      await page!.click('[data-open="lib/app.g.dart"]');
      await page!.until(`(document.querySelector('.code')?.textContent || '').includes('generated = 2')`);
      facts = await read(page!, `document.querySelector('.fv-head .facts')?.textContent ?? ''`);
      rows = await read(page!, `[...document.querySelectorAll('.code .ln')].map((row) => [row.querySelector('.sg')?.textContent ?? '', row.querySelector('.no')?.textContent ?? '', row.querySelector('.tx')?.textContent ?? ''].join(' ')).join('\\n')`);
    });

    it('then its header says it is generated, and by which adapter.', () => {
      assert.equal(facts, 'Generated (build_runner adapter) · +1 −1');
    });

    it('then its changed lines are shown for reference.', () => {
      assert.equal(rows, '− 1 const generated = 1;\n+ 1 const generated = 2;');
    });
  });

  describe('when the generated file is shown side by side, ', () => {
    let rows: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="layout"]')`);
      await page!.click('[data-act="layout"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.g.dart"] > .sl')`);
      rows = await read(page!, `[...document.querySelectorAll('.code[data-p="lib/app.g.dart"] > .ln, .code[data-p="lib/app.g.dart"] > .sl')].map((row) => row.matches('.ln') ? 'unified: ' + row.textContent : [...row.querySelectorAll('.half')].map((half) => [half.querySelector('.sg')?.textContent ?? '', half.querySelector('.no')?.textContent ?? '', half.querySelector('.tx')?.textContent ?? ''].join(' ')).join(' | ')).join('\\n')`);
    });

    after(async () => {
      await rest(page!);
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="layout"]')`);
      await page!.click('[data-act="layout"]');
      await page!.until(`!document.querySelector('.code > .sl')`);
    });

    it('then its removed line is on the left, beside the line that replaced it.', () => {
      assert.equal(rows, '− 1 const generated = 1; | + 1 const generated = 2;');
    });
  });

  describe('when the chain scrolls past its graph and the graph\'s button is clicked, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await openChain(page!, 'used');
      await page!.setViewport(1400, 360);
      await page!.until(`!!document.querySelector('.fv-head [data-act="graph"]')`);
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); main.scrollTop = main.scrollHeight; })()`);
      await page!.until(`document.querySelector('.fv-head [data-act="graph"]').getAttribute('aria-pressed') === 'false'`);
      await page!.click('.fv-head [data-act="graph"]', { scroll: false });
      await page!.until(`!document.querySelector('.gd').hidden`);
      shown = await read(page!, `[document.querySelector('.graph-box') ? 'in the page' : 'gone', document.querySelector('.gd .graph') ? 'dropped' : 'not dropped'].join(' · ')`);
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then the graph, still in the page at the top, drops over the code from the header.', () => {
      assert.equal(shown, 'in the page · dropped');
    });
  });

  describe('when the right arrow is pressed on the sidebar splitter, ', () => {
    let widths: string;

    before(async () => {
      await rest(page!);
      const beforeWidth = await read(page!, `document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''`);
      await page!.eval(`document.querySelector('#vw-split').focus()`);
      await page!.key('ArrowRight');
      const afterWidth = await read(page!, `document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''`);
      widths = `${beforeWidth}\n${afterWidth}`;
    });

    it('then the sidebar grows by 16 pixels.', () => {
      const [beforeWidth, afterWidth] = widths.split('\n').map(Number);
      assert.equal(afterWidth - beforeWidth, 16);
    });
  });
});
