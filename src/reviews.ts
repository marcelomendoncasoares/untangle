// untangle reviews: the reviews on this machine, from their records. Running ones also say what
// they're doing now (their agents, the memory they hold), asked of each review's own API; the
// others say what they hold on disk.
import '../viewer/core.js';
import { call } from './client.js';
import { openPage } from './open.js';
import type { Status, StepStatus } from './narrate.js';
import type { AgentView } from './notes.js';
import { dirSize, listRecords, type Listed } from './records.js';
import { keptDirs } from './space.js';
import { listRuns } from './runs.js';

/** What a running review says of itself, through its summary route. */
export interface Summary {
  title: string;
  /** The build: its phase, the step it's on, the steps it expects, and why it failed. */
  phase: Status['phase'];
  step: StepStatus | null;
  plan: string[] | null;
  error: string | null;
  head: string | null;
  progress: { done: number; total: number } | null;
  notes: { open: number; waiting: number } | null;
  /** The open notes an agent had the last word on: they wait for your answer. */
  waiting: Array<{ n: number; path: string; line: number | null; by: string; wrote: boolean }>;
  agents: AgentView[];
  /** Bytes in memory: untangle's own, and its language server's. */
  memory: { untangle: number; lsp: number | null };
  /** The pages open on it now. */
  pages: number;
  /** When it was last in use, in ms: a page in front, its notes changing, an agent at work. */
  active: number;
  /** A newer head being built, when it's refreshing. */
  refreshing: unknown;
}

/** The summary of each running review, by its process, asked of them all at once. */
export async function summaries(list: Listed[]): Promise<Map<number, Summary>> {
  const runs = new Map(listRuns().map((r) => [r.pid, r]));
  const out = new Map<number, Summary>();
  await Promise.all(list.filter((r) => r.status === 'running' && r.pid != null && runs.has(r.pid)).map(async (r) => {
    try {
      const a = await call(runs.get(r.pid!)!, 'GET', 'summary', { timeout: 5000 });
      if (a.status === 200) out.set(r.pid!, a.data as unknown as Summary);
    } catch {
      // Stopping as we asked.
    }
  }));
  return out;
}

/** Bytes as people read them: 512 KB, 237 MB, 1.4 GB. */
export function bytes(n: number): string {
  if (n < 1 << 20) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1000 * (1 << 20)) return `${Math.round(n / (1 << 20))} MB`;
  return `${(n / (1 << 30)).toFixed(1)} GB`;
}

/** A review's short name: serverpod#5869, or the repository's for a branch. */
export function shortName(r: Pick<Listed, 'pr' | 'repoKey' | 'dir'>): string {
  if (r.pr) return r.pr.replace(/^[^/]+\//, '');
  return r.repoKey.startsWith('local/') && r.dir ? r.dir.split(/[\\/]/).pop()! : r.repoKey.split('/').pop()!;
}

/** The title without the pull request's number, which the name has. */
export const titleOf = (r: Pick<Listed, 'title' | 'pr'>) => (r.pr ? r.title.replace(/^#\d+ /, '') : r.title);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const fmt = (n: number) => n.toLocaleString('en-US');

/** Where a review's agent is: the label its page shows while it runs, the chat it keeps otherwise. */
export function agentOf(r: Listed, s: Summary | undefined): string {
  if (r.status === 'running') {
    const a = s?.agents[0];
    return a ? globalThis.ReviewCore.agentLabel(a) : 'no agent';
  }
  const c = r.chats[0];
  return c ? `${c.agent}’s chat, kept` : 'no agent';
}

/**
 * Opens the manager's page, starting the manager when it isn't running; -list prints the reviews
 * instead, and -serve is the manager itself.
 */
export async function reviews(o: { list: boolean; open: boolean; port: number | null; serve: boolean }): Promise<number> {
  if (o.list) return printReviews();
  const { findManager, serveManager, startManager } = await import('./manager.js');
  if (o.serve) return serveManager({ port: o.port, quiet: false });
  const m = (await findManager()) ?? (await startManager(o.port));
  const p = o.open ? await openPage(m.url) : null;
  process.stdout.write(`untangle: your reviews are ${p?.where === 'orca' ? 'open in Orca’s browser, at' : p ? 'open in the browser, at' : 'at'} ${m.url}\n`);
  return 0;
}

/** Prints the reviews: running first, then paused, then closed. */
async function printReviews(): Promise<number> {
  const list = listRecords();
  if (!list.length) {
    process.stdout.write('untangle: no reviews yet. untangle <pr-url> starts one, or untangle in a branch.\n');
    return 0;
  }
  const live = await summaries(list);
  const count = (s: Listed['status']) => list.filter((r) => r.status === s).length;
  process.stdout.write(`untangle: ${count('running')} running, ${count('paused')} paused, ${count('closed')} closed.\n\n`);
  const rows = list.map((r) => {
    const s = r.pid != null ? live.get(r.pid) : undefined;
    const building = r.status === 'running' && s && s.phase !== 'ready';
    const p = s?.progress ?? r.progress;
    return [
      r.status,
      shortName(r),
      clip(titleOf(r), 44),
      building ? 'building' : `${fmt(p.done)}/${fmt(p.total)}`,
      agentOf(r, s),
      r.status === 'running' ? (s ? bytes(s.memory.untangle + (s.memory.lsp ?? 0)) : '') : r.freed ? 'space freed' : `${bytes(keptDirs(r).reduce((n, d) => n + dirSize(d), 0))} on disk`,
    ];
  });
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  // Progress lines up on the right; the rest on the left.
  for (const row of rows) process.stdout.write(row.map((cell, i) => (i === 3 ? cell.padStart(widths[i]) : i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd() + '\n');
  return 0;
}
