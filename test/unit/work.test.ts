import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cloneDir, workDir } from '../../dist/cache.js';
import { readLocal } from '../../dist/local.js';
import { resolveUrl, type Target } from '../../dist/target.js';
import { workingFixture } from '../server/working-fixture.ts';

function setup(o: Parameters<typeof workingFixture>[0] = {}) {
  const f = workingFixture(o);
  const restore = f.use();
  return { ...f, remove: () => { restore(); f.remove(); } };
}
const resolve = (f: ReturnType<typeof setup>) => resolveUrl(f.url, () => {});
const local = (t: Target) => readLocal(t.work!.dir, { work: t.work!.dir, branch: t.work!.githubBranch, ref: t.work!.ref });

describe('Given an open pull request in its base repository, ', () => {
  let f: ReturnType<typeof setup>;
  beforeEach(() => { f = setup(); });
  afterEach(() => f.remove());

  describe('when its working copy is made, ', () => {
    it('then the narration announces the checkout before it starts.', async () => {
      const lines: string[] = [];
      const dir = workDir('github.com/acme/sample', 7);
      const t = await resolveUrl(f.url, (line) => {
        lines.push(line);
        if (line === 'checking out the working copy') assert.equal(fs.existsSync(dir), false);
      });
      assert.equal(t.work!.dir, dir);
      assert.equal(lines.filter((line) => line === 'checking out the working copy').length, 1);
    });

    it('then its named branch shares the clone’s objects and a plain push reaches the head branch over https.', async () => {
      const t = await resolve(f), work = t.work!;
      assert.equal(work.dir, workDir(t.repoKey, 7));
      assert.equal(f.git(work.dir, 'symbolic-ref', '--short', 'HEAD'), 'feature');
      assert.equal(f.git(work.dir, 'config', `remote.${work.remote}.url`), 'https://github.com/acme/sample.git');
      assert.equal(f.git(work.dir, 'rev-parse', '@{upstream}'), f.head);
      const next = f.commit(work.dir);
      assert.equal(f.git(t.repo, 'rev-parse', `${next}^{commit}`), next);
      assert.deepEqual((await local(t)).local.unpushed, [next]);
      f.git(work.dir, 'push');
      assert.equal(f.git(f.bare, 'rev-parse', 'feature'), next);
      assert.deepEqual((await local(t)).local.unpushed, []);
    });
  });

  describe('when the review opens again after a local commit, ', () => {
    it('then the same working copy supplies the review’s head.', async () => {
      const t = await resolve(f);
      const next = f.commit(t.work!.dir);
      const lines: string[] = [];
      const again = await resolveUrl(f.url, (line) => lines.push(line));
      assert.equal(again.work!.dir, t.work!.dir);
      assert.equal(again.headSha, next);
      assert.equal(lines.includes('checking out the working copy'), false);
    });
  });

  describe('when its folder was removed, ', () => {
    it('then the working copy is made again at GitHub’s branch.', async () => {
      const t = await resolve(f);
      fs.rmSync(t.work!.dir, { recursive: true });
      const again = await resolve(f);
      assert.equal(f.git(again.work!.dir, 'rev-parse', 'HEAD'), f.head);
      assert.equal(again.work!.branch, 'feature');
    });
  });

  describe('when another pull request uses the same branch name, ', () => {
    it('then it gets a unique branch whose plain push still reaches its head branch.', async () => {
      const first = await resolve(f);
      f.pr.number = 8;
      f.answer();
      const second = await resolveUrl(f.url.replace('/7', '/8'), () => {});
      assert.equal(first.work!.branch, 'feature');
      assert.equal(second.work!.branch, 'feature-pr-8');
      const next = f.commit(second.work!.dir);
      f.git(second.work!.dir, 'push');
      assert.equal(f.git(f.bare, 'rev-parse', 'feature'), next);
      assert.equal(f.git(first.work!.dir, 'rev-parse', 'HEAD'), f.head);
    });
  });

  describe('when an imported branch in the bare clone is stale, ', () => {
    it('then the working copy starts at the fetched head instead.', async () => {
      const repo = cloneDir('github.com/acme/sample');
      fs.mkdirSync(path.dirname(repo), { recursive: true });
      f.git(f.root, 'clone', '--bare', f.bare, repo);
      f.git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/sample.git');
      f.git(repo, 'update-ref', 'refs/heads/feature', f.base);
      const t = await resolve(f);
      assert.equal(t.work!.branch, 'feature');
      assert.equal(t.headSha, f.head);
    });
  });

  describe('when a tracked file is changed, ', () => {
    it('then local says dirty without changing the reviewed commit.', async () => {
      const t = await resolve(f);
      fs.writeFileSync(path.join(t.work!.dir, 'greeting.txt'), 'unfinished\n');
      assert.equal((await local(t)).local.dirty, true);
      assert.equal((await resolve(f)).headSha, f.head);
    });
  });

  describe('when an untracked file is added, ', () => {
    it('then local says dirty.', async () => {
      const t = await resolve(f);
      fs.writeFileSync(path.join(t.work!.dir, 'untracked.txt'), 'unfinished\n');
      assert.equal((await local(t)).local.dirty, true);
    });
  });

  describe('when local state is polled while the file’s timestamp changed, ', () => {
    it('then the index stays untouched for the agent’s next commit.', async () => {
      const t = await resolve(f);
      const index = f.git(t.work!.dir, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
      const before = fs.readFileSync(index);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(t.work!.dir, 'greeting.txt'), later, later);
      assert.equal((await local(t)).local.dirty, false);
      assert.deepEqual(fs.readFileSync(index), before);
    });
  });

  describe('when only an ignored file is added, ', () => {
    it('then local stays clean.', async () => {
      const t = await resolve(f);
      fs.writeFileSync(path.join(t.work!.dir, 'ignored'), 'build output\n');
      assert.equal((await local(t)).local.dirty, false);
    });
  });

  describe('when GitHub’s head branch is deleted, ', () => {
    it('then its old fetched tip no longer counts as a copy on GitHub.', async () => {
      const t = await resolve(f);
      f.git(f.remote, 'update-ref', '-d', 'refs/heads/feature');
      const again = await resolve(f);
      assert.equal(again.headSha, f.head);
      assert.deepEqual((await local(t)).local, { work: t.work!.dir, branch: 'feature', github: null, unpushed: null, behind: 0, dirty: false });
    });
  });

  describe('when GitHub moves on and the working copy has nothing of its own, ', () => {
    it('then the review fast-forwards it to GitHub.', async () => {
      const t = await resolve(f);
      const next = f.commit(f.author.dir);
      f.push();
      const again = await resolve(f);
      assert.equal(f.git(t.work!.dir, 'rev-parse', 'HEAD'), next);
      assert.equal(again.headSha, next);
      assert.deepEqual((await local(again)).local, { work: t.work!.dir, branch: 'feature', github: next, unpushed: [], behind: 0, dirty: false });
    });
  });

  describe('when GitHub moves on and the working copy has a commit of its own, ', () => {
    it('then both histories are kept and local counts the commits on each side.', async () => {
      const t = await resolve(f);
      const own = f.commit(t.work!.dir, 'own.txt');
      const theirs = f.commit(f.author.dir, 'theirs.txt');
      f.push();
      const again = await resolve(f);
      assert.equal(again.headSha, own);
      assert.deepEqual((await local(again)).local, { work: t.work!.dir, branch: 'feature', github: theirs, unpushed: [own], behind: 1, dirty: false });
    });
  });

  describe('when GitHub moves on and the working copy has an uncommitted change, ', () => {
    it('then its commit and files stay as they were and local reports behind.', async () => {
      const t = await resolve(f);
      fs.writeFileSync(path.join(t.work!.dir, 'greeting.txt'), 'unfinished\n');
      f.commit(f.author.dir);
      f.push();
      const again = await resolve(f);
      assert.equal(again.headSha, f.head);
      assert.equal(fs.readFileSync(path.join(t.work!.dir, 'greeting.txt'), 'utf8'), 'unfinished\n');
      assert.equal((await local(again)).local.behind, 1);
    });
  });
});

describe('Given a fork’s pull request and gh configured for ssh, ', () => {
  let f: ReturnType<typeof setup>;
  beforeEach(() => { f = setup({ fork: true, protocol: 'ssh' }); });
  afterEach(() => f.remove());

  describe('when its working copy is made, ', () => {
    it('then a plain push and pull use the fork’s head branch over ssh.', async () => {
      const t = await resolve(f), work = t.work!;
      assert.equal(work.branch, 'feature');
      assert.equal(f.git(work.dir, 'config', `remote.${work.remote}.url`), 'git@github.com:ada/sample.git');
      assert.equal((await local(t)).local.branch, 'ada:feature');
      const next = f.commit(work.dir);
      f.git(work.dir, 'push');
      assert.equal(f.git(f.remote, 'rev-parse', 'feature'), next);
      assert.equal(f.git(f.bare, 'branch', '--list', 'feature'), '');
      f.git(work.dir, 'pull', '--ff-only');
      assert.equal(f.git(work.dir, 'rev-parse', '@{upstream}'), next);
    });
  });
});

describe('Given a closed pull request, ', () => {
  it('when reviewed, then it has no working copy.', async () => {
    const f = setup({ state: 'CLOSED' });
    try {
      const t = await resolve(f);
      assert.equal(t.work, null);
      assert.equal(fs.existsSync(workDir(t.repoKey, 7)), false);
    } finally { f.remove(); }
  });
});

describe('Given a pull request whose head repository is gone, ', () => {
  it('when reviewed, then its readable head still opens without a working copy.', async () => {
    const f = setup({ missing: true });
    try {
      const t = await resolve(f);
      assert.equal(t.work, null);
      assert.equal(t.headSha, f.head);
    } finally { f.remove(); }
  });
});

describe('Given a working-copy path occupied by another folder, ', () => {
  it('when reviewed, then its files are kept and the review explains the failure.', async () => {
    const f = setup();
    try {
      const dir = workDir('github.com/acme/sample', 7);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mine'), 'keep');
      const t = await resolve(f);
      assert.equal(t.work, null);
      assert.equal(fs.readFileSync(path.join(dir, 'mine'), 'utf8'), 'keep');
      assert.match(t.notes.join('\n'), /could not open the working copy/);
    } finally { f.remove(); }
  });
});

describe('Given a pull request in the base repository and gh configured for ssh, ', () => {
  it('when a commit is pushed from its working copy, then the head branch receives it over ssh.', async () => {
    const f = setup({ protocol: 'ssh' });
    try {
      const t = await resolve(f);
      assert.equal(f.git(t.work!.dir, 'config', `remote.${t.work!.remote}.url`), 'git@github.com:acme/sample.git');
      const next = f.commit(t.work!.dir);
      f.git(t.work!.dir, 'push');
      assert.equal(f.git(f.remote, 'rev-parse', 'feature'), next);
    } finally { f.remove(); }
  });
});

describe('Given a fork’s pull request and gh configured for https, ', () => {
  it('when a commit is pushed from its working copy, then the fork’s head branch receives it over https.', async () => {
    const f = setup({ fork: true });
    try {
      const t = await resolve(f);
      assert.equal(f.git(t.work!.dir, 'config', `remote.${t.work!.remote}.url`), 'https://github.com/ada/sample.git');
      const next = f.commit(t.work!.dir);
      f.git(t.work!.dir, 'push');
      assert.equal(f.git(f.remote, 'rev-parse', 'feature'), next);
    } finally { f.remove(); }
  });
});

describe('Given a public fork’s pull request answered by the REST API, ', () => {
  it('when gh cannot answer, then its head repository is used and https is the fallback protocol.', async () => {
    const f = setup({ fork: true });
    const fetch = globalThis.fetch;
    try {
      f.gh.setReplies([]);
      globalThis.fetch = async (url) => {
        assert.equal(String(url), 'https://api.github.com/repos/acme/sample/pulls/7');
        return new Response(JSON.stringify({
          number: 7, title: 'Greet the world', html_url: f.url, state: 'open', merged_at: null,
          base: { ref: 'main', sha: f.base }, head: { ref: 'feature', sha: f.head, repo: { name: 'sample', owner: { login: 'ada' } } },
        }));
      };
      const t = await resolve(f);
      assert.equal(t.pr!.headRepository, 'sample');
      assert.equal(t.pr!.headRepositoryOwner, 'ada');
      assert.equal(t.pr!.isCrossRepository, true);
      assert.equal(f.git(t.work!.dir, 'config', `remote.${t.work!.remote}.url`), 'https://github.com/ada/sample.git');
    } finally {
      globalThis.fetch = fetch;
      f.remove();
    }
  });
});
