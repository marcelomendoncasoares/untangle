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

// VS Code's Dark+ theme (shiki/themes/dark-plus), not the page's stylesheet.
const darkPlus = {
  string: '#CE9178',
  function: '#DCDCAA',
  control: '#C586C0',
  variable: '#9CDCFE',
  type: '#4EC9B0',
};

function rgb(hex: string): string {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

const sample = `(() => {
  const pick = (selector, text) => [...document.querySelectorAll(selector)].find((el) => el.textContent === text);
  const paint = (el) => {
    const theme = [...el.classList].find((name) => /^k\\d+$/.test(name));
    const rule = theme && [...(document.querySelector('style')?.sheet?.cssRules || [])].find((item) => item.selectorText === '.' + theme);
    return [getComputedStyle(el).color, rule ? rule.style.color.toLowerCase() : ''].join(' ');
  };
  const syn = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
  const string = [...document.querySelectorAll('.t-str')].find((el) => (el.textContent || '').includes('hi'));
  const fn = pick('.t-fn', 'greet');
  const word = pick('.t-kw', 'return');
  const name = [...document.querySelectorAll('.t-id')].find((el) => el.textContent === 'name' && ![...el.classList].some((item) => /^k\\d+$/.test(item)));
  if (!string || !fn || !word || !name) return ['missing', !!string, !!fn, !!word, !!name].join(' ');
  return [paint(string), paint(fn), paint(word), getComputedStyle(name).color, syn('--syn-str'), syn('--syn-fn'), syn('--syn-kw'), syn('--syn-id')].join('\\n');
})()`;

describe('Given a served review of a greeting with a return, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    const author = ada('2020-09-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet(String name) {\n  if (name.isEmpty) return;\n  print('hi');\n}\n");
    repo.commit({ subject: 'Return early', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.click('[data-open="lib/a.dart"]');
    await page.until(`!!document.querySelector('.code[data-p="lib/a.dart"]')`);
    await page.until(`!!document.querySelector('.t-str[class*=" k"]')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when highlighting has loaded, ', () => {
    let colors: string;

    before(async () => {
      colors = await read(page!, sample);
    });

    it('then a string, a function, a control keyword and a plain variable use Dark+ and the syntax variables.', () => {
      const [string, fn, word, name, synStr, synFn, synKw, synId] = colors.split('\n');
      const theme = (line: string, hex: string) => line.trim() === rgb(hex) || line.trim().startsWith(`${rgb(hex)} `);
      assert.equal([
        theme(string, darkPlus.string) ? 'string' : string,
        theme(fn, darkPlus.function) ? 'function' : fn,
        theme(word, darkPlus.control) ? 'control' : word,
        name === rgb(darkPlus.variable) ? 'variable' : name,
        synStr === darkPlus.string.toLowerCase() ? 'syn-str' : synStr,
        synFn === darkPlus.function.toLowerCase() ? 'syn-fn' : synFn,
        synKw === darkPlus.control.toLowerCase() ? 'syn-kw' : synKw,
        synId === darkPlus.variable.toLowerCase() ? 'syn-id' : synId,
      ].join('\n'), 'string\nfunction\ncontrol\nvariable\nsyn-str\nsyn-fn\nsyn-kw\nsyn-id');
    });
  });
});

// A string over several lines, changed inside, and code after it changed too, far enough below
// that the two changes are hunks of their own: the second starts inside the string.
const config = (name: string, said: string) => ["const config = '''", `name: ${name}`, 'a: 1', 'b: 2', 'c: 3', 'd: 4', 'e: 5', 'f: 6', "''';", 'void start() {', `  print('${said}');`, '}', ''].join('\n');

describe('Given a served review of a change inside a string over several lines, and one in the code after it, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    const author = ada('2020-09-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/config.dart', config('base', 'started'));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/config.dart', config('head', 'running'));
    repo.commit({ subject: 'Rename and run', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.click('[data-open="lib/config.dart"]');
    await page.until(`!!document.querySelector('.code[data-p="lib/config.dart"] .t-str[class*=" k"]')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when highlighting has loaded, ', () => {
    let colors: string;

    before(async () => {
      colors = await read(page!, `(() => {
        const rows = [...document.querySelectorAll('.code[data-p="lib/config.dart"] .ln')];
        // A word on the row that holds a text, as Dark+ colors it.
        const word = (line, w) => { const row = rows.find((r) => r.querySelector('.tx')?.textContent === line); const el = row && [...row.querySelectorAll('.tx span')].find((s) => !s.children.length && s.textContent === w); return el ? getComputedStyle(el).color : 'missing'; };
        return [
          document.querySelectorAll('.code[data-p="lib/config.dart"] .hh').length + ' hunks',
          word('f: 6', 'f'),
          word('void start() {', 'start'),
          word("  print('running');", 'print'),
          word("  print('started');", 'print'),
        ].join('\\n');
      })()`);
    });

    it('then the hunk that starts inside the string reads it as one up to its end, and the code after it as code, on both sides.', () => {
      assert.equal(colors, ['2 hunks', rgb(darkPlus.string), rgb(darkPlus.function), rgb(darkPlus.function), rgb(darkPlus.function)].join('\n'));
    });
  });
});

// A Serverpod model changed far enough below its fields: line that the hunk starts inside the block
// and runs past it into indexes:.
const order = (total: string) => ['class: Order', 'table: orders', 'fields:', '  number: String', '  placedAt: DateTime', '  shippedAt: DateTime?', '  customer: String', '  note: String?', `  total: ${total}`, 'indexes:', '  order_number_idx:', '    fields: number', '    unique: true', ''].join('\n');

describe('Given a served review of a model retyped far below its fields: line, ', { skip, timeout: 180_000 }, () => {
  const file = 'lib/src/models/order.spy.yaml';
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    const author = ada('2020-09-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write(file, order('double'));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write(file, order('int'));
    repo.commit({ subject: 'Count in cents', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-act="models-open"]');
    await page.until(`[...document.querySelectorAll('.md-card .tx span')].some((s) => [...s.classList].some((c) => /^k\\d+$/.test(c)))`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when highlighting has loaded in the Models view, ', () => {
    let colors: string;

    before(async () => {
      colors = await read(page!, `(() => {
        const rows = [...document.querySelectorAll('.md-card[data-model="${file}"] .code .ln')];
        const word = (line, w) => { const row = rows.find((r) => r.querySelector('.tx')?.textContent === line); const el = row && [...row.querySelectorAll('.tx span')].find((s) => !s.children.length && s.textContent === w); return el ? getComputedStyle(el).color : 'missing'; };
        return [
          rows.find((r) => r.querySelector('.tx'))?.querySelector('.tx').textContent,
          word('  customer: String', 'String'),
          word('  total: double', 'double'),
          word('  total: int', 'int'),
          word('    fields: number', 'number'),
        ].join('\\n');
      })()`);
    });

    it('then the hunk reads its lines as fields, with type colors on both sides, and the index after it as an index.', () => {
      assert.equal(colors, ['  shippedAt: DateTime?', rgb(darkPlus.type), rgb(darkPlus.type), rgb(darkPlus.type), rgb(darkPlus.string)].join('\n'));
    });
  });
});
