import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { browsersOpened, startUntangle, type UntangleRun } from '../helpers/run.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

function script(file: string, log: string): void {
  fs.writeFileSync(file, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\n') + '\\n');\n`, { mode: 0o755 });
}

// Orca's CLI, as far as untangle uses it: it notes each call, one per line, and the tab it creates is page-7.
function orcaScript(file: string, log: string): void {
  const created = JSON.stringify({ id: '1', ok: true, result: { browserPageId: 'page-7' } });
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'tab' && args[1] === 'create') process.stdout.write(${JSON.stringify(created)} + '\\n');
`, { mode: 0o755 });
}

function packageRepo(): TempRepo {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  repo.commit({ subject: 'start', author: ada, committer: ada });
  repo.branch('feature');
  repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
  repo.commit({ subject: 'change', author: ada, committer: ada });
  return repo;
}

/** Waits until untangle has printed a line, and fails with what it printed if it never does. */
async function said(run: UntangleRun, line: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (run.output().split('\n').some((printed) => printed.trim() === line)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`untangle never said "${line}"\n${run.output()}`);
}

async function opened(log: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim()) return fs.readFileSync(log, 'utf8').trim();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return '';
}

describe('Given a repository, and BROWSER set to a stub, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let dir = '';
  let log = '';
  let stub = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-browser-'));
    log = path.join(dir, 'opened.txt');
    stub = path.join(dir, 'browser');
    script(stub, log);
    repo = packageRepo();
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('when it is reviewed without -no-open, ', () => {
    let run: UntangleRun | undefined;
    let recorded = '';
    let others = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh, open: true, quiet: false, args: ['-verbose'], env: { BROWSER: stub } });
      recorded = await opened(log);
      await said(run, 'opened in the browser');
      others = browsersOpened();
    });

    after(async () => {
      await run?.stop();
    });

    it('then the stub is asked to open the review’s URL.', () => {
      assert.equal(recorded, run!.url);
    });

    it('then no other browser is opened.', () => {
      assert.equal(others, '');
    });
  });
});

describe('Given a repository, in an Orca terminal whose CLI is a stub, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let dir = '';
  let log = '';
  let stub = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-orca-'));
    log = path.join(dir, 'opened.txt');
    stub = path.join(dir, 'orca');
    orcaScript(stub, log);
    repo = packageRepo();
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('when it is reviewed without -no-open, ', () => {
    let run: UntangleRun | undefined;
    let calls: string[][] = [];
    let others = '';

    before(async () => {
      run = await startUntangle(repo!.dir, {
        base: 'main',
        cacheDir: cache,
        gh,
        open: true,
        quiet: false,
        args: ['-verbose'],
        env: { ORCA_CLI_COMMAND: stub, ORCA_WORKTREE_ID: 'wt-9' },
      });
      // Only once untangle has heard back from Orca: stopping it sooner can end the stub first.
      await said(run, 'opened in Orca’s browser');
      calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      others = browsersOpened();
    });

    after(async () => {
      await run?.stop();
    });

    it('then Orca is asked for a tab in this worktree.', () => {
      assert.deepEqual(calls[0], ['tab', 'create', '--url', run!.url, '--worktree', 'id:wt-9', '--json']);
    });

    it('then Orca is asked to bring that tab to the front of the worktree, and for nothing else.', () => {
      assert.deepEqual(calls.slice(1), [['tab', 'switch', '--page', 'page-7', '--worktree', 'id:wt-9', '--focus']]);
    });

    it('then no other browser is opened.', () => {
      assert.equal(others, '');
    });
  });

  describe('when Orca names only the folder its CLI is in, as it does on macOS and Linux, ', () => {
    let run: UntangleRun | undefined;
    let calls: string[][] = [];

    before(async () => {
      fs.writeFileSync(log, '');
      run = await startUntangle(repo!.dir, {
        base: 'main',
        cacheDir: cache,
        gh,
        open: true,
        quiet: false,
        args: ['-verbose'],
        env: { ORCA_CLI_BIN_DIR: dir, ORCA_WORKTREE_ID: 'wt-9' },
      });
      await said(run, 'opened in Orca’s browser');
      calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    });

    after(async () => {
      await run?.stop();
    });

    it('then the orca in that folder is asked for a tab in this worktree.', () => {
      assert.deepEqual(calls[0], ['tab', 'create', '--url', run!.url, '--worktree', 'id:wt-9', '--json']);
    });
  });
});
