import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Local } from '../../dist/local.js';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { until, workingFixture } from './working-fixture.ts';

describe('Given a folder review that no agent holds, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;

  beforeEach(async () => {
    f = workingFixture();
    f.gh.setReplies([]);
    run = await startUntangle(f.author.dir, { base: 'main', cacheDir: f.cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await waitForReview(client);
    await until('the first local read', async () => ((await client.call('summary')).data as { local: unknown }).local);
  });
  afterEach(async () => { await run?.stop(); f?.remove(); });

  describe('when its branch gets a commit just after a local read, ', () => {
    it('then the very next page check answers with that commit, without waiting for the cached read to age.', async () => {
      const next = f.commit(f.author.dir);
      const answer = await client.call('refresh', { query: { check: '1' } });
      assert.equal(answer.status, 200);
      const state = answer.data as { latest: string; watched: boolean; local: Local };
      assert.equal(state.watched, false);
      assert.equal(state.latest, next);
      assert.equal(state.local.dirty, false);
    });
  });

  describe('when a file changes and the page asks without the check parameter, ', () => {
    it('then that response also waits for fresh local state.', async () => {
      fs.writeFileSync(path.join(f.author.dir, 'scratch.txt'), 'unfinished\n');
      const answer = await client.call('refresh');
      assert.equal(answer.status, 200);
      const state = answer.data as { watched: boolean; local: Local };
      assert.equal(state.watched, false);
      assert.equal(state.local.dirty, true);
    });
  });
});
