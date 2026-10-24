import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveUrl, type Target } from '../../dist/target.js';
import { legWorkingCopies, stackRecord } from '../../dist/stack.js';
import { free, forget, holdings } from '../../dist/space.js';
import { recordId, writeRecord, type ReviewRecord } from '../../dist/records.js';
import { useStub } from '../helpers/gh.ts';
import { stackFixture, type StackFixture } from '../helpers/stack.ts';

describe('Given a stack review with a lower working copy, ', () => {
  let s: StackFixture, cache: string, restore: () => void, previous: NodeJS.ProcessEnv;
  let t: Target, lower: string, r: ReviewRecord, ids: Set<string>;
  beforeEach(async () => {
    s = stackFixture();
    cache = fs.mkdtempSync('/tmp/untangle-stack-space-');
    previous = { ...process.env };
    restore = useStub(s.gh);
    Object.assign(process.env, s.env, { UNTANGLE_CACHE: cache });
    t = await resolveUrl(s.urls.c, () => {});
    lower = (await legWorkingCopies(t, true)(2))!.dir;
    const now = new Date().toISOString();
    r = {
      version: 1, target: s.urls.c, pr: 'acme/sample#3', dir: null, repoKey: t.repoKey, key: 'pr-3', repo: t.repo,
      title: '#3 Add c', author: null, url: s.urls.c, size: { add: 1, del: 1, files: 1 }, base: t.baseSha, head: t.headSha,
      progress: { done: 0, total: 1 }, notes: { open: 1, waiting: 0 }, chats: [], pid: null,
      started: now, opened: now, updated: now, stopped: { at: now, why: 'stop' }, closed: now,
      checkouts: [], analyses: [], stack: stackRecord(t.stack), local: { work: t.work!.dir, branch: 'c', ref: t.work!.ref },
    };
    writeRecord(r);
    ids = new Set([recordId(r)]);
  });
  afterEach(() => {
    restore();
    for (const key of [...Object.keys(s.env), 'UNTANGLE_CACHE']) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
    s.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the lower branch has a local commit and the review is opened again, ', () => {
    it('then that leg’s head is reused without resetting the commit.', async () => {
      s.git(lower, 'config', 'user.name', 'Ada');
      s.git(lower, 'config', 'user.email', 'ada@example.com');
      s.git(lower, 'commit', '--allow-empty', '-m', 'Local lower fix');
      const head = s.git(lower, 'rev-parse', 'HEAD');
      const again = await resolveUrl(s.urls.c, () => {});
      assert.equal(again.stack!.legs[1].head, head);
      assert.equal(s.git(lower, 'rev-parse', 'HEAD'), head);
    });
  });

  describe('when its lower branch has work and the review is forgotten, ', () => {
    it('then the lower working copy and its clone remain.', async () => {
      fs.writeFileSync(path.join(lower, 'unfinished.txt'), 'keep this');
      await forget(ids);
      assert.equal(fs.readFileSync(path.join(lower, 'unfinished.txt'), 'utf8'), 'keep this');
      assert.ok(fs.existsSync(t.repo));
      assert.ok(!fs.existsSync(t.work!.dir));
    });
  });

  describe('when the lower branch has an unpushed commit and the review is freed, ', () => {
    it('then that branch and its commit remain available.', async () => {
      s.git(lower, 'config', 'user.name', 'Ada');
      s.git(lower, 'config', 'user.email', 'ada@example.com');
      s.git(lower, 'commit', '--allow-empty', '-m', 'Keep the lower commit');
      const head = s.git(lower, 'rev-parse', 'HEAD');
      await free(ids);
      assert.equal(s.git(lower, 'rev-parse', 'HEAD'), head);
    });
  });

  describe('when a second open review keeps the same lower leg, ', () => {
    it('then freeing this review leaves the shared working copy.', async () => {
      writeRecord({ ...r, key: 'pr-4', target: s.urls.d, pr: 'acme/sample#4', closed: null, local: null, stack: { legs: [4, 3, 2, 1], base: 'main' } });
      assert.ok(holdings().open.has(lower));
      const result = await free(ids);
      assert.ok(!result.removed.includes(lower));
      assert.ok(fs.existsSync(lower));
    });
  });

  describe('when every working copy is clean and no other review keeps it, ', () => {
    it('then freeing the review removes the lower working copy too.', async () => {
      const result = await free(ids);
      assert.ok(result.removed.includes(lower));
      assert.ok(!fs.existsSync(lower));
    });
  });
});
