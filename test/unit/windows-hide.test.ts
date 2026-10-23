import assert from 'node:assert/strict';
import cp from 'node:child_process';
import module from 'node:module';
import { after, before, describe, it } from 'node:test';
import { childPids, rss } from '../../dist/metrics.js';
import { buildDartHistory, type BuiltReview } from '../helpers/review.ts';

interface Call {
  fn: string;
  command: string;
  windowsHide: unknown;
}

const starters = ['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const;

/** The test fixture's own git, which builds the repository before the review does. */
const fixture = /helpers[\\/]repo\.ts/;

/**
 * Records every child process the code under test starts, with whether it asked Windows to hide
 * the console window that process would otherwise get. The server runs without a console, so on
 * Windows a command started without the flag flashes a terminal window.
 */
function recordStarts(): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const target = cp as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = Object.fromEntries(starters.map((name) => [name, target[name]]));
  for (const name of starters) {
    target[name] = function recorded(this: unknown, ...args: unknown[]) {
      if (!fixture.test(new Error().stack ?? '')) {
        const options = args.slice(1).find((a) => a != null && typeof a === 'object' && !Array.isArray(a)) as { windowsHide?: unknown } | undefined;
        const argv = Array.isArray(args[1]) ? args[1] : [];
        calls.push({ fn: name, command: [args[0], ...argv].join(' '), windowsHide: options?.windowsHide });
      }
      return originals[name].call(this, ...args);
    };
  }
  module.syncBuiltinESMExports();
  return {
    calls,
    restore() {
      for (const name of starters) target[name] = originals[name];
      module.syncBuiltinESMExports();
    },
  };
}

describe('Given a review built while every process it starts is recorded, ', () => {
  let built: BuiltReview | undefined;
  let calls: Call[];

  before(async () => {
    const recording = recordStarts();
    calls = recording.calls;
    try {
      built = await buildDartHistory(
        { 'lib/a.dart': 'int a() => 1;\n' },
        [{ subject: 'change a', files: { 'lib/a.dart': 'int a() => 2;\n' } }],
      );
    } finally {
      recording.restore();
    }
  });

  after(() => built?.remove());

  it('then the build started commands, and every one asked Windows to hide its console.', () => {
    assert.ok(calls.length > 0, 'the build started no process');
    const shown = calls.filter((c) => c.windowsHide !== true).map((c) => `${c.fn}: ${c.command}`);
    assert.deepEqual(shown, []);
  });
});

describe('Given untangle running on Windows, ', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let recording: ReturnType<typeof recordStarts>;

  before(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    recording = recordStarts();
  });

  after(() => {
    recording.restore();
    Object.defineProperty(process, 'platform', platform);
  });

  it("when a process's memory and children are asked, then no process is started and neither is known.", () => {
    assert.equal(rss(process.pid), null);
    assert.deepEqual(childPids(process.pid), []);
    assert.deepEqual(recording.calls, []);
  });
});
