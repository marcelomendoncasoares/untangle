import { execFileSync } from 'node:child_process';
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
import { contents, read, rest, waitForSave } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

const greetBefore = [
  'void greet() {',
  "  print('hi');",
  '}',
  '',
  'void main() {',
  '  greet();',
  '}',
  '',
  'void wave() {',
  "  print('yo');",
  '}',
  '',
  'void run() {',
  '  wave();',
  '}',
  '',
].join('\n');

const greetAfter = [
  'void greet(String name) {',
  '  print(name);',
  '}',
  '',
  'void main() {',
  "  greet('ada');",
  '}',
  '',
  'void wave(String name) {',
  '  print(name);',
  '}',
  '',
  'void run() {',
  "  wave('ada');",
  '}',
  '',
].join('\n');

const pads = Array.from({ length: 44 }, (_, index) => `// pad ${index + 1}`);
const notesBefore = ['// start', ...pads, ''].join('\n');
const notesAfter = ['// changed', ...pads, ''].join('\n');

const pill = `document.querySelector('.pill-n')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`;
// The greeting's chain reads the members of its file together: the greeting's change, then its call's.
const greetSec = `[...document.querySelectorAll('.sec')].find((el) => (el.querySelector('.sec-h b')?.textContent || '').split(', ')[0] === 'greet')`;
// The chain's own changes: another chain's next to them shows dimmed, as context.
const ownTicks = (sec: string) => `[...(${sec}?.querySelectorAll('.tick[data-block]') ?? [])].filter((t) => !t.closest('.other'))`;
const greetTicks = `${ownTicks(greetSec)}.map((t) => t.getAttribute('aria-pressed')).join(' ')`;
const crumbs = `document.querySelector('.crumbs')?.textContent ?? ''`;
const fits = `(() => { const root = document.documentElement; const box = document.querySelector('#viewer'); return root.scrollWidth <= root.clientWidth && (!box || box.scrollWidth <= box.clientWidth) ? 'fits' : root.scrollWidth + ' > ' + root.clientWidth; })()`;
const tail = `[(document.querySelector('.hh-tail .hh-tx')?.textContent ?? ''), (document.querySelector('.hh-tail .mo')?.textContent ?? '')].join('\\n')`;

async function chain(page: Browser, name: string): Promise<void> {
  await contents(page);
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}`);
  await page.click(`[data-chain="${id}"]`);
  await page.until(`(document.querySelector('.crumbs')?.textContent || '').includes(${JSON.stringify(name)})`);
}

/** Opens Jump to on Everything. A previous jump can leave the list on Symbols. */
async function jump(page: Browser, query: string): Promise<void> {
  await page.key('k', { ctrl: true });
  await page.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
  for (let i = 0; i < 5; i += 1) {
    if (await read(page, `document.querySelector('.pal-scope')?.textContent ?? ''`) === 'Everything') break;
    await page.key('Tab');
  }
  await page.until(`document.querySelector('.pal-scope')?.textContent === 'Everything'`);
  if (!query) return;
  await page.type(query);
  // The language server's symbols redraw the list when they arrive, and rows are numbered by
  // position: wait for them, so the row a scenario reads is still the one it clicks.
  if (query.length >= 2) await page.until(`!(document.querySelector('.pal-wait')?.textContent || '').includes('language server')`);
}

async function openFile(page: Browser, file: string): Promise<void> {
  await contents(page);
  await page.click('[data-tab="files"]');
  await page.until(`!!document.querySelector(${JSON.stringify(`[data-open="${file}"]`)})`);
  await page.click(`[data-open="${file}"]`);
  await page.until(`!!document.querySelector(${JSON.stringify(`.code[data-p="${file}"]`)})`);
}

describe('Given a served review of a greeting and a wave, a 45-line notes file and a generated file, with reduced motion and the language server running, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient | undefined;
  let cache = '';
  let url = '';
  let head = '';

  before(async () => {
    const author = ada('2020-03-01T15:00:00Z');
    const later = ada('2020-03-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', greetBefore);
    repo.write('lib/notes.dart', notesBefore);
    repo.write('lib/app.g.dart', 'const generated = 1;\n');
    repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', greetAfter);
    repo.write('lib/notes.dart', notesAfter);
    repo.write('lib/only/nested/added.dart', 'void addedFile() {}\n');
    repo.write('lib/app.g.dart', 'const generated = 2;\n');
    head = repo.commit({ subject: 'Name the greetings', author: later, committer: later });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    url = run.url;
    client = reviewClient(url);
    await waitForReview(client);
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.until(`document.querySelector('#lsp-dot')?.classList.contains('ready')`, 180_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function fresh(): Promise<void> {
    await page!.eval(`localStorage.setItem('untangle:ui', JSON.stringify({ side: 272, sideOff: false, minimap: true, graph: true, filesList: false }))`);
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
  }

  // The page is reloaded first: a save it still had waiting lands before the reset, not after.
  async function clearMarks(): Promise<void> {
    await page!.goto(url);
    await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [] } });
    await fresh();
  }

  describe('when the greeting chain is opened, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      shown = await read(page!, `[${pill}, document.querySelector('.pill-act')?.textContent ?? '', document.querySelector('.fv-head .strip') ? 'chips' : 'no chips', document.querySelector('.fv-head .fv-here')?.textContent ?? '', document.querySelector('.graph-box') ? 'graph' : 'no graph', document.querySelector('.fv-head [data-act="graph"]')?.getAttribute('aria-pressed') ?? ''].join('\\n')`);
    });

    it('then the pill counts the two changes, the header names the member being read instead of chips, and the graph is open in the page.', () => {
      assert.equal(shown, '1 of 2\nMark and go to the nextSpace\nno chips\nReading greet · 1 of 2\ngraph\ntrue');
    });
  });

  describe('when j lands on the first change, ', () => {
    let landed: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '1'`);
      landed = await read(page!, pill);
    });

    it('then the pill stays on the first change.', () => {
      assert.equal(landed, '1 of 2');
    });
  });

  describe('when j is pressed again, ', () => {
    let next: string;

    before(async () => {
      await fresh();
      await chain(page!, 'greet(name)');
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '1'`);
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '2'`);
      next = await read(page!, pill);
    });

    it('then the pill is on the second change.', () => {
      assert.equal(next, '2 of 2');
    });
  });

  describe('when k is pressed, ', () => {
    let back: string;

    before(async () => {
      await fresh();
      await chain(page!, 'greet(name)');
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '1'`);
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '2'`);
      await page!.key('k');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '1'`);
      back = await read(page!, pill);
    });

    it('then the pill is back on the first change.', () => {
      assert.equal(back, '1 of 2');
    });
  });

  describe('when n is pressed, ', () => {
    let next: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.key('n');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('wave(name)')`);
      next = await read(page!, crumbs);
    });

    it('then the review moves to the wave chain.', () => {
      assert.equal(next, 'Map/wave(name)');
    });
  });

  describe('when p is pressed, ', () => {
    let back: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.key('n');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('wave(name)')`);
      await page!.key('p');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('greet(name)')`);
      back = await read(page!, crumbs);
    });

    it('then the review moves back to the greeting.', () => {
      assert.equal(back, 'Map/greet(name)');
    });
  });

  describe('when ? is pressed, ', () => {
    let listed: string;

    before(async () => {
      await rest(page!);
      await page!.key('?');
      await page!.until(`document.querySelector('.keys') && !document.querySelector('.keys').hidden`);
      listed = await read(page!, `[...document.querySelectorAll('.keys dt')].map((dt) => [...dt.querySelectorAll('kbd')].map((key) => key.textContent).join(' ') + ': ' + (dt.nextElementSibling?.textContent ?? '')).join('\\n')`);
    });

    it('then the keys are listed.', () => {
      assert.equal(listed, [
        'j k: Next and previous change to review',
        'Space: Mark the change reviewed and go to the next one',
        'Shift Space: Mark the hunk, or the member in a chain',
        'n p: Next and previous chain with changes to review',
        'g: The chain’s graph, over the code, and back',
        'Ctrl K: Jump to a chain, file, symbol or thread',
        'c: Comment on the line you’re on',
        'Alt ←: Back to where you were',
        'Ctrl B: Show or hide the sidebar',
        'Esc: Close the peek, the palette, a menu or a commit’s details; then show every change again (the lens off)',
        '?: These keys',
      ].join('\n'));
    });
  });

  describe('when Escape is pressed on the key list, ', () => {
    let closed: string;

    before(async () => {
      await rest(page!);
      await page!.key('?');
      await page!.until(`document.querySelector('.keys') && !document.querySelector('.keys').hidden`);
      await page!.key('Escape');
      await page!.until(`!document.querySelector('.keys') || document.querySelector('.keys').hidden`);
      closed = await read(page!, `!document.querySelector('.keys') || document.querySelector('.keys').hidden ? 'closed' : 'open'`);
    });

    it('then the list closes.', () => {
      assert.equal(closed, 'closed');
    });
  });

  describe('when Ctrl K is pressed, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      opened = await read(page!, `[...document.querySelectorAll('.pal-list > *')].map((el) => el.matches('.pal-r') ? '  ' + el.querySelector('.nm')?.textContent + ' | ' + el.querySelector('.hint')?.textContent : el.textContent).join('\\n')`);
    });

    it('then Jump to lists the greeting chain and the file.', () => {
      assert.equal(opened, [
        'Chains',
        '  + String name | 2 to review',
        '  greet(name) | 2 to review',
        '  wave(name) | 2 to review',
        'Files',
        '  lib/app.dart | 4 to review',
        '  lib/notes.dart | 1 to review',
        '  lib/only/nested/added.dart | 1 to review',
        '  lib/app.g.dart | generated',
      ].join('\n'));
    });
  });

  describe('when Tab is pressed in Jump to, ', () => {
    let narrowed: string;

    before(async () => {
      await rest(page!);
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      await page!.key('Tab');
      await page!.until(`(document.querySelector('.pal-scope')?.textContent || '').startsWith('Chains')`);
      narrowed = await read(page!, `['scope ' + (document.querySelector('.pal-scope')?.textContent ?? ''), ...[...document.querySelectorAll('.pal-list > *')].map((el) => el.matches('.pal-r') ? '  ' + el.querySelector('.nm')?.textContent + ' | ' + el.querySelector('.hint')?.textContent : el.textContent)].join('\\n')`);
    });

    it('then the list narrows to chains.', () => {
      assert.equal(narrowed, [
        'scope Chains',
        'Chains',
        '  + String name | 2 to review',
        '  greet(name) | 2 to review',
        '  wave(name) | 2 to review',
      ].join('\n'));
    });
  });

  describe('when Escape is pressed in Jump to, ', () => {
    let closed: string;

    before(async () => {
      await rest(page!);
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      await page!.key('Escape');
      await page!.until(`!document.querySelector('.pal') || document.querySelector('.pal').hidden`);
      closed = await read(page!, `!document.querySelector('.pal') || document.querySelector('.pal').hidden ? 'closed' : 'open'`);
    });

    it('then Jump to closes.', () => {
      assert.equal(closed, 'closed');
    });
  });

  describe('when the marks panel is opened, ', () => {
    let note: string;

    before(async () => {
      await rest(page!);
      await page!.click('[aria-label="Marks"]');
      await page!.until(`!!document.querySelector('.mi-note')`);
      note = await read(page!, `[document.querySelector('.mi-note')?.textContent ?? '', document.querySelector('.mi-foot button')?.textContent ?? ''].join('\\n')`);
    });

    it('then it says marks are kept in git as untangle/marks/feature, and offers to reset them.', () => {
      assert.equal(note, `Your marks are kept in git as untangle/marks/feature. git diff untangle/marks/feature ${head.slice(0, 7)} shows what’s left.\nReset all marks…`);
    });
  });

  describe('when the greeting’s chain is opened, ', () => {
    let read1 = '';

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      read1 = await read(page!, `[...document.querySelectorAll('#vw-main .sec')].map((el) => [el.querySelector('.sec-h b').textContent, el.querySelector('.sec-h span').textContent, [...el.querySelectorAll('.sec-file')].map((f) => f.textContent).join(','), ${ownTicks('el')}.map((t) => t.closest('.ln').dataset.c).join(' ')].join(' | ')).join('\\n')`);
    });

    it('then the greeting and its call, in one file, read as one section of it, in the file’s order.', () => {
      assert.equal(read1, 'greet, main | app.dart | lib/app.dart | L:1 L:6');
    });
  });

  describe('when Space is pressed on the greeting, ', () => {
    let folded: string;
    let next: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.sec-h b');
      await page!.key(' ');
      await waitForSave(page!);
      folded = await read(page!, greetTicks);
      next = await read(page!, pill);
    });

    after(async () => {
      await clearMarks();
    });

    it('then the greeting’s change is reviewed, and its call, in the same stretch of the file, waits.', () => {
      assert.equal(folded, 'true false');
    });

    it('then the pill is on the next change.', () => {
      assert.equal(next, '1 of 1');
    });
  });

  describe('when Shift Space is pressed on the greeting, ', () => {
    let members: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.sec-h b');
      await page!.key(' ', { shift: true });
      await waitForSave(page!);
      members = await read(page!, `[...document.querySelectorAll('.sec')].map((el) => el.querySelector('.sec-h b')?.textContent ?? '').join(' | ') + ' · ' + ${greetTicks}`);
    });

    after(async () => {
      await clearMarks();
    });

    it('then that member is reviewed and the call stays open, in the section that reads them together.', () => {
      assert.equal(members, 'greet, main · true false');
    });
  });

  describe('when the greeting is marked and the page is reloaded, ', () => {
    let reviewed: string;
    let saved: string;
    let message: string;
    let base: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.sec-h b');
      await page!.key(' ');
      await waitForSave(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await chain(page!, 'greet(name)');
      reviewed = await read(page!, greetTicks);
      await page!.click('[aria-label="Marks"]');
      await page!.until(`(document.querySelector('.mi-note')?.textContent || '').includes('untangle/marks/feature')`);
      saved = await read(page!, `document.querySelector('.mi-note')?.textContent ?? ''`);
      message = execFileSync('git', ['-C', repo!.dir, 'log', '-1', '--format=%B', 'untangle/marks/feature'], { encoding: 'utf8' });
      base = repo!.rev('main');
    });

    after(async () => {
      await clearMarks();
    });

    it('then the greeting is still reviewed.', () => {
      assert.equal(reviewed, 'true false');
    });

    it('then the marks panel says the marks are kept in git as untangle/marks/feature.', () => {
      assert.match(saved, new RegExp(`^Your marks are kept in git as untangle/marks/feature, at [0-9a-f]{7}\\. git diff untangle/marks/feature ${head.slice(0, 7)} shows what’s left\\.$`));
    });

    it('then that branch\'s last commit records the review against this base and head.', () => {
      assert.equal(message, `Review: 1 of 6 changes reviewed\n\nUntangle-Base: ${base}\nUntangle-Head: ${head}\n\n`);
    });
  });

  describe('when Reset all marks is clicked, ', () => {
    let afterReset: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.sec .tick');
      await waitForSave(page!);
      await page!.click('[aria-label="Marks"]');
      await page!.until(`!!document.querySelector('[data-act="reset"]')`);
      await page!.click('[data-act="reset"]');
      await page!.until(`!(document.querySelector('.sec .hh-sum')?.textContent || '').includes('reviewed')`);
      afterReset = await read(page!, `(${greetSec}?.querySelector('.tick')?.getAttribute('aria-pressed')) ?? 'missing'`);
    });

    after(async () => {
      await clearMarks();
    });

    it('then the greeting is unreviewed again.', () => {
      assert.equal(afterReset, 'false');
    });
  });

  describe('when the greeting chain is marked reviewed from its header, then its button is clicked again, ', () => {
    let button: string;
    let opened: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.fv-head [data-act="mark-chain"]');
      await page!.until(`!!document.querySelector('.fv-head [data-act="next-open"]')`);
      button = await read(page!, `document.querySelector('.fv-head [data-act="next-open"]').textContent`);
      await page!.click('.fv-head [data-act="next-open"]');
      await page!.until(`(${crumbs}).includes('wave')`);
      opened = await read(page!, `[${crumbs}, document.querySelector('.fv-head [data-act="mark-chain"]')?.textContent ?? ''].join('\\n')`);
    });

    after(async () => {
      await clearMarks();
    });

    it('then the button reads Next chain, and opens the wave’s chain, whose button marks it reviewed.', () => {
      assert.equal(`${button}\n${opened.split('\n')[1]}`, 'Next chain\nMark chain reviewed');
    });
  });

  describe('when the reviewed greeting chain is marked unreviewed from its menu, ', () => {
    let item: string;
    let button: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.fv-head [data-act="mark-chain"]');
      await page!.until(`!!document.querySelector('.fv-head [data-act="next-open"]')`);
      await page!.click('.fv-head [data-menu="view"]');
      await page!.until(`!!document.querySelector('.menu:not([hidden]) [data-act="mark-chain"]')`);
      item = await read(page!, `document.querySelector('.menu:not([hidden]) [data-act="mark-chain"]').textContent.trim()`);
      await page!.click('.menu:not([hidden]) [data-act="mark-chain"]');
      await page!.until(`!!document.querySelector('.fv-head [data-act="mark-chain"]')`);
      button = await read(page!, `document.querySelector('.fv-head [data-act="mark-chain"]').textContent`);
    });

    after(async () => {
      await clearMarks();
    });

    it('then the menu offers it, and the header’s button marks the chain reviewed again.', () => {
      assert.equal(`${item}\n${button}`, 'Mark the whole chain unreviewed\nMark chain reviewed');
    });
  });

  describe('when a member of the greeting graph is shift-clicked, ', () => {
    let beforeScroll: string;
    let shown: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      beforeScroll = await read(page!, `String(document.querySelector('#vw-main').scrollTop)`);
      const labelsBefore = await read(page!, `document.querySelectorAll('.g-elabel').length`);
      await page!.click('.graph-box g.g-node[aria-label="app.dart, top level"]', { scroll: false, shift: true });
      await page!.until(`!!document.querySelector('.focus-bar')`);
      const afterScroll = await read(page!, `String(document.querySelector('#vw-main').scrollTop)`);
      const label = await read(page!, `[...document.querySelectorAll('.g-elabel')].map((el) => el.textContent).join(' | ')`);
      const bar = await read(page!, `document.querySelector('.focus-bar')?.textContent ?? ''`);
      shown = `${labelsBefore}\n${beforeScroll} ${afterScroll}\n${label}\n${bar}`;
    });

    it('then only that member\'s code stays where it was, and its arrow is named.', () => {
      assert.equal(shown, `0\n${beforeScroll} ${beforeScroll}\nname\nShowing only app.dart · 1 changeShow all 2 members`);
    });
  });

  describe('when a member of the greeting graph is clicked, ', () => {
    let went = '';

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.setViewport(1400, 420);
      await page!.click('.graph-box g.g-node[aria-label="app.dart, top level"]', { scroll: false });
      await page!.until(`!!document.querySelector('.sec.flash-sec') && (document.querySelector('.fv-here')?.textContent || '').includes('app.dart')`);
      went = await read(page!, `(() => { const sec = document.querySelector('.sec.flash-sec'); const call = ${ownTicks('sec')}.pop().closest('.ln'); const top = call.getBoundingClientRect().top - document.querySelector('#vw-main').getBoundingClientRect().top - document.querySelector('.fv-head').offsetHeight; const seen = top >= 0 && call.getBoundingClientRect().bottom <= document.querySelector('#vw-main').getBoundingClientRect().bottom; return sec.querySelector('.sec-h b').textContent + ', its call ' + (seen ? 'in view' : 'out of view, at ' + Math.round(top)) + ' · ' + (document.querySelector('.focus-bar') ? 'filtered' : 'all members') + ' · ' + document.querySelector('.fv-here').textContent; })()`);
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then the page goes to that member\'s own change, in the section it shares with the greeting, all members still shown, and the header names it.', () => {
      // The call is near the file's end, so the page can't take it up to the header: it's in view, named.
      assert.equal(went, 'greet, main, its call in view · all members · Reading app.dart · 2 of 2');
    });
  });

  describe('when the graph icon is clicked at the top of the chain, ', () => {
    let folded = '';

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.setViewport(1400, 420);
      await page!.click('.fv-head [data-act="graph"]', { scroll: false });
      await page!.until(`document.querySelector('.fv-head [data-act="graph"]').getAttribute('aria-pressed') === 'false'`);
      folded = await read(page!, `(() => { const box = document.querySelector('.graph-box').getBoundingClientRect(); const top = document.querySelector('#vw-main').getBoundingClientRect().top + document.querySelector('.fv-head').offsetHeight; return (Math.round(box.bottom - top) <= 0 ? 'under the header' : 'still showing') + ' · ' + (document.querySelector('.gd').hidden ? 'not dropped' : 'dropped'); })()`);
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then the page scrolls the graph under the header, into its button.', () => {
      assert.equal(folded, 'under the header · not dropped');
    });
  });

  describe('when the graph icon is hovered past the graph, then left, ', () => {
    let dropped = '';
    let left = '';

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.setViewport(1400, 420);
      // The greeting's own change at the reading line: the graph has gone under the header.
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); const own = ${ownTicks(greetSec)}[0].closest('.ln'); main.scrollTop += own.getBoundingClientRect().top - main.getBoundingClientRect().top - main.querySelector('.fv-head').offsetHeight - 8; })()`);
      await page!.until(`(document.querySelector('.fv-here')?.textContent || '').includes('greet') && document.querySelector('.fv-head [data-act="graph"]').getAttribute('aria-pressed') === 'false'`);
      await page!.hover('.fv-head [data-act="graph"]', { scroll: false });
      await page!.until(`!document.querySelector('.gd').hidden`);
      dropped = await read(page!, `[document.querySelector('.gd .g-node.here')?.getAttribute('aria-label') ?? 'no ring', document.querySelector('.gd-foot').textContent, document.querySelector('.fv-head [data-act="graph"]').getAttribute('aria-expanded')].join('\\n')`);
      await page!.hover('.pill-n', { scroll: false });
      await page!.until(`document.querySelector('.gd').hidden`);
      left = await read(page!, `document.querySelector('.fv-head [data-act="graph"]').getAttribute('aria-expanded')`);
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then the graph drops from the header, the member being read ringed and named, and goes back up once the pointer leaves.', () => {
      assert.equal(`${dropped}\n${left}`, 'greet, app.dart\nCentered on greet, the member you’re readingClick a member to go to it · Esc or scrolling folds it\ntrue\nfalse');
    });
  });

  describe('when the graph icon is clicked past the graph, the pointer leaves, and Escape is pressed, ', () => {
    let kept = '';
    let closed = '';

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.setViewport(1400, 420);
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); main.scrollTop = main.scrollHeight; })()`);
      await page!.until(`document.querySelector('.fv-head [data-act="graph"]').getAttribute('aria-pressed') === 'false'`);
      await page!.click('.fv-head [data-act="graph"]', { scroll: false });
      await page!.hover('.pill-n', { scroll: false });
      await page!.eval(`new Promise((resolve) => setTimeout(resolve, 400))`);
      kept = await read(page!, `document.querySelector('.gd').hidden ? 'folded' : 'kept'`);
      await page!.key('Escape');
      await page!.until(`document.querySelector('.gd').hidden`);
      closed = await read(page!, `document.querySelector('.gd').hidden ? 'folded' : 'kept'`);
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then the click keeps it down after the pointer leaves, and Escape folds it.', () => {
      assert.equal(`${kept} ${closed}`, 'kept folded');
    });
  });

  describe('when g is pressed past the graph and a member of the dropped graph is clicked, ', () => {
    let went = '';

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.setViewport(1400, 420);
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); main.scrollTop = main.scrollHeight; })()`);
      await page!.until(`document.querySelector('.fv-head [data-act="graph"]').getAttribute('aria-pressed') === 'false'`);
      await page!.key('g');
      await page!.until(`!document.querySelector('.gd').hidden`);
      await page!.click('.gd g.g-node[aria-label^="greet,"]', { scroll: false });
      await page!.until(`document.querySelector('.gd').hidden && !!document.querySelector('.sec.flash-sec') && (document.querySelector('.fv-here')?.textContent || '').includes('greet')`);
      went = await read(page!, `document.querySelector('.sec.flash-sec .sec-h b').textContent + ' · ' + document.querySelector('.fv-here').textContent`);
    });

    after(async () => {
      await page!.setViewport(1400, 900);
    });

    it('then g drops the graph, and the member\'s click folds it and goes to its code.', () => {
      assert.equal(went, 'greet, main · Reading greet · 1 of 2');
    });
  });

  describe('when the Files tab is opened, ', () => {
    let tree: string;
    let total: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="files"]');
      await page!.until(`(document.querySelector('#vw-side')?.textContent || '').includes('Generated')`);
      tree = await read(page!, `[...document.querySelectorAll('#vw-side .sb-row.dir, #vw-side .sb-row.tr, #vw-side .sb-group')].map((el) => el.classList.contains('sb-group') ? el.textContent : (el.classList.contains('dir') ? 'dir ' : 'file ') + (el.querySelector('.nm')?.textContent ?? '')).join('\\n')`);
      total = await read(page!, `(() => { const heading = document.querySelector('#vw-side .sb-group'); return heading.textContent + '\\n' + heading.title; })()`);
    });

    it('then the review\'s files are headed by their count and the lines they add and remove, without the generated file\'s.', () => {
      assert.equal(total, 'In the review3 files · +8 −7\nThe lines the review’s files add and remove. Generated files and migrations, below, aren’t reviewed or counted.');
    });

    it('then a folder that holds only a folder is shown with it, and the generated file is set aside.', () => {
      assert.equal(tree, [
        'In the review3 files · +8 −7',
        'dir lib',
        'dir only/nested',
        'file added.dart',
        'file app.dart',
        'file notes.dart',
        'Generated, not reviewed1 · Expand',
      ].join('\n'));
    });
  });

  describe('when the Files tab is shown with the greeting chain open, then a file is opened from it, ', () => {
    const faded = `[...document.querySelectorAll('#vw-side .sb-row.tr')].map((el) => el.querySelector('.nm').textContent + ' ' + getComputedStyle(el.querySelector('.nm')).opacity + ' ' + getComputedStyle(el.querySelector('.ig') || el).opacity).join('\\n')`;
    let withChain: string;
    let withFile: string;

    before(async () => {
      await rest(page!);
      await fresh();
      await chain(page!, 'greet(name)');
      await page!.click('[data-tab="files"]');
      await page!.until(`!!document.querySelector('#vw-side [data-open="lib/app.dart"]')`);
      withChain = await read(page!, faded);
      await page!.click('[data-open="lib/notes.dart"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/notes.dart"]')`);
      withFile = await read(page!, faded);
    });

    it('then, the chain open, the files and folders without its changes fade, not the tree\'s lines.', () => {
      assert.equal(withChain, ['lib 1 1', 'only/nested 0.38 1', 'added.dart 0.38 1', 'app.dart 1 1', 'notes.dart 0.38 1'].join('\n'));
    });

    it('then, a file open, none of them fade.', () => {
      assert.equal(withFile, ['lib 1 1', 'only/nested 1 1', 'added.dart 1 1', 'app.dart 1 1', 'notes.dart 1 1'].join('\n'));
    });
  });

  describe('when the notes file is opened, ', () => {
    let divider: string;

    before(async () => {
      await rest(page!);
      await fresh();
      await openFile(page!, 'lib/notes.dart');
      await page!.until(`!!document.querySelector('.hh-tail')`);
      divider = await read(page!, tail);
    });

    it('then the divider under its change offers 20 of the 41 lines below.', () => {
      assert.equal(divider, '41 lines below\n20 lines');
    });
  });

  describe('when the notes file\'s divider is opened, ', () => {
    let divider: string;

    before(async () => {
      await rest(page!);
      await fresh();
      await openFile(page!, 'lib/notes.dart');
      await page!.until(`!!document.querySelector('.hh-tail')`);
      await page!.click('.hh-tail .mo');
      await page!.until(`document.querySelector('.hh-tail .hh-tx')?.textContent === '21 lines below'`);
      divider = await read(page!, tail);
    });

    it('then the next divider offers 20 more lines.', () => {
      assert.equal(divider, '21 lines below\n20 lines');
    });
  });

  describe('when the notes file\'s divider is opened twice, ', () => {
    let divider: string;

    before(async () => {
      await rest(page!);
      await fresh();
      await openFile(page!, 'lib/notes.dart');
      await page!.until(`!!document.querySelector('.hh-tail')`);
      await page!.click('.hh-tail .mo');
      await page!.until(`document.querySelector('.hh-tail .hh-tx')?.textContent === '21 lines below'`);
      await page!.click('.hh-tail .mo');
      await page!.until(`document.querySelector('.hh-tail .mo')?.textContent === '1 line'`);
      divider = await read(page!, tail);
    });

    it('then the last divider offers the remaining line.', () => {
      assert.equal(divider, '1 line below\n1 line');
    });
  });

  describe('when the header\'s Show the whole file is clicked, then again, ', () => {
    const button = `(() => { const b = document.querySelector('.fv-head .tools [data-act="whole"]'); return [b.getAttribute('aria-label'), b.getAttribute('aria-pressed'), b.title].join(' | '); })()`;
    let before0: string;
    let shown: string;
    let menu: string;
    let back: string;

    before(async () => {
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      await page!.until(`!!document.querySelector('.fv-head [data-act="whole"]')`);
      before0 = await read(page!, button);
      await page!.click('.fv-head [data-act="whole"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/notes.dart"]') && !document.querySelector('.hh-tail') && (document.querySelector('.code[data-p="lib/notes.dart"]')?.textContent || '').includes('// pad 44')`);
      shown = await read(page!, `(document.querySelector('.hh-tail') ? 'tail' : 'whole') + ' | ' + ${button}`);
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('.menu:not([hidden]) .mi')`);
      menu = await read(page!, `[...document.querySelectorAll('.menu .mi')].some((item) => item.textContent.includes('whole file')) ? 'in the menu' : 'not in the menu'`);
      await rest(page!);
      await page!.click('.fv-head [data-act="whole"]');
      await page!.until(`!!document.querySelector('.hh-tail')`);
      back = await read(page!, button);
    });

    it('then it\'s a toggle in the header, off while the changes show.', () => {
      assert.equal(before0, 'Show the whole file | false | Show the whole file');
    });

    it('then every line of the notes file is on the page, and it\'s on.', () => {
      assert.equal(shown, 'whole | Show the whole file | true | Show only the changes');
    });

    it('then the view\'s menu no longer has it.', () => {
      assert.equal(menu, 'not in the menu');
    });

    it('then, clicked again, it\'s off, and the changes show again.', () => {
      assert.equal(back, 'Show the whole file | false | Show the whole file');
    });
  });

  /** Opens the peek of greet's definition from its changed call. */
  async function peekGreet(): Promise<void> {
    await rest(page!);
    await chain(page!, 'greet(name)');
    await page!.clickIn('.ref', 'greet', "greet('ada')");
    await page!.until(`(document.querySelector('.peek .pk-loc')?.textContent || '').includes('lib/app.dart')`);
  }

  describe('when greet on the changed call is clicked, ', () => {
    let definition: string;

    before(async () => {
      await peekGreet();
      definition = await read(page!, `[...document.querySelectorAll('.peek .pk-h > *')].map((part) => part.textContent).filter(Boolean).join(' | ')`);
    });

    it('then a peek shows where greet is defined.', () => {
      assert.equal(definition, 'Definition | lib/app.dart:1 | this repo | Open file | Open in editor | Close');
    });
  });

  describe('when a name in greet\'s peek is clicked, ', () => {
    let inner: string;

    before(async () => {
      await peekGreet();
      await page!.clickIn('.peek .ref.live', 'print', 'print(');
      await page!.until(`document.querySelector('[data-act="peek-back"]')`);
      inner = await read(page!, `[document.querySelector('.peek .pk-loc')?.textContent ?? '', document.querySelector('[data-act="peek-back"]')?.textContent ?? 'no Back'].join(' | ')`);
    });

    it('then the peek shows that name\'s definition instead, with Back.', () => {
      assert.match(inner, /^dart:core\/print\.dart:\d+ \| Back$/);
    });
  });

  describe('when Back is clicked in a peek that went on to another name, ', () => {
    let back: string;

    before(async () => {
      await peekGreet();
      await page!.clickIn('.peek .ref.live', 'print', 'print(');
      await page!.until(`document.querySelector('[data-act="peek-back"]')`);
      await page!.click('[data-act="peek-back"]');
      await page!.until(`!document.querySelector('[data-act="peek-back"]')`);
      back = await read(page!, `document.querySelector('.peek .pk-loc')?.textContent ?? ''`);
    });

    it('then the peek returns to greet.', () => {
      assert.equal(back, 'lib/app.dart:1');
    });
  });

  describe('when a name in greet\'s peek is looked up live, with motion on, ', () => {
    let swap = '';

    before(async () => {
      await peekGreet();
      await page!.reducedMotion(false);
      // What the answer changes: the peek in place, easing to its new height; the page stays.
      await page!.eval(`(() => {
        const peek = document.querySelector('.peek');
        window.kept = { peek, head: document.querySelector('.fv-head'), h: peek.getBoundingClientRect().height };
        window.eased = null;
        new MutationObserver(() => {
          if (window.eased) return;
          const a = peek.getAnimations().find((x) => x.effect.getKeyframes().some((k) => k.height));
          window.eased = a ? a.effect.getKeyframes().map((k) => k.height).join(' to ') : 'none';
        }).observe(peek, { childList: true });
      })()`);
      await page!.clickIn('.peek .ref.live', 'print', 'print(');
      await page!.until(`document.querySelector('[data-act="peek-back"]') && window.eased`);
      swap = await read(page!, `(() => {
        const peek = document.querySelector('.peek');
        const [from, to] = window.eased.split(' to ').map(parseFloat);
        return [peek === window.kept.peek ? 'the same peek' : 'a new peek', document.querySelector('.fv-head') === window.kept.head ? 'the same page' : 'the page drawn again', Math.round(from) === Math.round(window.kept.h) && to > from ? 'eases from its height to a taller one' : window.eased].join(', ');
      })()`);
      await page!.reducedMotion(true);
    });

    it('then the answer fills the same peek, which eases to its new height, and the page around it isn\'t drawn again.', () => {
      assert.equal(swap, 'the same peek, the same page, eases from its height to a taller one');
    });
  });

  describe('when a peek scrolled down its file closes, with motion on, ', () => {
    let closing = '';

    before(async () => {
      await peekGreet();
      await page!.clickIn('.peek .ref.live', 'print', 'print(');
      await page!.until(`document.querySelector('[data-act="peek-back"]') && document.querySelector('.peek .pk-code:not(.pk-tall)')?.scrollTop > 0`);
      await page!.reducedMotion(false);
      const top = await read(page!, `String(document.querySelector('.peek .pk-code').scrollTop)`);
      await page!.click('.peek [data-act="close-peek"]');
      closing = await read(page!, `(() => {
        const code = document.querySelector('.ghost .pk-code');
        return code ? (String(code.scrollTop) === ${JSON.stringify(top)} ? 'its code where it was' : 'its code at ' + code.scrollTop + ', not ' + ${JSON.stringify(top)}) : 'no closing peek';
      })()`);
      await page!.until(`!document.querySelector('.ghost')`);
      await page!.reducedMotion(true);
    });

    it('then it folds away with its code where it was, rather than back at the file\'s top.', () => {
      assert.equal(closing, 'its code where it was');
    });
  });

  describe('when the page outside greet\'s peek is clicked, ', () => {
    let closed: string;

    before(async () => {
      await peekGreet();
      await page!.click('.sb-prog');
      await page!.until(`!document.querySelector('.peek')`);
      closed = await read(page!, `document.querySelector('.peek') ? 'open' : 'closed'`);
    });

    it('then the peek closes.', () => {
      assert.equal(closed, 'closed');
    });
  });

  describe('when the sidebar is dragged wider, ', () => {
    let widths: string;

    before(async () => {
      await rest(page!);
      const start = await read(page!, `document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''`);
      await page!.drag('#vw-split', 80, 0);
      await page!.until(`document.querySelector('#vw-split')?.getAttribute('aria-valuenow') === '${Number(start) + 80}'`);
      const next = await read(page!, `document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''`);
      widths = `${start}\n${next}`;
    });

    after(async () => {
      await fresh();
    });

    it('then the sidebar grows by that distance.', () => {
      assert.equal(widths, '272\n352');
    });
  });

  describe('when the sidebar splitter is double-clicked, ', () => {
    let hidden: string;

    before(async () => {
      await rest(page!);
      await page!.doubleClick('#vw-split');
      await page!.until(`document.querySelector('#viewer')?.classList.contains('side-off')`);
      hidden = await read(page!, `[document.querySelector('#viewer')?.classList.contains('side-off') ? 'hidden' : 'shown', document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''].join('\\n')`);
    });

    after(async () => {
      await fresh();
    });

    it('then the sidebar hides.', () => {
      assert.equal(hidden, 'hidden\n0');
    });
  });

  describe('when the minimap is clicked below the code on screen, ', () => {
    let moved: string;

    before(async () => {
      await fresh();
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      await page!.until(`!!document.querySelector('.fv-head [data-act="whole"]')`);
      await page!.click('.fv-head [data-act="whole"]');
      await page!.until(`(document.querySelector('.code[data-p="lib/notes.dart"]')?.textContent || '').includes('// pad 44')`);
      await page!.until(`document.querySelector('#vw-mini') && !document.querySelector('#vw-mini').hidden`);
      const beforeScroll = Number(await page!.eval(`document.querySelector('#vw-main').scrollTop`));
      await page!.clickRatio('#vw-mini', 0.5, 0.92);
      await page!.until(`document.querySelector('#vw-main').scrollTop > ${beforeScroll}`);
      const afterScroll = Number(await page!.eval(`document.querySelector('#vw-main').scrollTop`));
      moved = afterScroll > beforeScroll ? 'moved' : `${beforeScroll} ${afterScroll}`;
    });

    it('then the code moves there.', () => {
      assert.equal(moved, 'moved');
    });
  });

  describe('when the wheel turns over the minimap, ', () => {
    let moved: string;

    before(async () => {
      await fresh();
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      await page!.until(`!!document.querySelector('.fv-head [data-act="whole"]')`);
      await page!.click('.fv-head [data-act="whole"]');
      await page!.until(`(document.querySelector('.code[data-p="lib/notes.dart"]')?.textContent || '').includes('// pad 44')`);
      await page!.until(`document.querySelector('#vw-mini') && !document.querySelector('#vw-mini').hidden`);
      const beforeScroll = Number(await page!.eval(`document.querySelector('#vw-main').scrollTop`));
      await page!.wheel('#vw-mini', 200);
      await page!.until(`document.querySelector('#vw-main').scrollTop > ${beforeScroll}`);
      const afterScroll = Number(await page!.eval(`document.querySelector('#vw-main').scrollTop`));
      moved = afterScroll > beforeScroll ? 'moved' : `${beforeScroll} ${afterScroll}`;
    });

    it('then the code scrolls.', () => {
      assert.equal(moved, 'moved');
    });
  });

  describe('when the language server\'s dot is shown, ', () => {
    let popover: string;

    before(async () => {
      await page!.click('#vw-lsp');
      // CPU is measured between two samples: until the second one, it reads —.
      await page!.until(`/%$/.test(document.querySelector('[data-m="cpu"]')?.textContent ?? '') && /%$/.test(document.querySelector('[data-m="lspCpu"]')?.textContent ?? '')`, 30_000);
      popover = await read(page!, `(() => {
        const pop = document.querySelector('#lsp-pop');
        const shown = pop ? getComputedStyle(pop).display : '';
        const pid = document.querySelector('#lsp-pid')?.textContent ?? '';
        const rss = document.querySelector('[data-m="rss"]')?.textContent ?? '';
        const cpu = document.querySelector('[data-m="cpu"]')?.textContent ?? '';
        const server = document.querySelector('[data-m="lspRss"]')?.textContent ?? '';
        const serverCpu = document.querySelector('[data-m="lspCpu"]')?.textContent ?? '';
        const kind = (value, pattern, name) => pattern.test(value) ? name : value;
        return [shown, document.querySelector('#lsp-state')?.textContent ?? '', kind(pid, /^pid \\d+$/, 'pid'), kind(rss, /^\\d+(\\.\\d+)? (KB|MB|GB)$/, 'memory'), kind(cpu, /^\\d+\\.\\d%$/, 'cpu'), kind(server, /^\\d+(\\.\\d+)? (KB|MB|GB)$/, 'server memory'), kind(serverCpu, /^\\d+\\.\\d%$/, 'server cpu')].join('\\n');
      })()`);
    });

    it('then its popover names the running server, its pid, and the memory and CPU.', () => {
      assert.equal(popover, 'grid\nDart analysis server, running\npid\nmemory\ncpu\nserver memory\nserver cpu');
    });

    it('then the dot reads the memory and CPU that untangle and the server use together.', async () => {
      const usage = await read(page!, `(() => { const use = document.querySelector('#lsp-use'); const sum = (k1, k2) => [k1, k2].map((k) => { const m = /^([\\d.]+) (KB|MB|GB)$/.exec(document.querySelector('[data-m="' + k + '"]').textContent); return m ? Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]] : 0; }).reduce((x, y) => x + y, 0); const mem = /^(\\d+) MB · [\\d.]+%$/.exec(use.textContent); return (getComputedStyle(use).display !== 'none' ? 'shown' : 'hidden') + ' · ' + (mem ? (Math.abs(Number(mem[1]) - sum('rss', 'lspRss')) <= 1 ? 'the two memories' : 'other memory: ' + use.textContent) : /^[\\d.]+ GB · [\\d.]+%$/.test(use.textContent) ? 'the two memories' : use.textContent); })()`);
      assert.equal(usage, 'shown · the two memories');
    });
  });

  describe('when the language server\'s memory is freed from its popover, ', () => {
    let freed: string;

    before(async () => {
      const pid = await read(page!, `document.querySelector('#lsp-pid').textContent`);
      await page!.hover('#vw-lsp');
      await page!.click('#lsp-free');
      await page!.until(`document.querySelector('#lsp-dot').classList.contains('ready') && !document.querySelector('#lsp-free').hidden && document.querySelector('#lsp-pid').textContent !== ${JSON.stringify(pid)}`, 180_000);
      freed = await read(page!, `document.querySelector('#lsp-state').textContent + ' · ' + (document.querySelector('#lsp-pid').textContent === ${JSON.stringify(pid)} ? 'the same process' : 'another process')`);
    });

    it('then the server starts over in another process, and runs again.', () => {
      assert.equal(freed, 'Dart analysis server, running · another process');
    });
  });

  describe('when the greeting chain is opened at 760 pixels wide, ', () => {
    let fit: string;

    before(async () => {
      await page!.setViewport(760, 900);
      await rest(page!);
      await chain(page!, 'greet(name)');
      fit = await read(page!, fits);
    });

    after(async () => {
      await page?.setViewport(1400, 900);
    });

    it('then the page does not scroll sideways.', () => {
      assert.equal(fit, 'fits');
    });
  });

  describe('when the notes file is opened at 480 pixels wide, ', () => {
    let fit: string;

    before(async () => {
      await page!.setViewport(480, 800);
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      fit = await read(page!, fits);
    });

    after(async () => {
      await page?.setViewport(1400, 900);
    });

    it('then the page does not scroll sideways.', () => {
      assert.equal(fit, 'fits');
    });
  });

  describe('when a few letters are typed for a symbol, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      await page!.key('Tab');
      await page!.key('Tab');
      await page!.key('Tab');
      await page!.until(`document.querySelector('.pal-scope')?.textContent === 'Symbols'`);
      await page!.type('gre');
      await page!.until(`[...document.querySelectorAll('.pal-r')].some((el) => (el.textContent || '').includes('greet') && (el.textContent || '').includes('app.dart'))`);
      const id = await read(page!, `[...document.querySelectorAll('.pal-r')].find((el) => (el.textContent || '').includes('greet') && (el.textContent || '').includes('app.dart'))?.id ?? ''`);
      await page!.click(`#${id}`);
      await page!.until(`(document.querySelector('.code')?.textContent || '').includes('void greet(String name)')`);
      opened = await read(page!, `(document.querySelector('.code')?.textContent || '').includes('void greet(String name)') ? 'void greet(String name)' : (document.querySelector('.crumbs')?.textContent ?? '')`);
    });

    it('then the declaration in the repository opens.', () => {
      assert.equal(opened, 'void greet(String name)');
    });
  });

  describe('when changed lines are searched, ', () => {
    let found: string;

    before(async () => {
      await rest(page!);
      await jump(page!, 'name');
      await page!.until(`[...document.querySelectorAll('.pal-r')].some((el) => (el.textContent || '').includes('Changed lines'))`);
      const id = await read(page!, `[...document.querySelectorAll('.pal-r')].find((el) => (el.textContent || '').includes('Changed lines'))?.id ?? ''`);
      await page!.click(`#${id}`);
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('name') && !!document.querySelector('.code mark')`);
      found = await read(page!, `[document.querySelector('.crumbs')?.textContent ?? '', document.querySelector('.code .inst-file')?.textContent ?? '', document.querySelector('.code mark')?.textContent ?? ''].join('\\n')`);
    });

    it('then the changed lines that contain it are listed.', () => {
      assert.equal(found, 'Search/“name”\nlib/app.dart\nname');
    });
  });

  describe('when a name in the changed lines\' search results is clicked, ', () => {
    let seen: string;

    before(async () => {
      await rest(page!);
      await jump(page!, 'name');
      await page!.until(`[...document.querySelectorAll('.pal-r')].some((el) => (el.textContent || '').includes('Changed lines'))`);
      const id = await read(page!, `[...document.querySelectorAll('.pal-r')].find((el) => (el.textContent || '').includes('Changed lines'))?.id ?? ''`);
      await page!.click(`#${id}`);
      await page!.until(`!!document.querySelector('.code .ln .tx span[class*=" k"]')`);
      const lines = await read(page!, `[...document.querySelectorAll('.code .ln .tx')].map((tx) => [...tx.querySelectorAll('span')].some((s) => /\\bk\\d+\\b/.test(s.className)) ? 'colored' : 'plain').join(' ')`);
      const marks = await read(page!, `[...document.querySelectorAll('.code .ln .tx mark')].map((el) => el.textContent).join(' ')`);
      await page!.clickIn('.code .ln .ref', 'name', 'print(name)');
      await page!.until(`!!document.querySelector('.peek .pk-loc')`);
      seen = [lines, marks, await read(page!, `document.querySelector('.peek .pk-h b').textContent + ' ' + document.querySelector('.peek .pk-loc').textContent`)].join('\n');
    });

    it('then its lines read as code with the query marked, and the name peeks at its definition.', () => {
      assert.equal(seen, 'colored colored colored colored\nname name name name\nDefinition lib/app.dart:1');
    });
  });

  describe('when the repository is searched at the head, ', () => {
    let found: string;

    before(async () => {
      await rest(page!);
      await jump(page!, 'ada');
      await page!.until(`[...document.querySelectorAll('.pal-r')].some((el) => (el.textContent || '').includes('The repository'))`);
      const id = await read(page!, `[...document.querySelectorAll('.pal-r')].find((el) => (el.textContent || '').includes('The repository'))?.id ?? ''`);
      await page!.click(`#${id}`);
      await page!.until(`(document.querySelector('.fv-head')?.textContent || '').includes('after them') && !!document.querySelector('.code mark')`);
      found = await read(page!, `[document.querySelector('.fv-head .crumbs')?.textContent ?? '', document.querySelector('.fv-head .facts')?.textContent ?? '', document.querySelector('.code .inst-file')?.textContent ?? '', document.querySelector('.code mark')?.textContent ?? ''].join('\\n')`);
    });

    it('then the head lists the line.', () => {
      assert.equal(found, `Search/“ada”\n2 lines in the repository, after them · ${head.slice(0, 7)}\nlib/app.dart\nada`);
    });
  });

  describe('when a name in the repository\'s search results is clicked, ', () => {
    let seen: string;

    before(async () => {
      await rest(page!);
      await jump(page!, 'ada');
      await page!.until(`[...document.querySelectorAll('.pal-r')].some((el) => (el.textContent || '').includes('The repository'))`);
      const id = await read(page!, `[...document.querySelectorAll('.pal-r')].find((el) => (el.textContent || '').includes('The repository'))?.id ?? ''`);
      await page!.click(`#${id}`);
      await page!.until(`!!document.querySelector('.code .ln .ref.live[data-ll="6"]')`);
      const lines = await read(page!, `[...document.querySelectorAll('.code .ln .tx')].map((tx) => [...tx.querySelectorAll('span')].some((s) => /\\bk\\d+\\b/.test(s.className)) ? 'colored' : 'plain').join(' ')`);
      const mark = await read(page!, `document.querySelector('.code .ln .tx mark')?.textContent ?? ''`);
      await page!.click('.code .ln .ref.live[data-ll="6"]');
      await page!.until(`!!document.querySelector('.peek .pk-loc')`, 30_000);
      seen = [lines, mark, await read(page!, `document.querySelector('.peek .pk-loc').textContent`)].join('\n');
    });

    it('then its lines read as code with the query marked, and the name peeks at its definition.', () => {
      assert.equal(seen, 'colored colored\nada\nlib/app.dart:1');
    });
  });

  describe('when the repository is searched before these changes, ', () => {
    let found: string;

    before(async () => {
      await rest(page!);
      await jump(page!, 'hi');
      await page!.until(`[...document.querySelectorAll('.pal-r')].some((el) => (el.textContent || '').includes('The repository'))`);
      const id = await read(page!, `[...document.querySelectorAll('.pal-r')].find((el) => (el.textContent || '').includes('The repository'))?.id ?? ''`);
      await page!.click(`#${id}`);
      await page!.until(`!!document.querySelector('[data-scope="repo-base"]')`);
      await page!.until(`!!document.querySelector('.code mark') || ((document.querySelector('.empty')?.textContent || '') !== '' && (document.querySelector('.empty')?.textContent || '') !== 'Searching…')`);
      await page!.click('[data-scope="repo-base"]');
      try {
        await page!.until(`document.querySelector('[data-scope="repo-base"]')?.getAttribute('aria-pressed') === 'true'`, 5_000);
      } catch {
        await page!.click('[data-scope="repo-base"]');
        await page!.until(`document.querySelector('[data-scope="repo-base"]')?.getAttribute('aria-pressed') === 'true'`);
      }
      await page!.until(`!!document.querySelector('.code mark')`, 20_000);
      found = await read(page!, `[document.querySelector('.facts')?.textContent ?? '', document.querySelector('.code .inst-file')?.textContent ?? '', document.querySelector('.code mark')?.textContent ?? ''].join('\\n')`);
    });

    it('then the base lists the old line.', () => {
      assert.equal(found.replace(/· [0-9a-f]{7}/, '· sha'), '1 line in the repository, before these changes · sha\nlib/app.dart\nhi');
    });
  });

  describe('when Ctrl B is pressed, ', () => {
    let sidebar: string;

    before(async () => {
      await rest(page!);
      await fresh();
      await page!.key('b', { ctrl: true });
      await page!.until(`document.querySelector('#viewer')?.classList.contains('side-off')`);
      sidebar = await read(page!, `document.querySelector('#viewer')?.classList.contains('side-off') ? 'hidden' : 'shown'`);
    });

    after(async () => {
      await fresh();
    });

    it('then the sidebar hides.', () => {
      assert.equal(sidebar, 'hidden');
    });
  });

  describe('when Ctrl B is pressed twice, ', () => {
    let sidebar: string;

    before(async () => {
      await rest(page!);
      await fresh();
      await page!.key('b', { ctrl: true });
      await page!.until(`document.querySelector('#viewer')?.classList.contains('side-off')`);
      await page!.key('b', { ctrl: true });
      await page!.until(`!document.querySelector('#viewer')?.classList.contains('side-off')`);
      sidebar = await read(page!, `document.querySelector('#viewer')?.classList.contains('side-off') ? 'hidden' : 'shown'`);
    });

    it('then the sidebar shows again.', () => {
      assert.equal(sidebar, 'shown');
    });
  });

  describe('when the header arrows are used, ', () => {
    let walked: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      const total = Number(await read(page!, `(document.querySelector('.pill-n')?.textContent || '').match(/of (\\d+)/)?.[1] || '0'`));
      const at = () => read(page!, `document.querySelector('.pill-n b')?.textContent ?? ''`);
      // The first press lands on the change already on screen, the same way j does.
      const move = async (selector: string, before: string) => {
        await page!.click(selector);
        try {
          await page!.until(`document.querySelector('.pill-n b')?.textContent !== ${JSON.stringify(before)}`, 2_000);
        } catch {
          await page!.click(selector);
          await page!.until(`document.querySelector('.pill-n b')?.textContent !== ${JSON.stringify(before)}`);
        }
        return at();
      };
      const forward = [await at()];
      while (forward.length < total) forward.push(await move('[data-act="nav"][data-step="1"]', forward[forward.length - 1]));
      const back: string[] = [];
      while (back.length < total - 1) back.push(await move('[data-act="nav"][data-step="-1"]', back.length ? back[back.length - 1] : forward[forward.length - 1]));
      walked = `${forward.join(' ')}\n${back.join(' ')}`;
    });

    it('then each change is visited down and back up.', () => {
      const forward = walked.split('\n')[0];
      const numbers = forward.split(' ');
      const down = numbers.map((_, index) => String(index + 1)).join(' ');
      const up = numbers.slice(0, -1).reverse().join(' ');
      assert.equal(walked, `${down}\n${up}`);
    });
  });

  describe('when Side by side is chosen, ', () => {
    let layout: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="layout"]')`);
      await page!.click('[data-act="layout"]');
      await waitForSave(page!);
      await page!.until(`document.querySelector('#viewer')?.classList.contains('split') && !!document.querySelector('.half')`);
      layout = await read(page!, `[document.querySelector('#viewer')?.classList.contains('split') ? 'split' : 'unified', document.querySelectorAll('.code .sl .half.l').length === document.querySelectorAll('.code .sl .half.r').length ? 'left and right halves' : 'uneven halves'].join(', ')`);
    });

    after(async () => {
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'unified', showReviewedDiff: false } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    });

    it('then the change is shown in two columns.', () => {
      assert.equal(layout, 'split, left and right halves');
    });
  });

  describe('when a change is marked reviewed side by side, ', () => {
    let rows: string;

    before(async () => {
      await rest(page!);
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'split', showReviewedDiff: false } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile(page!, 'lib/app.dart');
      await page!.click('.code[data-p="lib/app.dart"] .tick');
      await waitForSave(page!);
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"] .sl.rvd-quiet')`);
      rows = await read(page!, `[...document.querySelectorAll('.code[data-p="lib/app.dart"] .sl')].slice(0, 3).map((row) => [row.className, row.querySelector('.half.l .tx')?.textContent, row.querySelector('.half.r .tx')?.textContent, row.querySelector('.tick')?.getAttribute('aria-pressed') ?? 'no mark', row.querySelector('[data-act="toggle-diff"]')?.textContent ?? 'no toggle'].join(' | ')).join('\\n')`);
    });

    after(async () => {
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'unified', showReviewedDiff: false } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    });

    it('then its new lines are drawn once, quiet, in both columns, with its mark on and show diff on the first.', () => {
      assert.equal(rows, [
        'sl rvd-quiet | void greet(String name) { | void greet(String name) { | true | show diff',
        'sl rvd-quiet |   print(name); |   print(name); | no mark | no toggle',
        'sl | } | } | no mark | no toggle',
      ].join('\n'));
    });
  });

  describe('when show diff is clicked on a reviewed change side by side, ', () => {
    let rows: string;

    before(async () => {
      await rest(page!);
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'split', showReviewedDiff: false } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile(page!, 'lib/app.dart');
      await page!.click('.code[data-p="lib/app.dart"] .tick');
      await waitForSave(page!);
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"] [data-act="toggle-diff"]')`);
      await page!.click('.code[data-p="lib/app.dart"] [data-act="toggle-diff"]');
      await page!.until(`!document.querySelector('.code[data-p="lib/app.dart"] .sl.rvd-quiet')`);
      rows = await read(page!, `[...document.querySelectorAll('.code[data-p="lib/app.dart"] .sl')].slice(0, 3).map((row) => [row.className, row.querySelector('.half.l')?.className, row.querySelector('.half.l .tx')?.textContent, row.querySelector('.half.r')?.className, row.querySelector('.half.r .tx')?.textContent].join(' | ')).join('\\n')`);
    });

    after(async () => {
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'unified', showReviewedDiff: false } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    });

    it('then its removed and added lines are back, side by side.', () => {
      assert.equal(rows, [
        'sl rvd | half l del | void greet() { | half r add | void greet(String name) {',
        "sl rvd | half l del |   print('hi'); | half r add |   print(name);",
        'sl | half l ctx | } | half r ctx | }',
      ].join('\n'));
    });
  });

  /** Marks the greeting's change in app.dart, whose hunk has other changes and so stays open. */
  async function markGreet(): Promise<void> {
    await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'unified', showReviewedDiff: false } });
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await openFile(page!, 'lib/app.dart');
    await page!.click('.code[data-p="lib/app.dart"] .tick');
    await waitForSave(page!);
    await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"] .ln.rvd-quiet')`);
  }

  describe('when a change whose hunk has others is marked reviewed, ', () => {
    let rows: string;

    before(async () => {
      await rest(page!);
      await markGreet();
      rows = await read(page!, `[...document.querySelectorAll('.code[data-p="lib/app.dart"] .ln')].slice(0, 3).map((row) => row.className + ' | ' + (row.querySelector('.tx')?.textContent ?? '')).join('\\n')`);
    });

    after(async () => {
      await clearMarks();
    });

    it('then it reads as plain code, quiet.', () => {
      assert.equal(rows, [
        'ln ctx rvd-quiet | void greet(String name) {',
        'ln ctx rvd-quiet |   print(name);',
        'ln ctx | }',
      ].join('\n'));
    });
  });

  describe('when Diffs of reviewed code is chosen, ', () => {
    let rows: string;

    before(async () => {
      await rest(page!);
      await markGreet();
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="revdiff"]')`);
      await page!.click('[data-act="revdiff"]');
      await waitForSave(page!);
      await page!.until(`!document.querySelector('.code[data-p="lib/app.dart"] .ln.rvd-quiet')`);
      rows = await read(page!, `[...document.querySelectorAll('.code[data-p="lib/app.dart"] .ln')].slice(0, 5).map((row) => row.className + ' | ' + (row.querySelector('.tx')?.textContent ?? '')).join('\\n')`);
    });

    after(async () => {
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'unified', showReviewedDiff: false } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    });

    it('then the reviewed change shows its diff again.', () => {
      assert.equal(rows, [
        'ln del rvd | void greet() {',
        "ln del rvd |   print('hi');",
        'ln add rvd | void greet(String name) {',
        'ln add rvd |   print(name);',
        'ln ctx | }',
      ].join('\n'));
    });
  });

  describe('when the minimap is turned off, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="minimap"]')`);
      await page!.click('[data-act="minimap"]');
      await page!.until(`document.querySelector('#vw-mini')?.hidden`);
      shown = await read(page!, `document.querySelector('#vw-mini')?.hidden ? 'hidden' : 'shown'`);
    });

    after(async () => {
      await page!.eval(`localStorage.setItem('untangle:ui', JSON.stringify({ side: 272, sideOff: false, minimap: true, graph: true, filesList: false }))`);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    });

    it('then the minimap is hidden.', () => {
      assert.equal(shown, 'hidden');
    });
  });

  describe('when the file\'s chains are opened, ', () => {
    let listed: string;

    before(async () => {
      await rest(page!);
      await openFile(page!, 'lib/app.dart');
      await page!.until(`!!document.querySelector('[data-menu="chains"]')`);
      const chip = await read(page!, `document.querySelector('[data-menu="chains"]')?.textContent ?? ''`);
      await page!.click('[data-menu="chains"]');
      await page!.until(`!!document.querySelector('.menu .mi')`);
      const names = await read(page!, `[...document.querySelectorAll('.menu .mi')].map((el) => [...el.childNodes].map((node) => (node.textContent || '').trim()).filter(Boolean).join(' | ')).join('\\n')`);
      listed = `${chip}\n${names}`;
    });

    it('then the menu lists the chains the file is in.', () => {
      assert.equal(listed, 'In 3 chains\n+ String name | 2 to review\ngreet(name) | 2 to review\nwave(name) | 2 to review');
    });
  });

  describe('when Open in editor is shown, ', () => {
    let href: string;
    let stayed: string;

    before(async () => {
      await rest(page!);
      await openFile(page!, 'lib/app.dart');
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('.menu a[href^="vscode://"]')`);
      href = await read(page!, `document.querySelector('.menu a[href^="vscode://"]')?.getAttribute('href') ?? ''`);
      stayed = await read(page!, `location.hostname === '127.0.0.1' ? 'stayed' : location.href`);
    });

    it('then the link points at the file and the page stays here.', () => {
      const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(`${href}\n${stayed}`, new RegExp(`^vscode://(vscode-remote/wsl\\+[^/]+|file)${escaped(cache)}/worktrees/local/[^/]+/${head.slice(0, 12)}/lib/app\\.dart:1:1\nstayed$`));
    });
  });

  describe('when Open file is chosen on a definition outside the changes, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.clickIn('.ref', 'greet', "greet('ada')");
      await page!.until(`(document.querySelector('.peek .pk-loc')?.textContent || '').includes('lib/app.dart')`);
      await page!.clickIn('.peek .ref.live', 'print', 'print(');
      await page!.until(`(document.querySelector('.peek .pk-loc')?.textContent || '').startsWith('dart:')`);
      await page!.click('.peek [data-act="open-source"]');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('Dart SDK') && [...document.querySelectorAll('.code.src .tx')].some((el) => (el.textContent || '').includes('print')) && !!document.querySelector('.code.src .no')`);
      opened = await read(page!, `[ (document.querySelector('.crumbs')?.textContent || '').includes('Dart SDK') ? 'Dart SDK' : (document.querySelector('.crumbs')?.textContent ?? ''), document.querySelector('.code.src .no') ? 'numbered' : 'unnumbered', [...document.querySelectorAll('.code.src .tx')].some((el) => (el.textContent || '').includes('print')) ? 'print' : '' ].join('\\n')`);
    });

    it('then that file opens on its own, with its lines.', () => {
      assert.equal(opened, 'Dart SDK\nnumbered\nprint');
    });
  });
});
