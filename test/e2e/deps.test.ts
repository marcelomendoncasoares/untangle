import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-09-01T15:00:00Z' };
const sdk = 'environment:\n  sdk: ^3.6.0\n';
const member = (name: string, version: string, rest = '') => `name: ${name}\nversion: ${version}\n${sdk}resolution: workspace\n${rest}`;
const lock = (versions: Record<string, string>) => 'packages:\n' + Object.entries(versions).map(([k, v]) => `  ${k}:\n    dependency: transitive\n    source: hosted\n    version: "${v}"\n`).join('') + 'sdks:\n  dart: ">=3.6.0 <4.0.0"\n';
// The block, row by row: a section's head, or a row's name, change (each of its parts) and count.
const block = `[...document.querySelectorAll('.dp-by-s, .dp-dep')].map((r) => (r.matches('.dp-by-s') ? '# ' : '') + [...r.children].map((x) => (x.matches('.ch') ? [...x.childNodes] : [x]).map((n) => n.textContent.trim()).filter(Boolean).join(' ')).filter(Boolean).join(' ')).join(' | ')`;
const lists = `[...document.querySelectorAll('.dp-pub')].map((r) => [...r.children].map((x) => x.textContent.trim()).filter(Boolean).join(' ')).join(' | ')`;
const card = (file: string) => `.md-card[data-model="${file}"]`;

describe('Given a review that upgrades a workspace: two packages, a test package, an app outside it, and their locks, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', `name: ws\n${sdk}workspace:\n  - packages/core\n  - packages/server\n  - test/core_test\n`);
    repo.write('packages/core/pubspec.yaml', member('core', '1.0.0'));
    repo.write('packages/core/lib/core.dart', 'int one() => 1;\n');
    repo.write('packages/server/pubspec.yaml', member('server', '1.0.0', 'dependencies:\n  core: 1.0.0\ndev_dependencies:\n  core_test: 1.0.0\n'));
    repo.write('packages/server/lib/server.dart', "import 'package:core/core.dart';\n\nint two() => one() + 1;\n");
    repo.write('test/core_test/pubspec.yaml', member('core_test', '1.0.0', 'dependencies:\n  core: 1.0.0\n'));
    repo.write('example/app/pubspec.yaml', `name: app\npublish_to: none\n${sdk}dependencies:\n  core:\n    path: ../../packages/core\n`);
    repo.write('pubspec.lock', lock({ collection: '1.18.0' }));
    repo.write('example/app/pubspec.lock', lock({ core: '1.0.0' }));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('packages/core/pubspec.yaml', member('core', '1.1.0'));
    repo.write('packages/server/pubspec.yaml', member('server', '1.1.0', 'dependencies:\n  core: 1.1.0\ndev_dependencies:\n  core_test: 1.1.0\n'));
    repo.write('test/core_test/pubspec.yaml', member('core_test', '1.1.0', 'dependencies:\n  core: 1.1.0\n'));
    repo.write('example/app/pubspec.yaml', `name: app\npublish_to: none\n${sdk}dependencies:\n  core:\n    path: ../../packages/core\n  server:\n    path: ../../packages/server\n`);
    repo.write('pubspec.lock', lock({ collection: '1.19.0' }));
    repo.write('example/app/pubspec.lock', lock({ core: '1.1.0', server: '1.1.0' }));
    repo.commit({ subject: 'Release 1.1.0', author, committer: author });
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

  describe('when Dependencies is opened from the Chains tab, ', () => {
    before(async () => {
      await page.click('[data-act="deps-open"]');
      await page.until(`!!document.querySelector('.dp-by')`);
    });

    it('then its row counts the three pubspecs outside the test package, and the header says so.', async () => {
      assert.equal(await read(page, `document.querySelector('[data-act="deps-open"] .cnt').textContent`), '3');
      assert.equal(await read(page, `document.querySelector('.fv-head .facts').textContent`), '3 pubspecs changed · 1 pubspec in test packages, folded');
    });

    it('then the block has the packages’ versions, then each change once in its group, with what the app’s lock resolved, and each lock’s other change.', async () => {
      assert.equal(await read(page, block), [
        '# Package versions', 'version 1.0.0 → 1.1.0 3 packages',
        '# Dependencies 2', 'core 1.0.0 → 1.1.0 2 pubspecs', 'server added path ../../packages/server resolves to 1.1.0 1 pubspec',
        '# Dev dependencies 1', 'core_test 1.0.0 → 1.1.0 1 pubspec',
        '# Resolved in pubspec.lock 2', 'example/app/pubspec.lock other packages, resolved differently 1 package', 'pubspec.lock other packages, resolved differently 1 package',
      ].join(' | '));
    });

    it('then the locks are set aside as pub get’s, and the pubspecs’ cards come in order, the app’s outside the workspace.', async () => {
      assert.equal(await read(page, `[...document.querySelectorAll('.md-card .md-h')].map((h) => [...h.children].map((x) => x.textContent.trim()).filter(Boolean).join(' ')).join(' | ')`),
        'app example/app/pubspec.yaml outside the workspace | core packages/core/pubspec.yaml 1.0.0 → 1.1.0 | server packages/server/pubspec.yaml 1.0.0 → 1.1.0');
      assert.equal(await read(page, `JSON.parse(document.querySelector('#d-model').textContent).compares.base.generated.map((g) => g.p + ' (' + g.gen + ')').join(', ')`), 'example/app/pubspec.lock (pub get), pubspec.lock (pub get)');
    });

    describe('and a row is opened, ', () => {
      before(async () => {
        await page.click('.dp-dep[data-k="g0"]');
        await page.until(`!!document.querySelector('.dp-pub')`);
      });

      it('then it lists its pubspecs one per line: the package, its folder and the line.', async () => {
        assert.equal(await read(page, lists), 'server packages/server line 7 | core_test test/core_test line 7');
      });

      describe('and the test package’s is clicked, ', () => {
        before(async () => {
          await page.click('.dp-pub[data-file]:nth-of-type(2)');
          await page.until(`!!document.querySelector('${card('test/core_test/pubspec.yaml')} .ln.flash')`);
        });

        it('then its folded group and its card open, at the line.', async () => {
          assert.equal(await read(page, `document.querySelector('${card('test/core_test/pubspec.yaml')} .ln.flash').dataset.n + ' ' + document.querySelector('.md-tg').getAttribute('aria-expanded')`), '7 true');
        });
      });
    });

    describe('and the server’s pubspec is marked reviewed, ', () => {
      before(async () => {
        await page.click(`${card('packages/server/pubspec.yaml')} .md-tick`);
        await page.until(`document.querySelector('${card('packages/server/pubspec.yaml')}').classList.contains('fold')`);
      });

      it('then it folds to its line, its changes in short, and the row counts two.', async () => {
        assert.equal(await read(page, `document.querySelector('${card('packages/server/pubspec.yaml')} .md-sum').textContent`), '1.0.0 → 1.1.0 · 1 dependency and 1 dev dependency to 1.1.0');
        assert.equal(await read(page, `document.querySelector('[data-act="deps-open"] .cnt').textContent`), '2');
      });
    });
  });
});
