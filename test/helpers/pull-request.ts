// Canned `gh` answers for a directory whose branch has a pull request.
import { stubGh, type GhReply, type GhStub } from './gh.ts';

const page = { hasNextPage: false, endCursor: null };
const ada = { login: 'ada', avatarUrl: 'https://example.test/ada', url: 'https://github.com/ada' };

export interface ForcePush {
  actor: string;
  before: string;
  after: string;
  at: string;
}

export interface PullRequestAnswers {
  number: number;
  title: string;
  url: string;
  base: string;
  baseSha: string;
  head: string;
  headSha: string;
  pushes?: ForcePush[];
  /** Reviews GitHub has, each on the commit it was made on. */
  reviews?: Array<{ login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; sha: string; at?: string }>;
}

/** `pr view` for the branch, and `api graphql` for the conversation and the commit facts. */
export function pullRequestGh(pr: PullRequestAnswers): GhStub {
  return stubGh(pullRequestReplies(pr));
}

export function pullRequestReplies(pr: PullRequestAnswers): GhReply[] {
  return [
    {
      match: ['pr', 'view'],
      stdout: {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: 'OPEN',
        baseRefName: pr.base,
        baseRefOid: pr.baseSha,
        headRefName: pr.head,
        headRefOid: pr.headSha,
      },
    },
    { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: commits(pr) },
    { match: ['api', 'graphql'], stdout: conversation(pr) },
  ];
}

function conversation(pr: PullRequestAnswers) {
  return {
    data: {
      viewer: ada,
      repository: {
        pullRequest: {
          id: 'PR_1',
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: 'OPEN',
          isDraft: false,
          locked: false,
          headRefOid: pr.headSha,
          createdAt: '2020-01-02T15:00:00Z',
          body: 'Please look.',
          bodyHTML: '<p>Please look.</p>',
          viewerDidAuthor: false,
          reviewDecision: 'REVIEW_REQUIRED',
          author: ada,
          viewerCanReact: true,
          reactionGroups: [],
          pendingReviews: { nodes: [] },
          reviewThreads: { pageInfo: page, nodes: [] },
          comments: { pageInfo: page, nodes: [] },
          reviews: { pageInfo: page, nodes: [] },
        },
      },
    },
  };
}

function commits(pr: PullRequestAnswers) {
  return {
    data: {
      repository: {
        pullRequest: {
          commits: { nodes: [{ commit: { oid: pr.headSha, statusCheckRollup: { state: 'SUCCESS' } } }] },
          reviews: {
            nodes: (pr.reviews ?? []).map((r, i) => ({
              state: r.state,
              submittedAt: r.at ?? '2020-01-07T15:00:00Z',
              url: `${pr.url}#pullrequestreview-${i + 1}`,
              author: { login: r.login, avatarUrl: `https://example.test/${r.login}`, url: `https://github.com/${r.login}` },
              commit: { oid: r.sha },
            })),
          },
          timelineItems: {
            nodes: (pr.pushes ?? []).map((push) => ({
              createdAt: push.at,
              actor: { login: push.actor },
              beforeCommit: { oid: push.before },
              afterCommit: { oid: push.after },
            })),
          },
        },
      },
    },
  };
}
