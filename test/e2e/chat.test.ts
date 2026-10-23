import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, untangleCommand, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

// The bar's label for the agent, and its menu when it's open: its title, what it says, its line and
// its buttons, then what its box for a note on the review asks.
const label = `(() => { const b = document.querySelector('.vw-agent'); return b ? b.className.replace('vw-agent ', '') + ' | ' + b.textContent.trim() : 'none'; })()`;
// The tab's icon: untangle's, or the circle that goes round while an agent works.
const tabIcon = `document.querySelector('link[rel="icon"]').getAttribute('href').includes('circle') ? 'working' : 'untangle'`;
const menu = `(() => { const m = document.querySelector('.ag-pop'); return m ? [m.querySelector('h4').textContent, m.querySelector('.ag-line')?.textContent ?? '', ...[...m.querySelectorAll('.rv-f button')].map((b) => b.textContent), m.querySelector('textarea[data-draft="agent"]')?.placeholder ?? 'no box'].join(' | ') : 'none'; })()`;

describe('Given a review a Claude chat in an Orca terminal holds, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient;
  let cache = '', bin = '', typed = '';
  let head = '';
  const chat = 'cccccccc-0000-4000-8000-000000000003';
  // Claude's word on the session its process runs (this test's), and whether it's busy.
  const session = (id: string, status: 'busy' | 'idle') => fs.writeFileSync(path.join(cache, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, status, statusUpdatedAt: Date.now() }));
  // A command run in Claude's chat.
  const inChat = (args: string[]) => untangleCommand(args, {
    cacheDir: cache, gh: gh!, cwd: repo!.dir,
    env: { UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(bin, 'browser.sh'), PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: path.join(cache, 'claude'), ORCA_TERMINAL_HANDLE: 'term_chat', ORCA_CLI_COMMAND: 'orca-ide' },
  });
  const watch = () => inChat(['watch']);
  const note = (line: number, body: string) => client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/app.dart', side: 'RIGHT', line, body } });

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', "void greet(String name) {\n  print('hi, $name');\n}\n");
    head = repo.commit({ subject: 'Name the greeting', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    fs.mkdirSync(path.join(cache, 'claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'browser.sh'), '#!/bin/sh\n', { mode: 0o755 });
    // Orca's CLI, standing in: it notes what it types, and says it went.
    typed = path.join(bin, 'typed.log');
    fs.writeFileSync(path.join(bin, 'orca-ide'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(typed)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write('{"ok":true,"result":{}}');\n`, { mode: 0o755 });
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main', env: { UNTANGLE_NOTES_QUIET: '100' } });
    client = reviewClient(run.url);
    await waitForReview(client);
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
    if (bin) fs.rmSync(bin, { recursive: true, force: true });
  });

  describe('when its watch waits, ', () => {
    let shown = '';
    let watching: ReturnType<typeof watch>;

    before(async () => {
      session(chat, 'busy');
      watching = watch();
      await page!.until(`document.querySelector('.vw-agent')?.textContent.includes('listening')`, 30_000);
      shown = await read(page!, `${label} + ' | ' + (${tabIcon})`);
    });

    it('then the bar says Claude is listening, and the tab shows untangle’s icon.', () => {
      assert.equal(shown, 'st-listening | Claude is listening | untangle');
    });

    describe('and the watch brings a note while its chat is busy, ', () => {
      before(async () => {
        await note(2, 'Say hello, not hi?');
        await watching;
        await page!.until(`document.querySelector('.vw-agent')?.textContent.includes('working')`, 10_000);
        shown = await read(page!, `${label} + ' | ' + (${tabIcon})`);
      });

      it('then Claude is working on it, and the tab’s icon is a circle going round.', () => {
        assert.equal(shown, 'st-working | Claude is working on N1 | working');
      });
    });
  });

  describe('when its turn ends with no watch, and you add a note, ', () => {
    let deaf = '', saved = '', opened = '';

    before(async () => {
      session(chat, 'idle');
      await page!.until(`document.querySelector('.vw-agent')?.classList.contains('st-deaf')`, 10_000);
      deaf = await read(page!, `${label} + ' | ' + (${tabIcon})`);
      await page!.click('[data-tab="files"]');
      await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
      await page!.click('[data-open="lib/app.dart"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`);
      await page!.hover('[data-c="R:1"]');
      await page!.until(`document.querySelector('.cm-add')?.classList.contains('on')`);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new.note textarea')`);
      await page!.click('.th.new.note textarea');
      await page!.type('Name it greetUser?');
      await page!.click('.th.new.note [data-act="nt-add"]');
      await page!.until(`!!document.querySelector('.th.note[data-note="2"]') && !!document.querySelector('.ag-line')`, 10_000);
      saved = await read(page!, `[document.querySelector('#vw-toast')?.textContent ?? '', document.querySelector('.th.note[data-note="2"] .cm-st')?.textContent ?? 'none'].join(' | ')`);
      opened = await read(page!, menu);
    });

    it('then the bar says Claude isn’t listening, the note reaches no one, and the menu opens, offering to wake Claude with the line for its chat.', () => {
      assert.deepEqual([deaf, saved, opened], [
        'st-deaf | Claude isn’t listening | untangle',
        'Note saved. Claude isn’t listening | no one is listening',
        'Claude isn’t listening | Wake types into its chat, in Orcauntangle: 1 new note on the review of feature. Run untangle watch to read it. | Copy for agent | Wake Claude | Write to Claude about the review',
      ]);
    });

    describe('and Wake is clicked, ', () => {
      let after = '';

      before(async () => {
        await page!.click('[data-act="nt-wake"]');
        await page!.until(`document.querySelector('.vw-agent')?.classList.contains('st-queued')`, 10_000);
        after = await read(page!, `[document.querySelector('.vw-agent').textContent.trim(), document.querySelector('#vw-toast')?.textContent ?? ''].join(' | ')`);
      });

      it('then untangle types the line into its terminal, through Orca, and the note waits for its turn.', () => {
        assert.deepEqual([after, fs.readFileSync(typed, 'utf8').trim().split('\n').map((l) => JSON.parse(l))], [
          'N2 waits for Claude’s turn | Typed into Claude’s chat',
          [['terminal', 'send', '--terminal', 'term_chat', '--text', 'untangle: 1 new note on the review of feature. Run untangle watch to read it.', '--enter', '--json']],
        ]);
      });
    });
  });

  describe('when Claude writes a note of its own, ', () => {
    let shown = '';

    before(async () => {
      await inChat(['note', 'lib/app.dart:1', 'Name', 'the', 'parameter', 'person?']);
      await page!.until(`!!document.querySelector('.th.note[data-note="3"] .cm.agent')`, 10_000);
      const lead = `document.querySelector('.th.note[data-note="3"] .cm.first')`;
      shown = await read(page!, `[${lead}.querySelector('.cm-who').textContent, ...[...${lead}.querySelectorAll('.cm-tag')].map((t) => '(' + t.textContent + ')'), ${lead}.querySelector('.cm-body').textContent.trim(), !!${lead}.querySelector('[data-act="nt-delete"]'), document.querySelector('#vw-toast')?.textContent ?? ''].join(' | ')`);
    });

    it('then it sits under its line as Claude’s thread, which you can delete, and a toast says so.', () => {
      assert.equal(shown, 'Claude | (Local) | (Agent) | Name the parameter person? | true | Claude wrote N3');
    });
  });

  describe('when Claude’s note is copied from its tools, ', () => {
    let copied = '';

    before(async () => {
      await page!.eval(`navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); }`);
      await page!.click('.th.note[data-note="3"] .cm.first [data-act="nt-copy-text"]');
      await page!.until(`typeof window.__copied === 'string'`);
      copied = await read(page!, `window.__copied + ' | ' + (document.querySelector('#vw-toast')?.textContent ?? '')`);
      await page!.eval('delete window.__copied');
    });

    it('then its words are on the clipboard as Claude wrote them, and a toast says so.', () => {
      assert.equal(copied, 'Name the parameter person? | Claude’s note, N3, copied');
    });
  });

  describe('when its label is clicked, and a note written in the menu’s box, ', () => {
    let typing = '', saved = '', note: unknown;

    before(async () => {
      await page!.click('.vw-agent');
      await page!.until(`document.activeElement?.dataset.draft === 'agent'`);
      typing = await read(page!, `document.activeElement.placeholder`);
      await page!.type('Start from the tests, then the greeting?');
      await page!.key('Enter', { ctrl: true });
      await page!.until(`(document.querySelector('#vw-toast')?.textContent ?? '').startsWith('Note saved') && document.querySelector('.ag-pop textarea')?.value === ''`, 10_000);
      saved = await read(page!, `[document.querySelector('#vw-toast').textContent, document.activeElement?.dataset.draft ?? 'no focus', document.querySelector('.ag-pop') ? 'open' : 'closed'].join(' | ')`);
      const n4 = ((await client.call('notes')).data as { notes: Array<{ n: number; review?: boolean; comments: Array<{ by: string | null; body: string }> }> }).notes.find((x) => x.n === 4);
      note = n4 && { review: n4.review, comments: n4.comments.map((c) => [c.by, c.body]) };
    });

    it('then the box takes the keys as the menu opens, and the note is on the review, yours, with the menu open and its box empty for the next.', () => {
      assert.deepEqual([typing, saved, note], [
        'Write to Claude about the review',
        'Note saved, queued to Claude | agent | open',
        { review: true, comments: [[null, 'Start from the tests, then the greeting?']] },
      ]);
    });
  });

  describe('when the chat ends, ', () => {
    let shown = '';

    before(async () => {
      session('dddddddd-0000-4000-8000-000000000004', 'idle');
      await page!.until(`document.querySelector('.vw-agent')?.classList.contains('st-left')`, 10_000);
      shown = await read(page!, `${label} + ' | ' + (document.querySelector('#vw-toast')?.textContent ?? '')`);
    });

    it('then the bar says Claude left, and so does a toast.', () => {
      assert.equal(shown, 'st-left | Claude left | Claude left: its chat ended');
    });
  });
});
