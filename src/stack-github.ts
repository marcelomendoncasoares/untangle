// Every leg keeps its own conversation and pending review. Only the coordinates are shared.
import { GitHubError, PullRequestConversation, type Action, type Conversation, type Draft } from './github.js';
import type { StackLines } from './stack-lines.js';
import type { Target } from './target.js';

export class StackConversation {
  private readonly conversations = new Map<number, PullRequestConversation>();

  constructor(private readonly target: Target, private readonly lines: StackLines) {
    for (const { pr } of target.stack!.legs) this.conversations.set(pr.number, new PullRequestConversation(pr, pr.headRefOid));
  }

  private leg(pr = this.target.pr!.number): PullRequestConversation {
    const c = this.conversations.get(pr);
    if (!c) throw new GitHubError(`#${pr} is not in this stack`);
    return c;
  }

  private owns(id: string): PullRequestConversation | null {
    for (const c of this.conversations.values()) {
      const d = c.knownConversation();
      if (d && (d.pr.id === id || d.pending?.id === id || d.reviews.some((r) => r.id === id) || d.threads.some((t) => t.id === id) || c.known(id))) return c;
    }
    return null;
  }

  private async owner(id: string): Promise<PullRequestConversation> {
    let c = this.owns(id);
    if (!c) { await this.load(); c = this.owns(id); }
    if (!c) throw new GitHubError('This comment or thread is no longer in the stack. Reload its conversation.');
    return c;
  }

  private async mapped(d: Conversation): Promise<Conversation> {
    const threads = await Promise.all(d.threads.map(async (t) => {
      const at = !t.outdated && t.line != null ? await this.lines.fromLeg(d.pr.number, t.side, t.path, t.line, d.pr.head) : null;
      const start = at && t.startLine != null ? await this.lines.fromLeg(d.pr.number, t.startSide ?? t.side, t.path, t.startLine, d.pr.head) : null;
      const lost = !t.file && (!at || (t.startLine != null && (!start || start.path !== at.path)));
      return { ...t, pr: d.pr.number, legLine: t.line, legStartLine: t.startLine, path: at?.path ?? t.path, line: lost ? null : at?.line ?? null, startLine: lost ? null : start?.line ?? null, outdated: t.outdated || lost };
    }));
    return { ...d, threads };
  }

  private async view(): Promise<Conversation> {
    const all = await Promise.all([...this.conversations.values()].map(async (c) => this.mapped(c.knownConversation() ?? await c.load())));
    return { ...all[0], legs: all.slice(1) };
  }

  async load(): Promise<Conversation> {
    await Promise.all([...this.conversations.values()].map((c) => c.load()));
    return this.view();
  }

  commits() { return this.leg().commits(); }

  async act(a: Action) {
    if (a.action === 'preview' || a.action === 'suggest') return this.leg().act(a);
    if (a.action === 'thread') {
      const placed = this.lines.place(a.draft);
      await this.leg(placed.pr).act({ ...a, draft: { ...a.draft, path: placed.path, line: placed.line ?? undefined, startLine: placed.startLine ?? undefined, side: placed.side, startSide: placed.side } });
      const { path: _, ...where } = placed;
      return { ...await this.view(), placed: where };
    }
    const id = a.action === 'reply' || a.action === 'resolve' ? a.thread : a.action === 'react' ? a.subject : a.action === 'edit' || a.action === 'delete' ? a.id : null;
    const c = id ? await this.owner(id) : this.leg('pr' in a ? a.pr : undefined);
    await c.act(a);
    return this.view();
  }

  async postThread(d: Draft & { pr?: number | null }, mode: 'single' | 'review') {
    const placed = this.lines.place(d, d.pr);
    const result = await this.leg(placed.pr).postThread({ ...d, path: placed.path, line: placed.line ?? undefined, startLine: placed.startLine ?? undefined, side: placed.side, startSide: placed.side }, mode);
    return { ...result, conversation: await this.view() };
  }

  async postReply(thread: string, body: string, mode: 'single' | 'review') {
    const result = await (await this.owner(thread)).postReply(thread, body, mode);
    return { ...result, conversation: await this.view() };
  }

  async postConversation(body: string) {
    const result = await this.leg().postConversation(body);
    return { ...result, conversation: await this.view() };
  }

  async setSummary(body: string) {
    const result = await this.leg().setSummary(body);
    return { ...result, conversation: await this.view() };
  }

  async editComment(id: string, body: string) {
    await (await this.owner(id)).editComment(id, body);
    return { conversation: await this.view() };
  }

  known(id: string) { return this.owns(id)?.known(id) ?? null; }
  legOf(id: string): number | null { return this.owns(id)?.knownConversation()?.pr.number ?? null; }
  knownPending() { return this.leg().knownPending(); }
  knownStale(pr?: number | null) { return this.leg(pr ?? undefined).knownStale(); }
}
