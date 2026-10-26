import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, pendingAnswer, pendingLookup, type ConversationSpec } from '../helpers/conversation.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, untangleCommand, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const callLine = 6;
const printLine = 2;

const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');

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

// A note as the page shows it: its comments (who, tags, text), or, folded, its header.
const noteShown = (n: number) => `(() => { const th = document.querySelector('.th.note[data-note="${n}"]'); if (!th) return 'none'; if (th.matches('.resolved') && !th.querySelector('.cm')) return 'folded: ' + th.querySelector('.th-fold').textContent.replace(/\\s+/g, ' ').trim(); return [...th.querySelectorAll('.cm')].map((cm) => [cm.querySelector('.nt-n')?.textContent ?? '', cm.querySelector('.cm-who')?.textContent ?? '', ...[...cm.querySelectorAll('.cm-h > span:not(.cm-tag):not(.cm-st):not([title])')].map((s) => s.textContent), ...[...cm.querySelectorAll('.cm-tag')].map((tag) => '(' + tag.textContent + ')'), '- ' + (cm.querySelector('.cm-body')?.textContent ?? '').trim()].filter(Boolean).join(' ')).join(' / '); })()`;

function posted(gh: GhStub, mutation: string): string {
  const call = [...gh.calls()].reverse().find((item) => item.stdin.includes(`${mutation}(input:`));
  if (!call) throw new Error(`no ${mutation} call`);
  return JSON.stringify((JSON.parse(call.stdin) as { variables: { input: unknown } }).variables.input);
}

describe('Given a served review of pull request 7, and an agent’s commands, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let head = '';
  let spec: ConversationSpec;
  const env = { UNTANGLE_NOTES_QUIET: '100' };
  const agent = (args: string[]) => untangleCommand(args, { cacheDir: cache, gh: gh!, cwd: repo!.dir, env });

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    head = repo.commit({ subject: 'Name the greeting', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    spec = { number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7', head, threads: [] };
    gh = stubGh([
      {
        match: ['pr', 'view'],
        stdout: { number: 7, title: 'Add a greeting', url: spec.url, state: 'OPEN', baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head },
      },
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
      { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) },
      { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThread', stdout: conversationOf({ ...spec, pending: { id: 'REVIEW_PENDING', comments: 1 }, threads: [{ id: 'THREAD_9', path: 'lib/app.dart', line: printLine, body: 'Print a greeting, not the name.', pending: true }] }) },
      { match: ['api', 'graphql'], stdout: conversationOf(spec) },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, env });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head') && !!document.querySelector('.rv-btn')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openApp(): Promise<void> {
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page!.click('[data-open="lib/app.dart"]');
    await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`);
  }

  describe('when the review’s menu opens, ', () => {
    let shown: string;

    before(async () => {
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-pop .rv-mode')`);
      shown = await read(page!, `[document.querySelector('.rv-btn').textContent.trim(), ...[...document.querySelectorAll('.rv-seg button')].map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? ' (on)' : ''))].join(' | ')`);
    });

    it('then new comments go to GitHub, as before.', () => {
      assert.equal(shown, 'Review | GitHub (on) | Local notes');
    });
  });

  describe('when Local notes is chosen and a line’s + is clicked, ', () => {
    let shown: string;

    before(async () => {
      await page!.click('.rv-seg [data-mode="local"]');
      await page!.until(`document.querySelector('.rv-btn').textContent.trim() === 'Notes'`);
      await rest(page!);
      await openApp();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new.note textarea')`);
      shown = await read(page!, `[document.querySelector('.rv-btn').textContent.trim(), document.querySelector('.th.new.note .th-new-h b').textContent, document.querySelector('.th.new.note .cmp-hint').textContent, ...[...document.querySelectorAll('.th.new.note .cmp-f button')].map((b) => b.textContent)].join(' | ')`);
    });

    it('then the button says Notes, and the box saves a note here, or asks for a draft comment.', () => {
      assert.equal(shown, `Notes | Note on line +${callLine} | Saved locally · Markdown · Ctrl+Enter: Add note | Cancel | Draft comment | Add note`);
    });
  });

  describe('when the note is added, ', () => {
    let shown: string;
    let cursors: string;

    before(async () => {
      await fill(page!, '.th.new.note textarea', 'Why greet `ada`?');
      await page!.click('.th.new.note [data-act="nt-add"]');
      await page!.until(`!!document.querySelector('.th.note[data-note="1"]')`);
      shown = await read(page!, noteShown(1));
      cursors = await read(page!, `['', ' .cm-h', ' .cm-body'].map((part) => getComputedStyle(document.querySelector('.th.note[data-note="1"]' + part)).cursor).join(' ')`);
    });

    it('then it sits under its line, numbered N1 and local.', () => {
      assert.equal(shown, `N1 You line ${callLine} (Local) - Why greet ada?`);
    });

    it('then the pointer over it is the page\'s, as over a comment, not a button\'s.', () => {
      assert.equal(cursors, 'auto auto auto');
    });
  });

  describe('when an agent answers it with untangle reply, ', () => {
    let replied: { code: number | null; out: string };
    let shown: string;

    before(async () => {
      replied = await agent(['reply', '-agent', 'Codex', 'N1', 'Because', 'ada', 'is', 'the', 'first', 'user.']);
      await page!.until(`!!document.querySelector('.th.note[data-note="1"] .cm.agent')`, 10_000);
      shown = await read(page!, noteShown(1));
    });

    it('then the answer shows under the note at once, with the agent’s name.', () => {
      assert.deepEqual([replied.code, replied.out, shown], [0, 'untangle: answered N1.\n', `N1 You line ${callLine} (Local) - Why greet ada? / Codex (Agent) - Because ada is the first user.`]);
    });
  });

  describe('when the agent’s answer is copied from its tools, ', () => {
    let tools: string;
    let copied: string;

    before(async () => {
      await page!.eval(`navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); }`);
      tools = await read(page!, `[...document.querySelectorAll('.th.note[data-note="1"] .cm')].map((cm) => [...cm.querySelectorAll('.cm-tools .ib')].map((b) => b.getAttribute('aria-label')).join(', ') || 'none').join(' / ')`);
      await page!.click('.th.note[data-note="1"] .cm.agent [data-act="nt-copy-text"]');
      await page!.until(`typeof window.__copied === 'string'`);
      copied = await read(page!, `window.__copied + ' | ' + (document.querySelector('#vw-toast')?.textContent ?? '')`);
      await page!.eval('delete window.__copied');
    });

    it('then yours has edit and delete, both have a copy, and each can be said on GitHub, Comment this last.', () => {
      assert.equal(tools, 'Edit, Delete the note, Copy the note’s text, Comment this / Copy its text, Comment this');
    });

    it('then its words are on the clipboard as it wrote them, and a toast says whose.', () => {
      assert.equal(copied, 'Because ada is the first user. | Codex’s reply copied');
    });
  });

  describe('when the agent resolves it, ', () => {
    let shown: string;

    before(async () => {
      await agent(['reply', '-agent', 'Codex', '-resolve', 'N1']);
      await page!.until(`!!document.querySelector('.th.note.resolved.by-agent[data-note="1"]')`, 10_000);
      shown = await read(page!, noteShown(1));
    });

    it('then the note folds, saying the agent resolved it.', () => {
      assert.equal(shown, `folded: ✦Resolved by Codex· N1 · line ${callLine} · 2 comments`);
    });
  });

  describe('when every note is copied for the agent, ', () => {
    let copied: string;
    let printed: string;

    before(async () => {
      await page!.eval(`navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); }`);
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-pop [name="nt-scope"][value="all"]')`);
      await page!.click('.rv-pop [name="nt-scope"][value="all"]');
      await page!.until(`document.querySelector('.rv-pop [name="nt-scope"][value="all"]').checked`);
      await page!.click('.rv-pop [data-act="nt-copy"]');
      await page!.until(`typeof window.__copied === 'string'`);
      copied = await read(page!, 'window.__copied');
      printed = (await agent(['notes', '-all'])).out;
      await rest(page!);
    });

    it('then the copy is what untangle notes prints: the note, its code, and its thread.', () => {
      assert.deepEqual([copied, copied], [printed, [
        `My review notes on acme/sample#7 (branch feature, at ${head.slice(0, 7)}). Line numbers are on that commit.`,
        '',
        'Where a note explicitly asks for a change, make it. Otherwise, discuss it with me before changing anything.',
        '',
        `N1 · lib/app.dart:${callLine} (resolved)`,
        'In the change "greet(name)"',
        '```dart',
        "  greet('ada');",
        '```',
        'Why greet `ada`?',
        'Codex: Because ada is the first user.',
        '',
      ].join('\n')]);
    });
  });

  describe('when a note on the print is said on GitHub with Comment this, ', () => {
    let box: string;
    let sent: string;
    let shown: string;

    before(async () => {
      await showAdd(page!, printLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new.note textarea')`);
      await fill(page!, '.th.new.note textarea', 'Print a greeting, not the name.');
      await page!.click('.th.new.note [data-act="nt-add"]');
      await page!.until(`!!document.querySelector('.th.note[data-note="2"] [data-act="nt-comment-this"]')`);
      await page!.click('.th.note[data-note="2"] [data-act="nt-comment-this"]');
      await page!.until(`!!document.querySelector('.th.note[data-note="2"] textarea[data-draft="nreply:2"]')`);
      box = await read(page!, `[document.querySelector('textarea[data-draft="nreply:2"]').value, document.querySelector('.th.note[data-note="2"] .cmp-hint').textContent, ...[...document.querySelectorAll('.th.note[data-note="2"] .cmp-f button')].map((b) => b.textContent)].join(' | ')`);
      await page!.click('.th.note[data-note="2"] [data-act="nt-comment"][data-mode="review"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Added to your pending review'`);
      sent = posted(gh!, 'addPullRequestReviewThread');
      await page!.until(`!!document.querySelector('[data-thread="THREAD_9"] .th-talk')`);
      shown = await read(page!, `[document.querySelector('.code .th.note[data-note="2"]') ? 'apart' : 'in its thread', document.querySelector('[data-thread="THREAD_9"] .cm-tag.pending')?.textContent ?? 'no thread', document.querySelector('[data-thread="THREAD_9"] .th-talk').textContent.replace(/\\s+/g, ' ').trim()].join(' | ')`);
    });

    it('then its box holds the note, as a comment for GitHub, with GitHub’s buttons.', () => {
      assert.equal(box, 'Print a greeting, not the name. | Posts to GitHub · Markdown · Ctrl+Enter: Start a review | Cancel | Add single comment | Start a review');
    });

    it('then GitHub is asked for a thread on its line, in the pending review, and the note stays, in that thread.', () => {
      assert.deepEqual([sent, shown], [`{"pullRequestId":"PR_1","path":"lib/app.dart","body":"Print a greeting, not the name.","subjectType":"LINE","line":${printLine},"side":"RIGHT"}`, 'in its thread | Pending | N2 · 1 note with Codex · only here']);
    });
  });

  describe('when GitHub’s thread is answered in local mode, ', () => {
    let shown: string;

    before(async () => {
      await page!.click('[data-thread="THREAD_9"] [data-act="reply-open"]');
      await page!.until(`!!document.querySelector('[data-thread="THREAD_9"] textarea[data-draft="reply:THREAD_9"]')`);
      shown = await read(page!, `[...document.querySelectorAll('[data-thread="THREAD_9"] .cmp-f button')].map((b) => b.textContent).join(' | ')`);
      await fill(page!, '[data-thread="THREAD_9"] textarea[data-draft="reply:THREAD_9"]', 'Say why it prints the name at all.');
      await page!.click('[data-thread="THREAD_9"] [data-act="nt-thread"]');
      await page!.until(`[...document.querySelectorAll('[data-thread="THREAD_9"] .cm-body')].some((b) => b.textContent.includes('Say why'))`);
      shown += ' / ' + await read(page!, `[...document.querySelector('[data-thread="THREAD_9"]').querySelectorAll(':scope > .cm, :scope > .th-sub > .cm, :scope > .th-sub > .th-sub-h > .th-talk')].map((el) => el.matches('.th-talk') ? 'talk: ' + el.textContent.replace(/\\s+/g, ' ').trim() : (el.matches('.pending') ? 'GitHub' : 'note') + ': ' + el.querySelector('.cm-body').textContent.trim()).join(' | ')`);
    });

    it('then the answer joins the note’s talk in that thread, under its head, after the comment it made, kept here, not a reply on GitHub.', () => {
      assert.equal(shown, 'Cancel | Draft comment | Add note / talk: N2 · 1 note with Codex · only here | GitHub: Print a greeting, not the name. | talk: N2 · 1 note with Codex · only here | note: Say why it prints the name at all.');
    });
  });

  describe('when Codex answers in the thread’s talk while the review’s own thread is open, ', () => {
    let row: string;

    before(async () => {
      await page!.click('[data-tab="comments"]');
      await page!.until(`!!document.querySelector('.sb-row.sb-rv')`);
      await page!.click('.sb-row.sb-rv');
      await page!.until(`!!document.querySelector('#vw-main .conv') && !document.querySelector('#vw-main [data-thread="THREAD_9"]')`);
      await agent(['reply', '-agent', 'Codex', 'N2', 'It', 'prints', 'the', 'name', 'by', 'mistake.']);
      await page!.until(`!!document.querySelector('.sb-row[data-thread="THREAD_9"] .n.nt.new')`, 10_000);
      row = await read(page!, `[document.querySelector('.sb-row[data-thread="THREAD_9"]').title.split(' · ').pop(), document.querySelector('[data-tab="comments"] .nw') ? 'the tab’s dot' : 'no dot'].join(' | ')`);
      await openApp();
    });

    it('then the thread’s row has the talk’s dot amber, and says N2 has a new answer from Codex, as the tab’s dot does.', () => {
      assert.equal(row, 'N2 has a new answer from Codex | the tab’s dot');
    });
  });

  describe('when the hunk with GitHub’s thread and the notes is folded, ', () => {
    let counts: string;

    before(async () => {
      const chevron = '.code[data-p="lib/app.dart"] .hh [data-act="toggle-hunk"]';
      await page!.click(chevron);
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"] .hh .hh-sum .cm-cnt')`);
      counts = await read(page!, `(() => {
        const swatch = (token) => { const s = document.createElement('span'); s.style.color = 'var(' + token + ')'; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
        const named = { [swatch('--gh')]: 'GitHub’s color', [swatch('--local')]: 'the notes’ color' };
        return [...document.querySelectorAll('.code[data-p="lib/app.dart"] .hh .hh-sum .cm-cnt')].map((c) => c.textContent + ' ' + c.title.toLowerCase() + ', in ' + (named[getComputedStyle(c).color] || getComputedStyle(c).color)).join(' / ');
      })()`);
      await page!.click(chevron);
      await page!.until(`!document.querySelector('.code[data-p="lib/app.dart"] .hh .hh-sum')`);
    });

    it('then its line counts the thread in GitHub’s color, and the notes apart, in the notes’ color.', () => {
      assert.equal(counts, '1 threads on these lines, in GitHub’s color / 1 notes on these lines, in the notes’ color');
    });
  });

  describe('when GitHub is chosen again and a line’s + is clicked, ', () => {
    let shown: string;

    before(async () => {
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-seg [data-mode="github"]')`);
      await page!.click('.rv-seg [data-mode="github"]');
      await page!.until(`!document.querySelector('.rv-btn.local')`);
      await rest(page!);
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea')`);
      shown = await read(page!, `[document.querySelector('.th.new').matches('.note') ? 'a note' : 'a comment', document.querySelector('.th.new .cmp-hint').textContent, ...[...document.querySelectorAll('.th.new .cmp-f button')].map((b) => b.textContent)].join(' | ')`);
      await page!.click('.th.new [data-act="compose-cancel"]');
    });

    it('then the box posts to GitHub, into the pending review.', () => {
      assert.equal(shown, 'a comment | Posts to GitHub · Markdown · Ctrl+Enter: Add review comment | Cancel | Add review comment');
    });
  });

  describe('when a line’s box, with words in it, is switched to a note from the box itself, then back, ', () => {
    const box = `(() => { const th = document.querySelector('.th.new'); const ta = th.querySelector('textarea'); return [th.matches('.note') ? 'a note' : 'a comment', th.querySelector('.th-new-h b').textContent, [...th.querySelectorAll('.cmp-mode button')].map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? ' (on)' : '')).join(' '), ta.value, document.activeElement === ta ? 'caret at ' + ta.selectionStart : 'not focused', document.querySelector('.rv-btn').textContent.trim()].join(' | '); })()`;
    let note: string;
    let comment: string;

    before(async () => {
      await rest(page!);
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea')`);
      await fill(page!, '.th.new textarea', 'Why greet ada?');
      await page!.eval(`document.querySelector('.th.new textarea').setSelectionRange(4, 4)`);
      await page!.click('.th.new .cmp-mode [data-mode="local"]');
      await page!.until(`!!document.querySelector('.th.new.note')`);
      note = await read(page!, box);
      await page!.click('.th.new .cmp-mode [data-mode="github"]');
      await page!.until(`!!document.querySelector('.th.new:not(.note)')`);
      comment = await read(page!, box);
      await page!.click('.th.new [data-act="compose-cancel"]');
      await page!.until(`!document.querySelector('.th.new')`);
    });

    it('then it\'s a note, its words and the caret kept, and the bar says Notes.', () => {
      assert.equal(note, `a note | Note on line +${callLine} | Note (on) Comment | Why greet ada? | caret at 4 | Notes 1`);
    });

    it('then back, it\'s a comment for GitHub again, as it was.', () => {
      assert.equal(comment, `a comment | Comment on line +${callLine} | Note Comment (on) | Why greet ada? | caret at 4 | Finish review 1`);
    });
  });
});
