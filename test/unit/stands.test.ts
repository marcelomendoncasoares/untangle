import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { standOf, stands, type RawStand, type Stand } from '../../dist/github.js';
import { stubGh, useStub, type GhStub } from '../helpers/gh.ts';

// Ada reviews grace's pull request: its commits, oldest first, made by grace on the first day unless
// said otherwise.
const [first, second, head] = ['a', 'b', 'c'].map((c) => c.repeat(40));
const at = (day: number) => `2020-06-${String(day).padStart(2, '0')}T12:00:00Z`;
const commits = (days = [1, 1, 1], by = ['grace', 'grace', 'grace']): RawStand['commits'] => ({
  nodes: [first, second, head].map((oid, i) => ({ commit: { oid, committedDate: at(days[i]), author: { user: { login: by[i] } } } })),
});

function pr(o: Partial<RawStand> = {}): RawStand {
  return {
    state: 'OPEN', headRefOid: head, viewerDidAuthor: false, author: { login: 'grace' },
    reviewRequests: { nodes: [] }, mine: { nodes: [] }, talk: { nodes: [] }, asked: { nodes: [] }, pushed: { nodes: [] },
    commits: commits(), reviewThreads: { nodes: [] },
    ...o,
  };
}
type Review = RawStand['mine']['nodes'][number];
const review = (state: string, day: number, commit: string, o: Partial<Review> = {}): Review => ({ state, submittedAt: at(day), body: 'A few things.', commit: { oid: commit }, comments: { nodes: [{ replyTo: null }] }, ...o });
const reply = (day: number, commit: string) => review('COMMENTED', day, commit, { body: '', comments: { nodes: [{ replyTo: { id: 'C1' } }] } });
type Thread = RawStand['reviewThreads']['nodes'][number];
// Ada's thread, or another's, and who spoke last in it, on the third day unless said otherwise.
const thread = (by: string, last: string, o: Partial<Thread> = {}, day = 3): Thread => ({
  isResolved: false, isOutdated: false, first: { nodes: [{ author: { login: by }, state: 'SUBMITTED' }] }, last: { nodes: [{ author: { login: last }, createdAt: at(day) }] }, ...o,
});
const said = (day: number, by = 'ada') => ({ author: { login: by }, createdAt: at(day) });
const asked = (day: number, by: string, of = 'ada') => ({ createdAt: at(day), actor: { login: by }, requestedReviewer: { login: of } });
const none = { open: 0, outdated: 0, answered: 0, fresh: 0, resolved: 0 };

describe('Given ada’s review of grace’s pull request on GitHub, ', () => {
  it(
    'when ada requested changes on its head, in three threads grace hasn’t answered, '
    + 'then it waits on grace, with nothing pushed since and three threads open.',
    () => {
      const s = standOf(pr({ mine: { nodes: [review('CHANGES_REQUESTED', 2, head)] }, reviewThreads: { nodes: [thread('ada', 'ada'), thread('ada', 'ada'), thread('ada', 'ada')] } }), 'ada');
      assert.deepEqual(s, {
        author: 'grace', review: { state: 'CHANGES_REQUESTED', last: 'CHANGES_REQUESTED', at: at(2), commit: head }, word: null, since: null, again: null,
        threads: { ...none, open: 3 },
      } satisfies Stand);
    },
  );

  it(
    'when grace pushed two commits after the one ada reviewed, '
    + 'then they’re counted.',
    () => {
      assert.deepEqual(standOf(pr({ mine: { nodes: [review('COMMENTED', 2, first)] }, commits: commits([1, 3, 3]) }), 'ada')?.since, { commits: 2, forced: null });
    },
  );

  it(
    'when grace force-pushed after ada’s review, and GitHub carried the review onto the new head, '
    + 'then the push says it moved.',
    () => {
      assert.deepEqual(standOf(pr({ mine: { nodes: [review('APPROVED', 2, head)] }, pushed: { nodes: [{ createdAt: at(3) }] } }), 'ada')?.since, { commits: null, forced: at(3) });
      assert.equal(standOf(pr({ mine: { nodes: [review('APPROVED', 4, head)] }, pushed: { nodes: [{ createdAt: at(3) }] } }), 'ada')?.since, null);
    },
  );

  it(
    'when ada requested changes, then commented, then only replied in a thread, and grace pushed after, '
    + 'then the changes stay requested, the comment is her latest review: the reply isn’t one, but it’s her last word.',
    () => {
      const s = standOf(pr({ mine: { nodes: [review('CHANGES_REQUESTED', 2, first), review('COMMENTED', 3, second), reply(4, second)] }, commits: commits([1, 2, 5]) }), 'ada');
      assert.deepEqual([s?.review, s?.word, s?.since], [
        { state: 'CHANGES_REQUESTED', last: 'COMMENTED', at: at(3), commit: second }, { at: at(4), how: 'reply' }, { commits: 1, forced: null },
      ]);
    },
  );

  it(
    'when grace asked for ada’s review again after it, '
    + 'then it says when and who; asked by ada herself, it says no one; asked before her review, it isn’t asked again.',
    () => {
      const again = (requests: Array<ReturnType<typeof asked>>) => standOf(pr({ mine: { nodes: [review('CHANGES_REQUESTED', 2, head)] }, reviewRequests: { nodes: [{ requestedReviewer: { login: 'Ada' } }] }, asked: { nodes: requests } }), 'ada')?.again;
      assert.deepEqual([again([asked(1, 'ada'), asked(3, 'grace')]), again([asked(3, 'ada')]), again([asked(1, 'grace')]), again([])], [
        { at: at(3), by: 'grace' }, { at: at(3), by: null }, null, { at: null, by: null },
      ]);
    },
  );

  it(
    'when ada’s threads are answered, resolved, open on lines that changed, or a draft, and others’ are open, '
    + 'then only hers count, each once.',
    () => {
      const s = standOf(pr({ mine: { nodes: [review('COMMENTED', 2, head)] }, reviewThreads: { nodes: [
        thread('ada', 'grace'),
        thread('ada', 'grace', { isResolved: true }),
        thread('ada', 'bob', { isOutdated: true }),
        thread('ada', 'ada', { first: { nodes: [{ author: { login: 'ada' }, state: 'PENDING' }] } }),
        thread('bob', 'bob'),
      ] } }), 'ada');
      assert.deepEqual(s?.threads, { open: 1, outdated: 1, answered: 1, fresh: 1, resolved: 1 });
    },
  );

  it(
    'when ada’s review went in after commits it wasn’t on, as one she began before they came does, '
    + 'then nothing was pushed since: it waits on grace.',
    () => {
      const s = standOf(pr({ mine: { nodes: [review('CHANGES_REQUESTED', 4, first)] }, commits: commits([1, 3, 3]) }), 'ada');
      assert.deepEqual([s?.word, s?.since], [null, null]);
    },
  );

  describe('when grace pushed two commits after ada’s review, and answered her thread, ', () => {
    const after = (o: Partial<RawStand>) => standOf(pr({ mine: { nodes: [review('CHANGES_REQUESTED', 2, first)] }, commits: commits([1, 3, 3]), reviewThreads: { nodes: [thread('ada', 'grace')] }, ...o }), 'ada');

    it(
      'and then ada commented in the conversation, '
      + 'then that’s her last word: nothing was pushed since it, and the answer is no news.',
      () => {
        const s = after({ talk: { nodes: [said(3, 'grace'), said(4), said(5, 'bob')] } });
        assert.deepEqual([s?.word, s?.since, s?.threads], [{ at: at(4), how: 'comment' }, null, { ...none, answered: 1 }]);
      },
    );

    it(
      'and ada commented, and grace pushed and answered again after it, '
      + 'then both are news.',
      () => {
        const s = after({ talk: { nodes: [said(4)] }, commits: commits([1, 3, 5]), reviewThreads: { nodes: [thread('ada', 'grace', {}, 5)] } });
        assert.deepEqual([s?.since, s?.threads], [{ commits: 1, forced: null }, { ...none, answered: 1, fresh: 1 }]);
      },
    );

    it(
      'and then ada pushed to grace’s branch herself, with Update branch, or with a force push, '
      + 'then that’s her last word, and her own push is no news.',
      () => {
        const merged = after({ commits: commits([1, 3, 4], ['grace', 'grace', 'ada']) });
        const forced = after({ pushed: { nodes: [{ createdAt: at(4), actor: { login: 'ada' } }] } });
        assert.deepEqual([merged?.word, merged?.since, forced?.word, forced?.since], [{ at: at(4), how: 'push' }, null, { at: at(4), how: 'push' }, null]);
      },
    );
  });

  it(
    'when the pull request is ada’s own, or merged, or her review is only a draft, '
    + 'then there’s nothing to say.',
    () => {
      const drafted = review('PENDING', 2, head, { submittedAt: null });
      assert.deepEqual([
        standOf(pr({ viewerDidAuthor: true, mine: { nodes: [review('COMMENTED', 2, head)] } }), 'ada'),
        standOf(pr({ state: 'MERGED', mine: { nodes: [review('APPROVED', 2, head)] } }), 'ada'),
        standOf(pr({ mine: { nodes: [drafted] }, reviewThreads: { nodes: [thread('ada', 'ada', { first: { nodes: [{ author: { login: 'ada' }, state: 'PENDING' }] } })] } }), 'ada'),
      ], [null, null, null]);
    },
  );
});

describe('Given two pull requests ada reviewed, and one GitHub can’t show, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};
  let got = new Map<string, Stand | null>();

  before(async () => {
    const data = {
      p0: { pullRequest: pr({ mine: { nodes: [review('APPROVED', 2, head)] } }) },
      p1: { pullRequest: null },
      p2: { pullRequest: pr({ author: { login: 'bob' }, mine: { nodes: [review('CHANGES_REQUESTED', 2, first)] }, commits: commits([1, 3, 3], ['bob', 'bob', 'bob']) }) },
    };
    gh = stubGh([
      { match: ['api', 'graphql'], stdinIncludes: 'viewer { login }', stdout: { data: { viewer: { login: 'ada' } } } },
      // gh exits 1 when GitHub answers with errors, and prints what GitHub had.
      { match: ['api', 'graphql'], stdinIncludes: 'fragment Stand', stdout: { data, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with the number of 9.' }] }, code: 1 },
    ]);
    restore = useStub(gh);
    got = await stands(['acme/app#1', 'acme/app#9', 'acme/tools#2']);
  });

  after(() => {
    restore();
    gh?.remove();
  });

  it(
    'when their stands are asked for, '
    + 'then one call asks for all three, as ada, and each gets its own: none for the one GitHub can’t show.',
    () => {
      const calls = gh!.calls().filter((c) => c.stdin.includes('fragment Stand'));
      assert.equal(calls.length, 1);
      const { variables } = JSON.parse(calls[0].stdin) as { variables: Record<string, unknown> };
      assert.deepEqual(variables, { me: 'ada', o0: 'acme', r0: 'app', n0: 1, o1: 'acme', r1: 'app', n1: 9, o2: 'acme', r2: 'tools', n2: 2 });
      assert.deepEqual([...got].map(([k, v]) => [k, v && `${v.author} ${v.review?.state} ${v.since ? v.since.commits : 'nothing'} since`]), [
        ['acme/app#1', 'grace APPROVED nothing since'],
        ['acme/app#9', null],
        ['acme/tools#2', 'bob CHANGES_REQUESTED 2 since'],
      ]);
    },
  );
});
