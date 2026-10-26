import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, pendingAnswer, pendingLookup, type ConversationSpec } from '../helpers/conversation.ts';
import { stubGh, type GhReply, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, untangleCommand, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const callLine = 6;
const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');
const draft = 'Greeting ada by name reads well; a test for the greeting would keep it so.';
const rewrite = 'Could we add a test for the greeting? Calling greet with a name and checking what it prints would keep it so.';
const thread = '[data-thread="THREAD_D"]';
// The thread as the page shows it: each run of talk's head (folded or open, and what ends it), and
// each comment's voice, by the edge beside it: the note's orchid, the draft's amber, GitHub's own.
const shown = `[...document.querySelector('${thread}').querySelectorAll(':scope > .cm, :scope > .th-sub > .cm, :scope > .th-sub > .th-sub-h')].map((el) => {
  if (el.matches('.th-sub-h')) return (el.querySelector('.th-talk').getAttribute('aria-expanded') === 'true' ? '⌄ ' : '› ') + el.querySelector('.th-talk').textContent.replace(/\\s+/g, ' ').trim() + (el.querySelector('.th-sub-res') ? ' [' + el.querySelector('.th-sub-res').textContent + ']' : '');
  const edge = getComputedStyle(el.closest('.th-sub') || el).boxShadow;
  const voice = edge.startsWith('rgb(224, 138, 216) 2px') ? 'orchid' : edge.startsWith('rgb(233, 180, 76) 2px') ? 'amber' : 'GitHub';
  return '  ' + voice + ': ' + (el.querySelector('.cm-who')?.textContent ?? '') + ' - ' + el.querySelector('.cm-body').textContent.trim().slice(0, 30);
}).join('\\n')`;

describe('Given a GitHub thread that holds a note’s talk with Claude: its draft, pending, then a rewrite asked for, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  const env = { UNTANGLE_NOTES_QUIET: '100' };
  const agent = (args: string[]) => untangleCommand(args, { cacheDir: cache, gh: gh!, cwd: repo!.dir, env });
  const note = (body: object) => page!.eval(`fetch('api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.status)`);
  const resolvedOnGitHub = () => gh!.calls().some((c) => c.stdin.includes('resolveReviewThread'));
  // The head of the last run of talk, clicked.
  const lastHead = () => page!.eval(`[...document.querySelectorAll('${thread} .th-sub')].pop().querySelector('[data-act="nt-talk"]').click()`);
  const resolved = () => page!.eval(`fetch('api/notes').then((r) => r.json()).then((d) => !!d.notes.find((n) => n.n === 1).resolved)`);

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    const head = repo.commit({ subject: 'Name the greeting', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    const spec: ConversationSpec = { number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7', head, threads: [] };
    gh = stubGh([]);
    const base: GhReply[] = [
      { match: ['pr', 'view'], stdout: { number: 7, title: 'Add a greeting', url: spec.url, state: 'OPEN', baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head } },
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
      { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
    ];
    const github = (now: ConversationSpec, mutations: GhReply[] = []) => gh!.setReplies([...base, ...mutations, { match: ['api', 'graphql'], stdout: conversationOf(now) }]);
    github(spec, [{ match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) }]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, env });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    // N1 on the call's line, Claude's answer, the ask for a draft, and the draft, pending on GitHub.
    assert.equal(await note({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: callLine, body: 'Why greet ada?' }), 200);
    await agent(['reply', '-agent', 'Claude', 'N1', 'Because ada is the first user.']);
    assert.equal(await note({ action: 'reply', n: 1, body: '', draft: true }), 200);
    const now = { ...spec, pending: { id: 'REVIEW_P', comments: 1 }, threads: [{ id: 'THREAD_D', path: 'lib/app.dart', line: callLine, body: draft, pending: true }] };
    github(now, [
      { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer('REVIEW_P') },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThread', stdout: conversationOf(now) },
    ]);
    await agent(['reply', '-agent', 'Claude', 'N1', draft]);
    // Then a rewrite asked for in the thread, and Claude's answer.
    assert.equal(await note({ action: 'reply', n: 1, body: 'Rewrite it, explaining better.' }), 200);
    await agent(['reply', '-agent', 'Claude', 'N1', rewrite]);
    await page.click('[data-tab="files"]');
    await page.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page.click('[data-open="lib/app.dart"]');
    await page.until(`document.querySelectorAll('${thread} .th-sub').length === 2 && document.querySelectorAll('${thread} .th-sub .cm').length === 2`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when the thread is shown, '
    + 'then each run of N1’s talk has a head that names it, orchid on its edge: the one before the draft folded, the last one open, with Resolve N1.',
    async () => {
      assert.equal(await read(page!, shown), [
        '› N1 · 3 notes with Claude · only here',
        '  amber: grace - Greeting ada by name reads wel',
        '⌄ N1 · 2 notes with Claude · only here [Resolve N1]',
        '  orchid: You - Rewrite it, explaining better.',
        '  orchid: Claude - Could we add a test for the gr',
      ].join('\n'));
    },
  );

  describe('when the last run’s head is clicked, ', () => {
    let folded = '';
    let opened = '';

    before(async () => {
      await lastHead();
      await page!.until(`document.querySelectorAll('${thread} .th-sub .cm').length === 0`);
      folded = await read(page!, shown);
      await lastHead();
      await page!.until(`document.querySelectorAll('${thread} .th-sub .cm').length === 2`);
      opened = await read(page!, shown);
    });

    it('then it folds to its head, and opens again.', () => {
      assert.equal(folded, ['› N1 · 3 notes with Claude · only here', '  amber: grace - Greeting ada by name reads wel', '› N1 · 2 notes with Claude · only here [Resolve N1]'].join('\n'));
      assert.match(opened, /^⌄ N1 · 2 notes with Claude · only here \[Resolve N1\]$/m);
    });
  });

  describe('when Resolve N1 is clicked, ', () => {
    let folded = '';

    before(async () => {
      await page!.click(`${thread} .th-sub-res`);
      await page!.until(`document.querySelectorAll('${thread} .th-sub.resolved').length === 2`);
      folded = await read(page!, shown);
    });

    it('then N1 is resolved, and its talk folds, saying so, with Unresolve N1; the thread on GitHub stays open.', async () => {
      assert.equal(folded, [
        '› Resolved · N1 · 3 notes with Claude · only here',
        '  amber: grace - Greeting ada by name reads wel',
        '› Resolved · N1 · 2 notes with Claude · only here [Unresolve N1]',
      ].join('\n'));
      assert.deepEqual([await resolved(), resolvedOnGitHub(), await read(page!, `document.querySelector('${thread} [data-act="gh-resolve"]').textContent`)], [true, false, 'Resolve']);
    });

    describe('and Unresolve N1, ', () => {
      before(async () => {
        await page!.click(`${thread} .th-sub-res`);
        await page!.until(`document.querySelectorAll('${thread} .th-sub.resolved').length === 0 && document.querySelectorAll('${thread} .th-sub .cm').length === 2`);
      });

      it('then its last run opens again, as it was.', async () => {
        assert.equal(await resolved(), false);
        assert.match(await read(page!, shown), /^⌄ N1 · 2 notes with Claude · only here \[Resolve N1\]$/m);
      });
    });
  });
});
