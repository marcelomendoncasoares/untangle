import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { until, workingFixture } from './working-fixture.ts';

describe('Given a pull request review with no agent holding it, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;
  let work: string;

  before(async () => {
    f = workingFixture();
    run = await startUntangle(f.url, { cacheDir: f.cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await waitForReview(client);
    work = path.join(f.cache, 'work/github.com/acme/sample/7');
  });
  after(async () => { await run?.stop(); f?.remove(); });

  describe('when the page asks for refresh state without the check parameter, ', () => {
    it('then it starts a background GitHub check and the working copy follows the fetched commit.', async () => {
      const next = f.commit(f.author.dir);
      f.push();
      assert.equal(f.git(work, 'rev-parse', 'HEAD'), f.head);
      const before = f.gh.calls().length;

      const answer = await client.call('refresh');
      assert.equal(answer.status, 200);
      await until('the background fetch', () => f.git(work, 'rev-parse', 'HEAD') === next);
      assert.ok(f.gh.calls().length > before);
    });
  });
});
