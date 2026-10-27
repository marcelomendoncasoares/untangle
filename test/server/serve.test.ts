import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { reviewClient, waitForReview, jsonScript, type ReviewClient } from '../helpers/http.ts';
import { pullRequestGh } from '../helpers/pull-request.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

interface Model {
  compares: { base: { files: Array<{ blocks: Array<{ edits: number[] }> }> } };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dartRepo(): { repo: TempRepo; head: string } {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
  repo.branch('feature');
  repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
  const head = repo.commit({ subject: 'change', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  return { repo, head };
}

describe('Given a served review and an editor command, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let client: ReviewClient | undefined;
  let cache = '';
  let dir = '';
  let log = '';

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-editor-'));
    log = path.join(dir, 'opened.txt');
    const stub = path.join(dir, 'edit');
    // Written whole, then renamed: the test waits for the file to exist, so it must never see it half-written.
    fs.writeFileSync(stub, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(log + '.part')}, process.argv.slice(2).join('\\n'));\nfs.renameSync(${JSON.stringify(log + '.part')}, ${JSON.stringify(log)});\n`, { mode: 0o755 });
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, args: ['-editor', `${stub} {file} {line} {col}`], env: { ORCA_CLI_COMMAND: 'must-not-run' } });
    client = reviewClient(run.url);
    await waitForReview(client);
  });

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('when line 2, column 3 of lib/a.dart is opened in the editor, ', () => {
    let opened = '';
    let head = '';

    before(async () => {
      await client!.call('open', { method: 'POST', body: { side: 'head', p: 'lib/a.dart', l: 2, c: 3 } });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !fs.existsSync(log)) await new Promise((resolve) => setTimeout(resolve, 50));
      opened = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'the editor did not run';
      head = ((await client!.call('roots')).data as { head: string }).head;
    });

    it('then the editor is run with the file in the head checkout, the line, and the column counted from 1.', () => {
      assert.equal(opened, `${path.join(head, 'lib', 'a.dart')}\n2\n4`);
    });
  });
});

describe('Given a review untangle built once, into its cache, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let head = '';
  let base = '';

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    head = built.head;
    base = repo.rev('main');
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const first = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    try {
      await waitForReview(reviewClient(first.url));
    } finally {
      await first.stop();
    }
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when untangle opens it again, ', () => {
    let run: UntangleRun | undefined;
    let roots = '';
    let onDisk = '';
    let text = '';
    let listed: string[] = [];

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh });
      const client = reviewClient(run.url);
      await waitForReview(client);
      const dirs = (await client.call('roots')).data as { head: string; base: string };
      roots = `${dirs.head}\n${dirs.base}`;
      onDisk = `${fs.existsSync(dirs.head)} ${fs.existsSync(dirs.base)}`;
      text = ((await client.call('file', { query: { side: 'head', p: 'lib/a.dart' } })).data as { text: string }).text;
      listed = execFileSync('git', ['-C', repo!.dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fs.realpathSync(l.slice(9)));
    });

    after(async () => {
      await run?.stop();
    });

    it('then its checkouts are of its head and its base, in the cache.', () => {
      const worktree = (sha: string) => `${escaped(path.join(cache, 'worktrees', 'local', path.basename(repo!.dir)))}-[0-9a-f]{8}${escaped(path.sep)}${sha.slice(0, 12)}`;
      assert.match(roots, new RegExp(`^${worktree(head)}\\n${worktree(base)}$`));
    });

    it('then both checkouts are on disk.', () => {
      assert.equal(onDisk, 'true true');
    });

    it('then the repository lists neither among its worktrees.', () => {
      assert.deepEqual(listed, [fs.realpathSync(repo!.dir)]);
    });

    it('then a whole file opens from the head.', () => {
      assert.equal(text, "void greet() {\n  print('hello');\n}\n");
    });
  });

  describe('when the same commits open from another branch, against the base given as a commit, ', () => {
    let run: UntangleRun | undefined;
    let names = '';

    before(async () => {
      repo!.branch('renamed');
      run = await startUntangle(repo!.dir, { base, cacheDir: cache, gh, quiet: false });
      const model = jsonScript(await waitForReview(reviewClient(run.url)), 'd-model') as { compares: { base: { title: string; label: string } } };
      const cached = run.output().includes('using the analysis cached') ? 'from the cache' : 'built again';
      names = `${cached}\n${model.compares.base.title}\n${model.compares.base.label}`;
    });

    after(async () => {
      await run?.stop();
    });

    it('then the page names the review as this run does, though its analysis comes from the cache.', () => {
      assert.equal(names, `from the cache\nrenamed against ${base}\n${base.slice(0, 7)}`);
    });
  });
});

describe('Given reviewed marks, and untangle stopped, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let marked = '';

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const first = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    try {
      const client = reviewClient(first.url);
      const model = jsonScript(await waitForReview(client), 'd-model') as Model;
      const edits = model.compares.base.files.flatMap((file) => file.blocks.flatMap((block) => block.edits));
      await client.call('state', { method: 'PUT', body: { rev: { base: edits } } });
      marked = edits.join(' ');
    } finally {
      await first.stop();
    }
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when untangle opens the review again, with nothing changed, ', () => {
    let run: UntangleRun | undefined;
    let reviewed = '';
    let note = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh });
      const config = jsonScript(await waitForReview(reviewClient(run.url)), 'd-config') as { state: { rev: { base: number[] } }; snapshot: { note: string | null } };
      reviewed = config.state.rev.base.join(' ');
      note = config.snapshot.note ?? 'no note';
    });

    after(async () => {
      await run?.stop();
    });

    it('then the same changes are reviewed.', () => {
      assert.equal(reviewed, marked);
    });

    it('then nothing had to be replayed.', () => {
      assert.equal(note, 'no note');
    });
  });
});

describe('Given reviewed marks an older untangle kept on the branch untangle/feature, and untangle stopped, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let marked = '';
  const git = (...args: string[]) => execFileSync('git', ['-C', repo!.dir, ...args], { encoding: 'utf8' }).trim();

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const first = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    try {
      const client = reviewClient(first.url);
      const model = jsonScript(await waitForReview(client), 'd-model') as Model;
      const edits = model.compares.base.files.flatMap((file) => file.blocks.flatMap((block) => block.edits));
      await client.call('state', { method: 'PUT', body: { rev: { base: edits } } });
      marked = edits.join(' ');
    } finally {
      await first.stop();
    }
    git('update-ref', 'refs/heads/untangle/feature', git('rev-parse', 'refs/untangle/marks/feature'));
    git('update-ref', '-d', 'refs/untangle/marks/feature');
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when untangle opens the review again, ', () => {
    let run: UntangleRun | undefined;
    let reviewed = '';
    let kept = '';
    let branches = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh });
      const config = jsonScript(await waitForReview(reviewClient(run.url)), 'd-config') as { state: { rev: { base: number[] } }; snapshot: { ref: string } };
      reviewed = config.state.rev.base.join(' ');
      kept = config.snapshot.ref;
      branches = git('branch', '--format=%(refname:short)');
    });

    after(async () => {
      await run?.stop();
    });

    it('then the same changes are reviewed, their marks kept in git as untangle/marks/feature.', () => {
      assert.deepEqual([reviewed, kept], [marked, 'untangle/marks/feature']);
    });

    it('then the branch is gone: the repository’s branches are its own.', () => {
      assert.equal(branches, 'feature\nmain');
    });
  });
});

describe('Given reviewed marks whose base then gains a commit, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let base = '';

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const first = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    try {
      const client = reviewClient(first.url);
      const model = jsonScript(await waitForReview(client), 'd-model') as Model;
      const edits = model.compares.base.files.flatMap((file) => file.blocks.flatMap((block) => block.edits));
      await client.call('state', { method: 'PUT', body: { rev: { base: edits } } });
    } finally {
      await first.stop();
    }
    repo.checkout('main');
    repo.write('lib/note.dart', 'void note() {}\n');
    base = repo.commit({ subject: 'note', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
    repo.checkout('feature');
    repo.merge({ ref: 'main', subject: 'merge main', author: ada('2020-06-04T00:00:00Z'), committer: ada('2020-06-04T00:00:00Z') });
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when untangle opens the review again, ', () => {
    let run: UntangleRun | undefined;
    let note = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh });
      const config = jsonScript(await waitForReview(reviewClient(run.url)), 'd-config') as { snapshot: { note: string | null } };
      note = config.snapshot.note ?? 'no note';
    });

    after(async () => {
      await run?.stop();
    });

    it('then the marks panel says the review was replayed onto the new base.', () => {
      assert.equal(note, `replayed onto ${base.slice(0, 7)}`);
    });
  });
});

describe('Given reviewed marks on a file the new base deletes, and the branch rebased to add it back, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let base = '';

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const first = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    try {
      const client = reviewClient(first.url);
      const model = jsonScript(await waitForReview(client), 'd-model') as Model;
      const edits = model.compares.base.files.flatMap((file) => file.blocks.flatMap((block) => block.edits));
      await client.call('state', { method: 'PUT', body: { rev: { base: edits } } });
    } finally {
      await first.stop();
    }
    repo.checkout('main');
    repo.delete('lib/a.dart');
    base = repo.commit({ subject: 'delete the file', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
    repo.resetBranch('feature', base);
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'change', author: ada('2020-06-04T00:00:00Z'), committer: ada('2020-06-04T00:00:00Z') });
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when untangle opens the review again, ', () => {
    let run: UntangleRun | undefined;
    let note = '';
    let reviewed = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh });
      const config = jsonScript(await waitForReview(reviewClient(run.url)), 'd-config') as { snapshot: { note: string | null }; state: { rev: { base: number[] } } };
      note = config.snapshot.note ?? 'no note';
      reviewed = config.state.rev.base.join(' ') || 'nothing';
    });

    after(async () => {
      await run?.stop();
    });

    it('then the marks panel says the file conflicted and went back to unreviewed.', () => {
      assert.equal(note, `replayed onto ${base.slice(0, 7)}; 1 file conflicted and went back to unreviewed`);
    });

    it('then nothing is reviewed.', () => {
      assert.equal(reviewed, 'nothing');
    });
  });
});

describe('Given a pull request force-pushed over a commit the review no longer has, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let old = '';
  let head = '';

  before(() => {
    const built = dartRepo();
    repo = built.repo;
    repo.write('lib/a.dart', "void greet() {\n  print('dropped');\n}\n");
    old = repo.commit({ subject: 'dropped', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
    repo.checkout('HEAD~1');
    head = repo.rev('HEAD');
    gh = pullRequestGh({
      number: 7,
      title: 'Add a greeting',
      url: 'https://github.com/acme/sample/pull/7',
      base: 'main',
      baseSha: repo.rev('main'),
      head: 'feature',
      headSha: head,
      pushes: [{ actor: 'ada', before: old, after: head, at: '2020-06-03T15:00:00Z' }],
    });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when its history is asked for, ', () => {
    let run: UntangleRun | undefined;
    let ghosts = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { cacheDir: cache, gh });
      const client: ReviewClient = reviewClient(run.url);
      await waitForReview(client);
      const history = (await client.call('history')).data as { ghosts?: unknown };
      ghosts = JSON.stringify(history.ghosts);
    });

    after(async () => {
      await run?.stop();
    });

    it('then that old head is listed: pushed over by ada, still in the clone, with the one commit taken off the branch.', () => {
      const dropped = { sha: old, author: 'Ada Review', at: Date.parse('2020-06-03T00:00:00Z') / 1000, subject: 'dropped' };
      assert.equal(ghosts, JSON.stringify([{ sha: old, at: Date.parse('2020-06-03T15:00:00Z') / 1000, actor: 'ada', after: head, yours: false, here: true, fork: head, replaced: 1, commits: [dropped] }]));
    });
  });
});

describe('Given a package whose dependency cannot be resolved, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', ['name: sample', 'environment:', '  sdk: ">=3.0.0 <4.0.0"', 'dependencies:', '  missing:', '    path: ../missing_pkg', ''].join('\n'));
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'change', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when it is reviewed, ', () => {
    let run: UntangleRun | undefined;
    let failures = '';
    let files = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh, quiet: false });
      const html = await waitForReview(reviewClient(run.url));
      failures = run.output().split('\n').filter((line) => line.includes('pub get failed')).map((line) => line.trim()).sort().join('\n');
      files = (jsonScript(html, 'd-model') as { compares: { base: { files: Array<{ p: string }> } } }).compares.base.files.map((file) => file.p).join(' ');
    });

    after(async () => {
      await run?.stop();
    });

    it('then the progress says pub get failed in each checkout, whose code then resolves partly.', () => {
      const failed = (sha: string) => `pub get failed in ${escaped(path.join(cache, 'worktrees', 'local', path.basename(repo!.dir)))}-[0-9a-f]{8}${escaped(path.sep)}${sha.slice(0, 12)}; its code resolves partly`;
      const lines = [repo!.rev('feature'), repo!.rev('main')].map(failed).sort();
      assert.match(failures, new RegExp(`^(${lines[0]}\\n${lines[1]}|${lines[1]}\\n${lines[0]})$`));
    });

    it('then the review is still served, with its changed file.', () => {
      assert.equal(files, 'lib/a.dart');
    });
  });
});

describe('Given a served review whose branch has not moved, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';
  let client: ReviewClient | undefined;

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, quiet: false });
    client = reviewClient(run.url);
    await waitForReview(client);
  });

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when it is refreshed, ', () => {
    let answer: string;

    before(async () => {
      const refresh = await client!.call('refresh', { method: 'POST' });
      const data = refresh.data as { state?: string };
      answer = `${data.state ?? JSON.stringify(refresh.data)}\n${run!.output().split('\n').filter((line) => line.includes('up to date')).map((line) => line.trim()).join('\n')}`;
    });

    it('then it answers current and the progress says up to date.', () => {
      assert.equal(answer, 'current\nup to date');
    });
  });
});
