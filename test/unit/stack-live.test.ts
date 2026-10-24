import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { StackChanges } from '../../dist/stack-live.js';
import { resolveUrl } from '../../dist/target.js';
import { useStub } from '../helpers/gh.ts';
import { stackFixture, type StackFixture } from '../helpers/stack.ts';

describe('Given a running stack review, ', () => {
  let s: StackFixture, cache: string, restore: () => void, previous: NodeJS.ProcessEnv;
  let stack: StackChanges, held: boolean;
  const pending = new Set<Promise<void>>();
  const settled = async () => {
    do { await Promise.all([...pending]); await setImmediate(); } while (pending.size);
  };
  const lists = () => s.gh.calls().filter((c) => c.args.slice(0, 2).join(' ') === 'pr list' && c.args.includes('open')).length;

  beforeEach(async () => {
    s = stackFixture();
    cache = fs.mkdtempSync('/tmp/untangle-stack-live-');
    previous = { ...process.env };
    restore = useStub(s.gh);
    Object.assign(process.env, s.env, { UNTANGLE_CACHE: cache });
    const t = await resolveUrl(s.urls.c, () => {});
    held = false;
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const spawn = childProcess.spawn;
    mock.method(childProcess, 'spawn', ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
      pending.add(done);
      void done.then(() => pending.delete(done));
      return child;
    }) as typeof spawn);
    syncBuiltinESMExports();
    stack = new StackChanges(t, true, () => held, () => ({ local: null, head: t.headSha }));
    await settled();
  });
  afterEach(async () => {
    stack.stop();
    await settled();
    mock.reset();
    mock.timers.reset();
    syncBuiltinESMExports();
    restore();
    for (const key of [...Object.keys(s.env), 'UNTANGLE_CACHE']) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
    s.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when nobody holds it or asks for refresh, ', () => {
    it('then its background reads do not look up GitHub.', async () => {
      const before = s.gh.calls().length;
      mock.timers.tick(180_000);
      stack.check();
      await settled();
      assert.equal(s.gh.calls().length, before);
    });
  });

  describe('when a page asks, then an agent holds it, ', () => {
    it('then a single list serves a minute of page requests and each fifteen seconds while held.', async () => {
      const before = lists();
      stack.check(true);
      await settled();
      assert.equal(lists(), before + 1);
      mock.timers.tick(59_999);
      stack.check(true);
      await settled();
      assert.equal(lists(), before + 1);
      mock.timers.tick(1);
      stack.check(true);
      await settled();
      assert.equal(lists(), before + 2);
      held = true;
      mock.timers.tick(15_000);
      stack.check();
      await settled();
      assert.equal(lists(), before + 3);
    });
  });

  describe('when b is retargeted to main, ', () => {
    it('then the live stack offers a rebuild while retaining the history’s legs.', async () => {
      s.prs[1].baseRefName = 'main';
      s.update();
      stack.check(true);
      await settled();
      assert.equal(stack.value.changed, true);
      assert.deepEqual(stack.value.legs.map((l) => l.number), [3, 2, 1]);
    });
  });

  describe('when a lower leg merges, ', () => {
    it('then its state is live and the stack offers a rebuild.', async () => {
      s.prs[0].state = 'MERGED';
      s.prs[1].baseRefName = 'main';
      s.update();
      stack.check(true);
      await settled();
      assert.equal(stack.value.changed, true);
      assert.equal(stack.value.legs[2].state, 'MERGED');
    });
  });
});
