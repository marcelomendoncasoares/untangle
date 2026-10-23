import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { jsonScript, reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, untangleCommand, type UntangleRun } from '../helpers/run.ts';
import { slowGit, type SlowGit } from '../helpers/slow-git.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const later: Person = { ...ada, date: '2020-06-02T00:00:00Z' };
const newest: Person = { ...ada, date: '2020-06-03T00:00:00Z' };

function view(number: number, base: string, head: string) {
  return {
    number,
    title: 'Add a greeting',
    url: `https://github.com/acme/sample/pull/${number}`,
    state: 'OPEN',
    baseRefName: 'main',
    baseRefOid: base,
    headRefName: 'feature',
    headRefOid: head,
  };
}

/** The progress lines the page reported while the review was built. */
async function progressOf(client: ReviewClient): Promise<string[]> {
  const seen: string[] = [];
  const deadline = Date.now() + 180_000;
  await client.open();
  while (Date.now() < deadline) {
    const status = await client.call('status');
    const data = status.data as { phase?: string; steps?: Array<{ detail?: string }> };
    for (const step of data.steps ?? []) {
      if (step.detail && !seen.includes(step.detail)) seen.push(step.detail);
    }
    const page = await client.page();
    if (data.phase === 'ready' || (page.status === 200 && page.text.includes('id="d-model"'))) return seen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the review did not become ready\n${seen.join('\n')}`);
}

/**
 * A repository that stands in for github.com/acme/sample: a bare repo with main and the heads of
 * pull requests 7 and 8, and the git settings that send https://github.com/ there.
 */
function sampleOnGitHub(): { work: TempRepo; env: NodeJS.ProcessEnv; base: string; head: string; remove(): void } {
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-mirror-'));
  const bare = path.join(mirror, 'acme', 'sample.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const work = TempRepo.create();
  work.write('pubspec.yaml', pubspec);
  work.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  const base = work.commit({ subject: 'start', author: ada, committer: ada });
  work.branch('feature');
  work.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
  const head = work.commit({ subject: 'change', author: later, committer: later });
  work.remoteAdd('origin', bare);
  work.push('origin', 'main');
  execFileSync('git', ['-C', work.dir, 'push', 'origin', 'HEAD:refs/pull/7/head'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work.dir, 'push', 'origin', 'HEAD:refs/pull/8/head'], { stdio: 'ignore' });
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${mirror}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };
  return { work, env, base, head, remove: () => { work.remove(); fs.rmSync(mirror, { recursive: true, force: true }); } };
}

describe('Given a pull request URL whose repository untangle has not cloned yet, ', () => {
  let sample: ReturnType<typeof sampleOnGitHub> | undefined;
  let gh: GhStub | undefined;
  let git: SlowGit | undefined;
  let cache = '';

  before(() => {
    sample = sampleOnGitHub();
    gh = stubGh([{ match: ['pr', 'view'], stdout: view(7, sample.base, sample.head) }]);
    git = slowGit(['clone', 'fetch']);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    git?.remove();
    sample?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the pull request is reviewed, ', () => {
    let run: UntangleRun | undefined;
    let progress: string[] = [];
    let where = '';
    let cloned = '';

    before(async () => {
      run = await startUntangle('https://github.com/acme/sample/pull/7', { cacheDir: cache, gh, env: { ...sample!.env, PATH: `${git!.dir}${path.delimiter}${gh!.env.PATH}` }, quiet: false });
      const client = reviewClient(run.url);
      progress = await progressOf(client);
      where = (jsonScript(await waitForReview(client), 'd-config') as { where: string }).where;
      cloned = fs.existsSync(path.join(cache, 'repos', 'github.com', 'acme', 'sample.git')) ? 'cloned' : 'missing';
    });

    after(async () => {
      await run?.stop();
    });

    it('then the progress says it clones acme/sample, then fetches the pull request and main.', () => {
      assert.equal(progress.filter((line) => /clon|fetch/.test(line)).join('\n'), 'cloning acme/sample (blobs on demand)\nfetching #7\nfetching main');
    });

    it('then the repository is cloned into the cache.', () => {
      assert.equal(cloned, 'cloned');
    });

    it('then the review of that pull request is served.', () => {
      assert.equal(where, `acme/sample · main ${sample!.base.slice(0, 7)} → ${sample!.head.slice(0, 7)}`);
    });
  });
});

describe('Given a repository untangle cloned for one of its pull requests, ', () => {
  let sample: ReturnType<typeof sampleOnGitHub> | undefined;
  let gh: GhStub | undefined;
  let git: SlowGit | undefined;
  let cache = '';

  before(async () => {
    sample = sampleOnGitHub();
    gh = stubGh([{ match: ['pr', 'view'], stdout: view(7, sample.base, sample.head) }]);
    git = slowGit(['clone', 'fetch']);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const first = await startUntangle('https://github.com/acme/sample/pull/7', { cacheDir: cache, gh, env: sample.env });
    try {
      await waitForReview(reviewClient(first.url));
    } finally {
      await first.stop();
    }
  });

  after(() => {
    gh?.remove();
    git?.remove();
    sample?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when another of its pull requests is reviewed, ', () => {
    let run: UntangleRun | undefined;
    let progress: string[] = [];

    before(async () => {
      gh!.setReplies([{ match: ['pr', 'view'], stdout: view(8, sample!.base, sample!.head) }]);
      run = await startUntangle('https://github.com/acme/sample/pull/8', { cacheDir: cache, gh, env: { ...sample!.env, PATH: `${git!.dir}${path.delimiter}${gh!.env.PATH}` }, quiet: false });
      progress = await progressOf(reviewClient(run.url));
    });

    after(async () => {
      await run?.stop();
    });

    it('then it fetches that pull request and main, without cloning again.', () => {
      assert.equal(progress.filter((line) => /clon|fetch/.test(line)).join('\n'), 'fetching #8\nfetching main');
    });
  });
});

describe('Given a served review of a pull request, ', () => {
  let sample: ReturnType<typeof sampleOnGitHub> | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';

  before(async () => {
    sample = sampleOnGitHub();
    gh = stubGh([{ match: ['pr', 'view'], stdout: view(7, sample.base, sample.head) }]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle('https://github.com/acme/sample/pull/7', { cacheDir: cache, gh, env: sample.env });
    await waitForReview(reviewClient(run.url));
  });

  after(async () => {
    await run?.stop();
    gh?.remove();
    sample?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when a note is written and the agent prints the notes, ', () => {
    let header = '';

    before(async () => {
      const client = reviewClient(run!.url);
      await client.open();
      const added = await client.call('notes', { method: 'POST', head: sample!.head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
      assert.equal(added.status, 200);
      const r = await untangleCommand(['notes', '-review', 'https://github.com/acme/sample/pull/7'], { cacheDir: cache, gh: gh!, cwd: os.tmpdir(), env: sample!.env });
      header = r.out.split('\n')[0];
    });

    it('then they say where untangle checked the head out, to read its code there.', () => {
      const checkout = path.join(cache, 'worktrees', 'github.com', 'acme', 'sample', sample!.head.slice(0, 12));
      assert.equal(header, `My review notes on acme/sample#7 (branch feature, at ${sample!.head.slice(0, 7)}). Line numbers are on that commit. That commit is checked out at ${checkout}, for reading only, since untangle builds the review from it: propose any change in a reply.`);
    });
  });

  describe('when the pull request gains a commit, ', () => {
    let next = '';
    let offered = '';

    before(async () => {
      sample!.work.write('lib/a.dart', "void greet() {\n  print('hello');\n  print('again');\n}\n");
      next = sample!.work.commit({ subject: 'again', author: newest, committer: newest });
      execFileSync('git', ['-C', sample!.work.dir, 'push', '--force', 'origin', 'HEAD:refs/pull/7/head'], { stdio: 'ignore' });
      gh!.setReplies([{ match: ['pr', 'view'], stdout: view(7, sample!.base, next) }]);
      const client = reviewClient(run!.url);
      await client.open();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const answer = await client.call('refresh', { query: { check: '1' } });
        offered = (answer.data as { latest?: string }).latest ?? '';
        if (offered === next) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    });

    it('then the review offers that new head.', () => {
      assert.equal(offered, next);
    });
  });
});

describe('Given a merged pull request whose recorded base commit is not an ancestor of its head, ', () => {
  let work: TempRepo | undefined;
  let mirror = '';
  let cache = '';
  let gh: GhStub | undefined;
  let baseCommit = '';
  let fork = '';

  before(() => {
    mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-mirror-'));
    const bare = path.join(mirror, 'acme', 'sample.git');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true'], { stdio: 'ignore' });
    work = TempRepo.create();
    work.write('pubspec.yaml', pubspec);
    work.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    fork = work.commit({ subject: 'start', author: ada, committer: ada });
    work.branch('side');
    work.write('lib/a.dart', "void greet() {\n  print('base');\n}\n");
    baseCommit = work.commit({ subject: 'the recorded base', author: later, committer: later });
    work.checkout('main');
    work.branch('feature');
    work.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    const head = work.commit({ subject: 'change', author: newest, committer: newest });
    work.remoteAdd('origin', bare);
    work.push('origin', 'main');
    work.push('origin', 'side');
    execFileSync('git', ['-C', work.dir, 'push', 'origin', `HEAD:refs/pull/7/head`], { stdio: 'ignore' });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    gh = stubGh([{
      match: ['pr', 'view'],
      stdout: { ...view(7, baseCommit, head), state: 'MERGED' },
    }]);
  });

  after(() => {
    gh?.remove();
    work?.remove();
    if (mirror) fs.rmSync(mirror, { recursive: true, force: true });
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the pull request is reviewed, ', () => {
    let run: UntangleRun | undefined;
    let fetched = '';
    let notes = '';
    let base = '';

    before(async () => {
      run = await startUntangle('https://github.com/acme/sample/pull/7', {
        cacheDir: cache,
        gh,
        quiet: false,
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.file://${mirror}/.insteadOf`,
          GIT_CONFIG_VALUE_0: 'https://github.com/',
        },
      });
      const html = await waitForReview(reviewClient(run.url));
      base = (jsonScript(html, 'd-model') as { compares: { base: { left: string } } }).compares.base.left;
      const clone = path.join(cache, 'repos', 'github.com', 'acme', 'sample.git');
      try {
        execFileSync('git', ['-C', clone, 'cat-file', '-e', `${baseCommit}^{commit}`], { stdio: 'ignore' });
        fetched = 'in the clone';
      } catch {
        fetched = 'missing';
      }
      notes = run.output().split('\n').filter((line) => line.includes('#7 is merged')).map((line) => line.trim()).join('\n');
    });

    after(async () => {
      await run?.stop();
    });

    it('then the recorded base commit is fetched into the clone.', () => {
      assert.equal(fetched, 'in the clone');
    });

    it('then the progress says it compares with main as it was then.', () => {
      assert.equal(notes, '#7 is merged: comparing with main as it was then');
    });

    it('then the comparison starts where the two histories meet.', () => {
      assert.equal(base, fork.slice(0, 7));
    });
  });
});
