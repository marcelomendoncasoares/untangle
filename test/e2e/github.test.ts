import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, issueAnswer, mentionAnswer, pendingAnswer, pendingLookup, type ConversationSpec } from '../helpers/conversation.ts';
import type { GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { stubGh } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { motionOf, read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const callLine = 6;
const printLine = 2;

const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');

/** The + is a pointer target, so a busy machine can drop the first move. */
async function showAdd(page: Browser, line: number): Promise<void> {
  const cell = `[data-c="R:${line}"]`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.hover(cell);
    try {
      await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`, 5_000);
      return;
    } catch {
      // Try the move again.
    }
  }
  await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`);
}

/** Types into a composer and waits until the box holds the text. */
async function fill(page: Browser, selector: string, text: string): Promise<void> {
  const want = JSON.stringify(text);
  const ready = `document.querySelector(${JSON.stringify(selector)})?.value === ${want}`;
  await page.click(selector);
  await page.key('a', { ctrl: true });
  await page.type(text);
  try {
    await page.until(ready, 5_000);
  } catch {
    await page.click(selector);
    await page.key('a', { ctrl: true });
    await page.type(text);
    await page.until(ready);
  }
}

function posted(gh: GhStub, mutation: string): string {
  const call = [...gh.calls()].reverse().find((item) => item.stdin.includes(`${mutation}(input:`));
  if (!call) throw new Error(`no ${mutation} call`);
  const body = JSON.parse(call.stdin) as { variables: { input: unknown } };
  return JSON.stringify(body.variables.input);
}

// A thread as the page shows it: open or folded, and its header.
const threadShown = (id: string) => `(() => { const th = document.querySelector('.th[data-thread="${id}"]'); if (!th) return 'none'; const head = th.querySelector(':scope > .th-fold')?.textContent.replace(/\\s+/g, ' ').trim(); return (th.querySelector(':scope > .cm') ? 'open' : 'folded') + (head ? ': ' + head : ''); })()`;

describe('Given a served review of pull request 7, with an open thread on the call and a resolved thread on the print, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let url = '';
  let head = '';
  let baseSpec: ConversationSpec;

  before(async () => {
    const author = ada('2020-06-01T15:00:00Z');
    const later = ada('2020-06-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    head = repo.commit({ subject: 'Name the greeting', author: later, committer: later });
    baseSpec = {
      number: 7,
      title: 'Add a greeting',
      url: 'https://github.com/acme/sample/pull/7',
      head,
      threads: [
        { id: 'THREAD_1', path: 'lib/app.dart', line: callLine, body: 'Why this name?' },
        { id: 'THREAD_2', path: 'lib/app.dart', line: printLine, body: 'Ship the name.', resolved: true },
      ],
    };
    gh = stubGh([
      {
        match: ['pr', 'view'],
        stdout: {
          number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7', state: 'OPEN',
          baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head,
        },
      },
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
      { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) },
      { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
      { match: ['api', 'graphql'], stdinIncludes: 'mentionableUsers', stdout: mentionAnswer() },
      { match: ['api', 'graphql'], stdinIncludes: 'issueOrPullRequest', stdout: issueAnswer() },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThreadReply', stdout: conversationOf({ ...baseSpec, threads: [{ id: 'THREAD_1', path: 'lib/app.dart', line: callLine, body: 'Why this name?', reply: 'Because it reads clearly.' }, { id: 'THREAD_2', path: 'lib/app.dart', line: printLine, body: 'Ship the name.', resolved: true }] }) },
      { match: ['api', 'graphql'], stdinIncludes: 'unresolveReviewThread', stdout: conversationOf(baseSpec) },
      { match: ['api', 'graphql'], stdinIncludes: 'resolveReviewThread', stdout: conversationOf({ ...baseSpec, threads: [{ id: 'THREAD_1', path: 'lib/app.dart', line: callLine, body: 'Why this name?', resolved: true }, { id: 'THREAD_2', path: 'lib/app.dart', line: printLine, body: 'Ship the name.', resolved: true }] }) },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThread', stdout: conversationOf({ ...baseSpec, pending: { id: 'REVIEW_PENDING', comments: 1 }, threads: [...baseSpec.threads!, { id: 'THREAD_3', path: 'lib/app.dart', line: callLine, body: 'Please rename it.', pending: true }] }) },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReview', stdout: conversationOf({ ...baseSpec, reviews: [{ id: 'REVIEW_1', state: 'COMMENTED', body: 'Looks good.' }], threads: [...baseSpec.threads!, { id: 'THREAD_3', path: 'lib/app.dart', line: callLine, body: 'Looks good.' }] }) },
      { match: ['api', 'markdown'], stdout: '<p><strong>hello</strong></p>' },
      { match: ['api', 'graphql'], stdinIncludes: 'updatePullRequestReviewComment', stdout: conversationOf(baseSpec) },
      { match: ['api', 'graphql'], stdinIncludes: 'deletePullRequestReviewComment', stdout: conversationOf(baseSpec) },
      { match: ['api', 'graphql'], stdinIncludes: 'addReaction', stdout: conversationOf(baseSpec) },
      { match: ['api', 'graphql'], stdout: conversationOf(baseSpec) },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    url = run.url;
    await waitForReview(reviewClient(url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openApp(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page!.click('[data-tab="files"]');
      try {
        await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`, 10_000);
        await page!.click('[data-open="lib/app.dart"]');
        await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`, 10_000);
        return;
      } catch {
        // A click can be lost while the machine is busy.
      }
    }
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page!.click('[data-open="lib/app.dart"]');
    await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`);
  }

  async function fresh(): Promise<void> {
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await openApp();
    await page!.until(`(document.body.textContent || '').includes('Why this name?')`);
  }

  describe('when the file is opened, ', () => {
    let under: string;

    before(async () => {
      await rest(page!);
      await openApp();
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"]')?.textContent || '').includes('Why this name?')`);
      under = await read(page!, `[...document.querySelectorAll('.th')].map((th) => th.matches('.resolved') ? 'resolved: ' + (th.querySelector('.th-fold')?.textContent ?? '').replace(/\\s+/g, ' ').trim() : 'open: ' + [...th.querySelectorAll('.cm')].map((cm) => [cm.querySelector('.cm-who')?.textContent ?? '', ...[...cm.querySelectorAll('.cm-tag')].map((tag) => '(' + tag.textContent + ')'), '- ' + (cm.querySelector('.cm-body')?.textContent ?? '').trim()].join(' ')).join(' / ')).join('\\n')`);
    });

    it('then the open thread sits under the call and the resolved one is folded.', () => {
      assert.equal(under, 'resolved: Resolved by ada· line 2 · 1 comment\nopen: grace (Author) - Why this name?');
    });
  });

  describe('when the Threads tab is opened, ', () => {
    let listed: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="comments"]');
      await page!.until(`!!document.querySelector('#vw-side .sb-rv') && (document.querySelector('#vw-side')?.textContent || '').includes('Why this name?')`);
      const text = await read(page!, `document.querySelector('#vw-side')?.textContent ?? ''`);
      const first = await read(page!, `document.querySelector('#vw-side .sb-row .nm').firstChild.textContent`);
      listed = `${first} first\n${text.includes('Why this name?') ? 'open' : 'missing'}\n${text.includes('Ship the name.') ? 'shown' : 'hidden'}`;
    });

    it('then the review’s own row comes first, the open thread is listed and the resolved one is hidden.', () => {
      assert.equal(listed, 'The review first\nopen\nhidden');
    });
  });

  describe('when the resolved group is opened, ', () => {
    let listed: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="comments"]');
      await page!.until(`(document.querySelector('#vw-side')?.textContent || '').includes('Why this name?')`);
      await page!.click('[data-act="resolved-toggle"]');
      await page!.until(`(document.querySelector('#vw-side')?.textContent || '').includes('Ship the name.')`);
      const text = await read(page!, `document.querySelector('#vw-side')?.textContent ?? ''`);
      listed = text.includes('Ship the name.') ? 'shown' : 'hidden';
    });

    it('then the resolved thread is listed.', () => {
      assert.equal(listed, 'shown');
    });
  });

  describe('when a reply is sent on the open thread, ', () => {
    let thread: string;
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('[data-thread="THREAD_1"] [data-act="reply-open"]');
      await page!.until(`!!document.querySelector('[data-thread="THREAD_1"] textarea[data-draft="reply:THREAD_1"]')`);
      await fill(page!, '[data-thread="THREAD_1"] textarea[data-draft="reply:THREAD_1"]', 'Because it reads clearly.');
      await page!.click('[data-thread="THREAD_1"] [data-act="gh-reply"][data-mode="single"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Reply posted'`);
      thread = await read(page!, `(() => { const th = document.querySelector('[data-thread="THREAD_1"]'); return [...th.querySelectorAll('.cm')].map((cm) => [cm.querySelector('.cm-who')?.textContent ?? '', ...[...cm.querySelectorAll('.cm-tag')].map((tag) => '(' + tag.textContent + ')'), '- ' + (cm.querySelector('.cm-body')?.textContent ?? '').trim()].join(' ')).join('\\n'); })()`);
      sent = posted(gh!, 'addPullRequestReviewThreadReply');
    });

    it('then the reply is under the thread.', () => {
      assert.equal(thread, 'grace (Author) - Why this name?\nada - Because it reads clearly.');
    });

    it('then GitHub is asked to reply on that thread.', () => {
      assert.equal(sent, '{"pullRequestReviewThreadId":"THREAD_1","body":"Because it reads clearly."}');
    });
  });

  describe('when the reply box opens on a thread, with motion on, ', () => {
    let heights: string;
    let eased: string;

    before(async () => {
      await page!.reducedMotion(false);
      await fresh();
      await page!.until(`document.getAnimations().length === 0`);
      const from = await read(page!, `String(document.querySelector('[data-thread="THREAD_1"]')?.getBoundingClientRect().height ?? 0)`);
      await page!.click('[data-thread="THREAD_1"] [data-act="reply-open"]');
      eased = await read(page!, `(() => { const th = document.querySelector('[data-thread="THREAD_1"]'); const a = document.getAnimations().find((x) => x.effect?.target === th); if (!a) return 'no animation'; const k = a.effect.getKeyframes(); return 'from ' + parseFloat(k[0].height).toFixed(1) + 'px to ' + parseFloat(k[k.length - 1].height).toFixed(1) + 'px'; })()`);
      await page!.until(`document.getAnimations().length === 0`);
      const to = await read(page!, `String(document.querySelector('[data-thread="THREAD_1"]')?.getBoundingClientRect().height ?? 0)`);
      heights = `from ${Number(from).toFixed(1)}px to ${Number(to).toFixed(1)}px`;
    });

    after(async () => {
      await page!.reducedMotion(true);
    });

    it('then the thread eases from its old height to its new one.', () => {
      assert.equal(eased, heights);
    });
  });

  describe('when the open thread is resolved, ', () => {
    let resolved: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="gh-resolve"][data-thread="THREAD_1"]');
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved')`);
      resolved = await read(page!, `(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved') ? 'resolved' : (document.querySelector('[data-thread="THREAD_1"]')?.textContent ?? '')`);
    });

    it('then the thread folds as resolved.', () => {
      assert.equal(resolved, 'resolved');
    });
  });

  describe('when the resolved thread is unresolved, ', () => {
    let opened: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="gh-resolve"][data-thread="THREAD_1"]');
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved')`);
      await page!.click('[data-act="thread-toggle"][data-thread="THREAD_1"]');
      await page!.until(`!!document.querySelector('[data-act="gh-resolve"][data-thread="THREAD_1"]')`);
      await page!.click('[data-act="gh-resolve"][data-thread="THREAD_1"]');
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"]')?.textContent || '').includes('Why this name?') && !(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved')`);
      opened = await read(page!, `(document.querySelector('[data-thread="THREAD_1"]')?.textContent || '').includes('Why this name?') && !(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved') ? 'open' : (document.querySelector('[data-thread="THREAD_1"]')?.textContent ?? '')`);
    });

    it('then the thread opens again.', () => {
      assert.equal(opened, 'open');
    });
  });

  describe('when the thread is resolved again, ', () => {
    let shown: string;

    before(async () => {
      await page!.click('[data-act="gh-resolve"][data-thread="THREAD_1"]');
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved')`);
      shown = await read(page!, threadShown('THREAD_1'));
    });

    it('then it folds, though it was unfolded before.', () => {
      assert.equal(shown, `folded: Resolved by ada· line ${callLine} · 1 comment`);
    });
  });

  describe('when the open thread is opened from the Threads tab and resolved, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await page!.click('[data-tab="comments"]');
      await page!.until(`!!document.querySelector('[data-act="thread-open"][data-thread="THREAD_1"]')`);
      await page!.click('[data-act="thread-open"][data-thread="THREAD_1"]');
      await page!.until(`!!document.querySelector('[data-act="gh-resolve"][data-thread="THREAD_1"]')`);
      await page!.click('[data-act="gh-resolve"][data-thread="THREAD_1"]');
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved')`);
      shown = await read(page!, threadShown('THREAD_1'));
    });

    it('then it folds.', () => {
      assert.equal(shown, `folded: Resolved by ada· line ${callLine} · 1 comment`);
    });
  });

  describe('when the resolved thread on the print is unfolded, then folded, with motion on, ', () => {
    const two = '.th[data-thread="THREAD_2"]';
    const toggle = '[data-act="thread-toggle"][data-thread="THREAD_2"]';
    const heightOf = `(document.querySelector('${two}')?.getBoundingClientRect().height ?? 0).toFixed(1)`;
    let opening: string;
    let closing: string;
    let shut = '';
    let open = '';

    /** Clicks the toggle, and reads how the thread changed as the page drew it anew. */
    async function motion(): Promise<string> {
      await page!.eval(motionOf(two));
      await page!.click(toggle);
      await page!.until('window.__motion != null');
      const seen = await read(page!, 'window.__motion');
      await page!.until(`document.getAnimations().length === 0`);
      return seen;
    }

    before(async () => {
      await page!.reducedMotion(false);
      await fresh();
      await page!.until(`document.getAnimations().length === 0`);
      shut = await read(page!, heightOf);
      opening = await motion();
      open = await read(page!, heightOf);
      closing = await motion();
    });

    after(async () => {
      await page!.reducedMotion(true);
    });

    it('then it opens downward from its header, what it holds fading in.', () => {
      assert.equal(opening, `it eases from ${shut}px to ${open}px; cm, th-f fade in`);
    });

    it('then what it holds closes up under its header, fading.', () => {
      assert.equal(closing, `a stand-in after th-fold, holding cm, th-f, closes from ${(Number(open) - Number(shut)).toFixed(1)}px, fading`);
    });
  });

  describe('when the + on the call is clicked, ', () => {
    let buttons: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new [data-act="gh-thread"]')`);
      buttons = await read(page!, `[...document.querySelectorAll('.th.new [data-act="gh-thread"]')].map((el) => el.textContent).join('\\n')`);
    });

    it('then the comment can be sent on its own or can start a review.', () => {
      assert.equal(buttons, 'Add single comment\nStart a review');
    });
  });

  describe('when the + is dragged onto the print line, ', () => {
    let heading: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.dragOnto('.cm-add', `[data-c="R:${printLine}"]`);
      await page!.until(`(document.querySelector('.th-new-h b')?.textContent || '').includes('lines')`);
      heading = await read(page!, `document.querySelector('.th-new-h b')?.textContent ?? ''`);
    });

    it('then the comment covers the dragged lines.', () => {
      assert.equal(heading, `Comment on lines +${printLine} to +${callLine}`);
    });
  });

  describe('when the + on another line is shift-clicked, ', () => {
    let heading: string;

    before(async () => {
      await fresh();
      await showAdd(page!, printLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th-new-h')`);
      await showAdd(page!, callLine);
      await page!.shiftClick('.cm-add');
      await page!.until(`(document.querySelector('.th-new-h')?.textContent || '').includes('to +${callLine}')`);
      heading = await read(page!, `document.querySelector('.th-new-h')?.textContent ?? ''`);
    });

    it('then the comment covers the lines from the first to that one.', () => {
      assert.equal(heading, `Comment on lines +${printLine} to +${callLine}Drag the + over more lines, or shift-click it on another line of this hunk, for a range.`);
    });
  });

  describe('when Add single comment is clicked, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      await fill(page!, '.th.new textarea.cmp-ta', 'Looks good.');
      await page!.click('.th.new [data-act="gh-thread"][data-mode="single"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Comment posted'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked for one comment on that line.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"COMMENT","threads":[{"path":"lib/app.dart","body":"Looks good.","line":${callLine},"side":"RIGHT"}]}`);
    });
  });

  describe('when Start a review is clicked, ', () => {
    let sent: string;
    let pending: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      await fill(page!, '.th.new textarea.cmp-ta', 'Please rename it.');
      await page!.click('.th.new [data-act="gh-thread"][data-mode="review"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Added to your pending review'`);
      sent = posted(gh!, 'addPullRequestReviewThread');
      pending = await read(page!, `document.querySelector('.cm.pending') ? 'pending' : 'posted'`);
    });

    it('then the comment joins a review instead of posting on its own.', () => {
      assert.equal(`${pending}\n${sent}`, `pending\n{"pullRequestId":"PR_1","path":"lib/app.dart","body":"Please rename it.","subjectType":"LINE","line":${callLine},"side":"RIGHT"}`);
    });
  });

  describe('when @ is typed in a comment, ', () => {
    let suggestions: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      await fill(page!, '.th.new textarea.cmp-ta', '@');
      await page!.until(`document.querySelector('.mn-pop') && !document.querySelector('.mn-pop').hidden && (document.querySelector('.mn-pop')?.textContent || '').includes('grace')`);
      suggestions = await read(page!, `[...document.querySelectorAll('.mn-pop [data-mn]')].map((item) => [...item.children].map((part) => part.textContent).filter(Boolean).join(' | ') || item.textContent).join('\\n')`);
    });

    it('then the people on the pull request are suggested.', () => {
      assert.equal(suggestions, 'grace');
    });
  });

  describe('when #12 is typed in a comment, ', () => {
    let suggestions: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      await fill(page!, '.th.new textarea.cmp-ta', '#12');
      await page!.until(`(document.querySelector('.mn-pop')?.textContent || '').includes('The name')`);
      suggestions = await read(page!, `[...document.querySelectorAll('.mn-pop [data-mn]')].map((item) => [...item.children].map((part) => part.textContent).filter(Boolean).join(' | ') || item.textContent).join('\\n')`);
    });

    it('then issue 12 is suggested.', () => {
      assert.equal(suggestions, '#12 | The name');
    });
  });

  describe('when the review is approved, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-pop')`);
      await page!.click('input[value="APPROVE"]');
      await fill(page!, 'textarea[data-draft="review"]', 'Ship it.');
      await page!.click('[data-act="gh-submit"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Approved'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked to approve, with that comment.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"APPROVE","body":"Ship it."}`);
    });
  });

  describe('when the review requests changes, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-pop')`);
      await page!.click('input[value="REQUEST_CHANGES"]');
      await fill(page!, 'textarea[data-draft="review"]', 'Please rename it.');
      await page!.click('[data-act="gh-submit"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Changes requested'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked to request changes.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"REQUEST_CHANGES","body":"Please rename it."}`);
    });
  });

  describe('when the review is submitted as a comment, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-pop')`);
      await fill(page!, 'textarea[data-draft="review"]', 'A note.');
      await page!.click('[data-act="gh-submit"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Review submitted'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked to comment.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"COMMENT","body":"A note."}`);
    });
  });

  describe('when c is pressed, ', () => {
    let where: string;

    before(async () => {
      await fresh();
      await page!.key('j');
      await page!.key('c');
      await page!.until(`(document.querySelector('.th.new b')?.textContent || '').startsWith('Comment on line ')`);
      where = await read(page!, `(() => {
        const heading = document.querySelector('.th.new b')?.textContent || '';
        const match = heading.match(/([+−-])(\\d+)$/);
        const side = match && match[1] === '+' ? 'R' : 'L';
        const row = match ? document.querySelector('[data-c="' + side + ':' + match[2] + '"]') : null;
        return row ? heading : heading + ' missing';
      })()`);
    });

    it('then a comment opens on the line you are on.', () => {
      assert.equal(where, 'Comment on line −6');
    });
  });

  describe('when Preview is chosen, ', () => {
    let preview: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      await fill(page!, '.th.new textarea.cmp-ta', '**hello**');
      await page!.click('.th.new [data-act="cmp-pane"][data-pane="preview"]');
      await page!.until(`document.querySelector('.th.new .cmp-pre strong')?.textContent === 'hello'`);
      preview = await read(page!, `document.querySelector('.th.new .cmp-pre strong')?.textContent ?? ''`);
    });

    it('then the comment is shown rendered.', () => {
      assert.equal(preview, 'hello');
    });
  });

  describe('when Ctrl Enter is pressed in a comment, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      await fill(page!, '.th.new textarea.cmp-ta', 'Ship it.');
      await page!.click('.th.new textarea.cmp-ta');
      await page!.key('Enter', { ctrl: true });
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Added to your pending review'`);
      sent = posted(gh!, 'addPullRequestReviewThread');
    });

    it('then the comment is posted into a review.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","path":"lib/app.dart","body":"Ship it.","subjectType":"LINE","line":${callLine},"side":"RIGHT"}`);
    });
  });

  describe('when a change is suggested on a new line, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new [data-act="cmp-suggest"]')`);
      await page!.click('.th.new [data-act="cmp-suggest"]');
      await page!.until(`(document.querySelector('.th.new textarea.cmp-ta')?.value || '').includes('\`\`\`suggestion')`);
      await page!.click('.th.new [data-act="gh-thread"][data-mode="single"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Comment posted'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then the posted comment contains a suggestion block.', () => {
      const body = sent.includes('```suggestion') && sent.includes("greet('ada')") ? 'suggestion greet(\'ada\')' : sent;
      assert.equal(body, 'suggestion greet(\'ada\')');
    });
  });

  describe('when your own comment is edited, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="edit-open"][data-id="THREAD_1_C"]');
      await page!.until(`!!document.querySelector('[data-draft="edit:THREAD_1_C"]')`);
      await page!.click('[data-draft="edit:THREAD_1_C"]');
      await page!.key('a', { ctrl: true });
      await page!.type('A better question.');
      await page!.until(`document.querySelector('[data-draft="edit:THREAD_1_C"]')?.value === 'A better question.'`);
      await page!.click('[data-act="gh-edit"]');
      await page!.until(`!document.querySelector('[data-draft="edit:THREAD_1_C"]')`);
      sent = posted(gh!, 'updatePullRequestReviewComment');
    });

    it('then GitHub is asked to update it.', () => {
      assert.equal(sent, '{"pullRequestReviewCommentId":"THREAD_1_C","body":"A better question."}');
    });
  });

  describe('when your own comment is deleted, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="gh-delete"][data-id="THREAD_1_C"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Comment deleted'`);
      sent = posted(gh!, 'deletePullRequestReviewComment');
    });

    it('then GitHub is asked to delete it.', () => {
      assert.equal(sent, '{"id":"THREAD_1_C"}');
    });
  });

  describe('when a reaction is added, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="react-open"][data-subject="THREAD_1_C"]');
      await page!.until(`!!document.querySelector('[data-act="gh-react"][data-content="THUMBS_UP"]')`);
      await page!.click('[data-act="gh-react"][data-content="THUMBS_UP"]');
      await page!.until(`!!document.querySelector('.cm-rx')`);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && ![...gh!.calls()].some((call) => call.stdin.includes('addReaction(input:'))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      sent = posted(gh!, 'addReaction');
    });

    it('then GitHub is asked for that reaction.', () => {
      assert.equal(sent, '{"subjectId":"THREAD_1_C","content":"THUMBS_UP"}');
    });
  });

  describe('when a comment is written on the file, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="file-comment"]')`);
      await page!.click('[data-act="file-comment"]');
      await page!.until(`!!document.querySelector('[data-draft="file:lib/app.dart"]')`);
      await fill(page!, '[data-draft="file:lib/app.dart"]', 'On the whole file.');
      await page!.click('.th.new [data-act="gh-thread"][data-mode="single"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Comment posted'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked to comment on the file.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"COMMENT","threads":[{"path":"lib/app.dart","body":"On the whole file."}]}`);
    });
  });

  describe('when Down and Enter choose a mention, ', () => {
    let value: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await fill(page!, '.th.new textarea.cmp-ta', '@g');
      await page!.until(`(document.querySelector('.mn-pop')?.textContent || '').includes('grace')`);
      await page!.key('ArrowDown');
      await page!.key('Enter');
      await page!.until(`(document.querySelector('.th.new textarea.cmp-ta')?.value || '').includes('@grace')`);
      value = await read(page!, `document.querySelector('.th.new textarea.cmp-ta')?.value ?? ''`);
    });

    it('then @grace is inserted.', () => {
      assert.equal(value, '@grace ');
    });
  });

  describe('when Down and Tab choose an issue, ', () => {
    let value: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await fill(page!, '.th.new textarea.cmp-ta', '#12');
      await page!.until(`(document.querySelector('.mn-pop')?.textContent || '').includes('The name')`);
      await page!.key('ArrowDown');
      await page!.key('Tab');
      await page!.until(`(document.querySelector('.th.new textarea.cmp-ta')?.value || '').includes('#12')`);
      value = await read(page!, `document.querySelector('.th.new textarea.cmp-ta')?.value ?? ''`);
    });

    it('then #12 is inserted.', () => {
      assert.equal(value, '#12 ');
    });
  });

  describe('when a mention is picked with the mouse, ', () => {
    let value: string;
    let focused: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await fill(page!, '.th.new textarea.cmp-ta', '@g');
      await page!.until(`(document.querySelector('.mn-pop')?.textContent || '').includes('grace')`);
      const item = await read(page!, `[...document.querySelectorAll('.mn-pop [data-mn]')].find((el) => (el.textContent || '').includes('grace'))?.dataset.mn ?? ''`);
      await page!.click(`.mn-pop [data-mn="${item}"]`);
      await page!.until(`(document.querySelector('.th.new textarea.cmp-ta')?.value || '').includes('@grace')`);
      value = await read(page!, `document.querySelector('.th.new textarea.cmp-ta')?.value ?? ''`);
      focused = await read(page!, `document.activeElement === document.querySelector('.th.new textarea.cmp-ta') ? 'the comment box' : document.activeElement?.className ?? 'nothing'`);
    });

    it('then @grace is inserted.', () => {
      assert.equal(value, '@grace ');
    });

    it('then the comment box keeps the focus.', () => {
      assert.equal(focused, 'the comment box');
    });
  });

  describe('when Escape is pressed on the mention list, ', () => {
    let list: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await fill(page!, '.th.new textarea.cmp-ta', '@');
      await page!.until(`document.querySelector('.mn-pop') && !document.querySelector('.mn-pop').hidden`);
      await page!.key('Escape');
      await page!.until(`document.querySelector('.mn-pop').hidden`);
      list = await read(page!, `document.querySelector('.mn-pop').hidden ? 'closed' : 'open'`);
    });

    it('then the list closes.', () => {
      assert.equal(list, 'closed');
    });
  });

  describe('when a thread is chosen in Jump to, ', () => {
    let opened: string;

    before(async () => {
      await fresh();
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      for (let i = 0; i < 6; i += 1) {
        if (await read(page!, `document.querySelector('.pal-scope')?.textContent ?? ''`) === 'Threads') break;
        await page!.key('Tab');
      }
      await page!.until(`document.querySelector('.pal-scope')?.textContent === 'Threads'`);
      await page!.type('Why this name');
      await page!.until(`(document.querySelector('.pal')?.textContent || '').includes('Why this name')`);
      await page!.key('Enter');
      await page!.until(`!!document.querySelector('[data-thread="THREAD_1"]')`);
      opened = await read(page!, `document.querySelector('[data-thread="THREAD_1"]') ? 'open' : 'closed'`);
    });

    it('then the thread opens on its file.', () => {
      assert.equal(opened, 'open');
    });
  });

  describe('when the page reloads right after a reply is sent, ', () => {
    let box: string;

    before(async () => {
      await page!.installClock();
      await fresh();
      await page!.click('[data-thread="THREAD_1"] [data-act="reply-open"]');
      await fill(page!, '[data-thread="THREAD_1"] textarea[data-draft="reply:THREAD_1"]', 'Sent just now.');
      // The typed reply is kept. Sending clears it, and that write stays pending.
      await page!.advance(300);
      await page!.click('[data-thread="THREAD_1"] [data-act="gh-reply"][data-mode="single"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Reply posted'`);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openApp();
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"]')?.textContent || '').includes('Why this name?')`);
      box = await read(page!, `document.querySelector('textarea[data-draft="reply:THREAD_1"]')?.value ?? ''`);
    });

    it('then the reply box does not come back with the sent text.', () => {
      assert.equal(box, '');
    });
  });

  describe('when the page reloads right after a comment is typed, ', () => {
    let value: string;

    before(async () => {
      await page!.installClock();
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await fill(page!, '.th.new textarea.cmp-ta', 'Keep this.');
      // The clock does not move, so this write is still waiting when the page goes.
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openApp();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      value = await read(page!, `document.querySelector('.th.new textarea.cmp-ta')?.value ?? ''`);
    });

    it('then the text is still there.', () => {
      assert.equal(value, 'Keep this.');
    });
  });
});
