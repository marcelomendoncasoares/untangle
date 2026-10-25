import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { comparePubspecs, depSpec, lockVersions, parsePubspec, pubspecSummary, readPubspecs, type PubChange, type PubspecsData } from '../../analysis/pubspecs.js';
import { has } from '../../dist/exec.js';
import { buildDartReview, type BuiltReview } from '../helpers/review.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';

/** A change as one line: its section, dependency, what it was and is, and its side and line. */
const line = (c: PubChange) => `${c.sec} ${c.dep}: ${c.old ?? '-'} > ${c.new ?? '-'} ${c.side}:${c.line}${c.res ? ` res ${c.res[0] ?? '-'} > ${c.res[1] ?? '-'}` : ''}`;
const pubspec = (name: string, rest: string) => `name: ${name}\n${rest}`;
const lock = (versions: Record<string, string>) => 'packages:\n' + Object.entries(versions).map(([k, v]) => `  ${k}:\n    dependency: transitive\n    source: hosted\n    version: "${v}"\n`).join('') + 'sdks:\n  dart: ">=3.6.0 <4.0.0"\n';

describe('Given dependencies written each way pub takes them, ', () => {
  it('then each reads as one line: its constraint, or where it comes from.', () => {
    assert.deepEqual([
      depSpec('^1.2.0'), depSpec('>=4.0.4 <4.1.0'), depSpec(''), depSpec(null), depSpec({ path: '../core' }),
      depSpec({ git: { url: 'https://github.com/someone/fork.git', ref: '4f2a75a0d8d5b1c7e9f3a2b4c6d8e0f1a3b5c7d9', path: 'packages/server' } }),
      depSpec({ git: 'https://github.com/someone/fork.git' }), depSpec({ sdk: 'flutter' }), depSpec({ hosted: 'https://pub.example.com', version: '^2.0.0' }),
    ], ['^1.2.0', '>=4.0.4 <4.1.0', 'any', 'any', 'path ../core', 'git github.com/someone/fork @ 4f2a75a · packages/server', 'git github.com/someone/fork', 'sdk flutter', '^2.0.0 from pub.example.com']);
  });
});

describe('Given a pubspec with a version, a workspace and sections indented two ways, ', () => {
  const p = parsePubspec(['name: app', 'version: 1.0', 'workspace:', '  - packages/a', 'environment:', '  sdk: ^3.6.0', 'dependencies:', '  a: ^1.0.0', '  local:', '    path: ../local', 'dev_dependencies:', '    lints: any', ''].join('\n'))!;

  it('then its version stays as written, and it knows its workspace.', () => {
    assert.deepEqual([p.name, p.version, p.workspace], ['app', '1.0', ['packages/a']]);
  });

  it('then each entry has its spec and its line, and each top-level key its line.', () => {
    assert.deepEqual([...p.entries.dependencies].map(([k, v]) => `${k} ${v.spec} L${v.line}`), ['a ^1.0.0 L8', 'local path ../local L9']);
    assert.deepEqual([...p.entries.dev_dependencies].map(([k, v]) => `${k} ${v.spec} L${v.line}`), ['lints any L12']);
    assert.deepEqual([...p.entries.environment].map(([k, v]) => `${k} ${v.spec} L${v.line}`), ['sdk ^3.6.0 L6']);
    assert.equal(p.top.get('version'), 2);
  });

  it('then a file that isn’t a map reads as none.', () => {
    assert.equal(parsePubspec('- a\n- b\n'), null);
    assert.equal(parsePubspec(null), null);
  });
});

describe('Given two sides of a pubspec, ', () => {
  const before = parsePubspec(pubspec('a', 'environment:\n  sdk: ^3.5.0\ndependencies:\n  kept: ^1.0.0\n  bumped: ^1.0.0\n  dropped: ^2.0.0\ndev_dependencies:\n  test: ^1.24.0\n'));
  const after = parsePubspec(pubspec('a', 'environment:\n  sdk: ^3.6.0\ndependencies:\n  kept: ^1.0.0\n  bumped: ^1.1.0\n  added: any\ndev_dependencies:\n  test: ^1.25.0\n'));

  it('then each entry that changed, by section, is on its new line, or its old one when it’s gone.', () => {
    assert.deepEqual(comparePubspecs(before, after).map(line), [
      'dependencies added: - > any RIGHT:7',
      'dependencies bumped: ^1.0.0 > ^1.1.0 RIGHT:6',
      'dependencies dropped: ^2.0.0 > - LEFT:7',
      'dev_dependencies test: ^1.24.0 > ^1.25.0 RIGHT:9',
      'environment sdk: ^3.5.0 > ^3.6.0 RIGHT:3',
    ]);
  });

  it('then a folded pubspec’s line says it in short.', () => {
    const same = (sec: PubChange['sec'], dep: string): PubChange => ({ sec, dep, old: '>=4.0.4 <4.1.0', new: '^4.1.0-beta.3', side: 'RIGHT', line: 1 });
    assert.deepEqual([
      pubspecSummary(['0.0.10', '0.0.11'], [same('dependencies', 'a'), same('dependencies', 'b')], 'M'),
      pubspecSummary(null as never, [same('dependencies', 'a'), same('dev_dependencies', 'b'), same('dev_dependencies', 'c')], 'M'),
      pubspecSummary(undefined, comparePubspecs(before, after), 'M'),
      pubspecSummary(undefined, [{ sec: 'dependency_overrides', dep: 'a', old: null, new: 'git x', side: 'RIGHT', line: 1 }], 'M'),
      pubspecSummary(undefined, [], 'M'),
    ], ['0.0.10 → 0.0.11 · 2 dependencies to ^4.1.0-beta.3', '1 dependency and 2 dev dependencies to ^4.1.0-beta.3', '3 dependencies and 1 dev dependency changed · sdk ^3.6.0', '1 override', 'other keys']);
  });
});

describe('Given a pubspec.lock, ', () => {
  it('then it says the version each package resolved to.', () => {
    assert.deepEqual([...lockVersions(lock({ meta: '1.16.0', path: '1.9.0' }))!], [['meta', '1.16.0'], ['path', '1.9.0']]);
  });

  it('then one that can’t be read says nothing.', () => {
    assert.equal(lockVersions('packages: [\n'), null);
    assert.equal(lockVersions(null), null);
  });
});

describe('Given a workspace upgrade: the root, two members, an app outside it, a test package, and the lock, ', () => {
  const sides: Record<'left' | 'right', Record<string, string>> = {
    left: {
      'pubspec.yaml': pubspec('ws', 'workspace:\n  - packages/core\n  - packages/server\n  - test/core_test\ndev_dependencies:\n  melos: ^7.0.0\n'),
      'packages/core/pubspec.yaml': pubspec('core', 'version: 1.0.0\nresolution: workspace\ndependencies:\n  meta: ^1.16.0\n'),
      'packages/server/pubspec.yaml': pubspec('server', 'version: 1.0.0\nresolution: workspace\ndependencies:\n  core: 1.0.0\n  meta: ^1.16.0\ndev_dependencies:\n  test: ^1.24.0\n'),
      'example/app/pubspec.yaml': pubspec('app', 'publish_to: none\ndependencies:\n  meta: ^1.16.0\n'),
      'test/core_test/pubspec.yaml': pubspec('core_test', 'resolution: workspace\ndependencies:\n  meta: ^1.16.0\n'),
      'pubspec.lock': lock({ meta: '1.16.0', test: '1.24.0', path: '1.9.0' }),
    },
    right: {
      'pubspec.yaml': pubspec('ws', 'workspace:\n  - packages/core\n  - packages/server\n  - test/core_test\ndev_dependencies:\n  melos: ^7.0.0\n'),
      'packages/core/pubspec.yaml': pubspec('core', 'version: 1.1.0\nresolution: workspace\ndependencies:\n  meta: ^1.17.0\n'),
      'packages/server/pubspec.yaml': pubspec('server', 'version: 1.1.0\nresolution: workspace\ndependencies:\n  core: 1.1.0\n  meta: ^1.17.0\ndev_dependencies:\n  test: ^1.25.0\n'),
      'example/app/pubspec.yaml': pubspec('app', 'publish_to: none\ndependencies:\n  meta: ^1.17.0\n'),
      'test/core_test/pubspec.yaml': pubspec('core_test', 'resolution: workspace\ndependencies:\n  meta: ^1.17.0\n'),
      'pubspec.lock': lock({ meta: '1.17.0', test: '1.25.0', path: '1.9.1' }),
    },
  };
  const changed = ['example/app/pubspec.yaml', 'packages/core/pubspec.yaml', 'packages/server/pubspec.yaml', 'test/core_test/pubspec.yaml'];
  const files = changed.map((p) => ({ p, s: 'M', oldSrc: sides.left[p], newSrc: sides.right[p] }));
  const data = readPubspecs({ files, generated: [{ p: 'pubspec.lock', s: 'M' }], review: {}, show: (side, p) => sides[side][p] ?? null, index: (f) => files.indexOf(f as (typeof files)[number]) })!;
  const at = (f: number) => changed[f];

  it('then they come by path, the app outside the workspace among them, and the test package last.', () => {
    assert.deepEqual(data.cards.map((c) => `${c.name} ${c.dir}${c.member ? ' member' : ''}${c.outside ? ' outside' : ''}${c.test ? ' test' : ''}`), ['app example/app outside', 'core packages/core member', 'server packages/server member', 'core_test test/core_test member test']);
  });

  it('then a member’s changes say what the root’s lock resolved, and the app’s, with no lock of its own, don’t.', () => {
    assert.deepEqual(data.cards.find((c) => c.name === 'server')!.changes.map(line), ['dependencies core: 1.0.0 > 1.1.0 RIGHT:5', 'dependencies meta: ^1.16.0 > ^1.17.0 RIGHT:6 res 1.16.0 > 1.17.0', 'dev_dependencies test: ^1.24.0 > ^1.25.0 RIGHT:8 res 1.24.0 > 1.25.0']);
    assert.deepEqual(data.cards.find((c) => c.name === 'app')!.changes.map(line), ['dependencies meta: ^1.16.0 > ^1.17.0 RIGHT:4']);
  });

  it('then each change comes once, with the pubspecs that make it, the most made first.', () => {
    assert.deepEqual(data.groups.map((g) => `${g.sec} ${g.dep} ${g.old} > ${g.new}: ${g.f.map(at).join(', ')}`), [
      'dependencies meta ^1.16.0 > ^1.17.0: example/app/pubspec.yaml, packages/core/pubspec.yaml, packages/server/pubspec.yaml, test/core_test/pubspec.yaml',
      'dependencies core 1.0.0 > 1.1.0: packages/server/pubspec.yaml',
      'dev_dependencies test ^1.24.0 > ^1.25.0: packages/server/pubspec.yaml',
    ]);
  });

  it('then the packages’ versions come by change, each with its line.', () => {
    assert.deepEqual(data.versions.map((v) => `${v.old} > ${v.new}: ${v.f.map(at).join(', ')}`), ['1.0.0 > 1.1.0: packages/core/pubspec.yaml, packages/server/pubspec.yaml']);
    assert.deepEqual(data.cards.filter((c) => c.version).map((c) => `${c.name} L${c.vline}`), ['core L2', 'server L2']);
  });

  it('then the lock’s other changes are what resolved differently that no pubspec says.', () => {
    assert.deepEqual(data.locks, [{ p: 'pubspec.lock', others: [{ dep: 'path', old: '1.9.0', new: '1.9.1' }] }]);
  });

  it('then a folded pubspec’s line is its version and its dependencies in short.', () => {
    assert.deepEqual(data.cards.map((c) => c.sum), ['1 dependency to ^1.17.0', '1.0.0 → 1.1.0 · 1 dependency to ^1.17.0', '1.0.0 → 1.1.0 · 2 dependencies and 1 dev dependency changed', '1 dependency to ^1.17.0']);
  });
});

describe('Given a review that upgrades a workspace’s packages and commits its lock, ', { skip: skipDart }, () => {
  const ws = 'name: ws\nenvironment:\n  sdk: ^3.6.0\nworkspace:\n  - packages/core\n  - packages/server\n';
  const member = (name: string, version: string, deps: string) => `name: ${name}\nversion: ${version}\nenvironment:\n  sdk: ^3.6.0\nresolution: workspace\n${deps}`;
  const files = {
    base: {
      'pubspec.yaml': ws,
      'packages/core/pubspec.yaml': member('core', '1.0.0', ''),
      'packages/core/lib/core.dart': 'int one() => 1;\n',
      'packages/server/pubspec.yaml': member('server', '1.0.0', 'dependencies:\n  core: 1.0.0\n'),
      'packages/server/lib/server.dart': "import 'package:core/core.dart';\n\nint two() => one() + 1;\n",
      'pubspec.lock': 'packages: {}\nsdks:\n  dart: ">=3.6.0 <4.0.0"\n',
    },
    head: {
      'packages/core/pubspec.yaml': member('core', '1.1.0', ''),
      'packages/server/pubspec.yaml': member('server', '1.1.0', 'dependencies:\n  core: 1.1.0\n'),
      'pubspec.lock': 'packages: {}\nsdks:\n  dart: ">=3.6.1 <4.0.0"\n',
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;
    let deps: PubspecsData | undefined;
    let generated: Array<{ p: string; gen: string }> = [];

    before(async () => {
      review = await buildDartReview(files);
      const base = review.data.model.compares.base as { deps?: PubspecsData; generated: Array<{ p: string; gen: string }> };
      deps = base.deps;
      generated = base.generated;
    });

    after(() => review?.remove());

    it('then the lock is set aside as pub get’s, and the pubspecs come with their changes by dependency.', () => {
      assert.deepEqual(generated.map((g) => `${g.p} (${g.gen})`), ['pubspec.lock (pub get)']);
      assert.deepEqual(deps?.cards.map((c) => `${c.name}: ${c.sum}`), ['core: 1.0.0 → 1.1.0', 'server: 1.0.0 → 1.1.0 · 1 dependency to 1.1.0']);
      assert.deepEqual(deps?.groups.map((g) => `${g.dep} ${g.old} > ${g.new} ×${g.f.length}`), ['core 1.0.0 > 1.1.0 ×1']);
    });
  });
});
