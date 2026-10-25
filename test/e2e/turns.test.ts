import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-09-01T15:00:00Z' };
const dart = (names: string[], said: string) => names.map((n) => `int ${n}() {\n  // ${said} ${n}\n  return 1;\n}\n`).join('\n');
// The Threads tab's notes: each group's head and count, then each row as its mark and number, and
// "new" while it's new to you; and the tab's dot.
const listed = `[...document.querySelectorAll('#vw-side .sb-group, #vw-side .sb-row.thr[data-n]')].map((r) => r.matches('.sb-group') ? '# ' + [...r.children].map((x) => x.textContent).join(' ') : r.querySelector('.mk').className.replace('mk ', '') + ' N' + r.dataset.n + (r.matches('.new') ? ' new' : '')).join(' | ') + (document.querySelector('[data-tab="comments"] .nw') ? ' | tab dot' : '')`;
// The line above a note's Reply, and the New tags in its thread, each after the time before it.
const turnOf = (n: number) => `document.querySelector('.th.note[data-note="${n}"] .nt-turn')?.textContent ?? 'no line'`;
const tagsOf = (n: number) => `[...document.querySelectorAll('.th.note[data-note="${n}"] .cm-tag.new')].map((t) => 'New after ' + t.previousElementSibling.textContent).join(', ') || 'no tag'`;

describe('Given a review with three notes of yours, in two files, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let client: ReviewClient;
  let cache = '';
  let head = '';
  const call = async (route: string, body: unknown) => {
    const r = await client.call(route, { method: 'POST', head, body });
    assert.equal(r.status, 200, r.text);
  };
  // Claude and Codex, standing in: a watch that reads what's new, and an answer through the notes' API.
  const watch = (agent: string) => call('notes/watch', { agent, wait: 5_000 });
  const answer = (agent: string, n: number, body: string, resolve = false) => call('notes/agent', { agent, n, body, resolve });
  const threads = async () => {
    await page.click('[data-tab="comments"]');
    await page.until(`!!document.querySelector('.sb-row.thr[data-n]')`);
  };

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', dart(['one', 'two'], 'first'));
    repo.write('lib/other.dart', dart(['three'], 'first'));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', dart(['one', 'two'], 'second'));
    repo.write('lib/other.dart', dart(['three'], 'second'));
    head = repo.commit({ subject: 'Say it again', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, env: { UNTANGLE_NOTES_QUIET: '100' } });
    client = reviewClient(run.url);
    await waitForReview(client);
    for (const [p, line, body] of [['lib/app.dart', 2, 'Why say it again?'], ['lib/other.dart', 2, 'Is three still one?'], ['lib/app.dart', 7, 'Same for two?']] as const) {
      await call('notes', { action: 'add', path: p, side: 'RIGHT', line, body });
    }
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await threads();
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when no agent has held it, ', () => {
    let shown = '';

    before(async () => {
      shown = await read(page, listed);
    });

    it('then its notes are one list, in the files’ order, each with its orchid ring, and the tab has no dot.', () => {
      assert.equal(shown, 'note N1 | note N3 | note N2');
    });

    describe('and N1 is copied for the agent from its thread, ', () => {
      let line = '';

      before(async () => {
        await page.click('.sb-row.thr[data-n="1"]');
        await page.until(`!!document.querySelector('.th.note[data-note="1"]')`);
        await page.eval(`navigator.clipboard.writeText = () => Promise.resolve()`);
        await page.click('.th.note[data-note="1"] [data-act="nt-copy1"]');
        await page.until(`!!document.querySelector('.th.note[data-note="1"] .nt-turn')`);
        line = await read(page, turnOf(1));
      });

      it('then the line above its Reply says so.', () => {
        assert.equal(line, 'Copied for your agent');
      });
    });
  });

  describe('when Claude reads them, and works on them, ', () => {
    let shown = '';

    before(async () => {
      await watch('Claude');
      await page.until(`!!document.querySelector('.sb-group.turn')`, 10_000);
      shown = [await read(page, listed), await read(page, turnOf(1))].join(' || ');
    });

    it('then they wait for Claude, each turning grey, as Claude never answered in them, and N1’s thread says Claude is on it.', () => {
      assert.equal(shown, '# Waiting for Claude 3 | on wait N1 | on wait N3 | on wait N2 || Claude is on it');
    });
  });

  describe('when Claude answers N2, in the file that isn’t open, ', () => {
    let shown = '';

    before(async () => {
      await answer('Claude', 2, 'Yes: `three` still returns 1.');
      await page.until(`!!document.querySelector('.sb-row.thr.new[data-n="2"]')`, 10_000);
      shown = [await read(page, listed), await read(page, `document.querySelector('#vw-toast')?.textContent ?? ''`)].join(' || ');
    });

    it('then N2 waits for you, amber and in bold, the tab has a dot, and the toast says Claude answered it.', () => {
      assert.equal(shown, '# Waiting for you 1 | new N2 new | # Waiting for Claude 2 | on wait N1 | on wait N3 | tab dot || Claude answered N2');
    });
  });

  describe('when N2 is opened, ', () => {
    let tagged = '';
    let seen = '';

    before(async () => {
      await page.click('.sb-row.thr[data-n="2"] .nm');
      await page.until(`!!document.querySelector('.th.note[data-note="2"] .cm-tag.new')`);
      tagged = await read(page, tagsOf(2));
      await page.until(`!document.querySelector('.th.note[data-note="2"] .cm-tag.new')`, 10_000);
      seen = await read(page, listed);
    });

    it('then Claude’s answer is tagged New after its time, and a second later it’s seen: N2’s dot turns orchid, and the tab’s dot goes.', () => {
      assert.deepEqual([tagged, seen], ['New after just now', '# Waiting for you 1 | ans N2 | # Waiting for Claude 2 | on wait N1 | on wait N3']);
    });
  });

  describe('when N2’s dot is clicked, ', () => {
    let shown = '';
    let reloaded = '';

    before(async () => {
      await page.hover('.sb-row.thr[data-n="2"] .nm');
      await page.click('.sb-row.thr[data-n="2"] .mk-b');
      await page.until(`!!document.querySelector('.sb-row.thr.new[data-n="2"]')`);
      // Its thread is on screen: still new two seconds on.
      await new Promise((r) => setTimeout(r, 2_000));
      shown = [await read(page, listed), await read(page, tagsOf(2))].join(' || ');
      await page.goto(run.url);
      await page.until(`!!document.querySelector('.t-head')`, 30_000);
      await threads();
      await page.until(`!!document.querySelector('.sb-row.thr[data-n="2"] .mk-b')`);
      reloaded = await read(page, listed);
    });

    it('then N2 is unread: new again, and still new on screen, its answer tagged New and the tab’s dot back, after a reload too.', () => {
      assert.deepEqual([shown, reloaded], [
        '# Waiting for you 1 | new N2 new | # Waiting for Claude 2 | on wait N1 | on wait N3 | tab dot || New after just now',
        '# Waiting for you 1 | new N2 new | # Waiting for Claude 2 | on wait N1 | on wait N3 | tab dot',
      ]);
    });
  });

  describe('when Shift+Space is pressed on N2’s row, with the focus, ', () => {
    let shown = '';

    before(async () => {
      await page.eval(`document.querySelector('.sb-row.thr[data-n="2"]').focus()`);
      await page.key(' ', { shift: true });
      await page.until(`!document.querySelector('.sb-row.thr.new[data-n="2"]')`);
      shown = [await read(page, listed), await read(page, `document.activeElement.dataset.n`)].join(' || ');
    });

    it('then N2 is seen, and its row keeps the focus.', () => {
      assert.equal(shown, '# Waiting for you 1 | ans N2 | # Waiting for Claude 2 | on wait N1 | on wait N3 || 2');
    });
  });

  describe('when you reply to N2 in its thread, ', () => {
    let shown = '';

    before(async () => {
      await page.click('.sb-row.thr[data-n="2"] .nm');
      await page.until(`!!document.querySelector('.th.note[data-note="2"] [data-act="nt-reply-open"]')`);
      await page.click('.th.note[data-note="2"] [data-act="nt-reply-open"]');
      await page.until(`!!document.querySelector('.th.note[data-note="2"] textarea')`);
      await page.click('.th.note[data-note="2"] textarea');
      await page.type('Then say so in its doc.');
      await page.until(`document.querySelector('.th.note[data-note="2"] textarea').value === 'Then say so in its doc.'`);
      await page.click('.th.note[data-note="2"] [data-act="nt-reply"]');
      await page.until(`document.querySelector('.sb-row.thr[data-n="2"]')?.dataset.grp === 'agent'`, 10_000);
      shown = [await read(page, listed), await read(page, turnOf(2))].join(' || ');
    });

    it('then N2 waits for Claude, its ring orchid, as Claude answered in it, and its thread says Claude hasn’t read your reply.', () => {
      assert.equal(shown, '# Waiting for Claude 3 | on wait N1 | on wait N3 | note N2 || Sent, not read yet');
    });
  });

  describe('when Claude resolves N3, ', () => {
    let shown = '';

    before(async () => {
      await answer('Claude', 3, 'Done in the same commit.', true);
      await page.until(`!!document.querySelector('[data-act="nt-resolved-toggle"]')`, 10_000);
      await page.click('[data-act="nt-resolved-toggle"]');
      await page.until(`!!document.querySelector('.sb-row.thr[data-n="3"]')`);
      shown = await read(page, `(() => { const mk = document.querySelector('.sb-row.thr[data-n="3"] .mk'); return mk.className + ' ' + mk.textContent + ' ' + getComputedStyle(mk).color; })()`);
    });

    it('then N3 is under Resolved notes with Claude’s mark, in green.', () => {
      assert.equal(shown, 'mk ok ag ✦ rgb(88, 197, 151)');
    });
  });

  describe('when Codex holds the review too, and answers N1, ', () => {
    let shown = '';

    before(async () => {
      await watch('Codex');
      await answer('Codex', 1, 'It says it again on purpose.');
      await page.until(`!!document.querySelector('.sb-row.thr.new[data-n="1"]')`, 10_000);
      shown = await read(page, `[...document.querySelectorAll('#vw-side .sb-group.turn > span:first-child')].map((x) => x.textContent).join(', ') + ' | ' + document.querySelector('.sb-row.thr[data-n="1"] .sn').textContent`);
    });

    it('then the notes wait for you or for the agents, and an answer’s row names who wrote it.', () => {
      assert.equal(shown, 'Waiting for you, Waiting for the agents | Codex: It says it again on purpose.');
    });
  });
});
