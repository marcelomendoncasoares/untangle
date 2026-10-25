import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Diff, RawDefinitions } from '../../analysis/analyze.js';
import { exportDiff, generatedPatterns } from '../../dist/pipeline/diff.js';
import { slim, type Definitions } from '../../dist/pipeline/definitions.js';
import { changedUsages } from '../../dist/pipeline/links.js';
import { headPositions, oldPositions } from '../../dist/pipeline/positions.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

function shownPositions(positions: Record<string, Record<string, Array<[number, number]>>>): string {
  return Object.entries(positions).flatMap(([file, lines]) => Object.entries(lines).map(([line, cols]) => `${file}:${line} ${cols.map(([col, len]) => `${col}+${len}`).join(' ')}`)).join('\n');
}

describe('Given a Dart file that gains a call on its second line, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void greet() {\n}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  describe('when the diff is exported, ', () => {
    let files: string;

    before(() => {
      const diff = exportDiff(repo!.dir, { base: { left: base, right: head, label: 'main' } }, []);
      files = diff.compares.base.files.map((file) => `${file.p} ${file.s} hunks ${file.hunks ? file.hunks.length : 'none'}`).join('\n');
    });

    it('then the file is modified and keeps its hunks.', () => {
      assert.equal(files, 'lib/a.dart M hunks 1');
    });
  });

  it(
    'when positions on the new side are read, '
    + 'then the added call is named, and so is the name on the context line.',
    async () => {
      const diff = exportDiff(repo!.dir, { base: { left: base, right: head, label: 'main' } }, []);
      const positions = await headPositions(diff, repo!.dir);
      assert.equal(shownPositions(positions.positions), 'lib/a.dart:1 5+5\nlib/a.dart:2 2+5');
    },
  );
});

describe('Given a Dart file that loses a call, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', "void greet() {\n  print('bye');\n}\n");
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'void greet() {\n}\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when positions on the old side are read, '
    + 'then the removed call is named.',
    () => {
      const diff = exportDiff(repo!.dir, { base: { left: base, right: head, label: 'main' } }, []);
      const positions = oldPositions(diff, 'base');
      assert.equal(shownPositions(positions.positions), 'lib/a.dart:2 2+5');
    },
  );
});

describe('Given a generated part and a file listed in .review.yaml, ', () => {
  let repo: TempRepo | undefined;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void greet() {}\n');
    repo.write('lib/a.g.dart', 'const generated = 1;\n');
    repo.write('.review.yaml', 'generated:\n  - lib/extra.dart\n');
    repo.write('lib/extra.dart', 'const extra = 1;\n');
    repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'void greet() { return; }\n');
    repo.write('lib/a.g.dart', 'const generated = 2;\n');
    repo.write('lib/extra.dart', 'const extra = 2;\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when the generated patterns are read, '
    + 'then the part adapter, pub get’s lock and the listed file are generated.',
    () => {
      assert.equal(generatedPatterns(repo!.dir, head).join('\n'), [
        '**/*.g.dart',
        '**/*.freezed.dart',
        '**/*.gr.dart',
        '**/*.config.dart',
        '**/*.mocks.dart',
        '**/pubspec.lock',
        'lib/extra.dart',
      ].join('\n'));
    },
  );

  it(
    'when the diff is exported, '
    + 'then only the library keeps its hunks.',
    () => {
      const patterns = generatedPatterns(repo!.dir, head);
      const diff = exportDiff(repo!.dir, { base: { left: repo!.rev('HEAD~1'), right: head, label: 'main' } }, patterns);
      assert.equal(
        diff.compares.base.files.map((file) => `${file.p} hunks ${file.hunks ? file.hunks.length : 'none'}`).sort().join('\n'),
        'lib/a.dart hunks 1\nlib/a.g.dart hunks none\nlib/extra.dart hunks none',
      );
    },
  );
});

describe('Given an added declaration and an added call of it in another file, ', () => {
  it(
    'when changed usages are read, '
    + 'then the call is a usage of the declaration.',
    () => {
      const head = '/work/head';
      const diff: Diff = {
        compares: {
          base: {
            left: 'base', right: 'head', label: 'main',
            files: [
              { p: 'lib/a.dart', s: 'M', a: 1, d: 0, ga: 'unspecified', hunks: [{ o: 1, n: 1, h: '', l: ['+void name() {}'] }] },
              { p: 'lib/b.dart', s: 'M', a: 1, d: 0, ga: 'unspecified', hunks: [{ o: 1, n: 1, h: '', l: ['+name();'] }] },
            ],
          },
        },
      };
      const raw: RawDefinitions = {
        'lib/a.dart:1:5': [path.join(head, 'lib/a.dart'), 0, 5],
        'lib/b.dart:1:0': [path.join(head, 'lib/a.dart'), 0, 5],
      };
      const usages = changedUsages(diff, head, raw);
      const list = usages.base?.['lib/a.dart:1:5'] ?? [];
      assert.equal(list.map(([file, line, col]) => `${file}:${line}:${col}`).join('\n'), 'lib/b.dart:1:0');
    },
  );
});

describe('Given a definition with a long line and twelve lines of snippet, ', () => {
  it(
    'when the definition is slimmed for the page, '
    + 'then the snippet is ten lines of at most 160 characters and the column is left out.',
    () => {
      const full: Definitions = {
        targets: [{ p: 'lib/a.dart', w: 'repo', l: 3, c: 4, s: 1, code: ['x'.repeat(200), 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] }],
        defs: { 'lib/a.dart': { '3': [[4, 1, 0]] } },
        raw: {},
      };
      const out = slim(full);
      const target = out.targets[0];
      assert.equal(
        [`lines ${target.code.length}`, `width ${target.code[0].length}`, `col ${'c' in target}`, `defs ${out.defs['lib/a.dart']['3'].join(':')}`].join('\n'),
        'lines 10\nwidth 160\ncol false\ndefs 4,1,0',
      );
    },
  );
});
