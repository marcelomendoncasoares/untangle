import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, pendingAnswer, pendingLookup, type ConversationSpec } from '../helpers/conversation.ts';
import { stubGh, type GhReply, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const guide = ['# Run it', 'It needs a database.', 'Start one with docker compose up.', ''].join('\n');
const setup = (dart: string) => ['# Set up', `Install ${dart}.`, 'Then run pub get.', ''].join('\n');

// What the open view shows: its file and facts (with their counts), then its toggles, and each
// thread or note with the code above it.
const shown = `[document.querySelector('.fv-head .crumbs b')?.textContent,
  [...document.querySelector('.fv-head .facts').childNodes].map((n) => n.nodeType === 3 ? n.textContent : n.title + ' ' + n.textContent).join(', '),
  ...[...document.querySelectorAll('.fthreads > *')].map((el) => el.matches('.th-hunk') ? 'code: ' + [...el.children].map((row) => row.textContent).join(' / ')
    : el.matches('.th-away') ? 'toggle: ' + el.textContent
    : [...(el.querySelector('.th-fold, .th-h')?.children ?? [])].map((c) => c.textContent.trim()).filter(Boolean).join(' ') + ' | ' + [...el.querySelectorAll('.cm-body')].map((b) => b.textContent.trim()).join(' / '))].join('\\n')`;

describe('Given a served review of pull request 7 with a note and a GitHub thread on the guide a commit added, a note on the setup line it changed, and that commit force-pushed away, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient;
  let cache = '';
  let dropped = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', "void greet() => print('hi');\n");
    repo.write('docs/setup.md', setup('dart'));
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', "void greet() => print('hello');\n");
    const kept = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    repo.write('docs/guide.md', guide);
    repo.write('docs/setup.md', setup('dart 3'));
    dropped = repo.commit({ subject: 'Write a guide', author: ada('2020-06-03T15:00:00Z'), committer: ada('2020-06-03T15:00:00Z') });
    const url = 'https://github.com/acme/sample/pull/7';
    gh = stubGh([]);
    const github = (head: string, outdated: boolean) => {
      const spec: ConversationSpec = { number: 7, title: 'Say hello', url, head, threads: [{ id: 'THREAD_G', path: 'docs/guide.md', line: 3, body: 'Which compose file?', outdated }] };
      const replies: GhReply[] = [
        { match: ['pr', 'view'], stdout: { number: 7, title: 'Say hello', url, state: 'OPEN', baseRefName: 'main', baseRefOid: repo!.rev('main'), headRefName: 'feature', headRefOid: head } },
        { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
        { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
        { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) },
        { match: ['api', 'graphql'], stdout: conversationOf(spec) },
      ];
      gh!.setReplies(replies);
    };
    github(dropped, false);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    client = reviewClient(run.url);
    await waitForReview(client);
    await client.call('notes', { method: 'POST', head: dropped, body: { action: 'add', path: 'docs/guide.md', side: 'RIGHT', line: 2, body: 'Which database?' } });
    await client.call('notes', { method: 'POST', head: dropped, body: { action: 'add', path: 'docs/setup.md', side: 'RIGHT', line: 2, body: 'Which version?' } });
    // The guide's commit taken off the branch, here and on GitHub, and the review moved onto it.
    repo.resetBranch('feature', kept);
    github(kept, true);
    await client.call('refresh', { method: 'POST' });
    for (let at = Date.now(); ; ) {
      const s = (await client.call('refresh', { query: { check: '1' } })).data as { state: string; head: string };
      if (s.head === kept && s.state === 'ready') break;
      if (Date.now() - at > 120_000) throw new Error(`the review didn't move: ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    page = await launchBrowser();
    await page.reducedMotion(true);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  /** Opens a row of the Threads tab. */
  async function openFromThreads(row: string): Promise<void> {
    await rest(page!);
    await page!.goto(run!.url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await page!.click('[data-tab="comments"]');
    await page!.until(`!!document.querySelector('${row}')`, 30_000);
    await page!.click(row);
    await page!.until(`!!document.querySelector('.fthreads')`);
  }

  describe('when the note is opened from the Threads tab, ', () => {
    let seen: string;
    before(async () => {
      await openFromThreads('[data-act="nt-open"][data-n="1"]');
      await page!.until(`!!document.querySelector('.th.note[data-note="1"] .cm-body')`);
      seen = await read(page!, shown);
    });

    it('then the guide opens, not in this review, with the note under the lines it was written on, gone since the commit taken off.', () => {
      assert.equal(seen, [
        'guide.md',
        'Not in this review, Open threads 1, Open notes 1',
        'toggle: 1 thread on code this version doesn’t have (outdated)',
        'toggle: 1 note on code this version doesn’t show',
        'code: 2It needs a database.',
        `Gone since ${dropped.slice(0, 7)} · N1 · line 2 · 1 comment | Which database?`,
      ].join('\n'));
    });
  });

  describe('when the GitHub thread is opened from the Threads tab, ', () => {
    let seen: string;
    before(async () => {
      await openFromThreads('[data-act="thread-open"][data-thread="THREAD_G"]');
      await page!.until(`!!document.querySelector('.fthreads [data-thread="THREAD_G"] .cm-body')`);
      seen = await read(page!, shown);
    });

    it('then the guide opens on it too, outdated, under the end of the diff GitHub has it on.', () => {
      assert.equal(seen, [
        'guide.md',
        'Not in this review, Open threads 1, Open notes 1',
        'toggle: 1 thread on code this version doesn’t have (outdated)',
        'code: +code',
        'Outdated · line 3 · 1 comment | Which compose file?',
        'toggle: 1 note on code this version doesn’t show',
        'code: 2It needs a database.',
        `Gone since ${dropped.slice(0, 7)} · N1 · line 2 · 1 comment | Which database?`,
      ].join('\n'));
    });
  });

  describe('when the note on the setup is opened from the Threads tab, ', () => {
    let seen: string;
    before(async () => {
      await openFromThreads('[data-act="nt-open"][data-n="2"]');
      await page!.until(`!!document.querySelector('.th.note[data-note="2"] .cm-body')`);
      seen = await read(page!, shown);
    });

    it('then the setup opens, not in this review, with the note under the line that took its line’s place, outside the diff.', () => {
      assert.equal(seen, [
        'setup.md',
        'Not in this review, Open notes 1',
        'toggle: 1 note on code this version doesn’t show',
        'code: 2Install dart.',
        'line 2, outside the diff · N2 · line 2 · 1 comment | Which version?',
      ].join('\n'));
    });
  });
});
