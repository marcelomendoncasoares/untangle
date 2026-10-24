import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { History } from '../../dist/history.js';
import type { Conversation } from '../../dist/github.js';
import type { LiveStack } from '../../dist/stack-live.js';
import { pendingAnswer, pendingLookup } from '../helpers/conversation.ts';
import { reviewClient, waitForReview, jsonScript, type ReviewClient } from '../helpers/http.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { stackFixture, type StackFixture } from '../helpers/stack.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null>, message: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  do {
    const found = await fn();
    if (found != null) return found;
    await sleep(100);
  } while (Date.now() < end);
  throw new Error(message);
}

function served(folder = false) {
  let s: StackFixture, cache: string, run: UntangleRun, client: ReviewClient, html: string;
  before(async () => {
    s = stackFixture();
    cache = fs.mkdtempSync('/tmp/untangle-stack-server-');
    run = await startUntangle(folder ? s.work.dir : s.urls.c, { cacheDir: cache, gh: s.gh, env: { ...s.env, UNTANGLE_NOTES_QUIET: '0' }, quiet: false });
    client = reviewClient(run.url);
    try { html = await waitForReview(client); } catch (e) { throw new Error(`${e}\n${run.output()}`); }
  });
  after(async () => {
    await run?.stop();
    s?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });
  return {
    get s() { return s; }, get cache() { return cache; }, get run() { return run; }, get client() { return client; }, get html() { return html; },
    post: (body: unknown) => client.call('github', { method: 'POST', body }),
  };
}

describe('Given a served stack review, ', () => {
  const f = served();
  describe('when the page loads, ', () => {
    it('then history, the live stack, its summary and its record all name the same legs.', async () => {
      const history = jsonScript(f.html, 'd-history') as History;
      assert.deepEqual(history.stack?.legs.map((l) => l.number), [3, 2, 1]);
      const refresh = (await f.client.call('refresh')).data as { stack: LiveStack; local: unknown };
      assert.deepEqual(refresh.stack.legs.map((l) => l.number), [3, 2, 1]);
      assert.deepEqual(refresh.stack.legs[0].local, refresh.local);
      assert.equal(refresh.stack.changed, false);
      const summary = (await f.client.call('summary')).data as { stack: unknown };
      assert.deepEqual(summary.stack, { legs: [3, 2, 1], base: 'main' });
      const record = JSON.parse(fs.readFileSync(path.join(f.cache, 'sessions/github.com/acme/sample/pr-3.json'), 'utf8'));
      assert.deepEqual(record.stack, summary.stack);
      const rows = (await f.client.call('reviews')).data as { reviews: Array<{ stack: unknown }> };
      assert.deepEqual(rows.reviews[0].stack, summary.stack);
    });
  });

  describe('when the conversations are read, ', () => {
    let d: Conversation;
    before(async () => { d = (await f.client.call('github')).data as Conversation; });
    it('then each leg has a conversation and b’s thread is placed at the review’s line.', () => {
      assert.deepEqual([d.pr.number, ...d.legs!.map((l) => l.pr.number)], [3, 2, 1]);
      const t = d.legs![0].threads.find((t) => t.id === 'B_LINE')!;
      assert.equal(t.pr, 2);
      assert.equal(t.legLine, f.s.line('b', "'b'"));
      assert.equal(t.line, f.s.line('c', "'b'"));
      assert.equal(t.outdated, false);
    });
    it('then a lower thread whose line changed above is outdated and has no review line.', () => {
      const t = d.legs![0].threads.find((t) => t.id === 'B_OLD')!;
      assert.equal(t.line, null);
      assert.equal(t.outdated, true);
      assert.equal(t.legLine, f.s.line('b', "'temporary b'"));
    });
    it('then a removed-line thread maps from b’s base to the stack’s base.', () => {
      const t = d.legs![0].threads.find((t) => t.id === 'B_REMOVED')!;
      assert.equal(t.side, 'LEFT');
      assert.equal(t.legLine, f.s.line('a', "'obsolete'"));
      assert.equal(t.line, f.s.line('main', "'obsolete'"));
    });
    it('then a context thread in a file the overall review no longer shows is outdated.', () => {
      const t = d.legs![0].threads.find((t) => t.id === 'B_CONTEXT')!;
      assert.equal(t.line, null);
      assert.equal(t.legLine, 2);
      assert.equal(t.outdated, true);
    });
  });

  describe('when the composer asks where b’s line goes, ', () => {
    it('then the answer is local, without any gh calls, and names b’s own line.', async () => {
      const before = f.s.gh.calls().filter((c) => c.args[0] === 'api').length;
      const r = await f.post({ action: 'where', draft: { path: f.s.file, line: f.s.line('c', "'b'") } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.data, { pr: 2, line: f.s.line('b', "'b'"), startLine: null, side: 'RIGHT' });
      assert.equal(f.s.gh.calls().filter((c) => c.args[0] === 'api').length, before);
    });
  });

  describe('when a comment on b’s line is posted, ', () => {
    it('then the mutation names b and the answer keeps every conversation with its placement.', async () => {
      f.s.update(3, [{ match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThread(', stdout: { data: { addPullRequestReviewThread: { thread: { pullRequest: f.s.conversations[1] } } } } }]);
      const r = await f.post({ action: 'thread', mode: 'review', draft: { path: f.s.file, line: f.s.line('c', "'b'"), body: 'Review b.' } });
      assert.equal(r.status, 200, r.text);
      const d = r.data as Conversation;
      assert.deepEqual(d.placed, { pr: 2, line: f.s.line('b', "'b'"), startLine: null, side: 'RIGHT' });
      assert.equal(d.pr.number, 3);
      assert.deepEqual(d.legs?.map((l) => l.pr.number), [2, 1]);
      const call = f.s.gh.calls().map((c) => JSON.parse(c.stdin || '{}')).findLast((c) => c.query?.includes('addPullRequestReviewThread('));
      assert.equal(call.variables.input.pullRequestId, 'PR_2');
      assert.equal(call.variables.input.line, f.s.line('b', "'b'"));
    });
  });

  describe('when a removed line is commented on, ', () => {
    it('then the comment goes to b’s base coordinates.', async () => {
      const r = await f.post({ action: 'thread', mode: 'review', draft: { path: f.s.file, side: 'LEFT', line: f.s.line('main', "'obsolete'"), body: 'The removed line.' } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual((r.data as Conversation).placed, { pr: 2, line: f.s.line('a', "'obsolete'"), startLine: null, side: 'LEFT' });
    });
  });

  describe('when a reply names a lower leg’s thread, ', () => {
    it('then the pending review lookup and reply belong to that leg.', async () => {
      f.s.update(3, [
        { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer('PENDING_B') },
        { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThreadReply(', stdout: { data: { addPullRequestReviewThreadReply: { comment: { pullRequest: f.s.conversations[1] } } } } },
      ]);
      const r = await f.post({ action: 'reply', mode: 'review', thread: 'B_LINE', body: 'Answer in b.' });
      assert.equal(r.status, 200, r.text);
      const calls = f.s.gh.calls().map((c) => JSON.parse(c.stdin || '{}'));
      assert.equal(calls.findLast((c) => c.query?.includes(pendingLookup)).variables.number, 2);
      assert.equal(calls.findLast((c) => c.query?.includes('addPullRequestReviewThreadReply(')).variables.input.pullRequestReviewThreadId, 'B_LINE');
    });
  });

  describe('when b’s pending review is submitted explicitly, ', () => {
    it('then only b’s pending review is submitted.', async () => {
      f.s.update(3, [
        { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer('PENDING_B') },
        { match: ['api', 'graphql'], stdinIncludes: 'submitPullRequestReview(', stdout: { data: { submitPullRequestReview: { pullRequestReview: { pullRequest: f.s.conversations[1] } } } } },
      ]);
      const r = await f.post({ action: 'submit', pr: 2, event: 'COMMENT', body: 'Reviewed b.' });
      assert.equal(r.status, 200, r.text);
      const call = f.s.gh.calls().map((c) => JSON.parse(c.stdin || '{}')).findLast((c) => c.query?.includes('submitPullRequestReview('));
      assert.equal(call.variables.input.pullRequestReviewId, 'PENDING_B');
    });
  });

  describe('when a note on a lower line asks for a change, ', () => {
    let note: { n: number; pr: number }, watch: { text: string };
    before(async () => {
      const r = await f.client.call('notes', { method: 'POST', body: { action: 'add', path: f.s.file, line: f.s.line('c', "'b'"), body: 'Please fix this in b.' } });
      note = (r.data as { notes: Array<{ n: number; pr: number }> }).notes[0];
      watch = (await f.client.call('notes/watch', { method: 'POST', body: { agent: 'Test', brief: true } })).data as { text: string };
    });
    it('then the note names b and the watch waits for b’s working copy.', () => {
      assert.equal(note.pr, 2);
      const work = path.join(f.cache, 'work/github.com/acme/sample/2');
      assert.ok(fs.existsSync(path.join(work, '.git')));
      assert.ok(watch.text.includes(`N${note.n} · ${f.s.file}:${f.s.line('c', "'b'")} · #2`), watch.text);
      assert.ok(watch.text.includes(`#2’s branch, b, is checked out at ${work}, for changes.`), watch.text);
      assert.ok(watch.text.includes('The review covers a stack: #3 and the pull requests under it, down to main. Each note names the pull request its line is in. When a note on a lower pull request asks for a change, make it on that pull request’s branch, in the working copy named with the note, and commit it there; then merge that branch into each branch above it, in order, up to c. When asked to push, push the lowest branch first.'), watch.text);
    });
    it('then Comment this routes through the note’s stored leg.', async () => {
      f.s.update(3, [{
        match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThread(',
        stdout: { data: { addPullRequestReviewThread: { thread: { id: 'B_POSTED', comments: { nodes: [{ id: 'B_NEW' }] }, pullRequest: f.s.conversations[1] } } } },
      }]);
      const r = await f.client.call('notes', { method: 'POST', body: { action: 'comment', n: note.n, mode: 'review', body: 'A comment from b’s note.' } });
      assert.equal(r.status, 200, r.text);
      const call = f.s.gh.calls().map((c) => JSON.parse(c.stdin || '{}')).findLast((c) => c.query?.includes('addPullRequestReviewThread('));
      assert.equal(call.variables.input.pullRequestId, 'PR_2');
    });
    it('then an agent’s draft answer becomes a pending thread on that same leg.', async () => {
      const added = await f.client.call('notes', { method: 'POST', body: { action: 'add', path: f.s.file, line: f.s.line('c', "'b'"), body: 'Explain this for the author.', draft: true } });
      const n = (added.data as { notes: Array<{ n: number }> }).notes.at(-1)!.n;
      const r = await f.client.call('notes/agent', { method: 'POST', body: { agent: 'Test', n, body: 'The draft for b.' } });
      assert.equal(r.status, 200, r.text);
      const call = f.s.gh.calls().map((c) => JSON.parse(c.stdin || '{}')).findLast((c) => c.query?.includes('addPullRequestReviewThread('));
      assert.equal(call.variables.input.pullRequestId, 'PR_2');
      assert.equal(call.variables.input.body, 'The draft for b.');
      const notes = (await f.client.call('notes')).data as { notes: Array<{ n: number; said: Array<{ pending: boolean }> }> };
      assert.equal(notes.notes.find((x) => x.n === n)!.said[0].pending, true);
    });
    it('then a note asking about an outdated lower thread retains that thread’s leg.', async () => {
      const r = await f.client.call('notes', { method: 'POST', body: {
        action: 'add', path: f.s.file, file: true, body: 'Explain this older thread.',
        about: { kind: 'thread', thread: 'B_OLD', author: 'ada', body: 'This later changes.', url: f.s.urls.b },
      } });
      assert.equal(r.status, 200, r.text);
      const note = (r.data as { notes: Array<{ pr: number }> }).notes.at(-1)!;
      assert.equal(note.pr, 2);
    });
  });

  describe('when a lower working copy has a commit that has not been merged up, ', () => {
    let lower = '', upper = '';
    before(() => {
      lower = path.join(f.cache, 'work/github.com/acme/sample/2');
      upper = path.join(f.cache, 'work/github.com/acme/sample/3');
      f.s.git(lower, 'config', 'user.name', 'Ada Review');
      f.s.git(lower, 'config', 'user.email', 'ada@example.com');
      f.s.git(lower, 'commit', '--allow-empty', '-m', 'Local b fix');
    });
    it('then refresh reports the unmerged count without needing a push.', async () => {
      const stack = await until(async () => {
        const r = (await f.client.call('refresh')).data as { stack: LiveStack };
        return r.stack.legs[1].notMergedUp === 1 ? r.stack : null;
      }, 'the lower commit was not counted');
      assert.equal(stack.legs[1].local?.unpushed?.length, 1);
    });
    it('then merging the branch upward returns the count to zero.', async () => {
      f.s.git(upper, 'merge', '--no-edit', 'b');
      const count = await until(async () => {
        const r = (await f.client.call('refresh')).data as { stack: LiveStack };
        return r.stack.legs[1].notMergedUp === 0 ? 0 : null;
      }, 'the merged commit is still counted');
      assert.equal(count, 0);
    });
  });
});

describe('Given a stack reviewed from a folder, ', () => {
  const f = served(true);
  describe('when its lower note is delivered, ', () => {
    it('then the watch names the branch and makes no working copy.', async () => {
      await f.client.call('notes', { method: 'POST', body: { action: 'add', path: f.s.file, line: f.s.line('c', "'b'"), body: 'Please change b.' } });
      const r = await f.client.call('notes/watch', { method: 'POST', body: { agent: 'Test', brief: true } });
      assert.ok((r.data as { text: string }).text.includes('#2’s branch is b.'), r.text);
      assert.ok(!fs.existsSync(path.join(f.cache, 'work')));
    });
  });
});

describe('Given a review built on a reviewed leg with marks, ', () => {
  const f = served();
  describe('when it opens with no marks of its own, ', () => {
    it('then it starts from the nearest lower review’s marks.', async () => {
      const model = jsonScript(f.html, 'd-model') as { compares: { base: { edits: Array<{ id: number }> } } };
      await f.client.call('state', { method: 'PUT', body: { rev: { base: model.compares.base.edits.map((e) => e.id) } } });
      const next = await startUntangle(f.s.urls.d, { cacheDir: f.cache, gh: f.s.gh, env: f.s.env, quiet: false });
      try {
        const c = reviewClient(next.url);
        await waitForReview(c);
        const summary = (await c.call('summary')).data as { progress: { done: number; total: number } };
        assert.ok(summary.progress.done > 0, JSON.stringify(summary));
        assert.ok(summary.progress.done < summary.progress.total, JSON.stringify(summary));
        assert.ok(next.output().includes('starting from your review of #3'), next.output());
      } finally { await next.stop(); }
    });
  });
});
