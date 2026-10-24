import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pendingAnswer, pendingLookup } from '../helpers/conversation.ts';
import { startUntangle, stopRuns, type UntangleRun } from '../helpers/run.ts';
import { stackFixture, type StackFixture } from '../helpers/stack.ts';

const skip = e2eSkip();

// A row's text, its spaces folded.
const text = (sel: string) => `[...document.querySelectorAll(${JSON.stringify(sel)})].map((x) => x.textContent.replace(/\\s+/g, ' ').trim())`;

describe('Given a stack of three pull requests (main, then #1, #2 and #3, with a fourth built on #3), the review of #3 open in a browser, ', { skip, timeout: 300_000 }, () => {
  let f: StackFixture;
  let cache = '';
  let run: UntangleRun;
  let page: Browser;
  let client: ReturnType<typeof reviewClient>;

  async function openFile(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.click('[data-tab="files"]');
      try {
        await page.until(`!!document.querySelector('[data-open="${f.file}"]')`, 10_000);
        await page.click(`[data-open="${f.file}"]`);
        await page.until(`!!document.querySelector('.code[data-p="${f.file}"]')`, 10_000);
        return;
      } catch {
        // A click can be lost while the machine is busy.
      }
    }
  }
  // The line of the stack's head that holds some code.
  const headLine = (content: string) => f.line(f.heads.c, content);
  // The + is a pointer target, so a busy machine can drop the first move.
  async function showAdd(line: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.hover(`[data-c="R:${line}"]`);
      try {
        await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`, 5_000);
        return;
      } catch {
        // Try the move again.
      }
    }
    await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`);
  }
  async function fill(selector: string, value: string): Promise<void> {
    await page.click(selector);
    await page.key('a', { ctrl: true });
    await page.type(value);
    await page.until(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
  }
  // What a GraphQL mutation was given, last time it was asked.
  const input = (mutation: string) => {
    const call = [...f.gh.calls()].reverse().find((c) => c.stdin.includes(`${mutation}(input:`));
    if (!call) throw new Error(`no ${mutation} call`);
    return (JSON.parse(call.stdin) as { variables: { input: Record<string, unknown> } }).variables.input;
  };

  before(async () => {
    f = stackFixture();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(f.urls.c, { cacheDir: cache, gh: f.gh, env: f.env });
    client = reviewClient(run.url);
    await client.open();
    await waitForReview(client);
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-stack')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    await stopRuns(cache);
    fs.rmSync(cache, { recursive: true, force: true });
    f?.remove();
  });

  it(
    'when its chip is clicked, '
    + 'then the stack lists #3, #2 and #1, top first, where it starts, and the pull request built on #3.',
    async () => {
      assert.equal(await page.eval(`document.querySelector('.t-stack').textContent`), 'Stack of 3');
      await page.click('.t-stack');
      await page.until(`!!document.querySelector('.stack-pop .sp-leg')`);
      const legs = (await page.eval(`[...document.querySelectorAll('.stack-pop .sp-leg')].map((x) => x.querySelector('.sp-num').textContent + ' ' + x.querySelector('.sp-t').textContent)`)) as string[];
      assert.deepEqual(legs.map((x) => x.replace(/ .*/, '')), ['#3', '#2', '#1', 'main']);
      assert.match(legs[0], /Add c/);
      assert.equal(await page.eval(`document.querySelector('.stack-pop .sp-leg .sp-tag').textContent`), 'This one');
      assert.deepEqual(await page.eval(text('.stack-pop .sp-above a')), ['#4']);
      await page.key('Escape');
    },
  );

  it(
    'when #2 is picked in the stack, '
    + 'then the top bar names its lens, and in the file only the lines #2 wrote stay bright, their run saying #2.',
    async () => {
      await page.click('.t-stack');
      await page.until(`!!document.querySelector('.stack-pop [data-leg="2"]')`);
      await page.click('.stack-pop [data-leg="2"]');
      await page.until(`(document.querySelector('.t-head') || {}).textContent === '#2 · 2 commits'`);
      await openFile();
      const b = headLine("'b'"), a = headLine("'a'");
      await page.until(`!!document.querySelector('[data-c="R:${b}"]')`);
      const bright = (await page.eval(`!document.querySelector('[data-c="R:${b}"]').closest('.lens-out')`)) as boolean;
      const faded = (await page.eval(`!!document.querySelector('[data-c="R:${a}"]').closest('.lens-out')`)) as boolean;
      assert.deepEqual([bright, faded], [true, true]);
      assert.equal(await page.eval(`(document.querySelector('[data-c="R:${b}"]').closest('.ln, .sl').querySelector('.lg-tag') || {}).textContent`), '#2');
      await page.click('.t-head');
      await page.until(`!!document.querySelector('.lens-pop')`);
      await page.click('.lens-pop [data-act="lens-all"]');
      await page.until(`!document.querySelector('.t-head.on')`);
    },
  );

  it(
    'when the Commits tab shows, '
    + 'then the commits read by pull request, top first, and the merge that brought #2 up says so under #3.',
    async () => {
      await page.click('[data-tab="commits"]');
      await page.until(`!!document.querySelector('.cm-leg')`);
      const order = (await page.eval(`[...document.querySelectorAll('.cm-leg, .cm-row')].map((x) => x.classList.contains('cm-leg') ? x.querySelector('.lg-n').textContent : x.dataset.commit.slice(0, 7))`)) as string[];
      const short = (sha: string) => sha.slice(0, 7);
      assert.deepEqual(order, ['#3', short(f.commits.merge), short(f.commits.c), '#2', short(f.commits.fix), short(f.commits.b), '#1', short(f.commits.a)]);
      assert.match((await page.eval(`document.querySelector('.cm-row[data-commit="${f.commits.merge}"] .cm-m').textContent`)) as string, /brings #2 up/);
    },
  );

  it(
    'when #2’s threads load, '
    + 'then the one on a line the stack still has shows under it, saying it’s on #2 at its own line, and the one #3 changed is in the Threads tab only.',
    async () => {
      await openFile();
      await page.until(`!!document.querySelector('[data-thread="B_LINE"]')`, 30_000);
      const said = (await page.eval(`document.querySelector('[data-thread="B_LINE"] .th-leg').textContent`)) as string;
      assert.match(said, new RegExp(`On #2, its line ${f.line(f.heads.b, "'b'")}`));
      assert.equal(await page.eval(`!!document.querySelector('.vw-main [data-thread="B_OLD"]')`), false);
      await page.click('[data-tab="comments"]');
      await page.until(`!!document.querySelector('.sb-row.thr[data-thread="B_OLD"]')`);
      assert.match((await page.eval(`document.querySelector('.sb-row.thr[data-thread="B_OLD"] .lgp').textContent`)) as string, /#2/);
    },
  );

  it(
    'when a comment is written on a line #2 wrote and posted, '
    + 'then its box says it goes to #2 at #2’s own line, and GitHub gets it on #2 there.',
    async () => {
      const b = headLine("'b'"), own = f.line(f.heads.b, "'b'");
      await openFile();
      await showAdd(b);
      await page.click('.cm-add');
      await page.until(`(document.querySelector('.th.new .th-to') || {}).textContent === 'to #2, its line ${own}'`, 15_000);
      f.update(3, [{ match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReview(', stdout: { data: { addPullRequestReview: { pullRequestReview: { pullRequest: f.conversations[1] } } } } }]);
      await fill('.th.new textarea.cmp-ta', 'Keep this print in b.');
      await page.click('.th.new [data-act="gh-thread"][data-mode="single"]');
      await page.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Comment posted on #2, its line ${own}'`);
      const sent = input('addPullRequestReview') as { pullRequestId: string; threads: Array<{ line: number }> };
      assert.deepEqual([sent.pullRequestId, sent.threads[0].line], ['PR_2', own]);
    },
  );

  it(
    'when #2 has a pending review, '
    + 'then the review form picks #2, says one comment waits there, and submits it to #2.',
    async () => {
      f.conversations[1].pendingReviews = { nodes: [{ id: 'PENDING_B', body: '', comments: { totalCount: 1 } }] };
      f.update(3, [
        { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer('PENDING_B') },
        { match: ['api', 'graphql'], stdinIncludes: 'submitPullRequestReview(', stdout: { data: { submitPullRequestReview: { pullRequestReview: { pullRequest: f.conversations[1] } } } } },
      ]);
      await page.click('[data-tab="comments"]');
      await page.click('[data-act="gh-refresh"]');
      await page.until(`(document.querySelector('#vw-review .rv-btn') || {}).textContent === 'Finish review 1'`, 30_000);
      await page.click('#vw-review .rv-btn');
      await page.until(`!!document.querySelector('.rv-legs [aria-checked="true"]')`);
      const form = (await page.eval(`[document.querySelector('.rv-h b').textContent, ...[...document.querySelectorAll('.rv-legs button')].map((b) => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')), document.querySelector('[data-act="gh-submit"]').textContent]`)) as string[];
      assert.deepEqual(form, ['Finish your review of #2', '#3', '#21*', 'Submit to #2']);
      await page.click('[data-act="gh-submit"]');
      await page.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Review submitted'`);
      assert.equal(input('submitPullRequestReview').pullRequestReviewId, 'PENDING_B');
    },
  );

  it(
    'when a note is written on a line #2 wrote, '
    + 'then the note says #2 beside its lines.',
    async () => {
      await client.call('notes', { method: 'POST', body: { action: 'add', path: f.file, line: headLine("'b'"), body: 'Fix this in b.' } });
      await openFile();
      await page.until(`!!document.querySelector('[data-note="1"] .cm-tag.leg')`, 30_000);
      assert.equal(await page.eval(`document.querySelector('[data-note="1"] .cm-tag.leg').textContent`), '#2');
    },
  );
});
