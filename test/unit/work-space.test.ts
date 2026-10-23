import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { localSummary, recordedLocal } from '../../dist/local.js';
import { listRecords, readRecord, recordFile, recordId, writeRecord, type ReviewRecord } from '../../dist/records.js';
import { forget, free, holdings, keptDirs, removeOld } from '../../dist/space.js';
import { resolveUrl, type Target } from '../../dist/target.js';
import { workingFixture } from '../server/working-fixture.ts';

describe('Given a closed review with a working copy, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let restore: () => void;
  let t: Target;
  let record: ReviewRecord;
  let ids: Set<string>;
  const saved = () => readRecord(recordFile(record.repoKey, record.key))!;

  beforeEach(async () => {
    f = workingFixture();
    restore = f.use();
    t = await resolveUrl(f.url, () => {});
    const now = new Date().toISOString();
    record = {
      version: 1, target: f.url, pr: 'acme/sample#7', dir: null, repoKey: t.repoKey, key: 'pr-7', repo: t.repo,
      title: '#7 Greet the world', author: null, url: f.url, size: { add: 1, del: 1, files: 1 }, base: f.base, head: f.head,
      progress: { done: 0, total: 1 }, notes: { open: 0, waiting: 0 }, chats: [], pid: null,
      started: now, opened: now, updated: now, stopped: { at: now, why: 'stop' }, closed: now,
      checkouts: [], analyses: [], freed: null,
      local: { work: t.work!.dir, branch: t.work!.githubBranch, ref: t.work!.ref },
    };
    writeRecord(record);
    ids = new Set([recordId(record)]);
  });
  afterEach(() => { restore(); f.remove(); });

  describe('when it has a commit GitHub lacks and is freed, ', () => {
    it('then the working copy stays, its record names it, and its local count remains readable.', async () => {
      f.commit(t.work!.dir);
      const result = await free(ids);
      assert.deepEqual(result.freed, [...ids]);
      assert.ok(saved().freed);
      assert.equal(saved().local?.work, t.work!.dir);
      assert.equal(fs.existsSync(t.work!.dir), true);
      assert.deepEqual(localSummary(await recordedLocal(saved())), { work: t.work!.dir, branch: 'feature', unpushed: 1, behind: 0, dirty: false });
      assert.ok(keptDirs(listRecords()[0]).includes(t.work!.dir));
    });
  });

  describe('when it has an untracked file and is freed, ', () => {
    it('then the working copy and that file stay.', async () => {
      const file = path.join(t.work!.dir, 'unfinished');
      fs.writeFileSync(file, 'keep');
      await free(ids);
      assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
      assert.equal(saved().local?.work, t.work!.dir);
    });
  });

  describe('when it has nothing GitHub lacks and is freed, ', () => {
    it('then git removes its worktree and the record no longer names it.', async () => {
      const result = await free(ids);
      assert.ok(result.removed.includes(t.work!.dir));
      assert.equal(fs.existsSync(t.work!.dir), false);
      assert.equal(saved().local, null);
      assert.ok(!f.git(t.repo, 'worktree', 'list').includes(t.work!.dir));
    });
  });

  describe('when it has a commit GitHub lacks and is forgotten, ', () => {
    it('then its record goes but the working copy and clone keep that commit.', async () => {
      const own = f.commit(t.work!.dir);
      await forget(ids);
      assert.equal(listRecords().length, 0);
      assert.equal(fs.existsSync(t.repo), true);
      assert.equal(f.git(t.work!.dir, 'rev-parse', 'HEAD'), own);
      assert.ok(f.git(t.repo, 'worktree', 'list').includes(t.work!.dir));
    });
  });

  describe('when it has an uncommitted change and is forgotten, ', () => {
    it('then its files and the clone they need stay.', async () => {
      fs.writeFileSync(path.join(t.work!.dir, 'greeting.txt'), 'unfinished\n');
      await forget(ids);
      assert.equal(fs.existsSync(t.repo), true);
      assert.equal(fs.readFileSync(path.join(t.work!.dir, 'greeting.txt'), 'utf8'), 'unfinished\n');
    });
  });

  describe('when GitHub’s last fetched head is unknown and it is forgotten, ', () => {
    it('then the working copy is kept because its commits cannot be proved pushed.', async () => {
      f.git(t.repo, 'update-ref', '-d', t.work!.ref);
      await forget(ids);
      assert.equal(fs.existsSync(t.work!.dir), true);
      assert.equal(fs.existsSync(t.repo), true);
    });
  });

  describe('when it has nothing GitHub lacks and is forgotten, ', () => {
    it('then its working copy and unused clone go with its record.', async () => {
      await forget(ids);
      assert.equal(fs.existsSync(t.work!.dir), false);
      assert.equal(fs.existsSync(t.repo), false);
      assert.equal(listRecords().length, 0);
    });
  });

  describe('when retained work is pushed after freeing and then forgotten, ', () => {
    it('then the now-clean working copy and clone can go.', async () => {
      f.commit(t.work!.dir);
      await free(ids);
      f.git(t.work!.dir, 'push');
      await forget(ids);
      assert.equal(fs.existsSync(t.work!.dir), false);
      assert.equal(fs.existsSync(t.repo), false);
    });
  });

  describe('when the review is paused and old checkouts are removed, ', () => {
    it('then its working copy is an open holding and is never an old checkout.', () => {
      writeRecord({ ...record, closed: null });
      const old = new Date(Date.now() - 86_400_000);
      fs.utimesSync(t.work!.dir, old, old);
      assert.ok(holdings().open.has(t.work!.dir));
      assert.ok(!removeOld().includes(t.work!.dir));
      assert.equal(fs.existsSync(t.work!.dir), true);
    });
  });
});
