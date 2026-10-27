import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Local, LocalSummary } from '../../dist/local.js';
import { jsonScript, reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { workingFixture, until } from './working-fixture.ts';

interface Refresh { state: string; head: string; latest: string | null; local: Local | null }
const state = async (client: ReviewClient) => (await client.call('refresh', { query: { check: '1' } })).data as Refresh;
const hold = (client: ReviewClient) => client.call('notes/watch', { method: 'POST', body: { agent: 'Test', wait: 5_000 } });

describe('Given a running review of an open pull request’s link, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;
  let work: string;
  let next: string;

  before(async () => {
    f = workingFixture();
    run = await startUntangle(f.url, { cacheDir: f.cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await client.open();
    await waitForReview(client);
    await client.call('notes', { method: 'POST', body: { action: 'settings', live: true } });
    work = (await until('its working copy', async () => (await state(client)).local)).work!;
    await hold(client);
  });
  after(async () => { await run?.stop(); f?.remove(); });

  describe('when it is first read, ', () => {
    it('then both refresh forms include local, and its summary counts unpushed commits.', async () => {
      const expected = { work, branch: 'feature', github: f.head, unpushed: [], behind: 0, dirty: false };
      assert.deepEqual((await state(client)).local, expected);
      assert.deepEqual(((await client.call('refresh')).data as Refresh).local, expected);
      const summary = (await client.call('summary')).data as { local: LocalSummary };
      assert.deepEqual(summary.local, { work, branch: 'feature', unpushed: 0, behind: 0, dirty: false });
      const reviews = (await client.call('reviews')).data as { reviews: Array<{ local: LocalSummary }> };
      assert.deepEqual(reviews.reviews[0].local, summary.local);
    });

    it('then the watch names the reading checkout and the branch where changes belong.', async () => {
      await client.call('notes', { method: 'POST', body: { action: 'add', path: 'greeting.txt', side: 'RIGHT', line: 1, body: 'Change this greeting.' } });
      const watch = await hold(client);
      const text = JSON.stringify(watch.data);
      const checkout = path.join(f.cache, 'worktrees/github.com/acme/sample', f.head.slice(0, 12));
      assert.ok(text.includes(`That commit is checked out at ${checkout}, for reading only. The pull request’s branch, feature, is checked out at ${work}, for changes: commit there, and push when asked.`), text);
    });
  });

  describe('when the agent commits in the working copy, ', () => {
    before(() => { next = f.commit(work, 'greeting.txt', 'hello everyone\n'); });

    it('then latest follows it, local marks it unpushed, and a refresh reviews that commit.', async () => {
      const s = await until('the local commit', async () => {
        const s = await state(client);
        return s.latest === next && s.local?.unpushed?.includes(next) ? s : null;
      });
      assert.equal(s.head, f.head);
      await client.call('refresh', { method: 'POST' });
      await until('the refreshed review', async () => { const s = await state(client); return s.head === next && s.state === 'ready'; });
      const page = await client.page();
      const model = jsonScript(page.text, 'd-model') as { compares: { base: { right: string } } };
      assert.equal(model.compares.base.right, next.slice(0, 7));
      const notes = (await client.call('notes')).data as { head: string; notes: Array<{ changed: boolean; line: number }> };
      assert.equal(notes.head, next);
      assert.equal(notes.notes[0].line, 1);
      assert.equal(notes.notes[0].changed, true);
    });
  });

  describe('when the agent pushes that commit to the stand-in GitHub, ', () => {
    it('then the unpushed marks disappear.', async () => {
      f.git(work, 'push');
      const s = await until('the pushed commit', async () => {
        const s = await state(client);
        return s.local?.github === next && s.local.unpushed?.length === 0 ? s : null;
      });
      assert.equal(s.local!.dirty, false);
    });
  });

  describe('when an untracked file is added, ', () => {
    it('then dirty changes while the review and latest still name the committed head.', async () => {
      fs.writeFileSync(path.join(work, 'scratch.txt'), 'unfinished');
      const s = await until('the dirty flag', async () => {
        const s = await state(client);
        return s.local?.dirty ? s : null;
      });
      assert.equal(s.head, next);
      assert.equal(s.latest, next);
    });
  });

  describe('when the review is paused, ', () => {
    it('then the reviews page reads its uncommitted work from disk without fetching.', async () => {
      await run.stop();
      const restore = f.use();
      try {
        const { Manager } = await import('../../dist/manager.js');
        const before = f.gh.calls().length;
        const manager = new Manager();
        const view = await until('the paused local state', async () => {
          const view = await manager.view({ disk: false });
          return view.reviews[0]?.local ? view : null;
        });
        assert.equal(view.reviews[0].status, 'paused');
        assert.deepEqual(view.reviews[0].local, { work, branch: 'feature', unpushed: 0, behind: 0, dirty: true });
        assert.equal(f.gh.calls().length, before);
      } finally { restore(); }
    });
  });
});

describe('Given a folder whose branch has a pull request, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;

  before(async () => {
    f = workingFixture();
    run = await startUntangle(f.author.dir, { cacheDir: f.cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await client.open();
    await waitForReview(client);
    await client.call('notes', { method: 'POST', body: { action: 'settings', live: true } });
    await client.call('notes', { method: 'POST', body: { action: 'add', review: true, path: '', body: 'Please review.' } });
    await hold(client);
  });
  after(async () => { await run?.stop(); f?.remove(); });

  describe('when its commit is compared with the pull request, ', () => {
    it('then local reports its GitHub head and never makes a working copy for it.', async () => {
      const local = await until('the branch comparison', async () => {
        const local = (await state(client)).local;
        return local?.github ? local : null;
      });
      assert.deepEqual(local, { work: null, branch: 'feature', github: f.head, unpushed: [], behind: 0, dirty: false });
      assert.equal(fs.existsSync(path.join(f.cache, 'work')), false);
    });
  });

  describe('when someone else pushes, ', () => {
    it('then the folder stays on its own head and reports behind.', async () => {
      // Make the remote's next commit in a separate worktree, leaving the reviewed folder alone.
      const other = path.join(f.root, 'other');
      f.git(f.root, 'clone', '--branch', 'feature', f.remote, other);
      const theirs = f.commit(other, 'theirs.txt');
      f.git(other, 'push', 'origin', 'feature');
      f.git(f.bare, 'update-ref', 'refs/pull/7/head', theirs);
      f.pr.headRefOid = theirs;
      f.answer();
      const local = await until('the newer GitHub head', async () => {
        const local = (await state(client)).local;
        return local?.github === theirs ? local : null;
      });
      assert.equal(local.behind, 1);
      assert.equal(f.git(f.author.dir, 'rev-parse', 'HEAD'), f.head);
    });
  });
});

describe('Given a folder with a GitHub upstream and no pull request, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;

  before(async () => {
    f = workingFixture();
    f.gh.setReplies([]);
    f.git(f.author.dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/sample.git');
    f.git(f.author.dir, 'config', 'branch.feature.remote', 'origin');
    f.git(f.author.dir, 'config', 'branch.feature.merge', 'refs/heads/feature');
    f.git(f.author.dir, 'update-ref', 'refs/remotes/origin/feature', f.base);
    run = await startUntangle(f.author.dir, { base: 'main', cacheDir: f.cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await client.open();
    await waitForReview(client);
  });
  after(async () => { await run?.stop(); f?.remove(); });

  describe('when local is read, ', () => {
    it('then it compares with the upstream without moving the folder or its remote-tracking ref.', async () => {
      const local = await until('the upstream comparison', async () => {
        const local = (await state(client)).local;
        return local?.github ? local : null;
      });
      assert.deepEqual(local, { work: null, branch: 'feature', github: f.head, unpushed: [], behind: 0, dirty: false });
      assert.equal(f.git(f.author.dir, 'rev-parse', 'refs/remotes/origin/feature'), f.base);
      assert.equal(f.git(f.author.dir, 'rev-parse', 'HEAD'), f.head);
    });
  });
});

describe('Given a folder without a pull request or upstream, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;

  before(async () => {
    f = workingFixture();
    f.gh.setReplies([]);
    fs.writeFileSync(path.join(f.author.dir, 'untracked.txt'), 'unfinished');
    run = await startUntangle(f.author.dir, { base: 'main', cacheDir: f.cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await client.open();
    await waitForReview(client);
  });
  after(async () => { await run?.stop(); f?.remove(); });

  describe('when local is read, ', () => {
    it('then the branch and dirty flag are known and its GitHub comparison is unknown.', async () => {
      const local = await until('the local state', async () => (await state(client)).local);
      assert.deepEqual(local, { work: null, branch: 'feature', github: null, unpushed: null, behind: 0, dirty: true });
    });
  });
});

describe('Given a clean working copy whose pull request moves on, ', () => {
  let f: ReturnType<typeof workingFixture>;
  let run: UntangleRun;
  let client: ReviewClient;
  let work: string;

  before(async () => {
    f = workingFixture();
    run = await startUntangle(f.url, { cacheDir: f.cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await client.open();
    await waitForReview(client);
    work = (await until('its working copy', async () => (await state(client)).local)).work!;
    await client.call('notes', { method: 'POST', body: { action: 'settings', live: true } });
    await client.call('notes', { method: 'POST', body: { action: 'add', review: true, path: '', body: 'Please review.' } });
    await hold(client);
  });
  after(async () => { await run?.stop(); f?.remove(); });

  describe('when the background lookup sees GitHub’s new commit, ', () => {
    it('then the working copy fast-forwards and latest offers it while the page keeps its reviewed head.', async () => {
      const next = f.commit(f.author.dir);
      f.push();
      const s = await until('the fast-forward', async () => {
        const s = await state(client);
        return s.latest === next && s.local?.github === next ? s : null;
      });
      assert.equal(s.head, f.head);
      assert.equal(f.git(work, 'rev-parse', 'HEAD'), next);
      assert.deepEqual(s.local, { work, branch: 'feature', github: next, unpushed: [], behind: 0, dirty: false });
    });
  });

  describe('when its author force-pushes back over that commit, ', () => {
    it('then the working copy follows GitHub back, and latest offers it with nothing not pushed.', async () => {
      f.git(f.author.dir, 'reset', '--hard', f.head);
      f.push(true);
      const s = await until('the follow back', async () => {
        const s = await state(client);
        return s.latest === f.head && s.local?.github === f.head ? s : null;
      });
      assert.equal(f.git(work, 'rev-parse', 'HEAD'), f.head);
      assert.deepEqual(s.local, { work, branch: 'feature', github: f.head, unpushed: [], behind: 0, dirty: false });
    });
  });
});
