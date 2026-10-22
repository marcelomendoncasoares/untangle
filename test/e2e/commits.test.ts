import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import type { GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pullRequestGh } from '../helpers/pull-request.ts';
import { pubspec } from '../helpers/review.ts';
import type { Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { featureHistory, saveReviewedHead, type StoryStep } from '../helpers/story.ts';
import { contents, dayOf, dotOf, fullWhen, historyDots, historySubjects, read, rest, waitForSave, whenOf } from './page.ts';

const skip = e2eSkip();
const noon = (day: string) => `2020-01-${day}T15:00:00Z`;
const ada = (day: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date: noon(day) });
const grace = (day: string): Person => ({ name: 'Grace Commit', email: 'grace@example.com', date: noon(day) });
const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const minus = '\u2212';
const dash = '\u2013';
const dot = '\u00b7';

const startApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const namedApp = ['void greet(String name) {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const passedApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');

const newestFirst = [
  'Pass the name',
  'Name the parameter',
  'Merge main',
  'Add a binary',
  'Rename the file',
  'Delete the old file',
  'Add a nested file',
  'Commit it later',
  'Mention the code',
  'Overwrite the hollow line',
  'Plant a hollow line',
];

const factsOf = `[...document.querySelectorAll('.hd-facts dt')].map((dt) => dt.textContent + ': ' + (dt.nextElementSibling?.textContent ?? '').replace(/\\s+/g, ' ').trim()).join('\\n')`;
const topBar = `document.querySelector('.t-head')?.textContent ?? ''`;
// The function's change: the first in the section that reads the greeting and its call together.
const functionTick = `(() => {
  const sec = [...document.querySelectorAll('.sec')].find((el) => (el.querySelector('.sec-h b')?.textContent || '').split(', ')[0] === 'greet');
  if (!sec) return 'headers:' + [...document.querySelectorAll('.sec-h b')].map((el) => el.textContent).join(',');
  const summary = sec.querySelector('.hh-sum')?.textContent || '';
  if (summary.includes('reviewed')) return 'reviewed';
  const pressed = sec.querySelector('.tick')?.getAttribute('aria-pressed');
  return pressed === 'true' ? 'reviewed' : pressed ?? 'no tick';
})()`;
const lineFade = (text: string) => `(() => { const line = [...document.querySelectorAll('.ln, .sl')].find((el) => (el.textContent || '').includes(${JSON.stringify(text)})); return line && line.className.includes('lens-out') ? 'faded' : 'shown'; })()`;

function step(subject: string, day: string, extra: Partial<StoryStep> = {}): StoryStep {
  return { subject, author: ada(day), committer: ada(day), ...extra };
}

async function history(page: Browser): Promise<void> {
  await contents(page);
  await page.click('[data-act="history-open"]');
  await page.until(`!!document.querySelector('.hs-s')`);
}

async function details(page: Browser, sha: string): Promise<void> {
  await history(page);
  const selector = `.hs-main[data-detail="${sha}"]`;
  const expanded = await page.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded') === 'true'`);
  if (!expanded) await page.click(selector);
  await page.until(`document.querySelector('.hs-detail')?.dataset.detailOf === ${JSON.stringify(sha)}`);
}

async function chain(page: Browser): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('[data-chain]')].find((el) => (el.textContent || '').includes('greet(name)')) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error('the greet(name) chain is not in the sidebar');
  await page.click(`[data-chain="${id}"]`);
  await page.until(`!!document.querySelector('.sec')`);
}

async function changesFrom(page: Browser): Promise<void> {
  await page.click('.t-head');
  await page.until(`!!document.querySelector('.menu.lens-pop:not([hidden])')`);
}

async function commitsTab(page: Browser): Promise<void> {
  await page.click('[data-tab="commits"]');
  await page.until(`!!document.querySelector('.cm-row')`);
}

describe('Given a served review of feature, its pull request, a merge of two commits from main, and a saved review of that merge, ', { skip, timeout: 360_000 }, () => {
  let repoDir = '';
  let removeRepo: (() => void) | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient | undefined;
  let cache = '';
  let url = '';
  let sha: Record<string, string> = {};
  const short = (subject: string) => sha[subject].slice(0, 7);

  before(async () => {
    const built = featureHistory({
      start: step('Start the package', '02', {
        write: {
          'pubspec.yaml': pubspec,
          'lib/app.dart': startApp,
          'lib/old.dart': 'void oldFile() {}\n',
          'lib/gone.dart': 'void goneFile() {}\n',
          'lib/temp.dart': "void temp() {\n  print('base');\n}\n",
          'lib/app.g.dart': 'const generated = 1;\n',
        },
      }),
      feature: [
        step('Plant a hollow line', '03', { write: { 'lib/temp.dart': "void temp() {\n  print('base');\n  print('HOLLOW');\n}\n" } }),
        step('Overwrite the hollow line', '04', { write: { 'lib/temp.dart': "void temp() {\n  print('base');\n  print('KEPT');\n}\n" } }),
        step('Mention the code', '05', {
          body: 'Call `greet` from #12.\nSee https://example.test/notes.\n',
          write: { 'lib/docs.dart': '/// A note.\n' },
        }),
        {
          subject: 'Commit it later',
          author: ada('06'),
          committer: grace('07'),
          write: { 'lib/docs.dart': '/// A later note.\n' },
        },
        step('Add a nested file', '08', { write: { 'lib/only/nested/added.dart': 'void addedFile() {}\n' } }),
        step('Delete the old file', '09', { remove: ['lib/gone.dart'] }),
        step('Rename the file', '10', { rename: { from: 'lib/old.dart', to: 'lib/src/renamed.dart' } }),
        step('Add a binary', '11', { write: { 'assets/blob.bin': Buffer.from([0, 255, 0, 1]) } }),
      ],
      main: [
        step('Add extra on main', '14', { write: { 'lib/extra.dart': 'void extra() {}\n' } }),
        step('Add a note on main', '15', { write: { 'lib/note.dart': 'void note() {}\n' } }),
      ],
      merge: { subject: 'Merge main', author: ada('12'), committer: ada('12') },
      after: [
        step('Name the parameter', '13', { write: { 'lib/app.dart': namedApp } }),
        step('Pass the name', '16', { write: { 'lib/app.dart': passedApp, 'lib/app.g.dart': 'const generated = 2;\n' } }),
      ],
    });
    sha = built.sha;
    removeRepo = () => built.repo.remove();
    repoDir = built.repo.dir;
    saveReviewedHead(built.repo, 'pr-7', sha['Merge main'], sha.main, ada('20'));
    gh = pullRequestGh({
      number: 7,
      title: 'Add a greeting',
      url: 'https://github.com/acme/sample/pull/7',
      base: 'main',
      baseSha: sha.main,
      head: 'feature',
      headSha: sha['Pass the name'],
    });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repoDir, { cacheDir: cache, gh });
    url = run.url;
    client = reviewClient(url);
    await waitForReview(client);
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.until(`!!document.querySelector('.lens-offer')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    removeRepo?.();
    gh?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  // The page is reloaded first: a save it still had waiting lands before the reset, not after.
  async function resetMarks(): Promise<void> {
    await page!.goto(url);
    await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [] } });
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await page!.until(`!!document.querySelector('.lens-offer')`, 30_000);
  }

  describe('when History is opened, ', () => {
    let subjects: string;
    let lanes: string;
    let facts: string;
    let dots: string;
    let flag: string;
    let merge: string;

    before(async () => {
      await rest(page!);
      await history(page!);
      subjects = await read(page!, historySubjects);
      lanes = await read(page!, `[...document.querySelectorAll('.hs-main')].every((el) => !!el.querySelector('svg.lanes')) ? 'lanes' : 'missing'`);
      facts = await read(page!, `document.querySelector('.fv-head .facts')?.textContent ?? ''`);
      dots = await read(page!, historyDots);
      flag = await read(page!, `document.querySelector('.hs-flag')?.textContent ?? ''`);
      merge = await read(page!, `([...document.querySelectorAll('.hs-row')].find((el) => el.querySelector('.hs-s')?.textContent === 'Merge main')?.querySelector('.hs-m')?.textContent) ?? ''`);
    });

    it('then the commits are listed newest first.', () => {
      assert.equal(subjects, newestFirst.join('\n'));
    });

    it('then each commit has a lane.', () => {
      assert.equal(lanes, 'lanes');
    });

    it('then the header counts the commits, the merge and the time span.', () => {
      assert.equal(facts, `11 commits ${dot} 1 merge from main ${dot} ${dayOf(noon('03'))} ${dash} ${dayOf(noon('16'))}`);
    });

    it('then a commit whose lines were all overwritten is hollow.', () => {
      assert.equal(dotOf(dots, 'Plant a hollow line'), 'gone');
    });

    it('then a commit with changes to review is amber.', () => {
      assert.equal(dotOf(dots, 'Pass the name'), 'left');
    });

    it('then the commit that deleted lib/gone.dart still has that deletion to review.', () => {
      assert.equal(dotOf(dots, 'Delete the old file'), 'left');
    });

    it('then your review is flagged on the merge.', () => {
      assert.equal(flag, `Your review${whenOf(noon('20'))}`);
    });

    it('then the merge says it brings 2 commits from main.', () => {
      assert.equal(merge, `${short('Merge main')} ${dot} Ada Review ${dot} ${dayOf(noon('12'))} ${dot} brings 2 commits from main`);
    });
  });

  describe('when Show them is clicked on the merge, ', () => {
    let brought: string;

    before(async () => {
      await rest(page!);
      await history(page!);
      await page!.click(`[data-act="brought"][data-sha="${sha['Merge main']}"]`);
      await page!.until(`[...document.querySelectorAll('.hs-sub-s')].map((el) => el.textContent).join('\\n') === 'Add a note on main\\nAdd extra on main'`);
      brought = await read(page!, `[...document.querySelectorAll('.hs-sub-s')].map((el) => el.textContent).join('\\n')`);
    });

    it('then the two commits from main are listed.', () => {
      assert.equal(brought, 'Add a note on main\nAdd extra on main');
    });
  });

  describe('when History is opened at 760 pixels wide, ', () => {
    let fit: string;

    before(async () => {
      await page!.setViewport(760, 900);
      await rest(page!);
      await history(page!);
      fit = await read(page!, `(() => { const root = document.documentElement; const box = document.querySelector('#viewer'); return root.scrollWidth <= root.clientWidth && box.scrollWidth <= box.clientWidth ? 'fits' : root.scrollWidth + ' > ' + root.clientWidth; })()`);
    });

    after(async () => {
      await page?.setViewport(1400, 900);
    });

    it('then the page does not scroll sideways.', () => {
      assert.equal(fit, 'fits');
    });
  });

  describe('when the commit written by someone else is opened, ', () => {
    let facts: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Commit it later']);
      facts = await read(page!, factsOf);
    });

    it('then the committer and the committed time are shown.', () => {
      assert.equal(facts, [
        `Commit: ${sha['Commit it later']}`,
        `Parents: ${short('Mention the code')}`,
        'Author: Ada Review <ada@example.com>',
        'Committer: Grace Commit <grace@example.com>',
        `Date: ${fullWhen(noon('06'))}`,
        `Committed: ${fullWhen(noon('07'))}`,
      ].join('\n'));
    });
  });

  describe('when a commit with one author is opened, ', () => {
    let facts: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Mention the code']);
      facts = await read(page!, factsOf);
    });

    it('then no committer or committed time is shown.', () => {
      assert.equal(facts, [
        `Commit: ${sha['Mention the code']}`,
        `Parents: ${short('Overwrite the hollow line')}`,
        'Author: Ada Review <ada@example.com>',
        `Date: ${fullWhen(noon('05'))}`,
      ].join('\n'));
    });
  });

  describe('when the commit that mentions code and an issue is opened, ', () => {
    let message: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Mention the code']);
      message = await read(page!, `document.querySelector('.hd-msg')?.innerHTML ?? ''`);
    });

    it('then code is code, and the issue and the address are links.', () => {
      assert.equal(message, `<p class="hd-subj">Mention the code</p><p class="hd-text">Call <code>greet</code> from ${link('https://github.com/acme/sample/issues/12', '#12')}.\nSee ${link('https://example.test/notes', 'https://example.test/notes')}.</p>`);
    });
  });

  describe('when an in-range parent is clicked, ', () => {
    let subject: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Commit it later']);
      await page!.click('[data-act="hd-go"]');
      await page!.until(`document.querySelector('.hs-detail')?.dataset.detailOf === ${JSON.stringify(sha['Mention the code'])}`);
      subject = await read(page!, `document.querySelector('.hd-subj')?.textContent ?? ''`);
    });

    it('then that parent\'s details open.', () => {
      assert.equal(subject, 'Mention the code');
    });
  });

  describe('when the first commit is opened, ', () => {
    let parents: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Plant a hollow line']);
      parents = await read(page!, `([...document.querySelectorAll('.hd-facts dt')].find((el) => el.textContent === 'Parents')?.nextElementSibling?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
    });

    it('then its parent outside the branch says where the branch starts.', () => {
      assert.equal(parents, `${short('Start the package')} where the branch starts`);
    });
  });

  describe('when the nested file\'s commit is opened, ', () => {
    let files: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Add a nested file']);
      files = await read(page!, `[...document.querySelectorAll('.hd-files .sb-row')].map((el) => (el.classList.contains('dir') ? 'dir ' : 'file ') + (el.querySelector('.nm')?.textContent ?? '') + ' ' + (el.querySelector('.cnt')?.textContent ?? '')).join('\\n')`);
    });

    it('then a folder that holds only a folder is shown with it, and the added file is green in its count.', () => {
      assert.equal(files, `dir lib/only/nested \nfile added.dart +1${minus}0`);
    });
  });

  describe('when that added file\'s row is measured, ', () => {
    let color: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Add a nested file']);
      color = await read(page!, `(() => { const el = document.querySelector('.hd-files .s-a:not(.away) .nm'); return (el?.textContent ?? '') + ' ' + (el ? getComputedStyle(el).color : ''); })()`);
    });

    it('then the added file is green.', () => {
      assert.equal(color, 'added.dart rgb(126, 226, 160)');
    });
  });

  describe('when the folder is collapsed, ', () => {
    let collapsed: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Add a nested file']);
      await page!.click('[data-act="hd-dir"]');
      await page!.until(`document.querySelector('[data-act="hd-dir"]')?.getAttribute('aria-expanded') === 'false'`);
      collapsed = await read(page!, `document.querySelector('[data-act="hd-dir"]')?.getAttribute('aria-expanded') + '\\n' + (document.querySelector('[data-act="hd-open"]') ? 'file' : 'hidden')`);
    });

    it('then the file under it is hidden.', () => {
      assert.equal(collapsed, 'false\nhidden');
    });
  });

  describe('when the files are shown as a list and the page is reloaded, ', () => {
    let name: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Add a nested file']);
      await page!.click('[data-act="hd-view"][data-v="list"]');
      await page!.until(`(document.querySelector('.hd-files .nm')?.textContent ?? '') === 'lib/only/nested/added.dart'`);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await details(page!, sha['Add a nested file']);
      name = await read(page!, `document.querySelector('.hd-files .nm')?.textContent ?? ''`);
    });

    after(async () => {
      await page?.eval(`localStorage.setItem('untangle:ui', JSON.stringify({ filesList: false }))`);
      await page?.goto(url);
      await page?.until(`!!document.querySelector('.t-head')`, 30_000);
    });

    it('then the whole path is still shown.', () => {
      assert.equal(name, 'lib/only/nested/added.dart');
    });
  });

  describe('when the deleting commit is opened, ', () => {
    let row: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Delete the old file']);
      row = await read(page!, `(() => { const el = document.querySelector('.hd-files .s-d .nm'); return (el?.textContent ?? '') + ' ' + (el ? getComputedStyle(el).textDecorationLine : ''); })()`);
    });

    it('then the deleted file is struck through.', () => {
      assert.equal(row, 'gone.dart line-through');
    });
  });

  describe('when the renaming commit is opened, ', () => {
    let name: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Rename the file']);
      name = await read(page!, `document.querySelector('.hd-files .s-r .nm')?.textContent ?? ''`);
    });

    it('then the file says where it was renamed from.', () => {
      assert.equal(name, 'renamed.dartfrom lib/old.dart');
    });
  });

  describe('when the binary commit is opened, ', () => {
    let row: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Add a binary']);
      row = await read(page!, `[...document.querySelectorAll('.hd-files .sb-row')].filter((el) => !el.classList.contains('dir')).map((el) => el.tagName + ' ' + (el.classList.contains('away') ? 'away' : 'in') + ' ' + (el.querySelector('.cnt')?.textContent ?? '')).join('\\n')`);
    });

    it('then the file is shown as binary.', () => {
      assert.equal(row, 'BUTTON in binary');
    });
  });

  describe('when the commit that touches a generated file is opened, ', () => {
    let row: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Pass the name']);
      row = await read(page!, `(() => { const el = document.querySelector('.hd-files .gen'); return (el?.tagName ?? '') + ' ' + (el?.querySelector('.fn')?.textContent ?? ''); })()`);
    });

    it('then the generated file is listed and can be opened.', () => {
      assert.equal(row, 'BUTTON app.g.dart');
    });
  });

  describe('when the merge is opened, ', () => {
    let header: string;
    let files: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Merge main']);
      header = await read(page!, `document.querySelector('.hd-fh')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`);
      files = await read(page!, `[...document.querySelectorAll('.hd-files .sb-row')].filter((el) => !el.classList.contains('dir')).map((el) => el.tagName + ' ' + (el.classList.contains('away') ? 'away' : 'in') + ' ' + (el.querySelector('.fn')?.textContent ?? '')).join('\\n')`);
    });

    it('then its files are against its first parent.', () => {
      assert.equal(header, `2 files ${dot} +2 ${minus}0 ${dot} against ${short('Add a binary')}, its first parent`);
    });

    it('then files outside the final diff are dimmed and can be read at this commit.', () => {
      assert.equal(files, 'BUTTON away extra.dart\nBUTTON away note.dart');
    });
  });

  describe('when a file in the commit is clicked, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Add a nested file']);
      await page!.click('[data-act="hd-open"][data-p="lib/only/nested/added.dart"]');
      await page!.until(`!!document.querySelector('.hs-detail .peek .pk-ln[data-n="1"]')`);
      opened = await read(page!, `[document.querySelector('.fv-head .crumbs')?.textContent, document.querySelector('.peek .pk-loc')?.textContent, document.querySelector('.peek .pk-src')?.textContent].join('\\n')`);
    });

    it('then the file opens inside the expanded commit, keeping History in view.', () => {
      assert.equal(opened, `History\nlib/only/nested/added.dart\nCommit ${short('Add a nested file')}`);
    });
  });

  describe('when the details of a commit with changes to review are opened, ', () => {
    let offer: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Pass the name']);
      offer = await read(page!, `document.querySelector('[data-act="hd-review"]')?.textContent ?? ''`);
    });

    it('then they offer to review its changes still to review.', () => {
      assert.equal(offer, 'Review its changes · 2');
    });
  });

  describe('when Review its changes is clicked, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Pass the name']);
      await page!.click('[data-act="hd-review"]');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('greet(name)')`);
      opened = await read(page!, `[document.querySelector('.crumbs')?.textContent ?? '', ${topBar}].join('\\n')`);
    });

    it('then the chain opens under that commit\'s lens.', () => {
      assert.equal(opened, `Map/greet(name)\n${short('Pass the name')} ${dot} Pass the name`);
    });
  });

  describe('when Only its changes is clicked, ', () => {
    let on: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Name the parameter']);
      await page!.click('[data-act="hd-lens"]');
      await page!.until(`document.querySelector('[data-act="hd-lens"]')?.getAttribute('aria-pressed') === 'true'`);
      on = await read(page!, `[document.querySelector('[data-act="hd-lens"]')?.getAttribute('aria-pressed') ?? '', document.querySelector('[data-act="lens-go"]')?.textContent ?? '', ${topBar}].join('\\n')`);
    });

    it('then the lens turns on and History offers to review those changes.', () => {
      assert.equal(on, `true\nReview these changes · 1\n${short('Name the parameter')} ${dot} Name the parameter`);
    });
  });

  describe('when Only its changes is clicked again, ', () => {
    let off: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Name the parameter']);
      await page!.click('[data-act="hd-lens"]');
      await page!.until(`document.querySelector('[data-act="hd-lens"]')?.getAttribute('aria-pressed') === 'true'`);
      await page!.click('[data-act="hd-lens"]');
      await page!.until(`document.querySelector('[data-act="hd-lens"]')?.getAttribute('aria-pressed') === 'false'`);
      off = await read(page!, `[document.querySelector('[data-act="hd-lens"]')?.getAttribute('aria-pressed') ?? '', ${topBar}].join('\\n')`);
    });

    it('then the lens turns off.', () => {
      assert.equal(off, `false\n${short('Pass the name')}`);
    });
  });

  describe('when another commit is shift-clicked, ', () => {
    let label: string;

    before(async () => {
      await rest(page!);
      await history(page!);
      await page!.click(`.hs-main[data-detail="${sha['Pass the name']}"]`);
      await page!.shiftClick(`.hs-main[data-detail="${sha['Name the parameter']}"]`);
      await page!.until(`document.querySelector('.t-head')?.textContent === '2 commits'`);
      label = await read(page!, topBar);
    });

    it('then the lens is the commits between them.', () => {
      assert.equal(label, '2 commits');
    });
  });

  describe('when Escape is pressed with details and a lens open, ', () => {
    let afterDetails: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Name the parameter']);
      await page!.click('[data-act="hd-lens"]');
      await page!.until(`document.querySelector('[data-act="hd-lens"]')?.getAttribute('aria-pressed') === 'true'`);
      await page!.key('Escape');
      await page!.until(`!document.querySelector('.hs-detail')`);
      afterDetails = await read(page!, `['closed', ${topBar}].join('\\n')`);
    });

    it('then the details close and the lens stays.', () => {
      assert.equal(afterDetails, `closed\n${short('Name the parameter')} ${dot} Name the parameter`);
    });
  });

  describe('when Escape is pressed again, ', () => {
    let afterLens: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Name the parameter']);
      await page!.click('[data-act="hd-lens"]');
      await page!.until(`document.querySelector('[data-act="hd-lens"]')?.getAttribute('aria-pressed') === 'true'`);
      await page!.key('Escape');
      await page!.until(`!document.querySelector('.hs-detail')`);
      await page!.key('Escape');
      await page!.until(`document.querySelector('.t-head')?.textContent === ${JSON.stringify(short('Pass the name'))}`);
      afterLens = await read(page!, topBar);
    });

    it('then the lens turns off.', () => {
      assert.equal(afterLens, short('Pass the name'));
    });
  });

  describe('when the details\' close button is clicked, ', () => {
    let open: string;

    before(async () => {
      await rest(page!);
      await details(page!, sha['Mention the code']);
      await page!.click('[data-act="hd-close"]');
      await page!.until(`!document.querySelector('.hs-detail')`);
      open = await read(page!, `document.querySelector('.hs-detail') ? 'open' : 'closed'`);
    });

    it('then the details close.', () => {
      assert.equal(open, 'closed');
    });
  });

  describe('when Changes from is opened, ', () => {
    let presets: string;
    let rows: string;
    let flag: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      presets = await read(page!, `[...document.querySelectorAll('.lp-pre')].map((el) => { const label = el.querySelector('span')?.childNodes[0]?.textContent ?? ''; const sub = el.querySelector('em')?.textContent ?? ''; const n = el.querySelector('b')?.textContent ?? ''; return [label, sub, n].filter(Boolean).join(' | '); }).join('\\n')`);
      rows = await read(page!, `[...document.querySelectorAll('.lp-list > button')].map((el) => el.classList.contains('lp-flag') ? 'Your review' : (el.querySelector('.lp-s')?.textContent ?? '') + ' | ' + (el.querySelector('svg.lanes') ? 'lane' : 'no-lane')).join('\\n')`);
      flag = await read(page!, `document.querySelector('.lp-flag')?.textContent ?? ''`);
    });

    it('then the presets are every change, the review and the last commit that is not a merge.', () => {
      assert.equal(presets, [
        'All changes | 6',
        `Since your review | ${dayOf(noon('20'))} ${dot} 2 commits | 2`,
        `The last commit with changes | ${short('Pass the name')} | 2`,
      ].join('\n'));
    });

    it('then each commit is a row with a lane, and your review is flagged.', () => {
      assert.equal(rows, [
        'Pass the name | lane',
        'Name the parameter | lane',
        'Your review',
        ...newestFirst.slice(2).map((subject) => `${subject} | lane`),
      ].join('\n'));
    });

    it('then the flag names your review.', () => {
      assert.equal(flag, `Your review${whenOf(noon('20'))}`);
    });
  });

  describe('when a commit in Changes from is clicked, ', () => {
    let label: string;
    let pressed: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      await page!.click(`.lp-row[data-commit="${sha['Pass the name']}"]`);
      await page!.until(`document.querySelector('.menu')?.hidden === true`);
      label = await read(page!, topBar);
      await changesFrom(page!);
      pressed = await read(page!, `document.querySelector('.lp-row[data-commit="${sha['Pass the name']}"]')?.getAttribute('aria-pressed') ?? ''`);
    });

    it('then the popover closes and the top bar names that commit.', () => {
      assert.equal(label, `${short('Pass the name')} ${dot} Pass the name`);
    });

    it('then that row is pressed when Changes from is opened again.', () => {
      assert.equal(pressed, 'true');
    });
  });

  describe('when a second commit in Changes from is shift-clicked, ', () => {
    let label: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      await page!.click(`.lp-row[data-commit="${sha['Pass the name']}"]`);
      await page!.until(`document.querySelector('.menu')?.hidden === true`);
      await changesFrom(page!);
      await page!.shiftClick(`.lp-row[data-commit="${sha['Name the parameter']}"]`);
      await page!.until(`document.querySelector('.t-head')?.textContent === '2 commits'`);
      label = await read(page!, topBar);
    });

    it('then the lens is the commits between them.', () => {
      assert.equal(label, '2 commits');
    });
  });

  describe('when ArrowDown is pressed in Changes from, ', () => {
    let moved: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      await page!.until(`!!document.activeElement?.closest('.menu')`);
      const from = await read(page!, `document.activeElement?.querySelector('span')?.childNodes[0]?.textContent ?? ''`);
      await page!.key('ArrowDown');
      const to = await read(page!, `document.activeElement?.querySelector('span')?.childNodes[0]?.textContent ?? ''`);
      moved = `${from}\n${to}`;
    });

    it('then focus moves from All changes to Since your review.', () => {
      assert.equal(moved, 'All changes\nSince your review');
    });
  });

  describe('when Escape is pressed in Changes from, ', () => {
    let menu: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      await page!.key('Escape');
      await page!.until(`document.querySelector('.menu')?.hidden === true`);
      menu = await read(page!, `document.querySelector('.menu')?.hidden === true ? 'closed' : 'open'`);
    });

    it('then Changes from closes.', () => {
      assert.equal(menu, 'closed');
    });
  });

  describe('when History in Changes from is clicked, ', () => {
    let where: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      await page!.click('.lp-f [data-act="history-open"]');
      await page!.until(`!!document.querySelector('.hist')`);
      where = await read(page!, `document.querySelector('.crumbs')?.textContent ?? ''`);
    });

    it('then the History view opens.', () => {
      assert.equal(where, 'History');
    });
  });

  /** Opens the greeting's chain with Name the parameter as the lens. */
  async function chainUnderNameTheParameter(): Promise<void> {
    await rest(page!);
    await changesFrom(page!);
    await page!.click(`.lp-row[data-commit="${sha['Name the parameter']}"]`);
    await page!.until(`document.querySelector('.menu')?.hidden === true`);
    await chain(page!);
  }

  describe('when the chain is opened under one commit\'s lens, ', () => {
    let header: string;
    let lines: string;
    let counts: string;

    before(async () => {
      await chainUnderNameTheParameter();
      header = await read(page!, `[document.querySelector('.fv-head')?.textContent?.includes(${JSON.stringify(short('Name the parameter'))}) ? 'chip' : 'no chip', ${topBar}].join('\\n')`);
      lines = await read(page!, `[${lineFade('greet(String name)')}, ${lineFade('print(name)')}].join('\\n')`);
      counts = await read(page!, `[document.querySelector('.sb-prog b')?.textContent ?? '', document.querySelectorAll('.tick').length + ' ticks', document.querySelectorAll('.tick:not(.lens-out)').length + ' in the lens'].join('\\n')`);
    });

    it('then the view header has no lens chip and the top bar names the commit.', () => {
      assert.equal(header, `no chip\n${short('Name the parameter')} ${dot} Name the parameter`);
    });

    it('then lines outside the commit fade.', () => {
      assert.equal(lines, 'shown\nfaded');
    });

    it('then the sidebar counts only the change in the lens, the one of its two marks not faded.', () => {
      assert.equal(counts, '1\n2 ticks\n1 in the lens');
    });
  });

  describe('when j is pressed in a chain under one commit\'s lens, ', () => {
    let pill: string;

    before(async () => {
      await chainUnderNameTheParameter();
      await page!.key('j');
      await page!.until(`(document.querySelector('.pill-n')?.textContent || '').includes('of')`);
      pill = await read(page!, `document.querySelector('.pill-n')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`);
    });

    it('then the pill counts only the change in the lens.', () => {
      assert.equal(pill, '1 of 1');
    });
  });

  describe('when a chain is opened under a commit that did not touch it, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      await page!.click(`.lp-row[data-commit="${sha['Add a nested file']}"]`);
      await page!.until(`document.querySelector('.menu')?.hidden === true`);
      await chain(page!);
      await page!.until(`!!document.querySelector('.pill-msg')`);
      shown = await read(page!, `[document.querySelector('.fv-head .facts')?.textContent ?? '', String(document.querySelectorAll('[data-act="mark-blocks"], [data-act="mark-chain"], .tick:not(.lens-out)').length), document.querySelector('.pill-msg')?.textContent ?? ''].join('\\n')`);
    });

    it('then the view says nothing is in the lens and offers no mark.', () => {
      const [facts, marks, pill] = shown.split('\n');
      assert.equal(`${facts.includes('nothing in the lens') ? 'nothing in the lens' : facts}\n${marks}\n${pill}`, 'nothing in the lens\n0\nNothing in the lens here');
    });
  });

  describe('when All changes is clicked, ', () => {
    let label: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      await page!.click(`.lp-row[data-commit="${sha['Name the parameter']}"]`);
      await page!.until(`document.querySelector('.menu')?.hidden === true`);
      await changesFrom(page!);
      await page!.click('[data-act="lens-all"]');
      await page!.until(`document.querySelector('.t-head')?.textContent === ${JSON.stringify(short('Pass the name'))}`);
      label = await read(page!, topBar);
    });

    it('then the lens turns off.', () => {
      assert.equal(label, short('Pass the name'));
    });
  });

  describe('when Escape is pressed while a lens is on, ', () => {
    let label: string;

    before(async () => {
      await rest(page!);
      await changesFrom(page!);
      await page!.click(`.lp-row[data-commit="${sha['Name the parameter']}"]`);
      await page!.until(`document.querySelector('.menu')?.hidden === true`);
      await page!.key('Escape');
      await page!.until(`document.querySelector('.t-head')?.textContent === ${JSON.stringify(short('Pass the name'))}`);
      label = await read(page!, topBar);
    });

    it('then the lens turns off.', () => {
      assert.equal(label, short('Pass the name'));
    });
  });

  describe('when the Commits tab is opened, ', () => {
    let presets: string;
    let rows: string;
    let flag: string;

    before(async () => {
      await rest(page!);
      await commitsTab(page!);
      presets = await read(page!, `[...document.querySelectorAll('.cm-pre')].map((el) => (el.querySelector('.nm')?.textContent ?? '') + ' ' + (el.querySelector('.cnt')?.textContent ?? '')).join('\\n')`);
      rows = await read(page!, `[...document.querySelectorAll('.cm-list > button')].map((el) => el.classList.contains('cm-flag') ? 'Your review' : (el.querySelector('.cm-s')?.textContent ?? '')).join('\\n')`);
      flag = await read(page!, `document.querySelector('.cm-flag')?.textContent ?? ''`);
    });

    it('then its presets are every change and the review.', () => {
      assert.equal(presets, 'All changes 6\nSince your review 2');
    });

    it('then the commits are listed and your review is flagged.', () => {
      assert.equal(rows, [
        'Pass the name',
        'Name the parameter',
        'Your review',
        ...newestFirst.slice(2),
      ].join('\n'));
    });

    it('then the flag names your review.', () => {
      assert.equal(flag, `Your review${whenOf(noon('20'))}`);
    });
  });

  describe('when a commit in the Commits tab is clicked, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await commitsTab(page!);
      await page!.click(`.cm-row[data-commit="${sha['Pass the name']}"]`);
      await page!.until(`document.querySelector('.t-head')?.textContent === ${JSON.stringify(`${short('Pass the name')} ${dot} Pass the name`)}`);
      shown = await read(page!, `[document.querySelector('.hs-detail') ? 'details' : 'no details', ${topBar}].join('\\n')`);
    });

    it('then the commit is a lens and its details stay closed.', () => {
      assert.equal(shown, `no details\n${short('Pass the name')} ${dot} Pass the name`);
    });
  });

  describe('when a second commit in the Commits tab is shift-clicked, ', () => {
    let label: string;

    before(async () => {
      await rest(page!);
      await commitsTab(page!);
      await page!.click(`.cm-row[data-commit="${sha['Pass the name']}"]`);
      await page!.until(`(document.querySelector('.t-head')?.textContent || '').includes('Pass the name')`);
      await page!.shiftClick(`.cm-row[data-commit="${sha['Name the parameter']}"]`);
      await page!.until(`document.querySelector('.t-head')?.textContent === '2 commits'`);
      label = await read(page!, topBar);
    });

    it('then the lens is the commits between them.', () => {
      assert.equal(label, '2 commits');
    });
  });

  describe('when the chain is opened with no lens, ', () => {
    let offer: string;

    before(async () => {
      await rest(page!);
      await chain(page!);
      await page!.until(`!!document.querySelector('.lens-offer')`);
      offer = await read(page!, `document.querySelector('.lens-offer')?.textContent ?? ''`);
    });

    it('then the header offers what is new since your review.', () => {
      assert.equal(offer, 'New since your review2');
    });
  });

  describe('when New since your review is clicked, ', () => {
    let faded: string;

    before(async () => {
      await rest(page!);
      await chain(page!);
      await page!.until(`!!document.querySelector('.lens-offer')`);
      await page!.click('.lens-offer');
      await page!.until(`(document.querySelector('.t-head')?.textContent || '').includes('Since your review')`);
      await page!.click('[data-tab="files"]');
      await page!.click('[data-open="lib/docs.dart"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/docs.dart"] .lens-out')`);
      const docs = await read(page!, `document.querySelector('.code[data-p="lib/docs.dart"] .lens-out') ? 'faded' : 'shown'`);
      await chain(page!);
      const greet = await read(page!, lineFade('greet(String name)'));
      faded = `${docs}\n${greet}`;
    });

    it('then lines that did not change since fade, and the new lines stay.', () => {
      assert.equal(faded, 'faded\nshown');
    });
  });

  /** Marks the greeting's function change under one commit's lens, opened from its details. */
  async function markUnder(subject: string): Promise<void> {
    await history(page!);
    await details(page!, sha[subject]);
    await page!.click('[data-act="hd-review"]');
    await page!.until(`!!document.querySelector('.sec')`);
    const id = await read(page!, `([...document.querySelectorAll('.sec')].find((el) => (el.textContent || '').includes('void greet(String name)')) || {}).id ?? ''`);
    await page!.click(`#${id} .tick:not(.lens-out)`);
    await waitForSave(page!);
    await page!.key('Escape');
    await page!.until(`!(document.querySelector('.t-head')?.textContent || '').includes(${JSON.stringify(subject)})`);
  }

  describe('when the function change is marked under its first commit, ', () => {
    let tick: string;
    let dots: string;

    before(async () => {
      await rest(page!);
      await markUnder('Name the parameter');
      tick = await read(page!, functionTick);
      await history(page!);
      dots = await read(page!, historyDots);
    });

    after(async () => {
      await resetMarks();
    });

    it('then the change is not reviewed as a whole.', () => {
      assert.equal(tick, 'false');
    });

    it('then that commit shows a check and the other commit stays amber.', () => {
      assert.equal(`${dotOf(dots, 'Name the parameter')}\n${dotOf(dots, 'Pass the name')}`, 'done\nleft');
    });
  });

  describe('when the function change is marked under both of its commits, ', () => {
    let tick: string;

    before(async () => {
      await rest(page!);
      await markUnder('Name the parameter');
      await markUnder('Pass the name');
      tick = await read(page!, functionTick);
    });

    after(async () => {
      await resetMarks();
    });

    it('then the change is reviewed.', () => {
      assert.equal(tick, 'reviewed');
    });
  });

  describe('when the page is reloaded after the function change was marked under both of its commits, ', () => {
    let tick: string;

    before(async () => {
      await rest(page!);
      await markUnder('Name the parameter');
      await markUnder('Pass the name');
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await chain(page!);
      tick = await read(page!, functionTick);
    });

    after(async () => {
      await resetMarks();
    });

    it('then the change is still reviewed.', () => {
      assert.equal(tick, 'reviewed');
    });
  });

  describe('when the function change is unmarked under the second commit\'s lens, ', () => {
    let tick: string;
    let dots: string;

    before(async () => {
      await rest(page!);
      await history(page!);
      await details(page!, sha['Name the parameter']);
      await page!.click('[data-act="hd-review"]');
      await page!.until(`!!document.querySelector('.sec:not(.lens-out) .tick:not(.lens-out)')`);
      await page!.click('.sec:not(.lens-out) .tick:not(.lens-out)');
      await waitForSave(page!);
      await page!.key('Escape');
      await page!.until(`!(document.querySelector('.t-head')?.textContent || '').includes('Name the parameter')`);
      await history(page!);
      await details(page!, sha['Pass the name']);
      await page!.click('[data-act="hd-review"]');
      await page!.until(`!!document.querySelector('.sec')`);
      const id = await read(page!, `([...document.querySelectorAll('.sec')].find((el) => (el.textContent || '').includes('void greet(String name)')) || {}).id ?? ''`);
      await page!.click(`#${id} .tick:not(.lens-out)`);
      await waitForSave(page!);
      await page!.click(`#${id} .tick:not(.lens-out)`);
      await waitForSave(page!);
      tick = await read(page!, functionTick);
      await page!.key('Escape');
      await history(page!);
      dots = await read(page!, historyDots);
    });

    after(async () => {
      await resetMarks();
    });

    it('then the change is open again and the first commit stays reviewed.', () => {
      assert.equal(`${tick}\n${dotOf(dots, 'Name the parameter')}\n${dotOf(dots, 'Pass the name')}`, 'false\ndone\nleft');
    });
  });

  describe('when the function change is marked under Since your review, ', () => {
    let pressed: string;

    before(async () => {
      await rest(page!);
      await chain(page!);
      await page!.until(`!!document.querySelector('.lens-offer')`);
      await page!.click('.lens-offer');
      await page!.until(`(document.querySelector('.t-head')?.textContent || '').includes('Since your review')`);
      const id = await read(page!, `([...document.querySelectorAll('.sec')].find((el) => (el.textContent || '').includes('void greet(String name)')) || {}).id ?? ''`);
      await page!.click(`#${id} .tick:not(.lens-out)`);
      await waitForSave(page!);
      await page!.key('Escape');
      await page!.until(`!(document.querySelector('.t-head')?.textContent || '').includes('Since your review')`);
      pressed = await read(page!, functionTick);
    });

    after(async () => {
      await resetMarks();
    });

    it('then the whole change is reviewed, not only the lines since.', () => {
      assert.equal(pressed, 'reviewed');
    });
  });

  describe('when each commit\'s lens is opened on the greeting, ', () => {
    let named: string;
    let passed: string;

    before(async () => {
      const blamed = blameOf(repoDir);
      const lines = async (subject: string) => {
        await rest(page!);
        await page!.click('[data-tab="commits"]');
        await page!.until(`!!document.querySelector('.cm-row')`);
        await page!.click(`.cm-row[data-commit="${sha[subject]}"]`);
        await page!.until(`(document.querySelector('.t-head')?.textContent || '').includes(${JSON.stringify(subject)})`);
        await chain(page!);
        const rows = JSON.parse(String(await page!.eval(`JSON.stringify([...document.querySelectorAll('.code[data-p="lib/app.dart"] .ln.add')].map((el) => ({ n: Number(el.querySelector('.no')?.textContent), faded: el.classList.contains('lens-out') })))`))) as Array<{ n: number; faded: boolean }>;
        if (!rows.length) throw new Error(`no added lines under ${subject}`);
        const seen = rows.map((row) => `${row.n} ${row.faded ? 'faded' : 'shown'}`).join(', ');
        const want = rows.map((row) => `${row.n} ${blamed.get(row.n) === sha[subject] ? 'shown' : 'faded'}`).join(', ');
        return `${seen}\n${want}`;
      };
      named = await lines('Name the parameter');
      passed = await lines('Pass the name');
    });

    it('then a line stays only when git blame says that commit wrote it.', () => {
      const [namedSeen, namedWant] = splitPair(named);
      const [passedSeen, passedWant] = splitPair(passed);
      assert.equal(`${namedSeen}\n${passedSeen}`, `${namedWant}\n${passedWant}`);
    });
  });
});

function splitPair(value: string): [string, string] {
  const at = value.indexOf('\n');
  return [value.slice(0, at), value.slice(at + 1)];
}

/** The head commit that wrote each line of lib/app.dart, from git blame. */
function blameOf(dir: string): Map<number, string> {
  const out = execFileSync('git', ['-C', dir, 'blame', '-l', '--', 'lib/app.dart'], { encoding: 'utf8' });
  const lines = new Map<number, string>();
  for (const line of out.split('\n')) {
    const sha = /^([0-9a-f]{40}) /.exec(line);
    const number = / (\d+)\)/.exec(line);
    if (sha && number) lines.set(Number(number[1]), sha[1]);
  }
  return lines;
}
