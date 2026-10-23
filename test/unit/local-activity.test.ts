import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { LocalChanges } from '../../dist/local.js';
import { resolveUrl, type Target } from '../../dist/target.js';
import { workingFixture } from '../server/working-fixture.ts';

describe('Given a running pull request review with no page or agent, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let restore: () => void;
  let target: Target;
  let local: LocalChanges;
  let held: boolean;
  let calls: { gh: number; fetch: number };
  let statusReads: number;
  const pending = new Set<Promise<void>>();

  // Observe real child commands, and wait for their continuations as well as their exits.
  // Advancing only Date keeps the network cadence tests independent of wall-clock delays.
  async function settled() {
    do {
      await Promise.all([...pending]);
      await setImmediate();
    } while (pending.size);
  }

  async function tick(ms: number, pageAsked = false) {
    mock.timers.tick(ms);
    await local.check(pageAsked);
    await settled();
  }

  beforeEach(async () => {
    f = workingFixture();
    restore = f.use();
    target = await resolveUrl(f.url, () => {});
    held = false;
    calls = { gh: 0, fetch: 0 };
    statusReads = 0;
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

    const spawn = childProcess.spawn;
    mock.method(childProcess, 'spawn', ((...args: Parameters<typeof spawn>) => {
      if (args[0] === 'gh') calls.gh++;
      if (args[0] === 'git' && args[1]?.includes('fetch')) calls.fetch++;
      if (args[0] === 'git' && args[1]?.includes('status')) statusReads++;
      const child = spawn(...args);
      const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
      pending.add(done);
      void done.then(() => pending.delete(done));
      return child;
    }) as typeof spawn);
    syncBuiltinESMExports();

    local = new LocalChanges(target, true, () => held, () => {});
    await settled();
  });

  afterEach(async () => {
    local?.stop();
    await settled();
    mock.reset();
    mock.timers.reset();
    syncBuiltinESMExports();
    restore?.();
    f?.remove();
  });

  describe('when several background cycles pass without anyone asking, ', () => {
    it('then local changes are read without any gh call or git fetch.', async () => {
      fs.writeFileSync(path.join(target.work!.dir, 'greeting.txt'), 'unfinished\n');
      await tick(60_000);
      await tick(60_000);
      await tick(60_000);
      assert.equal(local.local!.dirty, true);
      assert.deepEqual(calls, { gh: 0, fetch: 0 });
    });
  });

  describe('when a page asks repeatedly, ', () => {
    it('then GitHub is checked at most once each minute.', async () => {
      await tick(0, true);
      assert.deepEqual(calls, { gh: 1, fetch: 1 });
      await tick(59_999, true);
      assert.deepEqual(calls, { gh: 1, fetch: 1 });
      await tick(1, true);
      assert.deepEqual(calls, { gh: 2, fetch: 2 });
    });
  });

  describe('when the branch gets a commit just after the initial background read, ', () => {
    it('then the first page request reads the new head even with no time elapsed on the clock.', async () => {
      const next = f.commit(target.work!.dir);
      await local.check(true);
      assert.equal(local.latest, next);
      assert.deepEqual(local.local!.unpushed, [next]);
    });
  });

  describe('when the page asks again within two seconds of its own read, ', () => {
    it('then those asks share the page read, and an ask after the window reads again.', async () => {
      await tick(0, true);
      const next = f.commit(target.work!.dir);
      const before = statusReads;
      mock.timers.tick(1_999);
      await local.check(true);
      assert.equal(local.latest, f.head);
      assert.equal(statusReads, before);

      mock.timers.tick(2);
      await local.check(true);
      assert.equal(local.latest, next);
      assert.deepEqual(local.local!.unpushed, [next]);
      assert.equal(statusReads - before, 1);
      assert.deepEqual(calls, { gh: 1, fetch: 1 });
    });
  });

  describe('when two page requests arrive after their previous read’s sharing window, ', () => {
    it('then both await the same local read without advancing the network schedule.', async () => {
      await tick(0, true);
      const next = f.commit(target.work!.dir);
      const before = statusReads;
      mock.timers.tick(2_001);
      await Promise.all([local.check(true), local.check(true)]);
      assert.equal(local.latest, next);
      assert.equal(statusReads - before, 1);
      assert.deepEqual(calls, { gh: 1, fetch: 1 });
    });
  });

  describe('when two minutes pass since the page last asked, ', () => {
    it('then GitHub checks stop while local reads continue.', async () => {
      await tick(0, true);
      await tick(60_000);
      assert.deepEqual(calls, { gh: 2, fetch: 2 });
      fs.writeFileSync(path.join(target.work!.dir, 'greeting.txt'), 'unfinished\n');
      await tick(60_000);
      await tick(60_000);
      assert.equal(local.local!.dirty, true);
      assert.deepEqual(calls, { gh: 2, fetch: 2 });
    });
  });

  describe('when the page asks again within those two minutes, ', () => {
    it('then its latest request renews the window.', async () => {
      await tick(0, true);
      await tick(60_000, true);
      await tick(60_000);
      assert.deepEqual(calls, { gh: 3, fetch: 3 });
      await tick(60_000);
      assert.deepEqual(calls, { gh: 3, fetch: 3 });
    });
  });

  describe('when an agent holds the review without a page asking, ', () => {
    it('then GitHub is checked every fifteen seconds until the agent lets go.', async () => {
      held = true;
      await tick(0);
      assert.deepEqual(calls, { gh: 1, fetch: 1 });
      await tick(14_999);
      assert.deepEqual(calls, { gh: 1, fetch: 1 });
      await tick(1);
      assert.deepEqual(calls, { gh: 2, fetch: 2 });
      held = false;
      await tick(60_000);
      assert.deepEqual(calls, { gh: 2, fetch: 2 });
    });
  });
});
