import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readHistory } from '../../dist/history.js';
import { Notes } from '../../dist/notes.js';
import { exportDiff } from '../../dist/pipeline/diff.js';
import { buildDartHistory, type BuiltReview } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const lines = (count: number, at = 0) => Array.from({ length: count }, (_, i) => `line ${at + i}`).join('\n') + '\n';

describe('Given a branch that moves a file and changes a line in it, moves another as it was, and changes, adds and deletes others, ', () => {
  let repo: TempRepo;
  let files: ReturnType<typeof exportDiff>['compares'][string]['files'];

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/payments/money_movement_engine.dart', lines(20));
    repo.write('lib/payments/rolling text.dart', lines(3, 100));
    repo.write('lib/kept.dart', 'one\n');
    repo.write('lib/gone.dart', 'gone\n');
    const base = repo.commit({ subject: 'Start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.delete('lib/payments/money_movement_engine.dart');
    repo.write('lib/payments/movement/engine.dart', lines(20).replace('line 3\n', 'line three\n'));
    repo.delete('lib/payments/rolling text.dart');
    repo.write('lib/common/rolling text.dart', lines(3, 100));
    repo.write('lib/kept.dart', 'two\n');
    repo.delete('lib/gone.dart');
    repo.write('lib/new.dart', 'new\n');
    const head = repo.commit({ subject: 'Move the engine', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    files = exportDiff(repo.dir, { base: { left: base, right: head, label: 'feature' } }, []).compares.base.files;
  });

  after(() => repo.remove());

  it(
    'when its diff is read, '
    + 'then each moved file is one changed file, at its new path with the one it came from, its diff only what changed in it.',
    () => {
      assert.deepEqual(files.map((f) => [f.s, f.p, f.from ?? null, f.a, f.d, (f.hunks ?? []).flatMap((h) => h.l.filter((l) => l[0] !== ' '))]), [
        ['M', 'lib/common/rolling text.dart', 'lib/payments/rolling text.dart', 0, 0, []],
        ['D', 'lib/gone.dart', null, 0, 1, ['-gone']],
        ['M', 'lib/kept.dart', null, 1, 1, ['-one', '+two']],
        ['A', 'lib/new.dart', null, 1, 0, ['+new']],
        ['M', 'lib/payments/movement/engine.dart', 'lib/payments/money_movement_engine.dart', 1, 1, ['-line 3', '+line three']],
      ]);
    },
  );
});

describe('Given a review whose first commit moves a Dart file and whose second changes a call in it, ', () => {
  let built: BuiltReview;
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

  before(async () => {
    built = await buildDartHistory({ [was]: engine('+') }, [
      { subject: 'Move the engine', files: { [was]: null, [now]: engine('+') } },
      { subject: 'Multiply by the helper', files: { [now]: engine('*') } },
    ]);
  });

  after(() => built?.remove());

  it(
    'when it is built, '
    + 'then the moved file is one file with its one change, and the old file isn’t in the review.',
    () => {
      const files = built.data.model.compares.base.files as Array<{ p: string; s: string; from?: string; blocks: Array<{ edits: unknown[] }> }>;
      assert.deepEqual(files.filter((f) => f.p.startsWith('lib/')).map((f) => [f.s, f.p, f.from ?? null, f.blocks.reduce((k, b) => k + b.edits.length, 0)]), [['M', now, was, 1]]);
    },
  );

  it(
    'when the removed line’s names are looked up, '
    + 'then they’re found where the base has them, at the file’s old path.',
    () => {
      const old = built.data.defsOld.base as { defs: Record<string, Record<string, Array<[number, number, number]>>>; targets: Array<{ p: string; l: number }> };
      const text = engine('+').split('\n'), line = text.indexOf('  return helper() + x;') + 1;
      const at = (old.defs[was]?.[line] ?? []).map(([, , ti]) => old.targets[ti]);
      // helper, and the parameter x.
      assert.deepEqual([Object.keys(old.defs).includes(now), at.map((t) => [t.p, t.l])], [false, [[was, 1], [was, text.indexOf('int total(int x) {') + 1]]]);
    },
  );

  it(
    'when its history is read, '
    + 'then the commit that changed the call wrote the added line and removed the old one, through the move.',
    async () => {
      const t = built.target, files = built.data.model.compares.base.files;
      const history = await readHistory(t.repo, t.baseSha, t.headSha, files, null);
      const fi = files.findIndex((f: { p: string }) => f.p === now);
      const rows = files[fi].hunks.flatMap((h: { rows: Array<[string]> }, hi: number) => h.rows.map(([type]: [string], ri: number) => [type, history.rows[fi]![hi][ri]])).filter(([type]: [string]) => type !== ' ');
      assert.deepEqual(rows.map(([type, at]: [string, number]) => [type, history.commits[at]?.subject ?? null]), [['-', 'Multiply by the helper'], ['+', 'Multiply by the helper']]);
    },
  );
});

describe('Given a review that moves a Dart file, reordering its declarations and those of its class, and edits, removes and adds some, ', () => {
  let built: BuiltReview;
  const fn = (i: number, op = '+') => `/// f${i}, documented.\nint f${i}(int x) {\n  final y = x ${op} ${i};\n  return y * 2;\n}\n`;
  const member = (i: number) => `  /// m${i}.\n  int m${i}() {\n    return ${i};\n  }\n`;
  const engine = (members: number[], fns: number[], imports: string[], tail = '') => [...imports.map((i) => `import "${i}";`), '', `class Engine {\n  final int base = 1;\n\n${members.map(member).join('\n')}}\n`, ...fns.map((i) => fn(i, i === 3 && tail ? '*' : '+')), tail].join('\n');
  const was = engine([0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5, 6, 7], ['dart:math', 'dart:async']);

  before(async () => {
    built = await buildDartHistory({ 'lib/money_movement_engine.dart': was }, [
      { subject: 'Move the engine', files: { 'lib/money_movement_engine.dart': null, 'lib/movement/engine.dart': engine([3, 1, 4, 0, 2], [7, 6, 4, 3, 2, 1, 0], ['dart:async', 'dart:collection'], 'int g() => 0;\n') } },
    ], 'structure');
  });

  after(() => built?.remove());

  it(
    'when it is built, '
    + 'then its diff holds only what changed, each removed line at its own old number: no declaration reads as a change for having moved.',
    () => {
      const f = (built.data.model.compares.base.files as Array<{ p: string; hunks: Array<{ o: number; n: number; rows: Array<[string, string]> }> }>).find((x) => x.p === 'lib/movement/engine.dart')!;
      const rows = f.hunks.flatMap((h) => { let o = h.o, n = h.n; return h.rows.flatMap(([t, text]) => { const r = t === ' ' ? [] : [`${t}${t === '-' ? o : n} ${text}`]; if (t !== '+') o++; if (t !== '-') n++; return r; }); });
      // Where a function starts, on a side; the old file ends in a blank line.
      const now = engine([3, 1, 4, 0, 2], [7, 6, 4, 3, 2, 1, 0], ['dart:async', 'dart:collection'], 'int g() => 0;\n').split('\n');
      const start = (lines: string[], i: number) => lines.indexOf(`/// f${i}, documented.`) + 1, f5 = start(was.split('\n'), 5), f3 = start(was.split('\n'), 3);
      assert.deepEqual(rows, [
        '-1 import "dart:math";',
        '+2 import "dart:collection";',
        ...['/// f5, documented.', 'int f5(int x) {', '  final y = x + 5;', '  return y * 2;', '}', ''].map((text, k) => `-${f5 + k} ${text}`),
        `-${f3 + 2}   final y = x + 3;`,
        `+${start(now, 3) + 2}   final y = x * 3;`,
        `-${was.replace(/\n$/, '').split('\n').length} `,
        `+${now.indexOf('int g() => 0;') + 1} int g() => 0;`,
      ]);
    },
  );
});

describe('Given notes on a review that moves a file, ', () => {
  let repo: TempRepo;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  let base = '', head = '';
  const was = 'lib/old/greeting.dart', now = 'lib/new/greeting.dart';

  before(() => {
    repo = TempRepo.create();
    repo.write(was, lines(10));
    base = repo.commit({ subject: 'Start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.delete(was);
    repo.write(now, lines(10).replace('line 4\n', 'line four\n'));
    head = repo.commit({ subject: 'Move the greeting', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    // One written on its removed lines before the review knew the file moved.
    fs.writeFileSync(path.join(dir, 'feature.json'), JSON.stringify({ version: 1, mode: 'local', live: true, opening: '', scope: 'open', base, head, next: 2, seq: 0, events: [], agents: {}, notes: [
      { n: 1, pr: null, path: was, file: false, side: 'LEFT', line: 5, startSide: null, startLine: null, code: ['line 4'], wrote: { head, path: was, line: 5, startLine: null, code: ['line 4'] }, changed: false, gone: false, resolved: null, copied: false, about: null, comments: [{ id: 'c1', by: null, body: 'Why four?', at: '2020-06-03T00:00:00Z', edited: null, sent: null }], said: [], seen: 0, unread: false },
    ] }));
    notes = new Notes(path.join(dir, 'feature.json'));
    notes.attach({ repo: repo.dir, base, head, name: 'acme/app#7', branch: 'feature', checkout: null, change: () => null, moved: () => new Map([[now, was]]), gh: null });
  });

  after(() => {
    notes?.close();
    repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'when one is written on a removed line by the file’s new path, another by an agent naming its old one, '
    + 'then both are on the new path with the old file’s line, as is the one written before.',
    async () => {
      await notes.act({ action: 'add', path: now, side: 'LEFT', line: 5, body: 'Four?' });
      notes.write('Claude', { path: was, side: 'LEFT', line: 5, body: 'Four, as a word.' });
      const view = notes.view() as { notes: Array<{ n: number; path: string; side: string; line: number; code: string[] }> };
      assert.deepEqual(view.notes.map((n) => [n.n, n.path, n.side, n.line, n.code]), [[1, now, 'LEFT', 5, ['line 4']], [2, now, 'LEFT', 5, ['line 4']], [3, now, 'LEFT', 5, ['line 4']]]);
    },
  );

  it(
    'when the agent reads them, '
    + 'then each says where the base has the file its lines are numbered on.',
    () => {
      const text = notes.exportText('open');
      assert.ok(text.includes(`\nN1 · ${now}:5, removed lines (numbered as on the base, where the file is ${was})\n`), text);
    },
  );
});
