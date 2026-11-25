// untangle -build: a review opened with nothing to review yet, to build the change from its notes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { jsonScript, reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const nothing = 'HEAD adds nothing to main: there is nothing to review (-build opens it anyway, to build the change from its notes)';

interface Config { build?: boolean; base: string; head: string }
interface Model { compares: { base: { files: Array<{ p: string }> } } }

/** What the page shows: whether it builds, what it compares, and its files. */
function shown(html: string): string {
  const config = jsonScript(html, 'd-config') as Config;
  const model = jsonScript(html, 'd-model') as Model;
  return `build ${config.build === true}\n${config.base.slice(0, 7)} → ${config.head.slice(0, 7)}\nfiles ${model.compares.base.files.map((f) => f.p).join(', ') || 'none'}`;
}

/** Asks the review to look for new commits, and waits until it's done: the state it ended in. */
async function refreshed(client: ReviewClient): Promise<string> {
  let state = ((await client.call('refresh', { method: 'POST' })).data as { state?: string }).state ?? '';
  const deadline = Date.now() + 120_000;
  while ((state === 'checking' || state === 'building') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = ((await client.call('refresh')).data as { state?: string }).state ?? '';
  }
  return state;
}

/** A package on main, and a feature branch that adds nothing to it yet. */
function unbuiltBranch(): { repo: TempRepo; start: string } {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  const start = repo.commit({ subject: 'Start the package', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
  repo.branch('feature');
  return { repo, start };
}

describe('Given a branch that adds nothing to main yet, ', { skip: skipDart, timeout: 300_000 }, () => {
  let repo: TempRepo;
  let start = '';
  let gh: GhStub;
  let cache = '';
  let run: UntangleRun | undefined;
  let client: ReviewClient;

  before(() => {
    ({ repo, start } = unbuiltBranch());
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(async () => {
    await run?.stop();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when untangle opens it, '
    + 'then it stops there: there is nothing to review, and -build opens it anyway.',
    async () => {
      const r = await untangleCommand(['-no-open', '-port', '0', '-no-color', '.'], { cacheDir: cache, gh, cwd: repo.dir });
      assert.deepEqual([r.code, `${r.out}${r.err}`.includes(nothing)], [1, true]);
    },
  );

  describe('when untangle opens it with -build, ', () => {
    let page = '';
    let hello: { build?: boolean } = {};

    before(async () => {
      run = await startUntangle(repo.dir, { cacheDir: cache, gh, args: ['-build'] });
      client = reviewClient(run.url);
      page = await waitForReview(client);
      hello = (await client.call('notes/hello')).data as { build?: boolean };
    });

    it('then the review opens with nothing in it, and its page and agents hear it builds.', () => {
      assert.equal(`${shown(page)}\nhello build ${hello.build === true}`, `build true\n${start.slice(0, 7)} → ${start.slice(0, 7)}\nfiles none\nhello build true`);
    });

    describe('and a commit lands on the branch and the review is refreshed, ', () => {
      let state = '';
      let head = '';

      before(async () => {
        repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
        head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
        state = await refreshed(client);
        page = (await client.page()).text;
      });

      it('then it reviews the commit, from where the build started.', () => {
        assert.equal(`${state}\n${shown(page)}`, `ready\nbuild true\n${start.slice(0, 7)} → ${head.slice(0, 7)}\nfiles lib/a.dart`);
      });
    });
  });
});

describe('Given main itself, with nothing on it that its origin lacks, opened with -build, ', { skip: skipDart, timeout: 300_000 }, () => {
  let repo: TempRepo;
  let origin: TempRepo;
  let start = '';
  let head = '';
  let gh: GhStub;
  let cache = '';
  let run: UntangleRun | undefined;
  let client: ReviewClient;
  let page = '';

  before(async () => {
    origin = TempRepo.bare();
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    start = repo.commit({ subject: 'Start the package', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.remoteAdd('origin', origin.dir);
    repo.push('origin', 'main');
    execFileSync('git', ['-C', repo.dir, 'fetch', '-q', 'origin']);
    execFileSync('git', ['-C', repo.dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, args: ['-build'] });
    client = reviewClient(run.url);
    page = await waitForReview(client);
  });

  after(async () => {
    await run?.stop();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    origin.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it('then the review opens with nothing in it.', () => {
    assert.equal(shown(page), `build true\n${start.slice(0, 7)} → ${start.slice(0, 7)}\nfiles none`);
  });

  describe('when a commit is pushed to main and the review is refreshed, ', () => {
    let state = '';

    before(async () => {
      repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
      head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
      repo.push('origin', 'main');
      state = await refreshed(client);
      page = (await client.page()).text;
    });

    it('then it still compares with where the build started, as main holds the commit now.', () => {
      assert.equal(`${state}\n${shown(page)}`, `ready\nbuild true\n${start.slice(0, 7)} → ${head.slice(0, 7)}\nfiles lib/a.dart`);
    });
  });

  describe('when it stops and untangle opens it again, without -build, ', () => {
    before(async () => {
      await run!.stop();
      run = await startUntangle(repo.dir, { cacheDir: cache, gh });
      client = reviewClient(run.url);
      page = await waitForReview(client);
    });

    it('then it’s still the build, from where it started.', () => {
      assert.equal(shown(page), `build true\n${start.slice(0, 7)} → ${head.slice(0, 7)}\nfiles lib/a.dart`);
    });
  });

  describe('when it’s closed and untangle opens it again, without -build, ', () => {
    let r: { code: number | null; out: string; err: string };

    before(async () => {
      await client.call('stop', { method: 'POST', body: { close: true } });
      await run!.exited;
      run = undefined;
      r = await untangleCommand(['-no-open', '-port', '0', '-no-color', '.'], { cacheDir: cache, gh, cwd: repo.dir });
    });

    it('then the build is over: there is nothing to review.', () => {
      assert.deepEqual([r.code, `${r.out}${r.err}`.includes(nothing)], [1, true]);
    });
  });
});

describe('Given an agent in a branch that adds nothing to main yet, ', { skip: skipDart, timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '';

  before(() => {
    ({ repo } = unbuiltBranch());
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(async () => {
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when an agent’s watch starts its review with -build, and nothing comes, ', () => {
    let r: { code: number | null; out: string; err: string };

    before(async () => {
      r = await untangleCommand(['watch', '-build', '-timeout', '2s'], { cacheDir: cache, gh, cwd: repo.dir });
    });

    it('then the review opens, and the watch tells the agent it builds the change the notes ask for.', () => {
      const lines = r.out.split('\n').filter((l) => /starting the review|is open|builds a change/.test(l));
      assert.deepEqual([r.code, lines], [0, [
        'untangle: starting the review of this directory…',
        'untangle: feature against main is open in the browser.',
        'untangle: the review builds a change: notes on the review say what to build. Build it on the reviewed branch and commit each step, so the review shows it.',
      ]]);
    });
  });
});
