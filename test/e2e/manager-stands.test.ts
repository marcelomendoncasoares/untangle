import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';

const skip = e2eSkip();
const [first, second, head] = ['a', 'b', 'c'].map((c) => c.repeat(40));
const at = (day: number) => `2020-06-${String(day).padStart(2, '0')}T12:00:00Z`;
const review = (state: string, day: number, commit: string) => ({ state, submittedAt: at(day), body: 'A few things.', commit: { oid: commit }, comments: { nodes: [{ replyTo: null }] } });
const thread = (last: string) => ({ isResolved: false, isOutdated: false, first: { nodes: [{ author: { login: 'ada' }, state: 'SUBMITTED' }] }, last: { nodes: [{ author: { login: last } }] } });
// What GitHub says of each pull request ada reviewed.
const pull = (o: Record<string, unknown>) => ({
  pullRequest: {
    state: 'OPEN', headRefOid: head, viewerDidAuthor: false, author: { login: 'grace' },
    reviewRequests: { nodes: [] }, asked: { nodes: [] }, pushed: { nodes: [] }, commits: { nodes: [first, second, head].map((oid) => ({ commit: { oid } })) },
    mine: { nodes: [] }, reviewThreads: { nodes: [] }, ...o,
  },
});
// Each row's tags: what they say, how they look, and what they say on hover.
const tags = `[...document.querySelectorAll('.row')].map((r) => [r.querySelector('.num').textContent, ...[...r.querySelectorAll('.ev.gh')].map((e) => [e.className.replace('ev gh', '').trim(), e.textContent].filter(Boolean).join(': '))].join(' | '))`;

describe('Given four reviews of pull requests ada reviewed on GitHub, paused, in the manager, ', { skip, timeout: 180_000 }, () => {
  let gh: GhStub;
  let cache = '', cwd = '';
  let page: Browser;

  before(async () => {
    gh = stubGh([
      { match: ['api', 'graphql'], stdinIncludes: 'viewer { login }', stdout: { data: { viewer: { login: 'ada' } } } },
      { match: ['api', 'graphql'], stdinIncludes: 'fragment Stand', stdout: { data: {
        // Changes requested on its head, two threads grace hasn't answered, one she has.
        p0: pull({ mine: { nodes: [review('CHANGES_REQUESTED', 2, head)] }, reviewThreads: { nodes: [thread('ada'), thread('ada'), thread('grace')] } }),
        // Asked for again by grace, after a force push.
        p1: pull({ mine: { nodes: [review('CHANGES_REQUESTED', 2, head)] }, pushed: { nodes: [{ createdAt: at(3) }] }, reviewRequests: { nodes: [{ requestedReviewer: { login: 'ada' } }] }, asked: { nodes: [{ createdAt: at(4), actor: { login: 'grace' }, requestedReviewer: { login: 'ada' } }] }, reviewThreads: { nodes: [thread('ada')] } }),
        // Two commits pushed since.
        p2: pull({ mine: { nodes: [review('COMMENTED', 2, first)] } }),
        // Approved, and nothing since.
        p3: pull({ mine: { nodes: [review('APPROVED', 2, head)] } }),
      } } },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    const dir = path.join(cache, 'sessions', 'github.com', 'acme', 'app');
    fs.mkdirSync(dir, { recursive: true });
    const titles = ['Retry calls', 'Cache tokens', 'Log less', 'Drop the old client'];
    titles.forEach((title, i) => {
      // Paused one after another, the first last: the newest first, as GitHub is asked.
      const stopped = new Date(Date.now() - (i + 1) * 60_000).toISOString();
      fs.writeFileSync(path.join(dir, `pr-${i + 1}.json`), JSON.stringify({
        version: 1, target: `https://github.com/acme/app/pull/${i + 1}`, pr: `acme/app#${i + 1}`, dir: null, repoKey: 'github.com/acme/app', key: `pr-${i + 1}`, repo: cwd,
        title: `#${i + 1} feat: ${title}`, author: 'grace', url: `https://github.com/acme/app/pull/${i + 1}`, size: { add: 9, del: 2, files: 3 }, base: 'd'.repeat(40), head,
        progress: { done: 0, total: 20 }, notes: { open: 0, waiting: 0 }, chats: [], pid: gone, started: stopped, opened: stopped, updated: stopped,
        stopped: { at: stopped, why: 'paused' }, closed: null, checkouts: [], analyses: [],
      }));
    });
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
    assert.equal(started.code, 0, started.err);
    page = await launchBrowser(1440, 900);
    await page.goto(/http:\/\/\S+/.exec(started.out)![0]);
    await page.until(`document.querySelectorAll('.ev.gh').length === 6`, 30_000);
  });

  after(async () => {
    await page?.close();
    await stopRuns(cache);
    gh.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'when the reviews are listed, '
    + 'then each row says whose move it is on GitHub, amber once it’s back to ada, and her threads grace hasn’t answered.',
    async () => {
      assert.deepEqual(await page.eval(tags), [
        '#1 | back: 1 thread answered | 2 threads unanswered',
        '#2 | back: Review requested again | 1 thread unanswered',
        '#3 | back: Updated since your review',
        '#4 | ok: Approved',
      ]);
    },
  );

  it(
    'when a tag is hovered, '
    + 'then it says what happened, in the order it did.',
    async () => {
      assert.deepEqual(await page.eval(`[...document.querySelectorAll('.row .ev.gh:first-child')].map((e) => e.title)`), [
        'You requested changes on Jun 2.\nNothing pushed since.\nYour threads: 2 unanswered, 1 answered but open.',
        'You requested changes on Jun 2.\nForce-pushed on Jun 3.\ngrace asked for your review again on Jun 4.\nYour threads: 1 unanswered.',
        'You commented on Jun 2.\n2 commits pushed since.',
        'You approved on Jun 2.\nNothing pushed since.',
      ]);
    },
  );

  it(
    'when the page is as narrow as a phone, '
    + 'then a row’s tags take the lines they need, none cut.',
    async () => {
      await page.phone(390, 844);
      await page.until(`getComputedStyle(document.querySelector('.row .agent')).display === 'none'`);
      const cut = await page.eval(`[...document.querySelectorAll('.ev.gh')].filter((e) => { const l3 = e.parentElement.getBoundingClientRect(), b = e.getBoundingClientRect(); return b.right > l3.right + 0.5 || e.scrollWidth > e.clientWidth; }).map((e) => e.textContent)`);
      assert.deepEqual(cut, []);
      assert.equal(await page.eval(`getComputedStyle(document.querySelector('.row .l3')).flexWrap`), 'wrap');
    },
  );
});
