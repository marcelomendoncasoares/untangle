import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveDirectory, resolveUrl, type Target } from '../../dist/target.js';
import { readHistory, type History } from '../../dist/history.js';
import { StackLines } from '../../dist/stack-lines.js';
import { reviewFiles } from '../helpers/review-files.ts';
import { stackFixture, type StackFixture } from '../helpers/stack.ts';
import { useStub } from '../helpers/gh.ts';

function fixture() {
  let s: StackFixture, cache: string, restore: () => void;
  let previous: NodeJS.ProcessEnv;
  before(() => {
    s = stackFixture();
    cache = fs.mkdtempSync('/tmp/untangle-stack-unit-');
    previous = { ...process.env };
    restore = useStub(s.gh);
    Object.assign(process.env, s.env, { UNTANGLE_CACHE: cache });
  });
  after(() => {
    restore();
    for (const key of [...Object.keys(s.env), 'UNTANGLE_CACHE']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    s.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });
  return { get s() { return s; }, get cache() { return cache; }, resolve: () => resolveUrl(s.urls.c, () => {}) };
}

describe('Given three open pull requests built on each other, ', () => {
  const f = fixture();
  let t: Target;
  describe('when the top pull request is opened, ', () => {
    before(async () => { t = await f.resolve(); });
    it('then its stack runs from c through b and a to main, and names the pull request above.', () => {
      assert.deepEqual(t.stack?.legs.map((l) => l.pr.number), [3, 2, 1]);
      assert.deepEqual(t.stack?.base, { ref: 'main', sha: f.s.base, squashed: null });
      assert.deepEqual(t.stack?.above, [{ number: 4, title: 'Add d', url: f.s.urls.d, branch: 'd' }]);
      assert.equal(t.baseSha, f.s.base);
    });
    it('then only the opened branch has a working copy.', () => {
      assert.ok(t.work);
      assert.deepEqual(fs.readdirSync(path.dirname(t.work!.dir)), ['3']);
    });
  });
});

describe('Given a branch below two pull requests with no open pull request of its own, ', () => {
  const f = fixture();
  describe('when the upper pull request is opened, ', () => {
    it('then that branch ends the stack.', async () => {
      f.s.prs[1].state = 'CLOSED';
      f.s.update(4);
      const t = await resolveUrl(f.s.urls.d, () => {});
      assert.deepEqual(t.stack?.legs.map((l) => l.pr.number), [4, 3]);
      assert.equal(t.stack?.base.ref, 'b');
    });
  });
});

describe('Given a fork pull request above two branches in the base repository, ', () => {
  const f = fixture();
  describe('when its stack is found, ', () => {
    it('then the fork can be the top leg and only base-repository branches are followed below.', async () => {
      f.s.prs[2].isCrossRepository = true;
      f.s.prs[2].headRepositoryOwner = { login: 'fork' };
      f.s.update();
      const t = await f.resolve();
      assert.deepEqual(t.stack?.legs.map((l) => l.pr.number), [3, 2, 1]);
      assert.deepEqual(t.stack?.above, []);
    });
  });
});

describe('Given a fork’s same-named branch below a pull request, ', () => {
  const f = fixture();
  describe('when the stack is found, ', () => {
    it('then the fork’s pull request does not count as a lower leg.', async () => {
      f.s.prs[0].isCrossRepository = true;
      f.s.prs[0].headRepositoryOwner = { login: 'fork' };
      f.s.update();
      const t = await f.resolve();
      assert.deepEqual(t.stack?.legs.map((l) => l.pr.number), [3, 2]);
      assert.equal(t.stack?.base.ref, 'a');
    });
  });
});

describe('Given gh cannot list a public stack, ', () => {
  const f = fixture();
  describe('when the REST fallback answers, ', () => {
    it('then the same repository’s legs, authors and draft state are retained.', async (test) => {
      f.s.update(3, [{ match: ['pr', 'list', '--repo', 'acme/sample', '--state', 'open'], code: 1 }]);
      test.mock.method(globalThis, 'fetch', async (input: string) => {
        assert.equal(input, 'https://api.github.com/repos/acme/sample/pulls?state=open&per_page=100&page=1');
        return new Response(JSON.stringify(f.s.prs.map((p) => ({
          number: p.number, title: p.title, html_url: p.url, draft: p.number === 2, user: p.author,
          base: { ref: p.baseRefName, sha: p.baseRefOid }, head: { ref: p.headRefName, sha: p.headRefOid, repo: { name: 'sample', owner: { login: 'acme' } } },
        }))), { status: 200 });
      });
      const t = await f.resolve();
      assert.deepEqual(t.stack?.legs.map((l) => l.pr.number), [3, 2, 1]);
      assert.equal(t.stack?.legs[1].pr.author, 'ada');
      assert.equal(t.stack?.legs[1].pr.isDraft, true);
    });
  });
});

describe('Given a pull request directly on main, ', () => {
  const f = fixture();
  describe('when it is opened, ', () => {
    it('then it is not a stack.', async () => {
      assert.equal((await resolveUrl(f.s.urls.a, () => {})).stack, null);
    });
  });
});

describe('Given a stacked branch in a folder, ', () => {
  const f = fixture();
  describe('when it is reviewed with an explicit base, ', () => {
    it('then the override has no stack or pull request.', async () => {
      const t = await resolveDirectory(f.s.work.dir, 'b', () => {});
      assert.equal(t.stack, null);
      assert.equal(t.pr, null);
      assert.equal(t.baseRef, 'b');
    });
  });
  describe('when it is reviewed without an explicit base, ', () => {
    it('then it finds the stack without making working copies.', async () => {
      const t = await resolveDirectory(f.s.work.dir, null, () => {});
      assert.deepEqual(t.stack?.legs.map((l) => l.pr.number), [3, 2, 1]);
      assert.ok(t.stack?.legs.every((l) => l.work === null));
      assert.ok(!fs.existsSync(path.join(f.cache, 'work')));
    });
  });
});

describe('Given a stacked pull request URL with an explicit base, ', () => {
  const f = fixture();
  describe('when it is opened, ', () => {
    it('then the base override suppresses stack discovery.', async () => {
      const t = await resolveUrl(f.s.urls.c, () => {}, 'b');
      assert.equal(t.stack, null);
      assert.equal(t.baseRef, 'b');
      assert.equal(f.s.gh.calls().some((c) => c.args[1] === 'list'), false);
    });
  });
});

describe('Given a stacked folder whose pull request has advanced on GitHub, ', () => {
  const f = fixture();
  describe('when its local head is reviewed, ', () => {
    it('then the remote head is fetched for line mapping without moving the folder’s branch.', async () => {
      const folder = path.join(f.s.mirror, 'folder');
      f.s.git(f.s.mirror, 'clone', '--single-branch', '--branch', 'c', f.s.bare, folder);
      f.s.git(folder, 'remote', 'set-url', 'origin', 'https://github.com/acme/sample.git');
      f.s.work.write('lib/new.dart', 'void newer() {}\n');
      const newer = f.s.commit('Advance c');
      f.s.publish(3);
      assert.throws(() => f.s.git(folder, 'cat-file', '-e', newer));

      const target = await resolveDirectory(folder, null, () => {});
      assert.equal(target.headSha, f.s.heads.c);
      assert.equal(target.stack?.legs[0].head, f.s.heads.c);
      assert.equal(target.stack?.legs[0].pr.headRefOid, newer);
      assert.equal(f.s.git(folder, 'rev-parse', 'refs/untangle/pull/3'), newer);
      assert.equal(f.s.git(folder, 'rev-parse', 'HEAD'), f.s.heads.c);
    });
  });
});

describe('Given pull requests whose base branches form a cycle, ', () => {
  const f = fixture();
  describe('when the stack is followed, ', () => {
    it('then the cycle is reported instead of following it again.', async () => {
      f.s.prs[0].baseRefName = 'c';
      f.s.update();
      await assert.rejects(f.resolve(), /cycle at #3/);
    });
  });
});

describe('Given a stack with a lower fix carried up by a merge, ', () => {
  const f = fixture();
  let h: History, t: Target, files: ReturnType<typeof reviewFiles>;
  describe('when its history is read, ', () => {
    before(async () => {
      t = await f.resolve();
      files = reviewFiles(t.repo, t.baseSha, t.headSha);
      h = await readHistory(t.repo, t.baseSha, t.headSha, files, null, t.stack!);
    });
    it('then each commit belongs to the lowest leg that contains it.', () => {
      const owned = Object.fromEntries(h.commits.map((c) => [c.subject, c.leg]));
      assert.deepEqual(owned, { 'Bring b into c': 3, 'Fix b': 2, 'Add c': 3, 'Add b': 2, 'Add a': 1 });
      for (const leg of h.stack!.legs) assert.ok(leg.commits.every((i) => h.commits[i].leg === leg.number));
    });
    it('then the carrying merge names b and its removed line belongs to b.', () => {
      assert.equal(h.commits.find((c) => c.sha === f.s.commits.merge)?.brings, 2);
      const fi = files.findIndex((file) => file.p === f.s.file);
      const rows = files[fi].hunks!;
      let leg: number | null = null;
      rows.forEach((chunk, hi) => chunk.rows.forEach((row, ri) => {
        if (row[0] === '-' && row[1].includes('obsolete')) leg = h.commits[h.rows[fi]![hi][ri]].leg;
      }));
      assert.equal(leg, 2);
    });
    it('then the composer maps b’s line and its deletion to b’s own coordinates.', async () => {
      const lines = new StackLines(t, h, files);
      await lines.prepare();
      assert.deepEqual(lines.place({ path: f.s.file, line: f.s.line('c', "'b'") }), { pr: 2, path: f.s.file, line: f.s.line('b', "'b'"), startLine: null, side: 'RIGHT' });
      assert.deepEqual(lines.place({ path: f.s.file, side: 'LEFT', line: f.s.line('main', "'obsolete'") }), { pr: 2, path: f.s.file, line: f.s.line('a', "'obsolete'"), startLine: null, side: 'LEFT' });
    });
    it('then a range starting on c’s own line cannot go to b.', async () => {
      const lines = new StackLines(t, h, files);
      await lines.prepare();
      assert.throws(() => lines.place({ path: f.s.file, line: f.s.line('c', "'b'"), startLine: 1 }), /first line.*#2/);
    });
    it('then a cached history of the same commits without a stack is rebuilt with its legs.', async () => {
      await readHistory(t.repo, t.baseSha, t.headSha, files, f.cache);
      const cached = await readHistory(t.repo, t.baseSha, t.headSha, files, f.cache, t.stack!);
      assert.deepEqual(cached.stack, h.stack);
      assert.ok(cached.commits.every((c) => c.leg != null && 'brings' in c));
    });
  });
});

describe('Given a carrying merge that resolves a conflict itself, ', () => {
  const f = fixture();
  describe('when the merged history is attributed, ', () => {
    it('then the conflict’s new line belongs to the merge in c.', async () => {
      const s = f.s;
      s.work.write(s.file, s.text().replace("'keep5'", "'c changed'"));
      s.commit('Change in c');
      s.work.checkout('b');
      s.work.write(s.file, s.text().replace("'keep5'", "'b changed'"));
      s.commit('Change in b');
      s.publish(2);
      s.work.checkout('c');
      const ours = s.text();
      assert.throws(() => s.git(s.work.dir, 'merge', '--no-edit', 'b'));
      s.work.write(s.file, ours.replace("'c changed'", "'resolved here'"));
      const merge = s.commit('Resolve b in c');
      s.publish(3);
      const t = await f.resolve();
      const files = reviewFiles(t.repo, t.baseSha, t.headSha);
      const h = await readHistory(t.repo, t.baseSha, t.headSha, files, null, t.stack!);
      let sha: string | undefined;
      files.forEach((file, fi) => file.hunks?.forEach((chunk, hi) => chunk.rows.forEach((row, ri) => {
        if (row[0] === '+' && row[1].includes('resolved here')) sha = h.commits[h.rows[fi]![hi][ri]].sha;
      })));
      assert.equal(sha, merge);
      assert.equal(h.commits.find((c) => c.sha === merge)?.brings, 2);
    });
  });
});

describe('Given a lower leg squash merged into main, ', () => {
  const f = fixture();
  before(() => {
    const s = f.s;
    s.work.checkout('main');
    s.git(s.work.dir, 'merge', '--squash', 'a');
    const squash = s.commit('Squash a');
    s.git(s.work.dir, 'push', s.bare, 'main');
    s.work.checkout('c');
    s.prs[0].state = 'MERGED';
    s.prs[1].baseRefName = 'main';
    s.prs[1].baseRefOid = squash;
    s.merged.push({ number: 1, headRefOid: s.heads.a, mergeCommit: { oid: squash }, mergedAt: '2020-07-01T00:00:00Z' });
    s.update();
  });
  describe('when the next leg has not merged main in, ', () => {
    it('then the old head of the merged leg remains the comparison base.', async () => {
      const t = await f.resolve();
      assert.deepEqual(t.stack?.base, { ref: 'main', sha: f.s.heads.a, squashed: 1 });
      assert.deepEqual(t.stack?.legs.map((l) => l.pr.number), [3, 2]);
    });
    it('then deleted-line comments still use GitHub’s original merge base, with numbers mapped both ways.', async () => {
      const t = await f.resolve();
      const files = reviewFiles(t.repo, t.baseSha, t.headSha);
      const h = await readHistory(t.repo, t.baseSha, t.headSha, files, null, t.stack!);
      const lines = new StackLines(t, h, files);
      await lines.prepare();
      const reviewed = f.s.line('a', "'obsolete'"), github = f.s.line(f.s.base, "'obsolete'");
      assert.deepEqual(lines.place({ path: f.s.file, side: 'LEFT', line: reviewed }), { pr: 2, path: f.s.file, side: 'LEFT', line: github, startLine: null });
      assert.deepEqual(await lines.fromLeg(2, 'LEFT', f.s.file, github), { path: f.s.file, line: reviewed });
    });
  });
  describe('when the next leg merges main and that merge reaches the top, ', () => {
    it('then main becomes the base again.', async () => {
      const s = f.s;
      s.work.checkout('b');
      s.git(s.work.dir, 'merge', '--no-edit', '-X', 'ours', 'main');
      s.publish(2);
      s.work.checkout('c');
      s.git(s.work.dir, 'merge', '--no-edit', 'b');
      s.publish(3);
      const t = await f.resolve();
      assert.deepEqual(t.stack?.base, { ref: 'main', sha: s.work.rev('main'), squashed: null });
    });
  });
});
