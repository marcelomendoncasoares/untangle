import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, pendingAnswer, pendingLookup, type ConversationSpec, type ThreadSpec } from '../helpers/conversation.ts';
import { stubGh, type GhReply, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, untangleCommand, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const callLine = 6;

const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');

const draft = 'Greeting ada by name reads well; a test for the greeting would keep it so.';
const edited = 'Greeting ada by name reads well. Add a test for the greeting?';
const summary = 'A small, clear change: the greeting takes a name. One ask: a test for it.';
// A bot's comment, as bots write them: a marker for itself, a heading, a link, a name and code.
const bench = '<!-- bench:7 -->\n## Benchmark\nSee [the run](https://example.test/run/7) for `greet_name`: _faster_ now.\n```\n12 ms --> 13 ms\n```';

/** The + is a pointer target, so a busy machine can drop the first move. */
async function showAdd(page: Browser, line: number): Promise<void> {
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

/** Types into a box and waits until it holds the text. */
async function fill(page: Browser, selector: string, text: string): Promise<void> {
  const ready = `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.click(selector);
    await page.key('a', { ctrl: true });
    await page.type(text);
    try {
      await page.until(ready, 5_000);
      return;
    } catch {
      // Type it again.
    }
  }
  await page.until(ready);
}

// A thread or note as the page shows it: each comment's mark (N1, GitHub's), tags and text, and
// the folded talk's line.
const shown = (selector: string) => `(() => { const th = document.querySelector(${JSON.stringify(selector)}); if (!th) return 'none'; return [...th.querySelectorAll(':scope > .cm, :scope > .th-sub > .cm, :scope > .th-sub > .th-sub-h > .th-talk')].map((el) => el.matches('.th-talk') ? 'talk: ' + el.textContent.replace(/\\s+/g, ' ').trim() : [el.querySelector('.nt-n')?.textContent ?? '', el.querySelector('.cm-who')?.textContent ?? '', ...[...el.querySelectorAll('.cm-tag')].map((tag) => '(' + tag.textContent + ')'), getComputedStyle(el).boxShadow.startsWith('rgb(233, 180, 76) 2px') ? '[amber gutter]' : '', '- ' + (el.querySelector('.cm-body')?.textContent ?? '').trim()].filter(Boolean).join(' ')).join(' / '); })()`;

function posted(gh: GhStub, mutation: string): string {
  const call = [...gh.calls()].reverse().find((item) => item.stdin.includes(`${mutation}(input:`));
  if (!call) throw new Error(`no ${mutation} call`);
  return JSON.stringify((JSON.parse(call.stdin) as { variables: { input: unknown } }).variables.input);
}

describe('Given a served review of pull request 7, kept as notes, and Claude’s commands, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let spec: ConversationSpec;
  let base: GhReply[] = [];
  const env = { UNTANGLE_NOTES_QUIET: '100' };
  const agent = (args: string[]) => untangleCommand(args, { cacheDir: cache, gh: gh!, cwd: repo!.dir, env });
  // GitHub, as the steps leave it: the replies for what's asked of it, then the pull request.
  const github = (now: ConversationSpec, mutations: GhReply[] = []) => gh!.setReplies([...base, ...mutations, { match: ['api', 'graphql'], stdout: conversationOf(now) }]);
  const drafted = (body: string): ThreadSpec => ({ id: 'THREAD_D', path: 'lib/app.dart', line: callLine, body, pending: true });

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    const head = repo.commit({ subject: 'Name the greeting', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    spec = { number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7', head, threads: [], comments: [{ id: 'IC_1', body: bench }] };
    gh = stubGh([]);
    base = [
      { match: ['pr', 'view'], stdout: { number: 7, title: 'Add a greeting', url: spec.url, state: 'OPEN', baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head } },
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
      { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
    ];
    github(spec, [{ match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) }]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, env });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head') && !!document.querySelector('.rv-btn')`, 30_000);
    // Comments go to notes, for Claude.
    await page.click('.rv-btn');
    await page.until(`!!document.querySelector('.rv-seg [data-mode="local"]')`);
    await page.click('.rv-seg [data-mode="local"]');
    await page.until(`document.querySelector('.rv-btn').textContent.trim() === 'Notes'`);
    await rest(page);
    await page.click('[data-tab="files"]');
    await page.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page.click('[data-open="lib/app.dart"]');
    await page.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`);
    await showAdd(page, callLine);
    await page.click('.cm-add');
    await page.until(`!!document.querySelector('.th.new.note textarea')`);
    await fill(page, '.th.new.note textarea', 'Why greet ada?');
    await page.click('.th.new.note [data-act="nt-add"]');
    await page.until(`!!document.querySelector('.th.note[data-note="1"]')`);
    await agent(['reply', '-agent', 'Claude', 'N1', 'Because ada is the first user.']);
    await page.until(`document.querySelectorAll('.th.note[data-note="1"] .cm').length === 2`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when Draft comment is pressed in the note’s box, with no words in it, ', () => {
    let buttons: string;
    let note: string;
    let printed: string;

    before(async () => {
      await page!.click('.th.note[data-note="1"] [data-act="nt-reply-open"]');
      await page!.until(`!!document.querySelector('textarea[data-draft="nreply:1"]')`);
      buttons = await read(page!, `[...document.querySelectorAll('.th.note[data-note="1"] .cmp-f button')].map((b) => b.textContent + (b.matches('.primary') ? ' (primary)' : '')).join(' | ')`);
      await page!.click('.th.note[data-note="1"] [data-act="nt-draft"]');
      await page!.until(`!!document.querySelector('.th.note[data-note="1"] .cm-tag.ask')`);
      note = await read(page!, shown('.th.note[data-note="1"]'));
      printed = (await agent(['notes'])).out;
    });

    it('then the box has it between Cancel and Reply, the one that leads.', () => {
      assert.equal(buttons, 'Cancel | Draft comment | Reply (primary)');
    });

    it('then the note says it asked, and Claude reads the ask in your stead.', () => {
      assert.match(note, / \/ You \(Draft comment\) - Asked for a draft comment\.$/);
      assert.match(printed, /\nClaude: Because ada is the first user\.\nYou: Draft a comment for GitHub from this talk, in a natural tone\.\nThis asks for a draft comment for GitHub: answer with the comment alone\.\n/);
    });
  });

  describe('when Claude answers the ask, ', () => {
    let said: string;
    let sent: string;
    let thread: string;

    before(async () => {
      github({ ...spec, pending: { id: 'REVIEW_P', comments: 1 }, threads: [drafted(draft)] }, [
        { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer('REVIEW_P') },
        { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThread', stdout: conversationOf({ ...spec, pending: { id: 'REVIEW_P', comments: 1 }, threads: [drafted(draft)] }) },
      ]);
      said = (await agent(['reply', '-agent', 'Claude', 'N1', draft])).out.trim();
      sent = posted(gh!, 'addPullRequestReviewThread');
      await page!.until(`!!document.querySelector('[data-thread="THREAD_D"] .cm-tag.draft')`);
      thread = await read(page!, shown('[data-thread="THREAD_D"]'));
    });

    it('then untangle posts the answer as it is, pending on the note’s lines, and tells Claude so.', () => {
      assert.deepEqual([sent, said], [
        `{"pullRequestId":"PR_1","path":"lib/app.dart","body":"${draft}","subjectType":"LINE","line":${callLine},"side":"RIGHT"}`,
        'untangle: answered N1 with the draft it asked for: it’s on its lines on GitHub, pending in your user’s review, for them to edit and send.',
      ]);
    });

    it('then the thread holds the talk, folded, and the draft, pending, marked a draft, the gutter amber beside it.', () => {
      assert.equal(thread, `talk: N1 · 3 notes with Claude · only here / grace (Author) (Pending) (Draft) [amber gutter] - ${draft}`);
    });
  });

  describe('when the draft is edited on the page, ', () => {
    let thread: string;

    before(async () => {
      github({ ...spec, pending: { id: 'REVIEW_P', comments: 1 }, threads: [drafted(edited)] }, [
        { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer('REVIEW_P') },
        { match: ['api', 'graphql'], stdinIncludes: 'updatePullRequestReviewComment', stdout: conversationOf({ ...spec, pending: { id: 'REVIEW_P', comments: 1 }, threads: [drafted(edited)] }) },
      ]);
      await page!.click('[data-thread="THREAD_D"] [data-act="edit-open"]');
      await page!.until(`!!document.querySelector('textarea[data-draft="edit:THREAD_D_C"]')`);
      await fill(page!, 'textarea[data-draft="edit:THREAD_D_C"]', edited);
      await page!.click('[data-thread="THREAD_D"] [data-act="gh-edit"]');
      await page!.until(`!document.querySelector('[data-thread="THREAD_D"] .cm-tag.draft') && !document.querySelector('textarea[data-draft="edit:THREAD_D_C"]')`);
      thread = await read(page!, shown('[data-thread="THREAD_D"]'));
    });

    it('then it’s yours: pending, and no longer marked a draft.', () => {
      assert.equal(thread, `talk: N1 · 3 notes with Claude · only here / grace (Author) (Pending) - ${edited}`);
    });
  });

  describe('when the Threads tab is opened, ', () => {
    let rows: string;

    before(async () => {
      await page!.click('[data-tab="comments"]');
      await page!.until(`!!document.querySelector('#vw-side .sb-rv') && !!document.querySelector('#vw-side [data-thread="THREAD_D"]')`);
      rows = await read(page!, `[...document.querySelectorAll('#vw-side .sb-rv, #vw-side .sb-sec, #vw-side .sb-row.thr, #vw-side .sb-gh')].map((el) => el.matches('.sb-sec') ? '# ' + el.querySelector('.nm').textContent : el.matches('.sb-gh') ? '  ' + el.textContent.trim() : '  ' + el.querySelector('.nm').firstChild.textContent.trim() + ' ' + [...el.querySelectorAll('.cnt .n')].map((n) => (n.matches('.nt') ? 'notes ' : '') + n.textContent).join(' ')).join('\\n')`);
    });

    it('then the review’s own row leads, the note is counted in its GitHub thread, and nothing is grouped under the sections.', () => {
      assert.equal(rows, ['  The review 1', '# Notes', '  None open: the + on a line writes one.', '# GitHub', '  From GitHub, just now', '  app.dart:6 1 notes 3'].join('\n'));
    });
  });

  describe('when the review’s own row is opened, ', () => {
    let view: string;
    let folded: string;
    let open: string;

    before(async () => {
      await page!.click('#vw-side .sb-rv');
      await page!.until(`!!document.querySelector('.conv [data-comment="PR_1"]')`);
      view = await read(page!, `[[...document.querySelectorAll('.fv-head .crumbs [data-tab], .fv-head .crumbs b')].map((el) => el.textContent).join(' / '), document.querySelector('[data-comment="PR_1"] .cm-tag').textContent, [...document.querySelectorAll('.fv-head .btn')].map((b) => b.textContent).join(', '), [...document.querySelectorAll('.conv-new .cmp-f button')].map((b) => b.textContent).join(', ')].join(' | ')`);
      await page!.click('[data-act="cards-fold"]');
      await page!.until(`!!document.querySelector('[data-comment="PR_1"].folded')`);
      folded = await read(page!, `[document.querySelector('[data-act="cards-fold"]').textContent, ...['PR_1', 'IC_1'].map((id) => document.querySelector(\`[data-comment="\${id}"] .cm-body\`).textContent.trim())].join(' | ')`);
      await page!.click('[data-act="cards-fold"]');
      await page!.until(`!document.querySelector('[data-comment="PR_1"].folded')`);
      open = await read(page!, `document.querySelector('[data-act="cards-fold"]').textContent`);
    });

    it('then it shows the description first, the folds, and a box that writes to Claude or asks it for a draft.', () => {
      assert.equal(view, 'The review / Add a greeting | Description | Fold all, Open on GitHub | Draft comment, Add note');
    });

    it('then Fold all folds each card to a line of its text, and Open all opens them again.', () => {
      assert.deepEqual([folded, open], ['Open all | Please look. | Benchmark See the run for greet_name: faster now. [code]', 'Fold all']);
    });
  });

  describe('when Ask is pressed on the description, and a note added, ', () => {
    let printed: string;

    before(async () => {
      await page!.click('[data-comment="PR_1"] [data-act="nt-ask"]');
      await page!.until(`!!document.querySelector('textarea[data-draft="ask:pr:PR_1"]')`);
      await fill(page!, 'textarea[data-draft="ask:pr:PR_1"]', 'Does this say what changed?');
      await page!.click('[data-ask="ask:pr:PR_1"] [data-act="nt-about-add"]');
      await page!.until(`!!document.querySelector('.cv-under .th.note[data-note="2"]')`);
      printed = (await agent(['notes'])).out;
    });

    it('then the note sits under the description, and Claude reads it with the description quoted.', () => {
      assert.match(printed, /\nN2 · on the review\nAbout the pull request’s description, by grace \(https:\/\/github\.com\/acme\/sample\/pull\/7\):\n> Please look\.\nDoes this say what changed\?\n/);
    });
  });

  describe('when a draft is asked for from the review’s box, and Claude answers, ', () => {
    let said: string;
    let card: string;

    before(async () => {
      await fill(page!, 'textarea[data-draft="issue"]', 'Sum the review up for the author.');
      await page!.click('.conv-new [data-act="nt-draft"]');
      await page!.until(`!!document.querySelector('.th.note[data-note="3"] .cm-tag.ask')`);
      const now = { ...spec, pending: { id: 'REVIEW_P', comments: 1, body: summary }, threads: [drafted(edited)] };
      github(now, [
        { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer('REVIEW_P') },
        { match: ['api', 'graphql'], stdinIncludes: 'updatePullRequestReview(', stdout: conversationOf(now) },
      ]);
      said = (await agent(['reply', '-agent', 'Claude', 'N3', summary])).out.trim();
      await page!.until(`!!document.querySelector('.cv-sum .cm-tag.draft')`);
      card = await read(page!, `[...document.querySelectorAll('.cv-sum .cm-who, .cv-sum .cm-tag, .cv-sum .cm-body, .cv-sum .cv-sum-f button')].map((el) => el.textContent.trim()).join(' | ')`);
    });

    it('then untangle makes the answer your pending review’s summary, marked a draft, with Edit and Finish review.', () => {
      assert.deepEqual([said, posted(gh!, 'updatePullRequestReview'), card], [
        'untangle: answered N3 with the draft it asked for: it’s as the summary of your user’s pending review, for them to edit and send.',
        `{"pullRequestReviewId":"REVIEW_P","body":"${summary}"}`,
        `Your review | Pending | Draft | ${summary} | Edit | Finish review`,
      ]);
    });
  });
});
