import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { until, workingFixture } from './working-fixture.ts';

const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

describe('Given a held review whose local git status is blocked, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;
  let gate: string;
  let entered: string;
  let next: string;

  before(async () => {
    f = workingFixture();
    f.gh.setReplies([]);
    gate = path.join(f.root, 'hold');
    entered = path.join(f.root, 'entered');
    const bin = path.join(f.root, 'bin');
    fs.mkdirSync(bin);
    const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = status ] && [ -e ${quote(gate)} ]; then
    touch ${quote(entered)}
    while [ -e ${quote(gate)} ]; do sleep 0.02; done
  fi
done
exec ${quote(git)} "$@"
`, { mode: 0o755 });
    run = await startUntangle(f.author.dir, { base: 'main', cacheDir: f.cache, gh: f.gh, env: { ...f.env, PATH: bin + path.delimiter + f.gh.env.PATH, UNTANGLE_NOTES_QUIET: '0' } });
    client = reviewClient(run.url);
    await client.open();
    await waitForReview(client);
    await until('the initial local state', async () => ((await client.call('refresh')).data as { local: unknown }).local);
    await client.call('notes', { method: 'POST', body: { action: 'settings', live: true } });
    await client.call('notes', { method: 'POST', body: { action: 'add', review: true, path: '', body: 'Please review.' } });
    await client.call('notes/watch', { method: 'POST', body: { agent: 'Test', wait: 1000 } });
    fs.writeFileSync(gate, 'hold status');
    await until('the background status command', () => fs.existsSync(entered));
    // The blocked read has already read HEAD; the page must get a later read of this commit.
    next = f.commit(f.author.dir);
  });
  after(async () => {
    if (gate) fs.rmSync(gate, { force: true });
    await run?.stop();
    f?.remove();
  });

  describe('when the page asks for local state and the summary, ', () => {
    it('then the summary stays responsive and refresh returns known state after its two-second limit.', async () => {
      let summaryTimeout: NodeJS.Timeout | undefined;
      let refreshTimeout: NodeJS.Timeout | undefined;
      let refreshed = false;
      const started = performance.now();
      const refresh = client.call('refresh', { query: { check: '1' } }).then((answer) => {
        refreshed = true;
        return answer;
      });
      try {
        const summary = await Promise.race([
          client.call('summary'),
          new Promise<never>((_, reject) => { summaryTimeout = setTimeout(() => reject(new Error('summary waited for git status')), 1500); }),
        ]);
        clearTimeout(summaryTimeout);
        assert.equal(summary.status, 200);
        assert.equal(refreshed, false);

        const answer = await Promise.race([
          refresh,
          new Promise<never>((_, reject) => { refreshTimeout = setTimeout(() => reject(new Error('refresh exceeded its local-read deadline')), 3000); }),
        ]);
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 1900 && elapsed < 3000, `refresh took ${elapsed} ms`);
        assert.equal(answer.status, 200);
        assert.equal((answer.data as { local: { dirty: boolean } }).local.dirty, false);
        assert.equal((answer.data as { latest: string }).latest, f.head);
        assert.equal(fs.existsSync(gate), true);
      } finally {
        clearTimeout(summaryTimeout);
        clearTimeout(refreshTimeout);
      }
    });
  });

  describe('when the older background read is released after that response, ', () => {
    it('then the pending page read still runs and the next ask sees the newer commit.', async () => {
      fs.rmSync(gate);
      const answer = await client.call('refresh', { query: { check: '1' } });
      assert.equal(answer.status, 200);
      assert.equal((answer.data as { latest: string }).latest, next);
    });
  });
});
