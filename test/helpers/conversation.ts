// A pull request document the stub can return, and the GraphQL envelopes around it.
const empty = { hasNextPage: false, endCursor: null };

const ada = { login: 'ada', avatarUrl: 'https://example.test/ada', url: 'https://github.com/ada' };
const grace = { login: 'grace', avatarUrl: 'https://example.test/grace', url: 'https://github.com/grace' };

export interface ThreadSpec {
  id: string;
  path: string;
  line: number;
  /** The first of its lines, for a thread on more than one. */
  startLine?: number;
  body: string;
  resolved?: boolean;
  /** A second comment, after the first. */
  reply?: string;
  pending?: boolean;
  /** On code the pull request no longer has: GitHub gives it no line now. */
  outdated?: boolean;
}

export interface ReviewSpec {
  id: string;
  state: string;
  body: string;
}

export interface ConversationSpec {
  number: number;
  title: string;
  url: string;
  head: string;
  threads?: ThreadSpec[];
  reviews?: ReviewSpec[];
  /** Set when a review is waiting to be finished, with its summary so far. */
  pending?: { id: string; comments: number; body?: string } | null;
  /** The description as GitHub rendered it, when a test needs particular HTML. */
  html?: string;
  /** Comments on the conversation, by ada, in order. */
  comments?: Array<{ id: string; body: string }>;
}

function reacts() {
  return { viewerCanReact: true, reactionGroups: [] as [] };
}

function rawComment(id: string, body: string, author: typeof ada, pending = false) {
  return {
    id, body, bodyHTML: `<p>${body}</p>`, createdAt: '2020-06-01T15:00:00Z', lastEditedAt: null,
    url: `https://github.com/${id}`, state: pending ? 'PENDING' : 'SUBMITTED', authorAssociation: 'MEMBER',
    viewerCanUpdate: true, viewerCanDelete: true, author, ...reacts(),
  };
}

/** The pull request GitHub would return, with the threads and reviews named here. */
export function pullRequest(spec: ConversationSpec) {
  return {
    id: 'PR_1',
    number: spec.number,
    title: spec.title,
    url: spec.url,
    state: 'OPEN',
    isDraft: false,
    locked: false,
    headRefOid: spec.head,
    createdAt: '2020-06-01T15:00:00Z',
    body: 'Please look.',
    bodyHTML: spec.html ?? '<p>Please look.</p>',
    viewerDidAuthor: false,
    reviewDecision: 'REVIEW_REQUIRED',
    author: grace,
    ...reacts(),
    pendingReviews: {
      nodes: spec.pending ? [{ id: spec.pending.id, body: spec.pending.body ?? '', comments: { totalCount: spec.pending.comments } }] : [],
    },
    reviewThreads: {
      pageInfo: empty,
      nodes: (spec.threads ?? []).map((thread) => ({
        id: thread.id,
        isResolved: !!thread.resolved,
        isOutdated: !!thread.outdated,
        isCollapsed: false,
        path: thread.path,
        line: thread.outdated ? null : thread.line,
        originalLine: thread.line,
        startLine: thread.startLine ?? null,
        originalStartLine: thread.startLine ?? null,
        diffSide: 'RIGHT',
        startDiffSide: thread.startLine != null ? 'RIGHT' : null,
        subjectType: 'LINE',
        viewerCanResolve: !thread.resolved,
        viewerCanUnresolve: !!thread.resolved,
        viewerCanReply: true,
        resolvedBy: thread.resolved ? { login: 'ada' } : null,
        head: { nodes: [{ diffHunk: '@@ -1 +1 @@\n+code', originalCommit: { oid: spec.head } }] },
        comments: {
          pageInfo: empty,
          nodes: [
            rawComment(`${thread.id}_C`, thread.body, grace, !!thread.pending),
            ...(thread.reply ? [rawComment(`${thread.id}_R`, thread.reply, ada)] : []),
          ],
        },
      })),
    },
    comments: { pageInfo: empty, nodes: (spec.comments ?? []).map((c) => rawComment(c.id, c.body, ada)) },
    reviews: {
      pageInfo: empty,
      nodes: (spec.reviews ?? []).map((review) => ({
        id: review.id,
        state: review.state,
        body: review.body,
        bodyHTML: `<p>${review.body}</p>`,
        createdAt: '2020-06-02T15:00:00Z',
        submittedAt: '2020-06-02T15:00:00Z',
        url: `https://github.com/${review.id}`,
        authorAssociation: 'MEMBER',
        author: ada,
        comments: { totalCount: 0 },
      })),
    },
  };
}

/** A query answer whose pull request `shape` can read. */
export function conversationOf(spec: ConversationSpec) {
  return { data: { viewer: ada, repository: { pullRequest: pullRequest(spec) } } };
}

/**
 * The pending-review lookup asks only for each review's id. The conversation query also mentions
 * pending reviews, and it asks for their body, so this text matches the lookup alone.
 */
export const pendingLookup = 'nodes { id } }';

export function pendingAnswer(id: string | null) {
  return { data: { repository: { pullRequest: { reviews: { nodes: id ? [{ id }] : [] } } } } };
}

export function mentionAnswer() {
  return {
    data: {
      repository: { mentionableUsers: { nodes: [{ login: 'ada', name: 'Ada Review', avatarUrl: ada.avatarUrl }] } },
    },
  };
}

export function issueAnswer() {
  return {
    data: {
      search: { nodes: [] },
      repository: { exact: { __typename: 'Issue', number: 12, title: 'The name', state: 'OPEN' } },
    },
  };
}
