import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('Given two closed reviews that share a base, a paused one that moved past a head, and a checkout no review names, in the manager, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '', cwd = '';
  let page: Browser;
  const shas: string[] = [];
  const local = 'local/app-0123abcd';
  const checkout = (sha: string) => path.join(cache, 'worktrees', local, sha.slice(0, 12));
  const row = (key: string) => `.crow[data-id="${local}/${key}"]`;

  before(async () => {
    repo = TempRepo.create();
    for (let i = 0; i < 7; i++) {
      repo.write('a.txt', `${i}\n`);
      shas.push(repo.commit({ subject: `c${i}`, author: ada(`2020-06-0${i + 1}T00:00:00Z`), committer: ada(`2020-06-0${i + 1}T00:00:00Z`) }));
    }
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    const [c0, c1, c2, c3, c4, c5] = shas;
    const then = new Date(Date.now() - 3600_000);
    for (const sha of shas) {
      git(repo.dir, 'worktree', 'add', '--quiet', '--detach', checkout(sha), sha);
      fs.utimesSync(checkout(sha), then, then);
    }
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const write = (key: string, o: Record<string, unknown>) => {
      const dir = path.join(cache, 'sessions', local);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
        version: 1, target: repo.dir, pr: null, dir: repo.dir, repoKey: local, key, repo: repo.dir, title: `Review ${key}`, author: null, url: null,
        size: { add: 1, del: 1, files: 1 }, progress: { done: 1, total: 2 }, notes: { open: 1, waiting: 0 }, chats: [], pid: gone, analyses: [],
        started: ago(60), opened: ago(60), updated: ago(2), ...o,
      }));
    };
    write('a', { base: c0, head: c1, checkouts: [c0, c1], stopped: { at: ago(2), why: 'stop' }, closed: ago(2) });
    write('b', { base: c0, head: c2, checkouts: [c0, c2], stopped: { at: ago(1), why: 'stop' }, closed: ago(1) });
    write('c', { base: c3, head: c5, checkouts: [c3, c4, c5], stopped: { at: ago(1), why: 'paused' }, closed: null });
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
    assert.equal(started.code, 0, started.err);
    page = await launchBrowser(1440, 900);
    await page.reducedMotion(true);
    await page.goto(/http:\/\/\S+/.exec(started.out)![0]);
  });

  after(async () => {
    await page?.close();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'when Closed is chosen, '
    + 'then it lists the two with what only each holds, and under Shared their base and the old checkouts. The side’s space has no shortcut to it.',
    async () => {
      await page.until(`!!document.querySelector('.disk .legend')`);
      assert.equal(await page.eval(`document.querySelectorAll('.disk button').length`), 0);
      await page.click('[data-act="tab"][data-key="closed"]');
      await page.until(`document.querySelectorAll('.crow').length === 4`);
      assert.deepEqual(await page.eval(`[[...document.querySelectorAll('.crow:not(.fixed) .ttl')].map((e) => e.textContent), [...document.querySelectorAll('.crow:not(.fixed) .sz small')].map((e) => e.textContent), [...document.querySelectorAll('.crow.fixed')].map((e) => e.querySelector('.ttl').textContent + ': ' + e.querySelector('.l2').textContent), document.querySelector('.head .btn').textContent.replace(/·.*/, '')]`), [
        ['Review b', 'Review a'],
        ['1 checkout', '1 checkout'],
        ['Base checkout of b and a: It goes with the second of them to be freed.', 'Old checkouts: 2 checkouts no review keeps. Your notes and marks stay.'],
        'Free the space of 2 closed reviews ',
      ]);
    },
  );

  it(
    'when the window is narrow, '
    + 'then what the Shared rows say wraps onto more lines, rather than being cut, and a review’s folder name ends in an ellipsis inside its column.',
    async () => {
      await page.setViewport(800, 900);
      try {
        await page.until(`innerWidth === 800`);
        assert.deepEqual(await page.eval(`[...document.querySelectorAll('.crow:not(.fixed)')].map((r) => r.querySelector('.num').getBoundingClientRect().right <= r.querySelector('.main').getBoundingClientRect().right + 0.5)`), [true, true]);
        const shared = `[...document.querySelectorAll('.crow.fixed')]`;
        assert.deepEqual(await page.eval(`${shared}.map((r) => [...r.querySelectorAll('.ttl, .l2')].map((e) => (e.scrollWidth <= e.clientWidth ? 'whole' : 'cut')).join(' '))`), ['whole whole', 'whole whole']);
        assert.equal(await page.eval(`${shared}.at(-1).querySelector('.l2').getBoundingClientRect().height > 20`), true);
      } finally {
        await page.setViewport(1440, 900);
      }
    },
  );

  it(
    'when one is picked and its space freed, '
    + 'then only its notes and marks are left, and the base stays for the other.',
    async () => {
      await page.click(row('a'));
      await page.until(`document.querySelector('.head .btn').textContent.startsWith('Free the space of 1 · ')`);
      await page.click('[data-act="free-picked"]');
      await page.until(`document.querySelector(${JSON.stringify(row('a'))} + ' .sz small').textContent === 'notes and marks'`);
      assert.deepEqual([fs.existsSync(checkout(shas[1])), fs.existsSync(checkout(shas[0]))], [false, true]);
      assert.equal(await page.eval(`document.querySelectorAll('.cb.on').length`), 0);
    },
  );

  it(
    'when it’s picked again and forgotten, '
    + 'then Forget asks first, in place, and once it’s confirmed the review is gone.',
    async () => {
      await page.click(row('a'));
      await page.click('[data-act="forget-ask"]');
      await page.until(`!!document.querySelector('.confirm')`);
      assert.equal(await page.eval(`document.querySelector('.confirm span').textContent`), 'Forget 1 review? Their notes, marks and records go too, and that can’t be undone.');
      await page.click('[data-act="forget"]');
      await page.until(`!document.querySelector(${JSON.stringify(row('a'))}) && !document.querySelector('.confirm')`);
      assert.equal(fs.existsSync(path.join(cache, 'sessions', local, 'a.json')), false);
    },
  );

  it(
    'when the old checkouts are removed, '
    + 'then their line goes, and the paused review keeps its own.',
    async () => {
      await page.click('[data-act="free-old"]');
      await page.until(`![...document.querySelectorAll('.crow.fixed .ttl')].some((e) => e.textContent === 'Old checkouts')`);
      assert.deepEqual(shas.slice(3).map((sha) => fs.existsSync(checkout(sha))), [true, false, true, false]);
    },
  );
});
