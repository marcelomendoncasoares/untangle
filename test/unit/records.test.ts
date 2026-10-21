import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ReviewRecord } from '../../dist/records.js';
const { dirSize, listRecords, recordFile, writeRecord } = await import('../../dist/records.js');

// A process that has ended: its id names no running process now.
const endedPid = () => spawnSync(process.execPath, ['-e', '0']).pid!;

const record = (key: string, more: Partial<ReviewRecord>): ReviewRecord => ({
  version: 1, target: `https://github.com/o/r/pull/${key}`, pr: `o/r#${key}`, dir: null, repoKey: 'github.com/o/r', key: `pr-${key}`, repo: '/repo',
  title: `#${key} Something`, author: 'ada', url: null, size: { add: 1, del: 0, files: 1 }, base: 'b'.repeat(40), head: 'h'.repeat(40),
  progress: { done: 0, total: 1 }, notes: { open: 0, waiting: 0 }, chats: [], pid: null,
  started: '2026-10-01T00:00:00.000Z', opened: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z',
  stopped: null, closed: null, checkouts: [], analyses: [], ...more,
});

describe('Given the records of reviews in the cache, ', () => {
  let cache = '';
  const was = process.env.UNTANGLE_CACHE;
  before(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-records-'));
    process.env.UNTANGLE_CACHE = cache;
  });
  after(() => {
    if (was === undefined) delete process.env.UNTANGLE_CACHE;
    else process.env.UNTANGLE_CACHE = was;
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when they are listed, '
    + 'then running ones come first, then paused, then closed, the latest first in each, '
    + 'and one whose process ended without saying so is paused, as ended.',
    () => {
      writeRecord(record('1', { stopped: { at: '2026-10-02T00:00:00.000Z', why: 'paused' } }));
      writeRecord(record('2', { pid: process.pid, opened: '2026-10-03T00:00:00.000Z' }));
      writeRecord(record('3', { pid: endedPid(), updated: '2026-10-05T00:00:00.000Z' }));
      writeRecord(record('4', { stopped: { at: '2026-10-04T00:00:00.000Z', why: 'stop' }, closed: '2026-10-04T00:00:00.000Z' }));
      writeRecord(record('5', { pid: process.pid, opened: '2026-10-06T00:00:00.000Z' }));
      const listed = listRecords();
      assert.deepEqual(listed.map((r) => [r.key, r.status, r.stopped && r.stopped.why]), [
        ['pr-5', 'running', null], ['pr-2', 'running', null],
        ['pr-3', 'paused', 'ended'], ['pr-1', 'paused', 'paused'],
        ['pr-4', 'closed', 'stop'],
      ]);
    },
  );

  it(
    'when a review’s name has a slash, as a branch’s can, '
    + 'then its record is one file in its repository’s folder.',
    () => {
      assert.equal(path.relative(cache, recordFile('local/app-1a2b', 'fix/login')), path.join('sessions', 'local', 'app-1a2b', 'fix%2Flogin.json'));
    },
  );

  it(
    'when a folder’s size is asked, '
    + 'then it counts what its files take on disk, through its subfolders, and 0 for a folder that isn’t there.',
    () => {
      const dir = path.join(cache, 'sized');
      fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'a', 'one.txt'), 'x'.repeat(10_000));
      fs.writeFileSync(path.join(dir, 'a', 'b', 'two.txt'), 'y'.repeat(5_000));
      assert.ok(dirSize(dir) >= 15_000, String(dirSize(dir)));
      assert.equal(dirSize(path.join(cache, 'none')), 0);
    },
  );
});
