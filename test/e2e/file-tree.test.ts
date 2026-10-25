import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { browserSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

describe('Given two sibling folders with a file in each, ', { skip: browserSkip(), timeout: 120_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;

  before(async () => {
    const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-10-01T00:00:00Z' };
    repo = TempRepo.create();
    repo.write('README.txt', 'Start\n');
    repo.write('.review.yaml', 'generated:\n  - "**/generated/**"\n  - "**/migrations/**"\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/first/a.txt', 'First\n');
    repo.write('lib/last/b.txt', 'Last\n');
    repo.write('lib/generated/model.g.dart', 'const generated = 1;\n');
    repo.write('server/migrations/1/up.sql', 'CREATE TABLE example (id integer);\n');
    repo.commit({ subject: 'Add folders', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('[data-tab="files"]')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the file tree is expanded, ', () => {
    let guides: unknown;

    before(async () => {
      await page.click('[data-tab="files"]');
      guides = await page.eval(`[...document.querySelectorAll('#vw-side .tr')].map(row => ({
        name: row.querySelector('.nm').textContent,
        guides: [...row.querySelectorAll('.ig')].map(line => [line.style.left, line.classList.contains('elbow')])
      }))`);
    });

    it('then each parent guide ends at its last child, and does not continue through that child’s descendants.', () => {
      assert.deepEqual(guides, [
        { name: 'lib', guides: [] },
        { name: 'first', guides: [['14px', false]] },
        { name: 'a.txt', guides: [['14px', false], ['28px', true]] },
        { name: 'last', guides: [['14px', true]] },
        { name: 'b.txt', guides: [['28px', true]] },
      ]);
    });
  });

  describe('when the last folder is collapsed, ', () => {
    let guides: unknown;
    let folders: unknown;

    before(async () => {
      await page.click('[data-dir="lib/last"]');
      guides = await page.eval(`[...document.querySelectorAll('#vw-side [data-dir="lib/last"] .ig')].map(line => [line.style.left, line.classList.contains('elbow')])`);
      folders = await page.eval(`[...document.querySelectorAll('#vw-side .sb-row.dir')].map(row => [row.dataset.dir, row.querySelector('.cnt > .mk') ? 'mark' : 'no mark', row.querySelector('.cnt').textContent, row.title])`);
    });

    it('then the outer guide still closes at that folder.', () => {
      assert.deepEqual(guides, [['14px', true]]);
    });

    it('then it says what\'s left inside it by its count, with no mark, and so when hovered; the open folders show their files\' marks instead.', () => {
      assert.deepEqual(folders, [
        ['lib', 'no mark', '2', 'lib/'],
        ['lib/first', 'no mark', '1', 'lib/first/'],
        ['lib/last', 'no mark', '1', 'lib/last/: 1 change to review inside'],
      ]);
    });
  });

  describe('when the Files tab first shows generated files and migrations, ', () => {
    let sections: unknown;

    before(async () => {
      sections = await page.eval(`[...document.querySelectorAll('[data-act="file-section"]')].map(button => [button.textContent, button.getAttribute('aria-expanded'), document.getElementById(button.getAttribute('aria-controls')).hidden])`);
    });

    it('then the two sections start collapsed with their own expansion buttons.', () => {
      assert.deepEqual(sections, [
        ['Generated, not reviewed1 · Expand', 'false', true],
        ['Migrations, not reviewed1 · Expand', 'false', true],
      ]);
    });
  });

  describe('when generated files are expanded, ', () => {
    let files: unknown;

    before(async () => {
      await page.click('[data-section="generated"]');
      files = await page.eval(`[...document.querySelectorAll('#files-generated [data-open], #files-migrations [data-open]')].map(row => row.dataset.open)`);
    });

    it('then only generated files are revealed.', () => {
      assert.deepEqual(files, ['lib/generated/model.g.dart']);
    });
  });

  describe('when migrations are also expanded, ', () => {
    let files: unknown;

    before(async () => {
      await page.click('[data-section="migrations"]');
      files = await page.eval(`[...document.querySelectorAll('#files-generated [data-open], #files-migrations [data-open]')].map(row => row.dataset.open)`);
    });

    it('then each section holds its own files.', () => {
      assert.deepEqual(files, ['lib/generated/model.g.dart', 'server/migrations/1/up.sql']);
    });
  });

  describe('when generated files are collapsed again, ', () => {
    let sections: unknown;

    before(async () => {
      await page.click('[data-section="generated"]');
      sections = await page.eval(`[...document.querySelectorAll('[data-act="file-section"]')].map(button => [button.dataset.section, button.getAttribute('aria-expanded'), document.getElementById(button.getAttribute('aria-controls')).hidden])`);
    });

    it('then migrations stay expanded.', () => {
      assert.deepEqual(sections, [['generated', 'false', true], ['migrations', 'true', false]]);
    });
  });
});

// A file's name in the Files tab, and the color it's drawn in, named by the page's own colors.
const named = `(() => {
  const ink = (name) => { const probe = document.createElement('i'); probe.style.color = 'var(--' + name + ')'; document.body.appendChild(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; };
  const inks = ['text', 'text-3', 'add-ink', 'add-no', 'del-ink', 'del-no'].map((name) => [name, ink(name)]);
  return [...document.querySelectorAll('#vw-side .sb-row.tr:not(.dir)')].map((row) => {
    const nm = getComputedStyle(row.querySelector('.nm'));
    return row.querySelector('.nm').textContent + ' ' + (inks.find(([, color]) => color === nm.color) || [nm.color])[0] + (nm.textDecorationLine === 'line-through' ? ', struck' : '');
  }).join('\\n');
})()`;

describe('Given a file added, one changed and one deleted, ', { skip: browserSkip(), timeout: 120_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;

  before(async () => {
    const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-10-01T00:00:00Z' };
    repo = TempRepo.create();
    repo.write('lib/changed.txt', 'Before\n');
    repo.write('lib/deleted.txt', 'Gone soon\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/added.txt', 'New\n');
    repo.write('lib/changed.txt', 'After\n');
    repo.delete('lib/deleted.txt');
    repo.commit({ subject: 'Add, change and delete', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('[data-tab="files"]')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the Files tab is opened, ', () => {
    let files: string;
    let titles: string;

    before(async () => {
      await page.click('[data-tab="files"]');
      await page.until(`!!document.querySelector('[data-open="lib/added.txt"]')`);
      files = await page.eval(named) as string;
      titles = await page.eval(`[...document.querySelectorAll('#vw-side [data-open]')].map((row) => row.title).join('\\n')`) as string;
    });

    it('then the added file is green, the deleted one red and struck through, and the changed one as it was.', () => {
      assert.equal(files, ['added.txt add-ink', 'changed.txt text', 'deleted.txt del-ink, struck'].join('\n'));
    });

    it('then each says so when hovered.', () => {
      assert.equal(titles, ['lib/added.txt: added, 1 change', 'lib/changed.txt: 1 change', 'lib/deleted.txt: deleted, 1 change'].join('\n'));
    });
  });

  describe('when the added and the deleted files are marked reviewed, ', () => {
    let files: string;

    before(async () => {
      for (const file of ['lib/added.txt', 'lib/deleted.txt']) {
        await page.click(`[data-open="${file}"]`);
        await page.until(`!!document.querySelector('.fv-head [data-act="mark-file"]') && (document.querySelector('.crumbs b')?.title === ${JSON.stringify(file)})`);
        await page.click('.fv-head [data-act="mark-file"]');
        await page.until(`document.querySelector('[data-open="${file}"]')?.classList.contains('done')`);
      }
      files = await page.eval(named) as string;
    });

    it('then they keep their hues, dimmed as the names of reviewed files are.', () => {
      assert.equal(files, ['added.txt add-no', 'changed.txt text', 'deleted.txt del-no, struck'].join('\n'));
    });
  });

  describe('when the folder is collapsed with the changed file left to review, then again once it\'s reviewed too, ', () => {
    const folder = `(() => { const row = document.querySelector('[data-dir="lib"]'); const count = row.querySelector('.cnt').textContent; return (row.querySelector('.cnt > .mk.ok') ? 'check' : row.querySelector('.cnt > .mk') ? 'mark' : 'no mark') + (count ? ' ' + count : '') + ' · ' + row.title; })()`;
    const closed = `document.querySelector('[data-dir="lib"]')?.getAttribute('aria-expanded') === 'false'`;
    let left: string;
    let none: string;

    before(async () => {
      await page.click('[data-dir="lib"]');
      await page.until(closed);
      left = await page.eval(folder) as string;
      await page.click('[data-dir="lib"]');
      await page.until(`!!document.querySelector('[data-open="lib/changed.txt"]')`);
      await page.click('[data-open="lib/changed.txt"]');
      await page.until(`document.querySelector('.crumbs b')?.title === 'lib/changed.txt'`);
      await page.click('.fv-head [data-act="mark-file"]');
      await page.until(`document.querySelector('[data-open="lib/changed.txt"]')?.classList.contains('done')`);
      await page.click('[data-dir="lib"]');
      await page.until(closed);
      none = await page.eval(folder) as string;
    });

    it('then, with the change left, the folder shows its count, with no mark.', () => {
      assert.equal(left, 'no mark 1 · lib/: 1 change to review inside');
    });

    it('then, all reviewed, a check takes its count\'s place.', () => {
      assert.equal(none, 'check · lib/');
    });
  });
});

// The open menu: its folder, then each item: its mark, its name, its count, whether it's where the
// file open is, and whether it has the focus.
const menuShown = `(() => {
  const menu = document.querySelector('.menu:not([hidden])');
  if (!menu) return 'no menu';
  return [menu.querySelector('.mi-h').textContent, ...[...menu.querySelectorAll('.mi')].map((item) => {
    const mk = item.querySelector('.ic .mk');
    const mark = !mk ? '-' : mk.classList.contains('gen') ? 'ring' : mk.classList.contains('ok') ? 'check' : 'dot';
    const count = item.querySelector('.k').textContent;
    return [mark, item.children[1].textContent, count && '(' + count + ')', item.getAttribute('aria-current') && 'current', item === document.activeElement && 'focused'].filter(Boolean).join(' ');
  })].join('\\n');
})()`;

describe('Given a file deep in folders, beside another, with a generated folder and a file one folder up, and files the review doesn\'t change, ', { skip: browserSkip(), timeout: 120_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;
  const deep = 'packages/long_package_name_here/lib/src/feature';

  before(async () => {
    const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-10-01T00:00:00Z' };
    repo = TempRepo.create();
    repo.write('.review.yaml', 'generated:\n  - "**/generated/**"\n');
    repo.write(`${deep}/model.txt`, 'Model\n');
    repo.write(`${deep}/widgets/icon.txt`, 'Icon\n');
    repo.write(`${deep}/theme/colors.txt`, 'Colors\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write(`${deep}/widgets/button.txt`, 'Button\n');
    repo.write(`${deep}/widgets/card.txt`, 'Card\n');
    repo.write(`${deep}/model.txt`, 'Model, changed\n');
    repo.write(`${deep}/generated/model.g.txt`, 'Generated\n');
    repo.commit({ subject: 'Add widgets', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('[data-tab="files"]')`);
    await page.click('[data-tab="files"]');
    await page.until(`!!document.querySelector('[data-open="${deep}/widgets/button.txt"]')`);
    await page.click(`[data-open="${deep}/widgets/button.txt"]`);
    await page.until(`document.querySelector('.crumbs b')?.title === '${deep}/widgets/button.txt'`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the file is open, ', () => {
    let crumbs: string;

    before(async () => {
      crumbs = await page.eval(`[...document.querySelectorAll('.crumbs .path button')].map((b) => b.textContent + ' ' + b.title).join('\\n')`) as string;
    });

    it('then each of its last folders is a button, and the first ones fold into one, the deepest of them.', () => {
      assert.equal(crumbs, [
        '… packages/long_package_name_here/: the files in it',
        `lib packages/long_package_name_here/lib/: the files in it`,
        `src packages/long_package_name_here/lib/src/: the files in it`,
        `feature ${deep}/: the files in it`,
        `widgets ${deep}/widgets/: the files in it`,
      ].join('\n'));
    });
  });

  describe('when its folder is clicked, then .. twice, then the first folded folder, ', () => {
    let own: string;
    let up: string;
    let top: string;
    let folded: string;

    before(async () => {
      await page.click('.crumbs [data-menu="crumb:5"]');
      await page.until(`!!document.querySelector('.menu:not([hidden]) .mi')`);
      own = await page.eval(menuShown) as string;
      await page.click('.menu .mi[data-up]');
      await page.until(`document.querySelector('.menu .mi-h')?.textContent === '…/long_package_name_here/lib/src/feature/'`);
      up = await page.eval(menuShown) as string;
      await page.click('.menu .mi[data-up]');
      await page.until(`document.querySelector('.menu .mi-h')?.textContent === 'Top level'`);
      top = await page.eval(menuShown) as string;
      await page.click('.crumbs [data-menu="crumb:1"]');
      await page.until(`document.querySelector('.menu .mi-h')?.textContent === 'packages/long_package_name_here/'`);
      folded = await page.eval(menuShown) as string;
    });

    it('then its menu lists the files beside it, the file open current and focused, and the repository\'s others without a mark.', () => {
      assert.equal(own, ['…/lib/src/feature/widgets/', '- ..', 'dot button.txt (1) current focused', 'dot card.txt (1)', '- icon.txt'].join('\n'));
    });

    it('then up, the folder above lists its folders first, the generated one ringed, and the folder it came from has the focus.', () => {
      assert.equal(up, ['…/long_package_name_here/lib/src/feature/', '- ..', 'ring generated/', '- theme/', 'dot widgets/ (2) current focused', 'dot model.txt (1)'].join('\n'));
    });

    it('then up again, it passes the folders that hold only one folder, to the top, where they show with it.', () => {
      assert.equal(top, ['Top level', `dot ${deep}/ (3) current focused`, '- .review.yaml'].join('\n'));
    });

    it('then the folded folders open on the deepest of them.', () => {
      assert.equal(folded, ['packages/long_package_name_here/', '- ..', 'dot lib/src/feature/ (3) current focused'].join('\n'));
    });
  });

  describe('when a folder in the menu is clicked, then a file in it, ', () => {
    let inside: string;
    let opened: string;

    before(async () => {
      await page.click('.menu .mi[data-act="crumb-dir"]:not([data-up])');
      await page.until(`document.querySelector('.menu .mi-h')?.textContent === '…/long_package_name_here/lib/src/feature/'`);
      inside = await page.eval(menuShown) as string;
      await page.click(`.menu .mi[data-open="${deep}/model.txt"]`);
      await page.until(`document.querySelector('.crumbs b')?.title === '${deep}/model.txt'`);
      opened = await page.eval(`[document.querySelector('.crumbs b').title, document.querySelector('.menu:not([hidden])') ? 'menu open' : 'menu closed'].join('\\n')`) as string;
    });

    it('then the menu opens that folder, what leads to the file open current and focused.', () => {
      assert.equal(inside, ['…/long_package_name_here/lib/src/feature/', '- ..', 'ring generated/', '- theme/', 'dot widgets/ (2) current focused', 'dot model.txt (1)'].join('\n'));
    });

    it('then the file opens, and the menu closes.', () => {
      assert.equal(opened, [`${deep}/model.txt`, 'menu closed'].join('\n'));
    });
  });

  describe('when a folder the review doesn\'t change is opened in the menu, then its file, then the file\'s own folder, ', () => {
    let folder: string;
    let opened: string;
    let own: string;

    before(async () => {
      await page.click('.crumbs [data-menu="crumb:4"]');
      await page.until(`!!document.querySelector('.menu:not([hidden]) .mi[data-folder="${deep}/theme"]')`);
      await page.click(`.menu .mi[data-folder="${deep}/theme"]`);
      await page.until(`document.querySelector('.menu .mi-h')?.textContent === '…/lib/src/feature/theme/'`);
      folder = await page.eval(`${menuShown} + '\\n' + document.querySelector('.menu .mi[data-p]').title`) as string;
      await page.click('.menu .mi[data-p]');
      await page.until(`document.querySelector('.crumbs b')?.title === '${deep}/theme/colors.txt' && !!document.querySelector('.code.src .ln')`);
      opened = await page.eval(`[document.querySelector('.fv-head .facts').textContent, document.querySelector('.code.src').textContent, document.querySelector('.menu:not([hidden])') ? 'menu open' : 'menu closed'].join('\\n')`) as string;
      await page.click('.crumbs [data-menu="crumb:5"]');
      await page.until(`!!document.querySelector('.menu:not([hidden]) .mi')`);
      own = await page.eval(menuShown) as string;
    });

    it('then the folder lists its file, unmarked and focused, which says it has no changes.', () => {
      assert.equal(folder, ['…/lib/src/feature/theme/', '- ..', '- colors.txt focused', `${deep}/theme/colors.txt: no changes in this review`].join('\n'));
    });

    it('then the file opens whole, as it is after the changes, and the menu closes.', () => {
      assert.match(opened, /^After these changes, at [0-9a-f]{7} · 1 line\n1Colors\nmenu closed$/);
    });

    it('then its folder\'s menu has it current and focused.', () => {
      assert.equal(own, ['…/lib/src/feature/theme/', '- ..', '- colors.txt current focused'].join('\n'));
    });
  });
});
