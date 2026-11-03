import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pubGet } from '../../dist/checkouts.js';
import { dartCommand, dartSpawn } from '../../dist/exec.js';
import { DartServer } from '../../dist/lsp/dart.js';

describe('Given untangle on Linux or macOS, ', () => {
  it('when it runs dart, then it runs the dart on PATH, by its name.', () => {
    assert.deepEqual(dartCommand(), { cmd: 'dart' });
  });
});

/**
 * Windows, as untangle reads it: process.platform, and a PATH of folders made here. Their programs
 * are scripts that note how they were started: FLUTTER_ROOT, then their arguments.
 */
describe('Given untangle on Windows, ', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, FLUTTER_ROOT: process.env.FLUTTER_ROOT };
  let root = '', flutter = '', started = '';
  const program = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$FLUTTER_ROOT" "$@" > ${JSON.stringify(started)}\n`, { mode: 0o755 });
    return file;
  };
  const onPath = (...dirs: string[]) => { process.env.PATH = [...dirs, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter); };
  const run = () => fs.readFileSync(started, 'utf8').trim().split('\n');

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-dart-'));
    started = path.join(root, 'started');
    flutter = path.join(root, 'flutter');
    // Flutter's bin: dart.bat, which runs the Dart SDK it keeps in its cache.
    program(path.join(flutter, 'bin', 'dart.bat'));
    program(path.join(flutter, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe'));
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    delete process.env.FLUTTER_ROOT;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  after(() => {
    Object.defineProperty(process, 'platform', platform);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it(
    'when dart on PATH is Flutter’s dart.bat, and a package is resolved, '
    + 'then the dart.exe of the SDK it wraps runs pub get, with FLUTTER_ROOT set as dart.bat sets it, so pub finds Flutter’s packages.',
    async () => {
      onPath(path.join(root, 'nothing'), path.join(flutter, 'bin'));
      const dir = path.join(root, 'package');
      fs.mkdirSync(dir);
      assert.deepEqual([await pubGet([dir], () => {}), run()], [[], [flutter, 'pub', 'get']]);
    },
  );

  it(
    'when the language server starts, '
    + 'then it’s that dart.exe too.',
    async () => {
      onPath(path.join(flutter, 'bin'));
      await assert.rejects(DartServer.start([{ name: 'a', dir: root }], { clientVersion: '0.1.0' }));
      assert.deepEqual(run(), [flutter, 'language-server', '--protocol=lsp', '--client-id', 'untangle', '--client-version', '0.1.0']);
    },
  );

  it(
    'when a Dart SDK’s dart.exe comes first on PATH, '
    + 'then it runs as it is.',
    () => {
      const sdk = path.join(root, 'dart-sdk', 'bin');
      const exe = program(path.join(sdk, 'dart.exe'));
      onPath(sdk, path.join(flutter, 'bin'));
      assert.deepEqual(dartCommand(), { cmd: exe });
    },
  );

  it(
    'when another .bat is dart on PATH, '
    + 'then it runs through the shell, which takes the line as it is: what holds a space is quoted.',
    () => {
      const bat = program(path.join(root, 'shims', 'dart.bat'));
      onPath(path.dirname(bat));
      assert.deepEqual(dartSpawn(['C:\\Users\\Ada Lovelace\\dart-sdk.dart', '--version'], { cwd: root }), [bat, ['"C:\\Users\\Ada Lovelace\\dart-sdk.dart"', '--version'], { cwd: root, shell: true }]);
    },
  );
});
