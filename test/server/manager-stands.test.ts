import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

interface Row { id: string; status: string; stand: { author: string; review: { state: string } | null; threads: { open: number } } | null }
const head = 'c'.repeat(40);
// What GitHub says of the pull request ada reviewed: changes requested on its head, a thread grace hasn't answered.
const reviewed = {
  state: 'OPEN', headRefOid: head, viewerDidAuthor: false, author: { login: 'grace' },
  reviewRequests: { nodes: [] }, talk: { nodes: [] }, asked: { nodes: [] }, pushed: { nodes: [] },
  commits: { nodes: [{ commit: { oid: head, committedDate: '2020-06-01T12:00:00Z', author: { user: { login: 'grace' } } } }] },
  mine: { nodes: [{ state: 'CHANGES_REQUESTED', submittedAt: '2020-06-02T12:00:00Z', body: 'A few things.', commit: { oid: head }, comments: { nodes: [{ replyTo: null }] } }] },
  reviewThreads: { nodes: [{ isResolved: false, isOutdated: false, first: { nodes: [{ author: { login: 'ada' }, state: 'SUBMITTED' }] }, last: { nodes: [{ author: { login: 'ada' }, createdAt: '2020-06-02T12:00:00Z' }] } }] },
};

describe('Given reviews of two pull requests, one paused and one closed, and a branch’s, in the manager, ', { timeout: 120_000 }, () => {
  let gh: GhStub;
  let cache = '', cwd = '';
  let manager: ReviewClient;
  const view = async () => (await manager.call('reviews')).data as { reviews: Row[] };
  const asked = () => gh.calls().filter((c) => c.stdin.includes('fragment Stand')).map((c) => (JSON.parse(c.stdin) as { variables: Record<string, unknown> }).variables);

  before(async () => {
    gh = stubGh([
      { match: ['api', 'graphql'], stdinIncludes: 'viewer { login }', stdout: { data: { viewer: { login: 'ada' } } } },
      { match: ['api', 'graphql'], stdinIncludes: 'fragment Stand', stdout: { data: { p0: { pullRequest: reviewed } } } },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    const now = new Date().toISOString();
    const write = (repoKey: string, key: string, o: Record<string, unknown>) => {
      const dir = path.join(cache, 'sessions', repoKey);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
        version: 1, target: cwd, pr: null, dir: cwd, repoKey, key, repo: cwd, title: `Review ${key}`, author: null, url: null,
        size: { add: 1, del: 1, files: 1 }, base: 'a'.repeat(40), head, progress: { done: 0, total: 2 }, notes: { open: 0, waiting: 0 }, chats: [], pid: gone,
        started: now, opened: now, updated: now, stopped: { at: now, why: 'paused' }, closed: null, checkouts: [], analyses: [], ...o,
      }));
    };
    const pull = (n: number) => ({ target: `https://github.com/acme/app/pull/${n}`, pr: `acme/app#${n}`, dir: null, url: `https://github.com/acme/app/pull/${n}`, author: 'grace' });
    write('github.com/acme/app', 'pr-7', pull(7));
    write('github.com/acme/app', 'pr-8', { ...pull(8), closed: now });
    write('local/app-0123abcd', 'wip', {});
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: {} });
    assert.equal(started.code, 0, started.err);
    manager = reviewClient(/http:\/\/\S+/.exec(started.out)![0]);
    await manager.open();
  });

  after(async () => {
    await stopRuns(cache);
    gh.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'when the page asks for the reviews, '
    + 'then GitHub is asked, in one call, where ada’s review of the open pull request stands, and its row says it; the others say nothing.',
    async () => {
      const v = await until('the stand', async () => { const x = await view(); return x.reviews.some((r) => r.stand) ? x : null; });
      assert.deepEqual(v.reviews.map((r) => [r.id, r.status, r.stand && `${r.stand.review?.state} · waiting on ${r.stand.author} · ${r.stand.threads.open} open`]).sort(), [
        ['github.com/acme/app/pr-7', 'paused', 'CHANGES_REQUESTED · waiting on grace · 1 open'],
        ['github.com/acme/app/pr-8', 'closed', null],
        ['local/app-0123abcd/wip', 'paused', null],
      ]);
      assert.deepEqual(asked(), [{ me: 'ada', o0: 'acme', r0: 'app', n0: 7 }]);
    },
  );

  it(
    'when the page asks again, and again as it’s shown again, within the minute, '
    + 'then GitHub isn’t asked again.',
    async () => {
      await view();
      await manager.call('reviews', { query: { shown: '1' } });
      await sleep(500);
      assert.equal(asked().length, 1);
    },
  );
});
