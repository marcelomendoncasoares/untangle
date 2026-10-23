import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { folderAt } from '../../dist/manager.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

describe('Given a repository on a branch, with its remote on GitHub, ', () => {
  let repo: TempRepo;
  let top = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void main() {}\n');
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repo.dir });
    top = fs.realpathSync(repo.dir);
  });

  after(() => repo.remove());

  describe('when a folder inside it is pasted, ', () => {
    it('then the palette is told of the repository it’s in: its top folder, owner and name on GitHub, and branch.', () => {
      assert.deepEqual(folderAt(path.join(repo.dir, 'lib')), { dir: top, name: path.basename(top), where: top, repo: 'acme/app', branch: 'feature' });
    });
  });

  describe('when it’s pasted from ~, ', () => {
    it('then ~ is the home folder.', () => {
      const f = folderAt('~/' + path.basename(repo.dir), path.dirname(repo.dir));
      assert.equal('dir' in f && f.dir, top);
    });
  });
});

describe('Given paths that hold no review, ', () => {
  let plain = '';

  before(() => {
    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-plain-'));
  });

  after(() => fs.rmSync(plain, { recursive: true, force: true }));

  describe('when one is pasted, ', () => {
    it('then the palette is told why: a path not whole, nothing there, or a folder outside git.', () => {
      assert.deepEqual([folderAt('lib/a'), folderAt(path.join(plain, 'gone')), folderAt(plain)], [
        { error: 'A folder’s whole path, from / or ~' },
        { error: `There’s no folder at ${path.join(plain, 'gone')}` },
        { error: `${plain} isn’t in a git repository` },
      ]);
    });
  });
});
