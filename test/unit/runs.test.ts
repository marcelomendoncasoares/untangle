import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { RunInfo } from '../../dist/runs.js';
const { findRun, holder, wantedUrl, writeRun } = await import('../../dist/runs.js');

const run = (pid: number, more: Partial<RunInfo>): RunInfo => ({ pid, url: `http://127.0.0.1:${pid}/`, token: 't', dir: null, pr: null, started: '2026-10-21T10:00:00.000Z', ...more });

describe('Given untangles that take a review as they start, ', () => {
  const a = run(101, { repoKey: 'github.com/acme/app', key: 'pr-5', claimed: '2026-10-21T10:00:01.000Z' });

  it(
    'when one takes a review another took first, '
    + 'then it gives way to that one, and the one that took it first keeps it.',
    () => {
      const b = run(102, { repoKey: 'github.com/Acme/App', key: 'pr-5', claimed: '2026-10-21T10:00:02.000Z' });
      assert.equal(holder(b, 'acme/app#5', [a, b])?.pid, 101);
      assert.equal(holder(a, 'acme/app#5', [a, b]), null);
    },
  );

  it(
    'when two take it at the same moment, '
    + 'then the one with the lower process id keeps it.',
    () => {
      const b = run(99, { repoKey: 'github.com/acme/app', key: 'pr-5', claimed: a.claimed });
      assert.equal(holder(a, null, [a, b])?.pid, 99);
      assert.equal(holder(b, null, [a, b]), null);
    },
  );

  it(
    'when the other one reviews something else, or hasn’t said what yet, '
    + 'then this one keeps it.',
    () => {
      const other = run(90, { repoKey: 'github.com/acme/app', key: 'pr-6', claimed: '2026-10-21T09:00:00.000Z' });
      const resolving = run(91, { pr: 'acme/app#5', started: '2026-10-21T09:00:00.000Z' });
      assert.equal(holder(a, 'acme/app#5', [a, other, resolving]), null);
    },
  );

  it(
    'when an untangle from before run files said which review they serve has built the same pull request or directory, '
    + 'then this one gives way to it.',
    () => {
      const older = run(80, { pr: 'acme/app#5', repoKey: 'github.com/acme/app', head: 'h'.repeat(40), started: '2026-10-20T10:00:00.000Z' });
      assert.equal(holder(a, 'acme/app#5', [a, older])?.pid, 80);
      const dir = run(81, { dir: '/work/app', head: 'h'.repeat(40) });
      assert.equal(holder({ ...a, dir: '/work/app' }, null, [a, dir])?.pid, 81);
    },
  );
});

describe('Given a pull request’s link, ', () => {
  let cache = '';
  const was = process.env.UNTANGLE_CACHE;
  before(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-runs-'));
    process.env.UNTANGLE_CACHE = cache;
  });
  after(() => {
    if (was === undefined) delete process.env.UNTANGLE_CACHE;
    else process.env.UNTANGLE_CACHE = was;
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when what it stands for is asked, '
    + 'then it’s the pull request, its repository, and its review’s key.',
    () => {
      assert.deepEqual(wantedUrl('https://github.com/Acme/App/pull/5/files'), { pr: 'acme/app#5', dir: null, repoKey: 'github.com/Acme/App', branch: null, key: 'pr-5' });
      assert.equal(wantedUrl('https://example.com/acme/app/pull/5'), null);
    },
  );

  it(
    'when its review is looked for while a directory on its branch is reviewed, '
    + 'then that review is found, by its key.',
    () => {
      writeRun(run(process.pid, { dir: '/work/app', repoKey: 'github.com/acme/app', branch: 'retry', key: 'pr-5', claimed: '2026-10-21T10:00:00.000Z' }));
      assert.equal(findRun(wantedUrl('https://github.com/acme/app/pull/5')!)?.pid, process.pid);
      assert.equal(findRun(wantedUrl('https://github.com/acme/app/pull/6')!), null);
    },
  );
});
