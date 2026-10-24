import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { StackTarget } from '../../dist/stack.js';
import type { WorkingCopy } from '../../dist/work.js';
import { stackFixture, type StackFixture } from '../helpers/stack.ts';

process.env.UNTANGLE_NOTES_QUIET = '0';
const { Notes } = await import('../../dist/notes.js');

describe('Given a stack watch waiting for a lower working copy, ', () => {
  let s: StackFixture, notes: InstanceType<typeof Notes>;
  let readyA: () => void, readyB: () => void;
  const a = new Promise<void>((resolve) => { readyA = resolve; });
  const b = new Promise<void>((resolve) => { readyB = resolve; });

  before(() => {
    s = stackFixture();
    const stack: StackTarget = {
      base: { ref: 'main', sha: s.base, squashed: null }, above: [],
      legs: s.prs.slice(0, 3).reverse().map((p) => ({ pr: { ...p, owner: 'acme', repo: 'sample', author: 'ada', headRepositoryOwner: 'acme', headRepository: 'sample' }, head: p.headRefOid, base: p.baseRefOid, work: null })),
    };
    const copies = new Map<number, Promise<WorkingCopy>>();
    for (const leg of stack.legs.slice(1)) {
      copies.set(leg.pr.number, (leg.pr.number === 1 ? a : b).then(() => {
        const work = { dir: path.join(s.mirror, leg.pr.headRefName), branch: leg.pr.headRefName, githubBranch: leg.pr.headRefName, remote: s.bare, ref: `refs/heads/${leg.pr.headRefName}` };
        leg.work = work;
        return work;
      }));
    }
    notes = new Notes(path.join(s.mirror, 'notes.json'), () => {});
    notes.attach({
      repo: s.work.dir, base: s.base, head: s.heads.c, name: 'acme/sample#3', branch: 'c', checkout: s.work.dir, stack,
      leg: (at) => at.line === s.line('c', "'a'") ? 1 : 2,
      legWork: (pr) => copies.get(pr)!, change: () => null, gh: null,
    });
  });

  after(() => { readyA(); readyB(); notes?.close(); s?.remove(); });

  describe('when a note on another lower leg arrives before the first copy is ready, ', () => {
    it('then the watch waits for both copies and names both branches with their folders.', async () => {
      await notes.act({ action: 'add', path: s.file, line: s.line('c', "'b'"), body: 'Fix b.' });
      let delivered = false;
      const watch = notes.watch('Claude', { timeout: 5_000 }).then((answer) => { delivered = true; return answer; });
      await notes.act({ action: 'add', path: s.file, line: s.line('c', "'a'"), body: 'Fix a too.' });
      readyB();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(delivered, false);
      readyA();
      const answer = await watch;
      assert.ok('text' in answer);
      assert.equal(answer.notes, 2);
      assert.ok(answer.text.includes(`#1’s branch, a, is checked out at ${path.join(s.mirror, 'a')}, for changes.`));
      assert.ok(answer.text.includes(`#2’s branch, b, is checked out at ${path.join(s.mirror, 'b')}, for changes.`));
    });
  });
});
