import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { motionOf, read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const pads = Array.from({ length: 30 }, (_, index) => `// line ${index + 4}`);
const app = (word: string) => ['void greet() {', `  print('${word}');`, '}', ...pads, ''].join('\n');

// A note as the page shows it: open or folded, and its header.
const noteShown = (n: number) => `(() => { const th = document.querySelector('.th.note[data-note="${n}"]'); if (!th) return 'none'; const head = th.querySelector(':scope > .th-fold')?.textContent.replace(/\\s+/g, ' ').trim(); return (th.querySelector(':scope > .cm') ? 'open' : 'folded') + (head ? ': ' + head : ''); })()`;
const heightOf = (selector: string) => `(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().height ?? 0).toFixed(1)`;
const still = `document.getAnimations().length === 0`;

describe('Given a served review with a note on its change and one on a line outside the diff, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient;
  let cache = '';
  let head = '';
  const one = '.th.note[data-note="1"]';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', app('hi'));
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', app('hello'));
    head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main' });
    client = reviewClient(run.url);
    await waitForReview(client);
    await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
    await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 30, body: 'Say why it’s here.' } });
    page = await launchBrowser();
    await page.reducedMotion(true);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openApp(): Promise<void> {
    await rest(page!);
    await page!.goto(run!.url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page!.click('[data-open="lib/app.dart"]');
    await page!.until(`!!document.querySelector('${one}') && ${still}`);
  }

  /** Opens a note from the Threads tab. */
  async function openFromThreads(n: number): Promise<void> {
    await rest(page!);
    await page!.goto(run!.url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await page!.click('[data-tab="comments"]');
    await page!.until(`!!document.querySelector('[data-act="nt-open"][data-n="${n}"]')`);
    await page!.click(`[data-act="nt-open"][data-n="${n}"]`);
    await page!.until(`!!document.querySelector('.th.note[data-note="${n}"] .cm')`);
  }

  /** Clicks, and reads how the box changed as the page drew it anew. */
  async function motion(box: string, click: string): Promise<string> {
    await page!.eval(motionOf(box));
    await page!.click(click);
    await page!.until('window.__motion != null');
    const seen = await read(page!, 'window.__motion');
    await page!.until(still);
    return seen;
  }

  describe('when the note is opened from the Threads tab and resolved, ', () => {
    let shown: string;

    before(async () => {
      await openFromThreads(1);
      await page!.click(`${one} [data-act="nt-resolve"]`);
      await page!.until(`!!document.querySelector('${one}.resolved')`);
      shown = await read(page!, noteShown(1));
    });

    it('then it folds.', () => {
      assert.equal(shown, 'folded: Resolved· N1 · line 2 · 1 comment');
    });
  });

  describe('when the resolved note is unfolded, unresolved and resolved again, ', () => {
    let shown: string;

    before(async () => {
      await openApp();
      await page!.click(`${one} [data-act="nt-fold"]`);
      await page!.until(`!!document.querySelector('${one} [data-act="nt-resolve"]')`);
      await page!.click(`${one} [data-act="nt-resolve"]`);
      await page!.until(`!!document.querySelector('${one}:not(.resolved) [data-act="nt-resolve"]')`);
      await page!.click(`${one} [data-act="nt-resolve"]`);
      await page!.until(`!!document.querySelector('${one}.resolved')`);
      shown = await read(page!, noteShown(1));
    });

    it('then it folds, though it was unfolded before.', () => {
      assert.equal(shown, 'folded: Resolved· N1 · line 2 · 1 comment');
    });
  });

  describe('when the other note is opened from the Threads tab, then resolved elsewhere, ', () => {
    let shown: string;

    before(async () => {
      await openFromThreads(2);
      await client.call('notes', { method: 'POST', head, body: { action: 'resolve', n: 2, resolved: true } });
      await page!.until(`!!document.querySelector('.th.note.resolved[data-note="2"]')`, 10_000);
      shown = await read(page!, noteShown(2));
    });

    it('then it folds too.', () => {
      assert.equal(shown, 'folded: Resolvedline 30, outside the diff· N2 · line 30 · 1 comment');
    });
  });

  describe('when the resolved note is unfolded, then folded, with motion on, ', () => {
    let opening: string;
    let closing: string;
    let shut = '';
    let open = '';

    before(async () => {
      await page!.reducedMotion(false);
      await openApp();
      shut = await read(page!, heightOf(one));
      opening = await motion(one, `${one} [data-act="nt-fold"]`);
      open = await read(page!, heightOf(one));
      closing = await motion(one, `${one} [data-act="nt-fold"]`);
    });

    after(async () => {
      await page!.reducedMotion(true);
    });

    it('then it opens downward from its header, what it holds fading in.', () => {
      assert.equal(opening, `it eases from ${shut}px to ${open}px; cm, th-f fade in`);
    });

    it('then what it holds closes up under its header, fading.', () => {
      assert.equal(closing, `a stand-in after th-fold, holding cm, th-f, closes from ${(Number(open) - Number(shut)).toFixed(1)}px, fading`);
    });
  });

  describe('when the resolved note is unfolded and unresolved, then resolved, with motion on, ', () => {
    let reopening: string;
    let resolving: string;
    let open = '';
    let reopened = '';
    let shut = '';

    before(async () => {
      await page!.reducedMotion(false);
      await openApp();
      await page!.click(`${one} [data-act="nt-fold"]`);
      await page!.until(`!!document.querySelector('${one} [data-act="nt-resolve"]') && ${still}`);
      open = await read(page!, heightOf(one));
      reopening = await motion(one, `${one} [data-act="nt-resolve"]`);
      reopened = await read(page!, heightOf(one));
      resolving = await motion(one, `${one} [data-act="nt-resolve"]`);
      shut = await read(page!, heightOf(one));
    });

    after(async () => {
      await page!.reducedMotion(true);
    });

    it('then, unresolved, its header closes over what stays.', () => {
      assert.equal(reopening, `a stand-in before cm, holding th-fold, closes from ${(Number(open) - Number(reopened)).toFixed(1)}px, fading`);
    });

    it('then, resolved, what it holds closes up into the header that takes its place, fading in.', () => {
      assert.equal(resolving, `a stand-in before th-fold, holding cm, th-f, closes from ${(Number(reopened) - Number(shut)).toFixed(1)}px, fading; th-fold fade in`);
    });
  });

  describe('when the notes outside the diff are folded, then unfolded, with motion on, ', () => {
    let closing: string;
    let opening: string;
    let open = '';
    let shut = '';

    before(async () => {
      await page!.reducedMotion(false);
      await openApp();
      open = await read(page!, heightOf('.fthreads'));
      closing = await motion('.fthreads', '[data-act="nt-away"]');
      shut = await read(page!, heightOf('.fthreads'));
      opening = await motion('.fthreads', '[data-act="nt-away"]');
    });

    after(async () => {
      await page!.reducedMotion(true);
    });

    it('then they close up under their toggle, fading.', () => {
      assert.equal(closing, `a stand-in after th-away, holding th-hunk, th, closes from ${(Number(open) - Number(shut)).toFixed(1)}px, fading`);
    });

    it('then they open downward from it, fading in.', () => {
      assert.equal(opening, `it eases from ${shut}px to ${open}px; th-hunk, th fade in`);
    });
  });

  describe('when two replies of yours follow your note, the last longer than a line, ', () => {
    let apart: string;

    before(async () => {
      await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 2, body: 'And the greeting?' } });
      await client.call('notes', { method: 'POST', head, body: { action: 'reply', n: 3, body: 'It greets everyone.' } });
      await client.call('notes', { method: 'POST', head, body: { action: 'reply', n: 3, body: 'It runs on every start, so this line of words goes on past the width of the thread, where the time of a reply shows.' } });
      await openApp();
      const last = `[...document.querySelectorAll('.th.note[data-note="3"] > .cm')].pop()`;
      await page!.until(`!!${last}?.matches(':not(.first)')`);
      apart = await read(page!, `(() => { const cm = ${last}, t = cm.querySelector('.cm-t').getBoundingClientRect(), b = cm.querySelector('.cm-body').getBoundingClientRect(); return t.left >= b.right ? 'beside it' : 'over it'; })()`);
    });

    it('then the last one’s time stands beside its text, not over it.', () => {
      assert.equal(apart, 'beside it');
    });
  });
});
