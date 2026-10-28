import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { resolveDirectory, tidyClone, type Target } from '../../dist/target.js';
import { stubGh, useStub, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function shown(target: Target): string {
  return [
    `pr ${target.pr ? `#${target.pr.number} ${target.pr.title}` : 'none'}`,
    `base ${target.baseRef} ${target.baseSha}`,
    `head ${target.headSha}`,
    `notes ${target.notes.join(' | ') || 'none'}`,
  ].join('\n');
}

describe('Given a branch with no pull request, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let restore = () => {};
  let base: string;
  let head: string;
  let target: Target;

  before(async () => {
    repo = TempRepo.create();
    gh = stubGh();
    restore = useStub(gh);
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', 'void main() {}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', 'void main() { return; }\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
  });

  after(() => {
    restore();
    repo?.remove();
    gh?.remove();
  });

  describe('when the directory is resolved, ', () => {
    before(async () => {
      target = await resolveDirectory(repo!.dir, null, () => {});
    });

    it('then the review compares the branch with main.', () => {
      assert.equal(shown(target), `pr none\nbase main ${base}\nhead ${head}\nnotes no pull request for this branch: comparing with main`);
    });
  });
});

describe('Given a branch whose pull request gh reports, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let restore = () => {};
  let base: string;
  let head: string;
  let target: Target;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', 'void main() {}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', 'void main() { return; }\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    gh = stubGh([{
      match: ['pr', 'view'],
      stdout: {
        number: 7,
        title: 'Add a greeting',
        url: 'https://github.com/acme/sample/pull/7',
        state: 'OPEN',
        baseRefName: 'main',
        baseRefOid: base,
        headRefName: 'feature',
        headRefOid: head,
      },
    }]);
    restore = useStub(gh);
  });

  after(() => {
    restore();
    repo?.remove();
    gh?.remove();
  });

  describe('when the directory is resolved, ', () => {
    before(async () => {
      target = await resolveDirectory(repo!.dir, null, () => {});
    });

    it('then the review is that pull request, compared with main.', () => {
      assert.equal(shown(target), `pr #7 Add a greeting\nbase main ${base}\nhead ${head}\nnotes none`);
    });
  });
});

describe('Given a fork whose origin main stayed where it began, and a branch from upstream’s main, which moved on, ', () => {
  let upstream: TempRepo | undefined;
  let fork: TempRepo | undefined;
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let restore = () => {};
  let main: string;
  let head: string;
  let target: Target;

  before(async () => {
    upstream = TempRepo.bare();
    fork = TempRepo.bare();
    repo = TempRepo.create();
    gh = stubGh();
    restore = useStub(gh);
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', 'void main() {}\n');
    const start = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.remoteAdd('origin', fork.dir);
    repo.remoteAdd('upstream', upstream.dir);
    repo.push('origin', 'main');
    repo.write('lib/a.dart', 'void main() { print(1); }\n');
    main = repo.commit({ subject: 'move main', author: ada, committer: ada });
    repo.push('upstream', 'main');
    repo.branch('feature');
    repo.write('lib/a.dart', 'void main() { print(2); }\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    // Your own main stayed behind as well.
    git(repo.dir, ['update-ref', 'refs/heads/main', start]);
    git(repo.dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  });

  after(() => {
    restore();
    repo?.remove();
    fork?.remove();
    upstream?.remove();
    gh?.remove();
  });

  describe('when the directory is resolved, ', () => {
    before(async () => {
      target = await resolveDirectory(repo!.dir, null, () => {});
    });

    it('then the review compares the branch with upstream’s main.', () => {
      assert.equal(shown(target), `pr none\nbase upstream/main ${main}\nhead ${head}\nnotes no pull request for this branch: comparing with upstream/main`);
    });
  });
});

describe('Given a fork whose origin main stayed where it began, and a branch from your own main, which moved on, ', () => {
  let fork: TempRepo | undefined;
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let restore = () => {};
  let main: string;
  let head: string;
  let target: Target;

  before(async () => {
    fork = TempRepo.bare();
    repo = TempRepo.create();
    gh = stubGh();
    restore = useStub(gh);
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', 'void main() {}\n');
    repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.remoteAdd('origin', fork.dir);
    repo.push('origin', 'main');
    repo.write('lib/a.dart', 'void main() { print(1); }\n');
    main = repo.commit({ subject: 'move main', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', 'void main() { print(2); }\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    git(repo.dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  });

  after(() => {
    restore();
    repo?.remove();
    fork?.remove();
    gh?.remove();
  });

  describe('when the directory is resolved, ', () => {
    before(async () => {
      target = await resolveDirectory(repo!.dir, null, () => {});
    });

    it('then the review compares the branch with your main.', () => {
      assert.equal(shown(target), `pr none\nbase main ${main}\nhead ${head}\nnotes no pull request for this branch: comparing with main`);
    });
  });
});

describe('Given a bare clone with blobs on demand, past gc’s pack limit, with a fork’s commit in it and what a failed repack left a day ago, ', () => {
  let repo: TempRepo | undefined;
  let dir = '';
  let packs = 0;
  let left: string[] = [];

  before(async () => {
    repo = TempRepo.create();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-clone-'));
    // git as untangle's clone sees it, without the user's settings.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const run = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    const origin = path.join(dir, 'origin.git'), fork = path.join(dir, 'fork.git'), clone = path.join(dir, 'clone.git');
    const fetch = (...args: string[]) => run(clone, ['-c', 'fetch.unpackLimit=1', ...args, 'fetch', '--quiet', 'origin', '+main:refs/heads/main']);
    const push = (to: string, branch: string) => run(repo!.dir, ['push', '--quiet', to, branch]);
    run(dir, ['init', '--quiet', '--bare', origin]);
    run(origin, ['config', 'uploadpack.allowFilter', 'true']);
    run(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    repo.write('a.txt', 'a\n');
    repo.commit({ subject: 'Start', author: ada, committer: ada });
    push(origin, 'main');
    run(dir, ['clone', '--quiet', '--bare', '--filter=blob:none', `file://${origin}`, clone]);
    // The pull request's branch, from a fork: objects of a remote that doesn't promise blobs.
    repo.branch('feature');
    repo.write('b.txt', 'b\n');
    repo.commit({ subject: 'Feature', author: ada, committer: ada });
    run(dir, ['init', '--quiet', '--bare', fork]);
    push(fork, 'feature');
    run(clone, ['-c', 'maintenance.auto=false', 'fetch', '--quiet', '--no-tags', `file://${fork}`, '+refs/heads/feature:refs/remotes/fork/feature']);
    // Past gc's pack limit, set low: each fetch keeps its own pack.
    run(clone, ['config', 'gc.autoPackLimit', '2']);
    repo.checkout('main');
    for (let i = 1; i <= 3; i++) {
      repo.write('a.txt', `a ${i}\n`);
      repo.commit({ subject: `Change ${i}`, author: ada, committer: ada });
      push(origin, 'main');
      fetch('-c', 'maintenance.auto=false');
    }
    const pack = path.join(clone, 'objects', 'pack');
    fs.writeFileSync(path.join(pack, '.tmp-1-pack-0123456789abcdef.pack'), 'PACK');
    fs.utimesSync(path.join(pack, '.tmp-1-pack-0123456789abcdef.pack'), new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 2 * 86_400_000));
    fs.writeFileSync(path.join(pack, 'tmp_idx_writing'), '');
    await tidyClone(clone);
    // The next fetch, and the upkeep after it, here rather than in the background.
    repo.write('a.txt', 'a 4\n');
    repo.commit({ subject: 'Change 4', author: ada, committer: ada });
    push(origin, 'main');
    fetch('-c', 'maintenance.autoDetach=false');
    packs = fs.readdirSync(pack).filter((name) => /^pack-.*\.pack$/.test(name)).length;
    left = fs.readdirSync(pack).filter((name) => /^(\.tmp-|tmp_)/.test(name));
  });

  after(() => {
    repo?.remove();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('then the fetch’s repack merges the packs, the promised objects’ and the fork’s, and leaves nothing behind but what may still be being written.', () => {
    assert.deepEqual({ packs, left }, { packs: 2, left: ['tmp_idx_writing'] });
  });
});
