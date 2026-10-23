import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { folderAt, orcaFolder, pathView, worktreesOf } from '../../dist/folders.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

/** git in a folder, its commits by Ada at the date given. */
function git(cwd: string, args: string[], date = '2020-06-01T00:00:00Z'): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada Review', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada Review', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

/** A new repository at dir, its first commit on main. */
function repoAt(dir: string): void {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'lib', 'a.dart'), 'void main() {}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'start']);
}

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

describe('Given a folder holding a repository on a branch, a worktree of it, a plain folder, a hidden one and a file, ', () => {
  let base = '';
  let alpha = '', alps = '';
  // Each folder as the palette lists it: its name, and a repository's branch.
  const names = (v: ReturnType<typeof pathView>) => v.folders.map((b) => (b.dir ? `${b.name} (${b.branch})` : b.name));

  before(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-paths-')));
    alpha = path.join(base, 'alpha');
    alps = path.join(base, 'alps');
    repoAt(alpha);
    git(alpha, ['checkout', '-q', '-b', 'feature']);
    git(alpha, ['worktree', 'add', '-q', '-b', 'polish', alps]);
    fs.mkdirSync(path.join(base, 'beta', 'inner'), { recursive: true });
    fs.mkdirSync(path.join(base, '.hidden'));
    fs.writeFileSync(path.join(base, 'notes.txt'), 'notes\n');
  });

  after(() => fs.rmSync(base, { recursive: true, force: true }));

  describe('when its path is typed with a separator at the end, ', () => {
    it('then the palette lists its folders but the hidden one, in order, each repository with where it is and its branch.', () => {
      const v = pathView(base + '/');
      assert.deepEqual([v.at, names(v), v.folders.map((b) => b.dir), v.folder, v.error], [base + '/', ['alpha (feature)', 'alps (polish)', 'beta'], [alpha, alps, null], null, null]);
    });
  });

  describe('when the start of a name is typed after it, ', () => {
    it('then only the folders whose names start so are listed, in any case.', () => {
      assert.deepEqual([names(pathView(base + '/AL')), names(pathView(base + '/b'))], [['alpha (feature)', 'alps (polish)'], ['beta']]);
    });
  });

  describe('when the name typed starts with a dot, ', () => {
    it('then the hidden folders are listed.', () => {
      assert.deepEqual(names(pathView(base + '/.')), ['.hidden']);
    });
  });

  describe('when it’s typed from ~, its home, ', () => {
    it('then the paths keep the ~, as typed.', () => {
      const v = pathView('~/', base);
      assert.deepEqual([v.at, v.folders.map((b) => b.path)], ['~/', ['~/alpha', '~/alps', '~/beta']]);
    });
  });

  describe('when a repository’s name is typed whole, ', () => {
    it('then it’s listed once, as a folder: the repository it is isn’t offered again.', () => {
      const v = pathView(alpha);
      assert.deepEqual([names(v), v.folder], [['alpha (feature)'], null]);
    });
  });

  describe('when the path goes into the repository, or names a folder in it, ', () => {
    it('then the repository is offered, with the folders in it.', () => {
      const into = pathView(alpha + '/'), lib = pathView(path.join(alpha, 'lib'));
      assert.deepEqual([names(into), into.folder && 'dir' in into.folder && into.folder.dir, names(lib), lib.folder && 'dir' in lib.folder && lib.folder.branch], [['lib'], alpha, ['lib'], 'feature']);
    });
  });

  describe('when the start of a name in the repository is typed, ', () => {
    it('then its folders are listed, and no folder is offered for what isn’t one.', () => {
      const v = pathView(path.join(alpha, 'li'));
      assert.deepEqual([names(v), v.folder], [['lib'], null]);
    });
  });

  describe('when there are more folders than it lists, ', () => {
    it('then it says how many more.', () => {
      const v = pathView(base + '/', os.homedir(), 2);
      assert.deepEqual([names(v), v.more], [['alpha (feature)', 'alps (polish)'], 1]);
    });
  });

  describe('when the path’s folder isn’t there, or the path isn’t whole, ', () => {
    it('then it says so, and lists nothing.', () => {
      const gone = pathView(base + '/gone/'), part = pathView('lib/');
      assert.deepEqual([gone.error, gone.folders, part.error], [`There’s no folder at ${base}/gone/`, [], 'A folder’s whole path, from / or ~']);
    });
  });
});

describe('Given a repository with worktrees on branches, one detached, and one in untangle’s own folder, ', () => {
  let base = '';
  let main = '', own = '';
  const listed = (ws: Awaited<ReturnType<typeof worktreesOf>>) => ws.map((w) => `${w.name} ${w.branch} ${w.repo ?? '-'} ${w.at}`);

  before(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-worktrees-')));
    main = path.join(base, 'app');
    own = path.join(base, 'own');
    repoAt(main);
    git(main, ['branch', 'feature']);
    git(main, ['branch', 'polish']);
    git(main, ['worktree', 'add', '-q', path.join(base, 'app-feature'), 'feature']);
    git(path.join(base, 'app-feature'), ['commit', '-q', '--allow-empty', '-m', 'feature'], '2020-06-02T00:00:00Z');
    git(main, ['worktree', 'add', '-q', path.join(base, 'app-polish'), 'polish']);
    git(path.join(base, 'app-polish'), ['commit', '-q', '--allow-empty', '-m', 'polish'], '2020-06-03T00:00:00Z');
    git(main, ['worktree', 'add', '-q', '--detach', path.join(base, 'app-detached')]);
    git(main, ['worktree', 'add', '-q', '-b', 'mine', path.join(own, 'app-mine')]);
  });

  after(() => fs.rmSync(base, { recursive: true, force: true }));

  describe('when its worktrees are asked for, from two of them, ', () => {
    it('then those on a branch are listed once, the branch last moved first, without the default branch’s, the detached one or untangle’s.', async () => {
      assert.deepEqual(listed(await worktreesOf([main, path.join(base, 'app-feature')], own)), [
        'app-polish polish - 2020-06-03T00:00:00Z',
        'app-feature feature - 2020-06-02T00:00:00Z',
      ]);
    });
  });

  describe('when it has a remote on GitHub whose default branch is polish, ', () => {
    it('then each says its repository, and the one on polish goes while the one on main comes.', async () => {
      git(main, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
      git(main, ['update-ref', 'refs/remotes/origin/polish', 'polish']);
      git(main, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/polish']);
      assert.deepEqual(listed(await worktreesOf([main], own)), [
        'app-feature feature acme/app 2020-06-02T00:00:00Z',
        'app main acme/app 2020-06-01T00:00:00Z',
      ]);
    });
  });
});

describe('Given the folders Orca names its projects by, ', () => {
  describe('when untangle runs in WSL, ', () => {
    it('then this distribution’s are its own folders, and another’s, or Windows’, aren’t.', { skip: process.platform !== 'linux' && 'WSL is Linux' }, () => {
      const env = { WSL_DISTRO_NAME: 'Ubuntu-24.04' };
      assert.deepEqual([
        orcaFolder('\\\\wsl.localhost\\Ubuntu-24.04\\home\\ada\\app', env),
        orcaFolder('\\\\wsl$\\ubuntu-24.04\\home\\ada', env),
        orcaFolder('\\\\wsl.localhost\\Debian\\home\\ada', env),
        orcaFolder('/home/ada/app', env),
        orcaFolder('C:\\Users\\ada\\app', env),
      ], ['/home/ada/app', '/home/ada', null, '/home/ada/app', null]);
    });
  });
});
