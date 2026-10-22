import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

interface Row { id: string; status: string; disk: number | null; freed: string | null; parts: { checkouts: number; analyses: number; shared: number } | null }
interface Disk { open: number; closed: number; old: number; shared: number; measuring: boolean; shares: Array<{ what: string; by: string[]; names: string[] }>; leftover: { checkouts: number; analyses: number; moved: number; past: string[] }; clones: Array<{ repo: string }> }

describe('Given reviews in the cache: two closed that share a base, one paused that moved past a head, a checkout and an analysis no review names, and a cloned repository’s, ', { timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '', cwd = '';
  let manager: ReviewClient;
  const shas: string[] = [];
  const local = 'local/app-0123abcd', clone = () => path.join(cache, 'repos', 'github.com', 'acme', 'app.git');
  const checkout = (key: string, sha: string) => path.join(cache, 'worktrees', key, sha.slice(0, 12));
  const analysis = (key: string, base: string, head: string) => path.join(cache, 'reviews', key, `${base.slice(0, 12)}-${head.slice(0, 12)}`);
  const id = (key: string) => `${local}/${key}`;
  const view = async () => (await manager.call('reviews')).data as { reviews: Row[]; disk: Disk };
  const record = (key: string) => JSON.parse(fs.readFileSync(path.join(cache, 'sessions', local, `${key}.json`), 'utf8'));

  before(async () => {
    repo = TempRepo.create();
    for (let i = 0; i < 7; i++) {
      repo.write('a.txt', `${i}\n`);
      shas.push(repo.commit({ subject: `c${i}`, author: ada(`2020-06-0${i + 1}T00:00:00Z`), committer: ada(`2020-06-0${i + 1}T00:00:00Z`) }));
    }
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    const [c0, c1, c2, c3, c4, c5, c6] = shas;
    // Checkouts, as reviews make them, and one no review names (c6).
    for (const sha of shas) git(repo.dir, 'worktree', 'add', '--quiet', '--detach', checkout(local, sha), sha);
    git(cwd, 'clone', '--quiet', '--bare', repo.dir, clone());
    git(clone(), 'worktree', 'add', '--quiet', '--detach', checkout('github.com/acme/app', c1), c1);
    const pairs: Array<[string, string, string]> = [[local, c0, c1], [local, c0, c2], [local, c3, c4], [local, c3, c5], [local, c0, c6], [local, c5, c6]];
    for (const [key, b, h] of pairs) {
      fs.mkdirSync(analysis(key, b, h), { recursive: true });
      fs.writeFileSync(path.join(analysis(key, b, h), 'model.json'), 'x'.repeat(64 * 1024));
    }
    // Marks on parts of a change: the review's, and one from before records.
    for (const [b, h] of [[c0, c1], [c5, c6]]) fs.writeFileSync(path.join(analysis(local, b, h), 'state.json'), '{"partial":[3]}');
    // Made a while ago: none is a review's checkout or analysis in the making.
    const then = new Date(Date.now() - 3600_000);
    for (const sha of shas) fs.utimesSync(checkout(local, sha), then, then);
    for (const [key, b, h] of pairs) fs.utimesSync(analysis(key, b, h), then, then);
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    const now = new Date().toISOString(), weeks = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const write = (repoKey: string, key: string, o: Record<string, unknown>) => {
      const dir = path.join(cache, 'sessions', repoKey);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
        version: 1, target: repo.dir, pr: null, dir: repo.dir, repoKey, key, repo: repo.dir, title: `Review ${key}`, author: null, url: null,
        size: { add: 1, del: 1, files: 1 }, progress: { done: 1, total: 2 }, notes: { open: 1, waiting: 0 }, chats: [], pid: gone,
        started: now, opened: now, updated: now, stopped: { at: now, why: 'stop' }, closed: now, ...o,
      }));
    };
    write(local, 'a', { base: c0, head: c1, checkouts: [c0, c1], analyses: [[c0, c1]] });
    write(local, 'b', { base: c0, head: c2, checkouts: [c0, c2], analyses: [[c0, c2]] });
    write(local, 'c', { base: c3, head: c5, checkouts: [c3, c4, c5], analyses: [[c3, c4], [c3, c5]], stopped: { at: now, why: 'paused' }, closed: null });
    write(local, 'e', { base: c0, head: c6, checkouts: [], analyses: [[c0, c6]], closed: weeks, stopped: { at: weeks, why: 'stop' } });
    write('github.com/acme/app', 'pr-12', { target: 'https://github.com/acme/app/pull/12', pr: 'acme/app#12', dir: null, repo: clone(), base: c0, head: c1, checkouts: [c1], analyses: [] });
    // Review a's notes, the ref that holds its marks, and the branch an older untangle kept them on.
    fs.mkdirSync(path.join(cache, 'notes', local), { recursive: true });
    fs.writeFileSync(path.join(cache, 'notes', local, 'a.json'), '{"notes":[]}');
    git(repo.dir, 'update-ref', 'refs/untangle/marks/a', c1);
    git(repo.dir, 'branch', 'untangle/a', c0);
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
  });

  after(async () => {
    fs.rmSync(path.join(cache, 'run', `${process.pid}.json`), { force: true });
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'when the page opens, '
    + 'then the checkouts made as worktrees of the repository become their own, and it lists none; the clone keeps its worktree.',
    async () => {
      await until('the repository to list no checkout', () => git(repo.dir, 'worktree', 'list').split('\n').length === 1);
      assert.ok(shas.every((sha) => fs.statSync(path.join(checkout(local, sha), '.git')).isDirectory()));
      assert.ok(git(clone(), 'worktree', 'list').includes(checkout('github.com/acme/app', shas[1])));
    },
  );

  it(
    'when the page opens, '
    + 'then the review closed three weeks ago is freed on its own, and the others list what only they hold, the base two share, and the old checkouts.',
    async () => {
      const v = await until('the space measured', async () => { const x = await view(); return x.reviews.every((r) => r.disk != null) && !x.disk.measuring && x.reviews.find((r) => r.id === id('e'))?.freed ? x : null; });
      const by = (k: string) => v.reviews.find((r) => r.id === id(k))!;
      assert.ok(!fs.existsSync(analysis(local, shas[0], shas[6])));
      assert.deepEqual([by('a').parts, by('b').parts, by('c').status, by('e').parts], [{ checkouts: 1, analyses: 1, shared: 1 }, { checkouts: 1, analyses: 1, shared: 1 }, 'paused', null]);
      assert.deepEqual(v.disk.shares.map((x) => [x.what, x.by, x.names]), [['base', [id('a'), id('b')], ['a', 'b']]]);
      assert.deepEqual([v.disk.leftover.checkouts, v.disk.leftover.analyses, v.disk.leftover.moved, v.disk.leftover.past], [2, 1, 1, ['c']]);
      assert.deepEqual(v.disk.clones.map((c) => c.repo), ['acme/app']);
      assert.ok(v.disk.open > 0 && v.disk.closed > 0 && v.disk.old > 0 && v.disk.shared > 0);
    },
  );

  it(
    'when one of the two is freed, '
    + 'then its head and its analysis go, but for the marks on parts of a change; the base stays for the other, and its record says so; its notes and its marks stay.',
    async () => {
      const r = await manager.call('free', { method: 'POST', body: { ids: [id('a')] } });
      assert.deepEqual([r.status, r.data], [200, { freed: 1 }]);
      assert.deepEqual([fs.existsSync(checkout(local, shas[1])), fs.readdirSync(analysis(local, shas[0], shas[1])), fs.existsSync(checkout(local, shas[0]))], [false, ['state.json'], true]);
      assert.ok(!git(repo.dir, 'worktree', 'list').includes(shas[1].slice(0, 12)));
      const a = record('a');
      assert.deepEqual([a.checkouts, a.analyses, typeof a.freed], [[], [[shas[0], shas[1]]], 'string']);
      assert.ok(fs.existsSync(path.join(cache, 'notes', local, 'a.json')));
      assert.equal(git(repo.dir, 'rev-parse', 'untangle/marks/a'), shas[1]);
    },
  );

  it(
    'when the other is freed too, '
    + 'then the base they shared goes with it.',
    async () => {
      assert.equal((await manager.call('free', { method: 'POST', body: { ids: [id('b')] } })).status, 200);
      assert.deepEqual([fs.existsSync(checkout(local, shas[0])), fs.existsSync(checkout(local, shas[2]))], [false, false]);
    },
  );

  it(
    'when the old checkouts are removed, '
    + 'then the head the paused review moved past goes, and the checkout and the analysis no review names, but for its marks; the paused one keeps its own.',
    async () => {
      const r = await manager.call('free-old', { method: 'POST', body: {} });
      assert.deepEqual(r.data, { removed: 3, checkouts: 2 });
      assert.deepEqual(shas.slice(3).map((sha) => fs.existsSync(checkout(local, sha))), [true, false, true, false]);
      assert.deepEqual(fs.readdirSync(analysis(local, shas[5], shas[6])), ['state.json']);
      // Only marks are left of it: it isn't old any more.
      assert.equal((await view()).disk.leftover.analyses, 0);
    },
  );

  it(
    'when a freed review is forgotten, '
    + 'then its notes, its marks (their ref, and the branch an older untangle kept them on), the marks on parts of a change and its record go.',
    async () => {
      const r = await manager.call('forget', { method: 'POST', body: { ids: [id('a')] } });
      assert.deepEqual(r.data, { forgot: 1 });
      assert.deepEqual([fs.existsSync(path.join(cache, 'notes', local, 'a.json')), fs.existsSync(path.join(cache, 'sessions', local, 'a.json')), fs.existsSync(analysis(local, shas[0], shas[1]))], [false, false, false]);
      assert.deepEqual([git(repo.dir, 'for-each-ref', 'refs/untangle/'), git(repo.dir, 'branch', '--list', 'untangle/a')], ['', '']);
    },
  );

  it(
    'when the only review of a cloned repository is forgotten, '
    + 'then the clone goes too, with its checkouts.',
    async () => {
      assert.equal((await manager.call('forget', { method: 'POST', body: { ids: ['github.com/acme/app/pr-12'] } })).status, 200);
      assert.deepEqual([fs.existsSync(clone()), fs.existsSync(checkout('github.com/acme/app', shas[1]))], [false, false]);
    },
  );

  it(
    'while a review is being built, '
    + 'then freeing waits: it may be taking a checkout no record names yet.',
    async () => {
      fs.mkdirSync(path.join(cache, 'run'), { recursive: true });
      fs.writeFileSync(path.join(cache, 'run', `${process.pid}.json`), JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:9/x/', token: 't', dir: repo.dir, pr: null, started: new Date().toISOString() }));
      const r = await manager.call('free', { method: 'POST', body: { ids: [id('b')] } });
      assert.deepEqual([r.status, r.data], [409, { error: 'a review is being built: free the space once it’s ready' }]);
      fs.rmSync(path.join(cache, 'run', `${process.pid}.json`));
    },
  );
});
