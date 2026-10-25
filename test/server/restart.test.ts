import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, stopRuns, untangleCommand } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 120_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

interface Check { pid: number; head: string | null; updated: boolean }
interface NotesView { notes: Array<{ n: number; comments: Array<{ body: string }> }>; agents: Array<{ name: string; state: string }> }

describe('Given a review an agent watches, and a newer untangle installed since it started, ', { timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let stamp = '';
  let client: ReviewClient;
  let head = '';
  let url = '';
  let before0: Check;
  let updated: Check;
  let watching: Promise<{ code: number | null; out: string; err: string }>;
  // The page's browser, as the review opens it: the link goes to a file. The stamp stands for
  // untangle's build on disk.
  const env = (): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(cache, 'browser.sh'), UNTANGLE_BUILT_FROM: stamp });
  const check = async () => (await client.call('refresh', { query: { check: '1' } })).data as Check;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    stamp = path.join(cache, 'built.stamp');
    fs.writeFileSync(stamp, '');
    fs.utimesSync(stamp, new Date(2020, 0, 1), new Date(2020, 0, 1));
    fs.writeFileSync(path.join(cache, 'browser.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    watching = untangleCommand(['watch', '-agent', 'Codex', '-no-open', '-port', '0', '-base', 'main'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
    const run = await until('the review the watch starts', () => runsIn(cache)[0]);
    url = run.url;
    client = reviewClient(url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    await until('the agent to watch', async () => ((await client.call('notes')).data as NotesView).agents.some((a) => a.state === 'listening'));
    before0 = await check();
    // untangle is built again on disk.
    const now = new Date(Date.now() + 5000);
    fs.utimesSync(stamp, now, now);
    updated = await check();
  });

  after(async () => {
    if (cache) await stopRuns(cache);
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('then the review says a newer untangle is installed than the one serving it.', () => {
    assert.deepEqual([before0.updated, updated.updated, updated.pid === before0.pid], [false, true, true]);
  });

  describe('when it’s restarted, ', () => {
    let answer: { status: number; data: unknown };
    let after0: Check;
    let runs: Array<{ pid: number; url: string }> = [];
    let watched: { code: number | null; out: string; err: string };

    before(async () => {
      answer = await client.call('restart', { method: 'POST' });
      after0 = await until('the untangle that takes the review over', async () => {
        try {
          const c = await check();
          return c.pid !== before0.pid && c.head ? c : null;
        } catch {
          return null;
        }
      });
      runs = runsIn(cache);
      await until('the agent to watch again', async () => ((await client.call('notes')).data as NotesView).agents.some((a) => a.state === 'listening'));
      const added = await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
      assert.equal(added.status, 200, added.text);
      watched = await watching;
    });

    it('then another untangle serves it at the same address, with the same token, and it’s up to date.', () => {
      assert.deepEqual([answer.status, answer.data], [200, { restarting: true, pid: before0.pid }]);
      assert.deepEqual([runs.length, runs[0]?.url === url, after0.updated, after0.head === head], [1, true, false, true]);
    });

    it('then the agent’s watch waits for it, and prints the note written there.', () => {
      assert.equal(watched.code, 0, watched.err);
      assert.ok(watched.out.includes('Why hello?'), watched.out);
      assert.ok(!/closed|nothing more to watch/.test(watched.out), watched.out);
    });
  });
});
