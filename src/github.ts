// The pull request's conversation on GitHub: review threads, comments, reviews and the pending
// review, read and written through the gh command line. GitHub sees the user's own login (gh's),
// so untangle never handles a token.
import { spawn } from 'node:child_process';
import { has } from './exec.js';

export class GitHubError extends Error {}

/** `gh api <args>` with a JSON body; the answer, parsed when it's JSON. Partly: with the data GitHub had, and its errors for the rest. */
function ghApi(args: string[], body: unknown, partly = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', ...args, '--input', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new GitHubError('GitHub did not answer within 60 s')); }, 60_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new GitHubError(`gh: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: { data?: unknown; errors?: Array<{ message: string }> } | null = null;
      try {
        json = out.trim().startsWith('{') ? JSON.parse(out) : null;
      } catch {
        // Not JSON: rendered markdown, or an error below.
      }
      // gh exits 1 on GitHub's errors, with what GitHub had.
      if (partly && json && json.data) return resolve(json);
      if (json && json.errors && json.errors.length) return reject(new GitHubError(json.errors.map((e) => e.message).join('; ')));
      if (code !== 0) {
        const msg = (err || out).trim().replace(/^gh: /, '');
        return reject(new GitHubError(/gh auth login/.test(msg) ? 'gh is not logged in to GitHub: run `gh auth login`' : msg.split('\n')[0] || `gh exited with ${code}`));
      }
      resolve(json ?? out);
    });
    child.stdin.end(JSON.stringify(body));
  });
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = (await ghApi(['graphql'], { query, variables })) as { data: T };
  return r.data;
}

// The fields the page needs, as fragments, each with the fragments it uses.
const FRAGMENTS: Record<string, [string, string[]]> = {
  Who: ['fragment Who on Actor { login avatarUrl url }', []],
  Reacts: ['fragment Reacts on Reactable { viewerCanReact reactionGroups { content viewerHasReacted reactors { totalCount } } }', []],
  RC: [`fragment RC on PullRequestReviewComment {
    id body bodyHTML createdAt lastEditedAt url state authorAssociation viewerCanUpdate viewerCanDelete
    author { ...Who } ...Reacts
  }`, ['Who', 'Reacts']],
  TH: [`fragment TH on PullRequestReviewThread {
    id isResolved isOutdated isCollapsed path line originalLine startLine originalStartLine diffSide startDiffSide subjectType
    viewerCanResolve viewerCanUnresolve viewerCanReply resolvedBy { login }
    head: comments(first: 1) { nodes { diffHunk originalCommit { oid } } }
    comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...RC } }
  }`, ['RC']],
  IC: [`fragment IC on IssueComment {
    id body bodyHTML createdAt lastEditedAt url authorAssociation viewerCanUpdate viewerCanDelete
    author { ...Who } ...Reacts
  }`, ['Who', 'Reacts']],
  RV: [`fragment RV on PullRequestReview {
    id state body bodyHTML createdAt submittedAt url authorAssociation
    author { ...Who } comments { totalCount }
  }`, ['Who']],
  PR: [`fragment PR on PullRequest {
    id number title url state isDraft locked headRefOid createdAt body bodyHTML viewerDidAuthor reviewDecision
    author { ...Who } ...Reacts
    pendingReviews: reviews(states: PENDING, first: 1) { nodes { id body comments { totalCount } } }
    reviewThreads(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...TH } }
    comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...IC } }
    reviews(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...RV } }
  }`, ['Who', 'Reacts', 'TH', 'IC', 'RV']],
};
/** The fragments a document uses, with theirs (GraphQL refuses a document with unused ones). */
function fragments(...names: string[]): string {
  const seen = new Set<string>();
  const add = (n: string) => { if (seen.has(n)) return; seen.add(n); FRAGMENTS[n][1].forEach(add); };
  names.forEach(add);
  return [...seen].map((n) => FRAGMENTS[n][0]).join('\n');
}

// The pull request, as each mutation returns it: one call does the change and reads the result.
const PR_OF = {
  review: 'pullRequestReview { pullRequest { ...PR } }',
  thread: 'thread { pullRequest { ...PR } }',
  comment: 'comment { pullRequest { ...PR } }',
  reviewComment: 'pullRequestReviewComment { pullRequest { ...PR } }',
  issueComment: 'issueComment { pullRequest { ...PR } }',
  subject: 'subject { ... on PullRequest { ...PR } ... on PullRequestReviewComment { pullRequest { ...PR } } ... on IssueComment { pullRequest { ...PR } } }',
};

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
/** What the notes' mutations answer with: the comment or review made, and the pull request after. */
interface Payload {
  // (Each asks for the comment's url too: tests tell the pending-review lookup by its "nodes { id } }".)
  thread?: { id: string; comments?: { nodes: Array<{ id: string }> }; pullRequest?: RawPR };
  comment?: { id: string; pullRequest?: RawPR };
  pullRequestReview?: { id?: string; comments?: { nodes: Array<{ id: string }> }; pullRequest?: RawPR };
  commentEdge?: { node: { id: string } };
  subject?: RawPR;
}
interface RawPerson { login: string; avatarUrl: string; url: string }
interface RawReacts { viewerCanReact: boolean; reactionGroups: Array<{ content: string; viewerHasReacted: boolean; reactors: { totalCount: number } }> }
interface RawComment extends RawReacts { id: string; body: string; bodyHTML: string; createdAt: string; lastEditedAt: string | null; url: string; state?: string; authorAssociation: string; viewerCanUpdate: boolean; viewerCanDelete: boolean; author: RawPerson | null }
interface RawThread {
  id: string; isResolved: boolean; isOutdated: boolean; isCollapsed: boolean; path: string; line: number | null; originalLine: number | null; startLine: number | null; originalStartLine: number | null;
  diffSide: 'LEFT' | 'RIGHT'; startDiffSide: 'LEFT' | 'RIGHT' | null; subjectType: 'LINE' | 'FILE'; viewerCanResolve: boolean; viewerCanUnresolve: boolean; viewerCanReply: boolean; resolvedBy: { login: string } | null;
  head: { nodes: Array<{ diffHunk: string; originalCommit: { oid: string } | null }> }; comments: Page<RawComment>;
}
interface RawReview { id: string; state: string; body: string; bodyHTML: string; createdAt: string; submittedAt: string | null; url: string; authorAssociation: string; author: RawPerson | null; comments: { totalCount: number } }
interface RawPR extends RawReacts {
  id: string; number: number; title: string; url: string; state: string; isDraft: boolean; locked: boolean; headRefOid: string; createdAt: string; body: string; bodyHTML: string; viewerDidAuthor: boolean; reviewDecision: string | null;
  author: RawPerson | null; pendingReviews: { nodes: Array<{ id: string; body: string; comments: { totalCount: number } }> };
  reviewThreads: Page<RawThread>; comments: Page<RawComment>; reviews: Page<RawReview>;
}

export interface Person { login: string; avatar: string; url: string }
export interface Reaction { content: string; count: number; mine: boolean }
export interface Comment { id: string; author: Person; association: string; html: string; body: string; created: string; edited: string | null; url: string; pending: boolean; canEdit: boolean; canDelete: boolean; canReact: boolean; reactions: Reaction[] }
export interface Thread {
  pr?: number;
  legLine?: number | null;
  legStartLine?: number | null;
  id: string; path: string; file: boolean; side: 'LEFT' | 'RIGHT'; line: number | null; startSide: 'LEFT' | 'RIGHT' | null; startLine: number | null;
  originalLine: number | null; originalStartLine: number | null; commit: string | null; hunk: string;
  resolved: boolean; outdated: boolean; collapsed: boolean; canResolve: boolean; canUnresolve: boolean; canReply: boolean; resolvedBy: string | null; comments: Comment[];
}
export interface Review { id: string; state: string; author: Person; association: string; html: string; body: string; created: string; url: string; comments: number }
export interface Conversation {
  legs?: Conversation[];
  placed?: { pr: number; line: number | null; startLine: number | null; side: 'LEFT' | 'RIGHT' };
  viewer: Person;
  pr: { id: string; number: number; title: string; url: string; state: string; draft: boolean; locked: boolean; head: string; created: string; author: Person; html: string; body: string; decision: string | null; mine: boolean; canReact: boolean; reactions: Reaction[] };
  /** Your pending review: its comments, and its summary so far. */
  pending: { id: string; comments: number; body: string } | null;
  threads: Thread[];
  comments: Comment[];
  reviews: Review[];
}

const GHOST: Person = { login: 'ghost', avatar: '', url: 'https://github.com/ghost' };
// The pull request in a mutation's payload, wherever the payload keeps it.
const findPR = (x: unknown): RawPR | null => {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.headRefOid === 'string' && o.reviewThreads) return o as unknown as RawPR;
  for (const v of Object.values(o)) { const r = findPR(v); if (r) return r; }
  return null;
};
const person = (a: RawPerson | null): Person => (a ? { login: a.login, avatar: a.avatarUrl, url: a.url } : GHOST);
const reactions = (r: RawReacts): Reaction[] => r.reactionGroups.filter((g) => g.reactors.totalCount || g.viewerHasReacted).map((g) => ({ content: g.content, count: g.reactors.totalCount, mine: g.viewerHasReacted }));
const comment = (c: RawComment): Comment => ({
  id: c.id, author: person(c.author), association: c.authorAssociation, html: c.bodyHTML, body: c.body, created: c.createdAt, edited: c.lastEditedAt, url: c.url,
  pending: c.state === 'PENDING', canEdit: c.viewerCanUpdate, canDelete: c.viewerCanDelete, canReact: c.viewerCanReact, reactions: reactions(c),
});

/** One line of a review thread, as the page anchors it. */
/** What GitHub knows about the pull request's commits. */
export interface CommitFacts {
  /** Each commit's checks, rolled up (SUCCESS, FAILURE, PENDING, ERROR, EXPECTED), by sha. */
  checks: Record<string, string>;
  /** Submitted reviews, with the commit each was made on. */
  reviews: Array<{ sha: string | null; state: string; author: Person; at: string | null; url: string }>;
  /** Force pushes, oldest first: the head before (null when GitHub no longer has it) and after. */
  pushes: Array<{ before: string | null; after: string | null; at: string; actor: string }>;
}
export interface Draft { path: string; body: string; line?: number; side?: 'LEFT' | 'RIGHT'; startLine?: number; startSide?: 'LEFT' | 'RIGHT' }

export type Action =
  | { action: 'thread'; mode: 'single' | 'review'; draft: Draft }
  | { action: 'reply'; mode: 'single' | 'review'; thread: string; body: string }
  | { action: 'edit'; kind: 'issue' | 'review'; id: string; body: string }
  | { action: 'delete'; kind: 'issue' | 'review'; id: string }
  | { action: 'resolve'; thread: string; resolved: boolean }
  | { action: 'react'; subject: string; content: string; on: boolean }
  | { action: 'comment'; body: string; pr?: number }
  | { action: 'submit'; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string; pr?: number }
  | { action: 'discard'; pr?: number }
  /** Your pending review's summary, set: a pending review starts with it when there's none. */
  | { action: 'summary'; body: string; pr?: number }
  | { action: 'preview'; text: string }
  | { action: 'suggest'; kind: '@' | '#'; query: string };

/** What @ and # complete to: a person or team to mention, or an issue or pull request to link. */
export interface Suggestion { kind: 'user' | 'team' | 'issue' | 'pr'; value: string; label: string; detail: string; avatar?: string; state?: string }
type IssueBits = { __typename: 'Issue' | 'PullRequest'; number: number; title: string; state: string; isDraft?: boolean };
const ISSUE_BITS = '__typename ... on Issue { number title state } ... on PullRequest { number title state isDraft }';

/** gh, ready to use: it's on PATH. (Whether it's logged in shows on the first call.) */
export const ghReady = () => has('gh');

/** A pull request's conversation: what the page shows, and what it changes. */
export class PullRequestConversation {
  private viewer: Person | null = null;
  // One change at a time: two quick clicks can't start two pending reviews.
  private queue: Promise<unknown> = Promise.resolve();
  private last: Conversation | null = null;

  constructor(
    private readonly pr: { owner: string; repo: string; number: number },
    /** The commit the review shows: new threads are written against it. */
    private readonly head: string,
  ) {}

  async load(): Promise<Conversation> {
    const d = await graphql<{ viewer: RawPerson; repository: { pullRequest: RawPR | null } }>(
      `query($owner: String!, $repo: String!, $number: Int!) { viewer { ...Who } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ...PR } } } ${fragments('Who', 'PR')}`,
      { owner: this.pr.owner, repo: this.pr.repo, number: this.pr.number },
    );
    if (!d.repository.pullRequest) throw new GitHubError(`GitHub has no ${this.pr.owner}/${this.pr.repo}#${this.pr.number}`);
    this.viewer = person(d.viewer);
    return this.shape(await this.rest(d.repository.pullRequest));
  }

  /** For the commits' graph: each commit's checks, the reviews by the commit they were made on, and the force pushes. */
  async commits(): Promise<CommitFacts> {
    type Raw = {
      commits: { nodes: Array<{ commit: { oid: string; statusCheckRollup: { state: string } | null } }> };
      reviews: { nodes: Array<{ state: string; submittedAt: string | null; url: string; author: RawPerson | null; commit: { oid: string } | null }> };
      timelineItems: { nodes: Array<{ createdAt?: string; actor?: { login: string } | null; beforeCommit?: { oid: string } | null; afterCommit?: { oid: string } | null }> };
    };
    const d = await graphql<{ repository: { pullRequest: Raw | null } }>(
      `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
        commits(last: 250) { nodes { commit { oid statusCheckRollup { state } } } }
        reviews(last: 100) { nodes { state submittedAt url author { ...Who } commit { oid } } }
        timelineItems(last: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { createdAt actor { login } beforeCommit { oid } afterCommit { oid } } } }
      } } } ${fragments('Who')}`,
      { owner: this.pr.owner, repo: this.pr.repo, number: this.pr.number },
    );
    const pr = d.repository.pullRequest;
    if (!pr) throw new GitHubError(`GitHub has no ${this.pr.owner}/${this.pr.repo}#${this.pr.number}`);
    const checks: Record<string, string> = {};
    pr.commits.nodes.forEach((n) => { if (n.commit.statusCheckRollup) checks[n.commit.oid] = n.commit.statusCheckRollup.state; });
    return {
      checks,
      reviews: pr.reviews.nodes.filter((r) => r.state !== 'PENDING').map((r) => ({ sha: r.commit ? r.commit.oid : null, state: r.state, author: person(r.author), at: r.submittedAt, url: r.url })),
      pushes: pr.timelineItems.nodes.filter((n) => n.createdAt).map((n) => ({ before: n.beforeCommit ? n.beforeCommit.oid : null, after: n.afterCommit ? n.afterCommit.oid : null, at: n.createdAt!, actor: n.actor ? n.actor.login : 'ghost' })),
    };
  }

  /** Carries out a change, and answers with the conversation after it. */
  act(a: Action): Promise<Conversation | { html: string } | { items: Suggestion[] }> {
    if (a.action === 'preview') return this.preview(a.text);
    if (a.action === 'suggest') return this.suggest(a.kind, a.query);
    const run = this.queue.then(() => this.change(a));
    this.queue = run.catch(() => {});
    return run;
  }

  private async preview(text: string): Promise<{ html: string }> {
    const html = await ghApi(['markdown'], { text, mode: 'gfm', context: `${this.pr.owner}/${this.pr.repo}` });
    return { html: String(html) };
  }

  // Suggestions for @ and #, for a few minutes: typing asks again and again.
  private readonly suggestions = new Map<string, { at: number; items: Suggestion[] }>();
  // Whether the repository's owner is an organization (with teams); null until known.
  private org: boolean | null = null;

  private async suggest(kind: '@' | '#', query: string): Promise<{ items: Suggestion[] }> {
    const q = query.trim().slice(0, 60);
    const key = kind + q.toLowerCase();
    const hit = this.suggestions.get(key);
    if (hit && Date.now() - hit.at < 300_000) return { items: hit.items };
    const items = kind === '@' ? await this.people(q) : await this.issues(q);
    if (this.suggestions.size > 300) this.suggestions.clear();
    this.suggestions.set(key, { at: Date.now(), items });
    return { items };
  }

  /** People who can be mentioned here, by login or name, and the organization's teams (org/team). */
  private async people(q: string): Promise<Suggestion[]> {
    const { owner, repo } = this.pr;
    const slash = q.indexOf('/');
    const users = slash >= 0 ? Promise.resolve(null) : graphql<{ repository: { mentionableUsers: { nodes: Array<{ login: string; name: string | null; avatarUrl: string }> } } }>(
      'query($owner: String!, $repo: String!, $q: String) { repository(owner: $owner, name: $repo) { mentionableUsers(query: $q, first: 12) { nodes { login name avatarUrl } } } }',
      { owner, repo, q: q || null },
    );
    // Teams only show to who may see them; a user's repository has none.
    const teams = this.org === false ? Promise.resolve(null) : graphql<{ organization: { teams: { nodes: Array<{ combinedSlug: string; name: string; avatarUrl: string | null }> } } | null }>(
      'query($owner: String!, $q: String) { organization(login: $owner) { teams(query: $q, first: 6) { nodes { combinedSlug name avatarUrl } } } }',
      { owner, q: (slash >= 0 ? q.slice(slash + 1) : q) || null },
    ).then((d) => { this.org = !!d.organization; return d; }, (e) => { if (/resolve to an Organization/i.test((e as Error).message)) this.org = false; return null; });
    const [u, t] = await Promise.all([users, teams]);
    const out: Suggestion[] = (u?.repository.mentionableUsers.nodes || []).map((x) => ({ kind: 'user', value: x.login, label: x.login, detail: x.name || '', avatar: x.avatarUrl }));
    (t?.organization?.teams.nodes || []).filter((x) => slash < 0 || x.combinedSlug.toLowerCase().startsWith(q.toLowerCase().slice(0, slash + 1))).forEach((x) => out.push({ kind: 'team', value: x.combinedSlug, label: x.combinedSlug, detail: x.name, avatar: x.avatarUrl || undefined }));
    return out;
  }

  /** Issues and pull requests to link: the one with that number first, then matches by title, newest activity first. */
  private async issues(q: string): Promise<Suggestion[]> {
    const { owner, repo } = this.pr;
    const n = /^\d+$/.test(q) ? Number(q) : 0;
    const d = await graphql<{ search: { nodes: Array<IssueBits | Record<string, never>> }; repository: { exact?: IssueBits | null } }>(
      `query($s: String!, $owner: String!, $repo: String!, $n: Int!, $exact: Boolean!) {
        search(query: $s, type: ISSUE, first: 12) { nodes { ${ISSUE_BITS} } }
        repository(owner: $owner, name: $repo) { exact: issueOrPullRequest(number: $n) @include(if: $exact) { ${ISSUE_BITS} } }
      }`,
      { s: `repo:${owner}/${repo} ${q && !n ? q + ' in:title' : q} sort:updated-desc`, owner, repo, n, exact: n > 0 },
    );
    const seen = new Set<number>();
    return [d.repository.exact, ...d.search.nodes].filter((x): x is IssueBits => !!x && 'number' in x && !seen.has(x.number) && !!seen.add(x.number)).map((x) => ({
      kind: x.__typename === 'PullRequest' ? 'pr' : 'issue', value: String(x.number), label: '#' + x.number, detail: x.title,
      state: x.isDraft && x.state === 'OPEN' ? 'DRAFT' : x.state,
    }));
  }

  /** A mutation that returns the pull request at `path` in its payload. */
  private async mutate(name: string, input: Record<string, unknown>, payload: string): Promise<Conversation> {
    const d = await graphql<Record<string, unknown>>(`mutation($input: ${name[0].toUpperCase() + name.slice(1)}Input!) { ${name}(input: $input) { ${payload} } } ${fragments('PR')}`, { input });
    const pr = findPR(d);
    return pr ? this.shape(await this.rest(pr)) : this.load();
  }

  private async pullRequestId(): Promise<string> {
    if (this.last) return this.last.pr.id;
    return (await this.load()).pr.id;
  }

  private async change(a: Exclude<Action, { action: 'preview' | 'suggest' }>): Promise<Conversation> {
    const pullRequestId = await this.pullRequestId();
    switch (a.action) {
      case 'thread': {
        const d = a.draft;
        const line = d.line != null ? { line: d.line, side: d.side || 'RIGHT', ...(d.startLine != null && d.startLine !== d.line ? { startLine: d.startLine, startSide: d.startSide || d.side || 'RIGHT' } : {}) } : {};
        // A single comment is a review of its own, submitted at once. GitHub refuses it while a
        // review is pending, so it can never submit the pending review's comments with it.
        if (a.mode === 'single') {
          return this.mutate('addPullRequestReview', { pullRequestId, commitOID: this.head, event: 'COMMENT', threads: [{ path: d.path, body: d.body, ...line }] }, PR_OF.review).catch((e) => {
            throw /one pending review/.test((e as Error).message) ? new GitHubError('You have a review pending on GitHub: add this comment to it, or finish the review first.') : e;
          });
        }
        try {
          // Into the pending review: GitHub starts one when there's none.
          return await this.mutate('addPullRequestReviewThread', { pullRequestId, path: d.path, body: d.body, subjectType: d.line != null ? 'LINE' : 'FILE', ...line }, PR_OF.thread);
        } catch (e) {
          // A rejected thread can leave the pending review it started behind, empty.
          await this.dropEmptyPending();
          throw e;
        }
      }
      case 'reply': {
        // Without a pending review, a reply is posted at once; with one, it joins it.
        if (a.mode === 'review' && !(await this.currentPending())) {
          await graphql(`mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }`, { input: { pullRequestId, commitOID: this.head } });
        }
        return this.mutate('addPullRequestReviewThreadReply', { pullRequestReviewThreadId: a.thread, body: a.body }, PR_OF.comment);
      }
      case 'edit':
        return a.kind === 'issue'
          ? this.mutate('updateIssueComment', { id: a.id, body: a.body }, PR_OF.issueComment)
          : this.mutate('updatePullRequestReviewComment', { pullRequestReviewCommentId: a.id, body: a.body }, PR_OF.reviewComment);
      case 'delete':
        if (a.kind === 'issue') {
          await graphql(`mutation($input: DeleteIssueCommentInput!) { deleteIssueComment(input: $input) { clientMutationId } }`, { input: { id: a.id } });
          return this.load();
        }
        return this.mutate('deletePullRequestReviewComment', { id: a.id }, PR_OF.review);
      case 'resolve':
        return this.mutate(a.resolved ? 'resolveReviewThread' : 'unresolveReviewThread', { threadId: a.thread }, PR_OF.thread);
      case 'react':
        return this.mutate(a.on ? 'addReaction' : 'removeReaction', { subjectId: a.subject, content: a.content }, PR_OF.subject);
      case 'comment':
        return this.mutate('addComment', { subjectId: pullRequestId, body: a.body }, PR_OF.subject);
      case 'submit': {
        const pending = await this.currentPending();
        return pending
          ? this.mutate('submitPullRequestReview', { pullRequestReviewId: pending, event: a.event, body: a.body }, PR_OF.review)
          : this.mutate('addPullRequestReview', { pullRequestId, commitOID: this.head, event: a.event, body: a.body }, PR_OF.review);
      }
      case 'discard': {
        const pending = await this.currentPending();
        return pending ? this.mutate('deletePullRequestReview', { pullRequestReviewId: pending }, PR_OF.review) : this.load();
      }
      case 'summary': {
        const pending = await this.currentPending();
        return pending
          ? this.mutate('updatePullRequestReview', { pullRequestReviewId: pending, body: a.body }, PR_OF.review)
          : this.mutate('addPullRequestReview', { pullRequestId, commitOID: this.head, body: a.body }, PR_OF.review);
      }
    }
  }

  // ---- What the notes post: each answers with the conversation after it, and the new comment's id.

  /** One change in the queue, as `act`'s are: two quick ones can't start two pending reviews. */
  private queued<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f);
    this.queue = run.catch(() => {});
    return run;
  }

  /** A mutation's payload with the pull request in it, shaped, and the payload itself. */
  private async mutateRaw(name: string, input: Record<string, unknown>, payload: string): Promise<{ data: Payload; conversation: Conversation }> {
    const data = await graphql<Record<string, Payload>>(`mutation($input: ${name[0].toUpperCase() + name.slice(1)}Input!) { ${name}(input: $input) { ${payload} } } ${fragments('PR')}`, { input });
    const p = data[name] || {};
    const pr = findPR(data);
    return { data: p, conversation: pr ? this.shape(await this.rest(pr)) : await this.load() };
  }

  /** The comment a mutation made, when its payload doesn't say: new since `before`, with this text. */
  private made(before: Conversation | null, after: Conversation, body: string): { thread: string | null; comment: string } | null {
    const old = new Set(before ? before.threads.flatMap((t) => t.comments.map((c) => c.id)).concat(before.comments.map((c) => c.id)) : []);
    const same = (c: Comment) => !old.has(c.id) && c.body.trim() === body.trim();
    for (const t of after.threads) for (const c of t.comments) if (same(c)) return { thread: t.id, comment: c.id };
    for (const c of after.comments) if (same(c)) return { thread: null, comment: c.id };
    return null;
  }

  /** A thread of its own on lines or a file: into the pending review, or a review of its own, posted at once. */
  postThread(d: Draft, mode: 'single' | 'review'): Promise<{ conversation: Conversation; thread: string; comment: string }> {
    return this.queued(async () => {
      const pullRequestId = await this.pullRequestId();
      const before = this.last;
      const line = d.line != null ? { line: d.line, side: d.side || 'RIGHT', ...(d.startLine != null && d.startLine !== d.line ? { startLine: d.startLine, startSide: d.startSide || d.side || 'RIGHT' } : {}) } : {};
      if (mode === 'single') {
        const r = await this.mutateRaw('addPullRequestReview', { pullRequestId, commitOID: this.head, event: 'COMMENT', threads: [{ path: d.path, body: d.body, ...line }] }, 'pullRequestReview { comments(first: 1) { nodes { id url } } pullRequest { ...PR } }').catch((e) => {
          throw /one pending review/.test((e as Error).message) ? new GitHubError('You have a review pending on GitHub: add this comment to it, or finish the review first.') : e;
        });
        const id = r.data.pullRequestReview?.comments?.nodes[0]?.id;
        const thread = id ? r.conversation.threads.find((t) => t.comments.some((c) => c.id === id)) : null;
        const m = id && thread ? { thread: thread.id, comment: id } : this.made(before, r.conversation, d.body);
        if (!m || !m.thread) throw new GitHubError('GitHub didn’t say which comment it made');
        return { conversation: r.conversation, thread: m.thread, comment: m.comment };
      }
      try {
        const r = await this.mutateRaw('addPullRequestReviewThread', { pullRequestId, path: d.path, body: d.body, subjectType: d.line != null ? 'LINE' : 'FILE', ...line }, 'thread { id comments(first: 1) { nodes { id url } } pullRequest { ...PR } }');
        const t = r.data.thread;
        const m = t && t.comments?.nodes[0] ? { thread: t.id, comment: t.comments.nodes[0].id } : this.made(before, r.conversation, d.body);
        if (!m || !m.thread) throw new GitHubError('GitHub didn’t say which comment it made');
        return { conversation: r.conversation, thread: m.thread, comment: m.comment };
      } catch (e) {
        await this.dropEmptyPending();
        throw e;
      }
    });
  }

  /** A reply in a review thread: into the pending review (started when there's none), or posted at once. */
  postReply(thread: string, body: string, mode: 'single' | 'review'): Promise<{ conversation: Conversation; comment: string }> {
    return this.queued(async () => {
      const pullRequestId = await this.pullRequestId();
      const before = this.last;
      if (mode === 'review' && !(await this.currentPending())) {
        await graphql(`mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }`, { input: { pullRequestId, commitOID: this.head } });
      }
      const r = await this.mutateRaw('addPullRequestReviewThreadReply', { pullRequestReviewThreadId: thread, body }, 'comment { id pullRequest { ...PR } }');
      const id = r.data.comment?.id || this.made(before, r.conversation, body)?.comment;
      if (!id) throw new GitHubError('GitHub didn’t say which comment it made');
      return { conversation: r.conversation, comment: id };
    });
  }

  /** A comment on the conversation, posted at once (GitHub keeps none of these pending). */
  postConversation(body: string): Promise<{ conversation: Conversation; comment: string }> {
    return this.queued(async () => {
      const pullRequestId = await this.pullRequestId();
      const before = this.last;
      const r = await this.mutateRaw('addComment', { subjectId: pullRequestId, body }, 'commentEdge { node { id } } subject { ... on PullRequest { ...PR } }');
      const id = r.data.commentEdge?.node.id || this.made(before, r.conversation, body)?.comment;
      if (!id) throw new GitHubError('GitHub didn’t say which comment it made');
      return { conversation: r.conversation, comment: id };
    });
  }

  /** The pending review's summary: set on the pending review, or a pending review started with it. */
  setSummary(body: string): Promise<{ conversation: Conversation; review: string }> {
    return this.queued(async () => {
      const pending = await this.currentPending();
      if (pending) {
        const r = await this.mutateRaw('updatePullRequestReview', { pullRequestReviewId: pending, body }, 'pullRequestReview { id pullRequest { ...PR } }');
        return { conversation: r.conversation, review: pending };
      }
      const r = await this.mutateRaw('addPullRequestReview', { pullRequestId: await this.pullRequestId(), commitOID: this.head, body }, 'pullRequestReview { id pullRequest { ...PR } }');
      const id = r.data.pullRequestReview?.id || r.conversation.pending?.id;
      if (!id) throw new GitHubError('GitHub didn’t say which review it started');
      return { conversation: r.conversation, review: id };
    });
  }

  /** Rewrites a review comment. */
  editComment(id: string, body: string): Promise<{ conversation: Conversation }> {
    return this.queued(async () => ({ conversation: await this.mutate('updatePullRequestReviewComment', { pullRequestReviewCommentId: id, body }, PR_OF.reviewComment) }));
  }

  /** What GitHub last said of a comment, as the page or the notes last read it. */
  known(id: string): { body: string; pending: boolean } | null {
    const d = this.last;
    if (!d) return null;
    for (const t of d.threads) { const c = t.comments.find((x) => x.id === id); if (c) return { body: c.body, pending: c.pending }; }
    const c = d.comments.find((x) => x.id === id);
    return c ? { body: c.body, pending: false } : null;
  }

  knownConversation(): Conversation | null {
    return this.last;
  }

  /** The pending review, as last read. */
  knownPending(): { id: string; body: string } | null {
    const p = this.last?.pending;
    return p ? { id: p.id, body: p.body } : null;
  }

  /** GitHub's pull request is on newer commits than the review, as last read. */
  knownStale(): boolean {
    return !!this.last && this.last.pr.head !== this.head;
  }

  /** The viewer's pending review on GitHub now (it may have been started or submitted elsewhere). */
  private async currentPending(): Promise<string | null> {
    const d = await graphql<{ repository: { pullRequest: { reviews: { nodes: Array<{ id: string }> } } } }>(
      'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviews(states: PENDING, first: 1) { nodes { id } } } } }',
      { owner: this.pr.owner, repo: this.pr.repo, number: this.pr.number },
    );
    return d.repository.pullRequest.reviews.nodes[0]?.id || null;
  }

  private async dropEmptyPending(): Promise<void> {
    try {
      const d = await graphql<{ repository: { pullRequest: { reviews: { nodes: Array<{ id: string; body: string; comments: { totalCount: number } }> } } } }>(
        'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviews(states: PENDING, first: 1) { nodes { id body comments { totalCount } } } } } }',
        { owner: this.pr.owner, repo: this.pr.repo, number: this.pr.number },
      );
      const p = d.repository.pullRequest.reviews.nodes[0];
      if (p && !p.comments.totalCount && !p.body) await graphql('mutation($input: DeletePullRequestReviewInput!) { deletePullRequestReview(input: $input) { clientMutationId } }', { input: { pullRequestReviewId: p.id } });
    } catch {
      // Left as it is: GitHub shows it, and it can be discarded.
    }
  }

  /** The pages past the first hundred threads, comments and reviews, and comments in long threads. */
  private async rest(pr: RawPR): Promise<RawPR> {
    const more = async <T>(field: string, fragment: string, page: Page<T>) => {
      let p = page;
      while (p.pageInfo.hasNextPage) {
        const d = await graphql<{ node: Record<string, Page<T>> }>(`query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest { ${field}(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...${fragment} } } } } } ${fragments(fragment)}`, { id: pr.id, after: p.pageInfo.endCursor });
        p = d.node[field];
        page.nodes.push(...p.nodes);
      }
    };
    await more('reviewThreads', 'TH', pr.reviewThreads);
    await more('comments', 'IC', pr.comments);
    await more('reviews', 'RV', pr.reviews);
    for (const t of pr.reviewThreads.nodes) {
      let p = t.comments;
      while (p.pageInfo.hasNextPage) {
        const d = await graphql<{ node: { comments: Page<RawComment> } }>(`query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...RC } } } } } ${fragments('RC')}`, { id: t.id, after: p.pageInfo.endCursor });
        p = d.node.comments;
        t.comments.nodes.push(...p.nodes);
      }
    }
    return pr;
  }

  private shape(pr: RawPR): Conversation {
    const pending = pr.pendingReviews.nodes[0];
    this.last = {
      viewer: this.viewer || GHOST,
      pr: {
        id: pr.id, number: pr.number, title: pr.title, url: pr.url, state: pr.state, draft: pr.isDraft, locked: pr.locked, head: pr.headRefOid, created: pr.createdAt,
        author: person(pr.author), html: pr.bodyHTML, body: pr.body, decision: pr.reviewDecision, mine: pr.viewerDidAuthor, canReact: pr.viewerCanReact, reactions: reactions(pr),
      },
      pending: pending ? { id: pending.id, comments: pending.comments.totalCount, body: pending.body } : null,
      threads: pr.reviewThreads.nodes.map((t) => ({
        id: t.id, path: t.path, file: t.subjectType === 'FILE', side: t.diffSide, line: t.line, startSide: t.startDiffSide, startLine: t.startLine,
        originalLine: t.originalLine, originalStartLine: t.originalStartLine, commit: t.head.nodes[0]?.originalCommit?.oid || null, hunk: t.head.nodes[0]?.diffHunk || '',
        resolved: t.isResolved, outdated: t.isOutdated, collapsed: t.isCollapsed, canResolve: t.viewerCanResolve, canUnresolve: t.viewerCanUnresolve, canReply: t.viewerCanReply,
        resolvedBy: t.resolvedBy?.login || null, comments: t.comments.nodes.map(comment),
      })),
      comments: pr.comments.nodes.map(comment),
      reviews: pr.reviews.nodes.filter((r) => r.state !== 'PENDING').map((r) => ({
        id: r.id, state: r.state, author: person(r.author), association: r.authorAssociation, html: r.bodyHTML, body: r.body, created: r.submittedAt || r.createdAt, url: r.url, comments: r.comments.totalCount,
      })),
    };
    return this.last;
  }
}

// ---- Where your reviews stand: for the Reviews page

/** Where your review of a pull request stands on GitHub: whose move it is, as the Reviews page says. */
export interface Stand {
  /** The pull request's author. */
  author: string;
  /**
   * Your reviews posted (replies in threads alone aren't one): your verdict, and your latest review,
   * which may only comment on it: what it was, when, and the commit it was on.
   */
  review: { state: Verdict; last: Verdict; at: string; commit: string | null } | null;
  /**
   * Your last word on it, when it came after your latest review: a reply in a thread, a comment in its
   * conversation, or a push of yours.
   */
  word: { at: string; how: 'reply' | 'comment' | 'push' } | null;
  /**
   * Pushed by others since your last word: the commits dated after it (null when a force push may
   * have rewritten older ones), and when it was force-pushed.
   */
  since: { commits: number | null; forced: string | null } | null;
  /** Your review asked for again after it: when, and by whom (null for you), when GitHub's timeline says. */
  again: { at: string | null; by: string | null } | null;
  /**
   * Your threads: those the author hasn't answered nor resolved (outdated among them), those answered
   * (fresh: since your last word), and those resolved.
   */
  threads: { open: number; outdated: number; answered: number; fresh: number; resolved: number };
}

type Verdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
type Login = { login?: string } | null;
/** A pull request, as the Stand fragment reads it. */
export interface RawStand {
  state: string; headRefOid: string; viewerDidAuthor: boolean; author: Login;
  reviewRequests: { nodes: Array<{ requestedReviewer: Login }> };
  mine: { nodes: Array<{ state: string; submittedAt: string | null; body: string; commit: { oid: string } | null; comments: { nodes: Array<{ replyTo: { id: string } | null }> } }> };
  talk: { nodes: Array<{ author: Login; createdAt: string }> };
  asked: { nodes: Array<{ createdAt?: string; actor?: Login; requestedReviewer?: Login }> };
  pushed: { nodes: Array<{ createdAt?: string; actor?: Login }> };
  commits: { nodes: Array<{ commit: { oid: string; committedDate: string; author: { user: Login } | null } }> };
  reviewThreads: { nodes: Array<{ isResolved: boolean; isOutdated: boolean; first: { nodes: Array<{ author: Login; state: string }> }; last: { nodes: Array<{ author: Login; createdAt: string }> } }> };
}
const STAND = `fragment Stand on PullRequest {
  state headRefOid viewerDidAuthor author { login }
  reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } } } }
  mine: reviews(last: 20, author: $me) { nodes { state submittedAt body commit { oid } comments(first: 10) { nodes { replyTo { id } } } } }
  talk: comments(last: 20) { nodes { author { login } createdAt } }
  asked: timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } } } } }
  pushed: timelineItems(last: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { createdAt actor { login } } } }
  commits(last: 100) { nodes { commit { oid committedDate author { user { login } } } } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated first: comments(first: 1) { nodes { author { login } state } } last: comments(last: 1) { nodes { author { login } createdAt } } } }
}`;

/** Where your review of a pull request stands, from what GitHub says of it; none for one you wrote, one not open, or one you haven't reviewed. */
export function standOf(p: RawStand, me: string): Stand | null {
  if (p.viewerDidAuthor || p.state !== 'OPEN') return null;
  const is = (a: Login | undefined, login: string) => !!a?.login && a.login.toLowerCase() === login.toLowerCase();
  const author = p.author?.login ?? 'ghost';
  const ms = (iso: string) => Date.parse(iso);
  const submitted = p.mine.nodes.filter((r) => r.state !== 'PENDING' && r.submittedAt);
  // Your reviews posted: one that only replies in threads answers there, and doesn't review.
  const replies = (r: RawStand['mine']['nodes'][number]) => r.state === 'COMMENTED' && r.body.trim() === '' && r.comments.nodes.length > 0 && r.comments.nodes.every((c) => c.replyTo);
  const posted = submitted.filter((r) => !replies(r)).sort((a, b) => ms(a.submittedAt!) - ms(b.submittedAt!));
  const last = posted[posted.length - 1];
  // A verdict stands until the next, as GitHub counts it: a comment after changes requested leaves
  // them requested. One dismissed is a comment.
  const said = (state: string): Verdict => (state === 'APPROVED' || state === 'CHANGES_REQUESTED' ? state : 'COMMENTED');
  const verdict = [...posted].reverse().find((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED');
  const review: Stand['review'] = last ? { state: said(verdict?.state ?? 'COMMENTED'), last: said(last.state), at: last.submittedAt!, commit: last.commit?.oid ?? null } : null;
  // Your last word on it: a review, a reply in a thread, a comment in its conversation, or a push: a
  // commit you made (the Update branch button's among them), or a force push. What others did before
  // it isn't news to you.
  const mine = (n: RawStand['commits']['nodes'][number]) => is(n.commit.author?.user, me);
  const word = [
    ...submitted.map((r) => ({ at: r.submittedAt!, how: replies(r) ? 'reply' as const : 'review' as const })),
    ...p.talk.nodes.filter((c) => is(c.author, me)).map((c) => ({ at: c.createdAt, how: 'comment' as const })),
    ...p.commits.nodes.filter(mine).map((n) => ({ at: n.commit.committedDate, how: 'push' as const })),
    ...p.pushed.nodes.filter((e) => e.createdAt && is(e.actor, me)).map((e) => ({ at: e.createdAt!, how: 'push' as const })),
  ].sort((a, b) => ms(a.at) - ms(b.at)).pop();
  const later = (iso: string | undefined) => !!iso && (!word || ms(iso) > ms(word.at));
  // A force push can carry your review onto the new head with it: then only the push says it moved.
  const forced = (review && p.pushed.nodes.find((e) => later(e.createdAt) && !is(e.actor, me))?.createdAt) || null;
  // Others' commits dated after your last word: GitHub doesn't say when a commit was pushed. After a
  // force push, only those after the commit you reviewed, if it's still on the branch: the others may
  // be older ones it rewrote.
  const oids = p.commits.nodes.map((n) => n.commit.oid);
  const at = review?.commit && review.commit !== p.headRefOid ? oids.lastIndexOf(review.commit) : -1;
  const pushed = p.commits.nodes.filter((n, i) => !mine(n) && later(n.commit.committedDate) && (!forced || i > at)).length;
  const since: Stand['since'] = review && (pushed || forced) ? { commits: pushed && (!forced || at >= 0) ? pushed : null, forced } : null;
  // Asked for again: GitHub drops a request once its review is in, so one still there came after,
  // unless the timeline says it came before.
  const asked = p.asked.nodes.filter((e) => e.createdAt && is(e.requestedReviewer, me)).pop();
  const again = review && p.reviewRequests.nodes.some((n) => is(n.requestedReviewer, me)) && (!asked || ms(asked.createdAt!) > ms(review.at))
    ? { at: asked?.createdAt ?? null, by: asked?.actor?.login && !is(asked.actor, me) ? asked.actor.login : null }
    : null;
  const threads = { open: 0, outdated: 0, answered: 0, fresh: 0, resolved: 0 };
  for (const t of p.reviewThreads.nodes) {
    const first = t.first.nodes[0], answer = t.last.nodes[0];
    // Yours, and posted: a pending one is still your draft.
    if (!first || !is(first.author, me) || first.state === 'PENDING') continue;
    if (t.isResolved) threads.resolved++;
    else if (is(answer?.author, author)) {
      threads.answered++;
      if (later(answer.createdAt)) threads.fresh++;
    } else {
      threads.open++;
      if (t.isOutdated) threads.outdated++;
    }
  }
  return review || threads.open || threads.answered
    ? { author, review, word: word && word.how !== 'review' ? { at: word.at, how: word.how } : null, since, again, threads }
    : null;
}

// Your login, as gh has it: asked once.
let login: Promise<string> | null = null;

/**
 * Where your reviews of these pull requests stand (owner/repo#n each), in one call to GitHub; none
 * for those `standOf` has nothing to say of, or GitHub doesn't show.
 */
export async function stands(prs: string[]): Promise<Map<string, Stand | null>> {
  login ??= graphql<{ viewer: { login: string } }>('query { viewer { login } }').then((d) => d.viewer.login);
  const me = await login.catch((e: unknown) => { login = null; throw e; });
  const asked = prs.map((pr) => ({ pr, m: /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(pr) })).filter((x): x is { pr: string; m: RegExpExecArray } => !!x.m);
  const out = new Map<string, Stand | null>();
  if (!asked.length) return out;
  const variables: Record<string, unknown> = { me };
  asked.forEach(({ m }, i) => Object.assign(variables, { [`o${i}`]: m[1], [`r${i}`]: m[2], [`n${i}`]: Number(m[3]) }));
  const query = `query($me: String!, ${asked.map((_, i) => `$o${i}: String!, $r${i}: String!, $n${i}: Int!`).join(', ')}) {
    ${asked.map((_, i) => `p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { ...Stand } }`).join('\n    ')}
  } ${STAND}`;
  // One that GitHub can't show doesn't spoil the others.
  const r = (await ghApi(['graphql'], { query, variables }, true)) as { data?: Record<string, { pullRequest: RawStand | null } | null> };
  asked.forEach(({ pr }, i) => {
    const p = r.data?.[`p${i}`]?.pullRequest;
    out.set(pr, p ? standOf(p, me) : null);
  });
  return out;
}
