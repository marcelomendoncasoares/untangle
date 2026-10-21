#!/usr/bin/env node
// untangle: review a pull request chain by chain, in the browser.
//
//   untangle [flags] [directory]
//   untangle [flags] <pr-url>
//   untangle watch | reply | note | notes | stop | skill | upgrade ...
import fs from 'node:fs';
import path from 'node:path';
import * as agent from './agent.js';
import { noteUsage, notesUsage, parseCommand, replyUsage, reviewsUsage, skillUsage, stopUsage, upgradeUsage, usage, UsageError, watchUsage, type Options } from './args.js';
import { buildReview, buildSteps, type ReviewData } from './build.js';
import { reviewDir, worktreeDir } from './cache.js';
import { chatFolder, chatFrom } from './chats.js';
import { readHistory } from './history.js';
import { gitMaybe } from './exec.js';
import { LiveSession } from './live.js';
import { rss } from './metrics.js';
import { Narrator, type Status } from './narrate.js';
import { NoteError, Notes, notesFile, type NoteAction, type Scope } from './notes.js';
import { openPage } from './open.js';
import { showTab } from './orca.js';
import { fonts, highlighter, progressPage, reviewPage, type PageConfig } from './page.js';
import { readRecord, recordFile, serves, writeRecord, type ChatRecord, type ReviewRecord, type StopReason } from './records.js';
import { Manager, openManager } from './manager.js';
import { reviews, type Summary } from './reviews.js';
import { findRun, holder, listRuns, prKey, removeRun, wantedDir, wantedUrl, writeRun, type RunInfo } from './runs.js';
import { ReviewServer } from './server.js';
import { editorFrom, ReviewSession } from './session.js';
import { skill } from './skill.js';
import { isPrUrl, latestHead, resolveDirectory, resolveUrl, type Target } from './target.js';
import { upgrade, upgradeNotice } from './upgrade.js';
import { VERSION } from './version.js';

// After its last page closes, untangle waits this long for a page to open again (a reload)
// before it stops.
const AUTOCLOSE_AFTER = 5000;

// An agent's long wait for notes is answered at least this often, however long it asked to wait.
const WATCH_ROUND = 5 * 60_000;

async function main(): Promise<number> {
  let command: ReturnType<typeof parseCommand>;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    const help = { watch: watchUsage, reply: replyUsage, note: noteUsage, notes: notesUsage, stop: stopUsage, skill: skillUsage, upgrade: upgradeUsage, reviews: reviewsUsage }[process.argv[2]];
    process.stderr.write(`${e.message}\n${help ? help() : usage(VERSION)}`);
    return 2;
  }
  if (command.cmd === 'help') {
    process.stdout.write(command.text);
    return 0;
  }
  if (command.cmd === 'watch') return agent.watch({ target: command.opts.target, given: command.given, forward: command.forward, agent: command.agent, timeout: command.timeout });
  if (command.cmd === 'reply') return agent.reply(command);
  if (command.cmd === 'note') return agent.note(command);
  if (command.cmd === 'notes') return agent.notes(command);
  if (command.cmd === 'stop') return agent.stop(command);
  if (command.cmd === 'skill') return skill(command);
  if (command.cmd === 'upgrade') return upgrade();
  if (command.cmd === 'reviews') return reviews(command);
  return review(command.opts);
}

async function review(opts: Options): Promise<number> {
  if (opts.help) {
    process.stdout.write(usage(VERSION));
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`untangle ${VERSION} (${process.platform}/${process.arch})\n`);
    return 0;
  }

  // Cheap checks first, so a typo doesn't open a browser.
  const byUrl = isPrUrl(opts.target);
  // A file stands for the repository it's in.
  let dir = opts.target;
  if (!byUrl) {
    if (/^https?:\/\//.test(opts.target)) throw new Error(`${opts.target} is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`);
    if (!fs.existsSync(opts.target)) throw new Error(`${opts.target} does not exist`);
    if (!fs.statSync(opts.target).isDirectory()) dir = path.dirname(opts.target);
    if (!gitMaybe(dir, 'rev-parse', '--git-dir')) throw new Error(`${path.resolve(dir)} is not inside a git repository`);
  }
  const exporting = opts.exportTo !== null;
  // Whether an upgrade brings a newer untangle: said once the review is up.
  const notice = opts.quiet || exporting ? null : upgradeNotice().catch(() => null);

  const say = new Narrator({ quiet: opts.quiet, verbose: opts.verbose, color: opts.color });
  say.header([`untangle ${VERSION}`]);

  // Served, the page shows the build's progress until the review replaces it.
  let session: ReviewSession | null = null;
  let render: ((config: PageConfig) => string) | null = null;
  let server: ReviewServer | null = null;
  let live: LiveSession | null = null;
  let target: Target | null = null;
  let url = '';
  // The review's notes: kept for its branch, they stay through refreshes. Where the page opened.
  let notes: Notes | null = null;
  // An agent's session started this review (its untangle watch, or untangle run in its chat).
  const byAgent = process.env.UNTANGLE_FROM_AGENT === '1' || !!(process.env.CLAUDECODE || process.env.CODEX_THREAD_ID || process.env.GEMINI_CLI);
  let opened: 'orca' | 'browser' | null = null;
  let opening: Promise<unknown> | null = null;
  let run: RunInfo | null = null;
  // Another untangle serves this review: the page that waits here goes to its page, or its own
  // comes to the front, and this untangle ends.
  const giveWay = async (other: RunInfo, title: string): Promise<number> => {
    await opening;
    let where = opened;
    if (!where && opts.open) where = other.page && (await showTab(other.page)) ? 'orca' : (await openPage(other.url))?.where ?? null;
    say.already(title, other.url, where);
    if (opts.quiet) process.stdout.write(other.url + '\n');
    // The page that waits here hears where to go, once it's there to ask.
    if (opened) {
      for (let i = 0; i < 30 && !server?.pageCount; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));
    }
    await server?.close();
    return 0;
  };
  if (!exporting) {
    // One untangle serves a review: when it's open already, its page comes to the front instead.
    const asked = byUrl ? wantedUrl(opts.target) : wantedDir(dir);
    const other = asked && findRun(asked);
    if (asked && other && (await serves(other))) return giveWay(other, other.title || `The review of ${asked.pr ?? path.basename(asked.dir ?? dir)}`);
    const idle = { after: AUTOCLOSE_AFTER, then: () => { say.stopping('The review’s page closed, so untangle stops (-autoclose=false keeps it serving).'); void stop('tab'); } };
    server = new ReviewServer(
      { host: opts.host, port: opts.port, portExplicit: opts.portExplicit, basePath: opts.basePath, idle: opts.autoclose ? idle : undefined },
      say,
      {
        // The page comes with the notes, so it opens in the mode they're in.
        page: () => (render && session ? render({ ...session.config(), notes: notes?.view() }) : null),
        asset: (name) => {
          const body = name === 'highlight.js' ? highlighter() : name === 'fonts.css' ? fonts() : null;
          return body && { type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', body };
        },
        call: (route, method, query, body, head, signal) => {
          if (route === 'refresh') return method === 'POST' ? refresh() : check(query.has('check'));
          if (route === 'stop' && method === 'POST') {
            // Paused (kept to pick up again), closed (done with), or just stopped.
            const b = (body && typeof body === 'object' ? body : {}) as { why?: unknown; close?: unknown };
            const why: StopReason = b.why === 'paused' ? 'paused' : 'stop';
            const close = b.close === true;
            setTimeout(() => { say.stopping(close ? 'The review was closed.' : why === 'paused' ? 'The review was paused.' : 'untangle stop closed the review.'); void stop(why, close); }, 50);
            return Promise.resolve({ data: { stopping: true } });
          }
          if (route === 'summary' && method === 'GET') return Promise.resolve({ data: summary() });
          if (route === 'reviews' || route.startsWith('reviews/')) return reviewsCall(route, method, body);
          if (!session || !target || !notes) return Promise.resolve({ status: 503, data: { error: 'the review is still being built' } });
          // A page from before a refresh shows other commits: what it sends would land on the wrong lines.
          if (head && head !== target.headSha && route !== 'metrics') return Promise.resolve({ status: 409, data: { error: `untangle now reviews ${target.headSha.slice(0, 7)}: reload the page.`, moved: target.headSha } });
          if (route === 'notes' || route.startsWith('notes/')) return notesCall(notes, route, method, query, body, signal);
          if (route === 'state') recordSoon();
          if (route === 'metrics') active = Date.now();
          return session.call(route, method, query, body);
        },
      },
      progressPage(),
      (line) => say.verbose(line),
    );
    url = await server.listen();
    say.serving(url);
    if (opts.quiet) process.stdout.write(url + '\n');
    if (opts.open) {
      opening = openPage(url).then((p) => {
        opened = p?.where ?? null;
        if (!p) return say.note('no browser to open: open the link above');
        say.verbose(p.where === 'orca' ? 'opened in Orca’s browser' : 'opened in the browser');
        // The tab, for untangle reviews to bring back.
        if (p.page && run) writeRun(run = { ...run, page: p.page });
      }, () => {});
    }
    // The run file: how untangle's commands (watch, reply, notes, stop) reach this review.
    const w = byUrl ? null : asked;
    run = { pid: process.pid, url, token: server.token, dir: w ? w.dir : null, pr: byUrl ? asked?.pr ?? null : null, repoKey: w?.repoKey ?? undefined, branch: w?.branch ?? null, started: new Date().toISOString() };
    writeRun(run);
    process.on('exit', () => {
      removeRun(process.pid);
      // Ended without saying why: an error, say.
      if (record && !record.stopped) {
        record.stopped = { at: new Date().toISOString(), why: 'ended' };
        recordNow();
      }
    });
  }

  const stop = async (why: StopReason, close = false) => {
    if (record) {
      const at = new Date().toISOString();
      record.stopped = { at, why };
      record.closed = close ? at : null;
      recordNow();
    }
    // A waiting untangle watch hears that the review closed before it does.
    if (notes) { notes.close(why === 'paused'); await new Promise((r) => setTimeout(r, 100)); }
    await server?.close();
    await live?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('signal'));
  process.on('SIGTERM', () => stop('signal'));

  // The other reviews, for the page's Reviews menu: what the manager lists, read from here, and
  // its page, opened from here.
  let others: Manager | null = null;
  const reviewsCall = async (route: string, method: string, body: unknown): Promise<{ status?: number; data: unknown }> => {
    others ??= new Manager();
    const b = (body && typeof body === 'object' ? body : {}) as { id?: unknown; palette?: unknown };
    if (route === 'reviews' && method === 'GET') return { data: { ...(await others.view({ disk: false })), self: record ? `${record.repoKey}/${record.key}` : null } };
    if (route === 'reviews/open' && method === 'POST') return others.call('open', 'POST', new URLSearchParams(), { id: b.id });
    if (route === 'reviews/manager' && method === 'POST') return { data: await openManager({ palette: b.palette === true }) };
    return { status: 404, data: { error: `no such call: ${method} ${route}` } };
  };

  // When the review was last in use: a page in front (it asks for its metrics while it's shown),
  // its notes changing, an agent at work.
  let active = Date.now();
  // What untangle reviews shows of this review while it runs: the build, progress, notes, where
  // its agents' chats are, and memory.
  const summary = (): Summary => {
    const lsp = live?.state();
    const st = say.status;
    const agents = notes?.agents() ?? [];
    if (agents.some((a) => a.state === 'working' || a.state === 'queued')) active = Date.now();
    return {
      title: target ? names(target).title : st.title,
      phase: st.phase,
      step: st.steps.length ? st.steps[st.steps.length - 1] : null,
      plan: st.plan ?? null,
      error: st.error ?? null,
      head: target?.headSha ?? null,
      progress: session?.progress() ?? null,
      notes: notes?.counts() ?? null,
      waiting: notes?.waiting() ?? [],
      agents,
      memory: { untangle: process.memoryUsage().rss, lsp: lsp?.pid ? rss(lsp.pid) : null },
      pages: server?.pageCount ?? 0,
      active,
      refreshing: refreshing ? refreshView() : null,
    };
  };

  // The review's record: what untangle remembers of it past this process, for untangle reviews.
  // It's written as the review opens, a second after its marks, notes or chats change, and as it stops.
  let record: ReviewRecord | null = null;
  let recordTimer: NodeJS.Timeout | null = null;
  const recordNow = () => {
    if (recordTimer) clearTimeout(recordTimer);
    recordTimer = null;
    if (!record) return;
    const now = new Date().toISOString();
    if (session && notes && target) {
      record.progress = session.progress();
      record.notes = notes.counts();
      for (const { agent: name, chat } of notes.chats()) {
        const was = record.chats.find((c) => c.id === chat.id);
        const c: ChatRecord = { agent: name, kind: chat.kind, id: chat.id, folder: chatFolder(chat) ?? was?.folder ?? null, home: chat.home, orca: chat.orca ? { handle: chat.orca.handle, pane: chat.orca.pane } : was?.orca ?? null, at: now };
        record.chats = [c, ...record.chats.filter((x) => x.id !== chat.id)];
      }
      // Its checkouts, once they're made.
      for (const sha of [target.baseSha, target.headSha]) if (!record.checkouts.includes(sha) && fs.existsSync(worktreeDir(target.repoKey, sha))) record.checkouts.push(sha);
    }
    record.updated = now;
    // Another untangle that runs holds this review's record: it's that one's to write.
    const held = readRecord(recordFile(record.repoKey, record.key));
    if (held && held.pid !== process.pid && !held.stopped && listRuns().some((r) => r.pid === held.pid)) return;
    try {
      writeRecord(record);
    } catch (e) {
      say.verbose(`couldn’t write the review’s record: ${(e as Error).message}`);
    }
  };
  const recordSoon = () => { if (record && !recordTimer) recordTimer = setTimeout(recordNow, 1000); };

  // The notes' API: the page's (list, add, reply, resolve, copy, post, wake) and the agents' (hello,
  // watch, reply, note, export).
  const notesCall = async (book: Notes, route: string, method: string, query: URLSearchParams, body: unknown, signal: AbortSignal): Promise<{ status?: number; data: unknown }> => {
    const b = (body && typeof body === 'object' ? body : {}) as { agent?: unknown; wait?: unknown; brief?: unknown; chat?: unknown; again?: unknown; n?: unknown; body?: string | null; resolve?: unknown; path?: unknown; side?: unknown; line?: unknown; startLine?: unknown; file?: unknown };
    const name = String(b.agent ?? query.get('agent') ?? '').trim().slice(0, 40) || 'Agent';
    const chatId = (x: unknown) => (typeof x === 'string' && /^[\w-]{1,100}$/.test(x) ? x : null);
    try {
      if (route === 'notes' && method === 'GET') return { data: book.view() };
      if (route === 'notes' && method === 'POST') return { data: await book.act((body || {}) as NoteAction) };
      if (route === 'notes/hello' && method === 'GET') return { data: { title: target ? names(target).title : '', url, head: target?.headSha, pages: server ? server.pageCount : 0, opened } };
      if (route === 'notes/watch' && (method === 'POST' || method === 'GET')) {
        const wait = Math.min(WATCH_ROUND, Math.max(0, Number(b.wait ?? query.get('wait')) || WATCH_ROUND));
        // The command the agent reads with, as it types it: it goes in the lines for its chat.
        const again = typeof b.again === 'string' && /^untangle watch[^\n]{0,300}$/.test(b.again) ? b.again : undefined;
        return { data: await book.watch(name, { timeout: wait, signal, chat: chatFrom(b.chat), again, brief: b.brief === true }) };
      }
      if (route === 'notes/agent' && method === 'POST') return { data: book.reply(name, Number(b.n), b.body ?? null, !!b.resolve, chatId(b.chat)) };
      if (route === 'notes/note' && method === 'POST') {
        const n = (x: unknown) => (x == null ? undefined : Number(x));
        return { data: book.write(name, { path: String(b.path ?? ''), side: b.side === 'LEFT' ? 'LEFT' : 'RIGHT', line: n(b.line), startLine: n(b.startLine), file: b.file === true, body: String(b.body ?? '') }, chatId(b.chat)) };
      }
      if (route === 'notes/export' && method === 'GET') {
        const scope = (['open', 'new', 'all'].includes(query.get('scope') || '') ? query.get('scope') : 'open') as Scope;
        return { data: { text: book.exportText(scope), other: book.other(name, chatId(query.get('chat'))) } };
      }
      if (route === 'notes/wake' && method === 'POST') return { data: await book.wake(name) };
    } catch (e) {
      if (e instanceof NoteError) return { status: e.status, data: { error: e.message } };
      throw e;
    }
    return { status: 404, data: { error: `no such call: ${method} ${route}` } };
  };
  // The notes of a target's review, moved onto its commits.
  const attachNotes = (t: Target, s: ReviewSession) => {
    const n = names(t);
    const file = notesFile(t.repoKey, n.snapshotKey);
    if (!notes || notes.file !== file) {
      notes?.close();
      const book: Notes = new Notes(file, () => { server?.broadcast({ notes: book.revision }); active = Date.now(); recordSoon(); }, undefined, byAgent);
      notes = book;
    }
    notes.attach(s.notesContext(t.pr ? `${t.pr.owner}/${t.pr.repo}#${t.pr.number}` : t.repoKey.startsWith('local/') ? path.basename(t.repo) : n.repoName, t.pr ? t.pr.headRefName : n.branch, byUrl ? worktreeDir(t.repoKey, t.headSha) : null));
    if (run) writeRun(run = { ...run, repoKey: t.repoKey, key: n.snapshotKey, claimed: run.key === n.snapshotKey ? run.claimed : new Date().toISOString(), branch: t.pr ? t.pr.headRefName : n.branch, title: n.title, head: t.headSha });
    // The record carries over what an earlier run of the review kept: when it started, its chats,
    // its checkouts and analyses. Opening a closed review opens it again.
    const now = new Date().toISOString();
    const was = record && record.repoKey === t.repoKey && record.key === n.snapshotKey ? record : readRecord(recordFile(t.repoKey, n.snapshotKey));
    const pair: [string, string] = [t.baseSha, t.headSha];
    record = {
      version: 1,
      target: byUrl ? opts.target : run?.dir ?? path.resolve(dir),
      pr: t.pr ? prKey(t.pr.owner, t.pr.repo, t.pr.number) : null,
      dir: byUrl ? null : run?.dir ?? path.resolve(dir),
      repoKey: t.repoKey,
      key: n.snapshotKey,
      repo: t.repo,
      title: n.title,
      author: t.pr?.author ?? null,
      url: t.pr ? t.pr.url : null,
      size: s.size(),
      base: t.baseSha,
      head: t.headSha,
      progress: s.progress(),
      notes: notes.counts(),
      chats: was?.chats ?? [],
      pid: process.pid,
      started: was?.started ?? now,
      opened: was && was.pid === process.pid ? was.opened : now,
      updated: now,
      stopped: null,
      closed: null,
      github: was?.github ?? null,
      checkouts: was?.checkouts ?? [],
      analyses: [...(was?.analyses ?? []).filter(([b, h]) => b !== pair[0] || h !== pair[1]), pair],
      freed: null,
    };
    recordNow();
  };

  const resolve = (progress: Narrator) => (byUrl ? resolveUrl(opts.target, (l) => progress.detail(l)) : resolveDirectory(dir, opts.base, (l) => progress.detail(l)));
  // What a review is called: in the terminal and the page, and the branch that keeps its marks.
  const names = (t: Target) => {
    const pr = t.pr;
    const branch = !pr ? gitMaybe(t.repo, 'rev-parse', '--abbrev-ref', 'HEAD')?.trim() : null;
    const title = pr ? `#${pr.number} ${pr.title}` : `${branch && branch !== 'HEAD' ? branch : t.headSha.slice(0, 7)} against ${t.baseRef}`;
    const repoName = t.repoKey.replace(/^github\.com\//, '').replace(/^local\//, '');
    // A base given as a commit shows once, not as "65bcfb7 65bcfb7".
    const base = t.baseSha.startsWith(t.baseRef) ? t.baseSha.slice(0, 7) : `${t.baseRef} ${t.baseSha.slice(0, 7)}`;
    return {
      title, base, repoName,
      branch: branch && branch !== 'HEAD' ? branch : null,
      where: `${repoName} · ${base} → ${t.headSha.slice(0, 7)}`,
      key: `${t.repoKey}:${t.baseSha.slice(0, 12)}-${t.headSha.slice(0, 12)}`,
      snapshotKey: pr ? `pr-${pr.number}` : branch && branch !== 'HEAD' ? branch : `head-${t.headSha.slice(0, 7)}`,
    };
  };
  // A target's review (built, or read from the cache), opened for the page.
  // The commits and who wrote each changed line: a review without them still works.
  const withHistory = async (t: Target, data: ReviewData, progress: Narrator): Promise<ReviewData> => {
    progress.step('history');
    try {
      const t0 = Date.now();
      const history = await readHistory(t.repo, t.baseSha, t.headSha, data.model.compares.base.files, reviewDir(t.repoKey, t.baseSha, t.headSha));
      progress.verbose(`${history.commits.length} commits, lines attributed in ${Date.now() - t0} ms`);
      return { ...data, history };
    } catch (e) {
      progress.note(`no commit history: ${(e as Error).message}`);
      return { ...data, history: null };
    }
  };
  const open = async (t: Target, progress: Narrator, noCache: boolean) => {
    const n = names(t);
    const built = await buildReview(t, { noCache, label: n.base.replace(' ', ' · '), title: n.title, chains: opts.chains }, progress);
    built.data = await withHistory(t, built.data, progress);
    const l = new LiveSession(t, { step: () => {}, detail: () => {}, note: (x) => say.verbose(x), verbose: (x) => say.verbose(x) }, built.checkouts);
    const s = new ReviewSession(t, built.data, l, editorFrom(opts.editor), { key: n.key, url: t.pr ? t.pr.url : null, where: n.where, snapshotKey: n.snapshotKey }, progress, built.data.history ?? null);
    return { live: l, session: s, render: reviewPage(built.data, n.title, 'served') };
  };

  // Refreshing: the pull request (or the branch) is looked up again. When it moved, the new review
  // is built while the page keeps working on the current one, and then replaces it.
  let refreshing: { state: 'checking' | 'building' | 'ready' | 'failed'; head: string; status: Status; error?: string } | null = null;
  let latest = { at: 0, head: null as string | null };
  const refreshView = () => (refreshing ? { state: refreshing.state, head: refreshing.head, steps: refreshing.status.steps, error: refreshing.error } : { state: 'idle', head: target?.headSha || null });
  const check = async (ask: boolean) => {
    // Asking GitHub at most twice a minute, however many pages ask. While an agent holds the review,
    // its commits show within seconds: the branch is asked every few, GitHub every 15.
    const every = notes?.watched() ? (byUrl ? 15_000 : 2_000) : 30_000;
    if (ask && target && Date.now() - latest.at > every) latest = { at: Date.now(), head: await latestHead(target, byUrl).catch(() => latest.head) };
    return { data: { ...refreshView(), latest: ask ? latest.head : undefined, watched: notes?.watched() || false } };
  };
  const refresh = async (): Promise<{ status?: number; data: unknown }> => {
    if (!target) return { status: 503, data: { error: 'the review is still being built' } };
    if (refreshing && (refreshing.state === 'checking' || refreshing.state === 'building')) return { data: refreshView() };
    const progress = new Narrator({ quiet: opts.quiet, verbose: opts.verbose, color: opts.color });
    const r: NonNullable<typeof refreshing> = { state: 'checking', head: target.headSha, status: progress.status };
    refreshing = r;
    let t: Target;
    try {
      progress.header(['', 'Refreshing']);
      progress.step(byUrl ? 'pull request' : 'branch');
      t = await resolve(progress);
      progress.finish();
    } catch (e) {
      progress.fail((e as Error).message);
      Object.assign(r, { state: 'failed', error: (e as Error).message });
      return { data: refreshView() };
    }
    latest = { at: Date.now(), head: t.headSha };
    if (t.headSha === target.headSha && t.baseSha === target.baseSha) {
      refreshing = null;
      progress.note('up to date');
      return { data: { state: 'current', head: t.headSha } };
    }
    const n = names(t);
    r.state = 'building';
    r.head = t.headSha;
    progress.title(n.title, n.where);
    t.notes.forEach((x) => progress.note(x));
    void open(t, progress, false).then(async (next) => {
      const old = live;
      target = t;
      live = next.live;
      session = next.session;
      render = next.render;
      attachNotes(t, next.session);
      progress.finish();
      progress.note(`now reviewing ${n.where}; marks go to ${next.session.snapshot.name}`);
      r.state = 'ready';
      await old?.stop();
      next.live.ensure().catch((e) => say.note(`live go to definition is off: ${(e as Error).message}`));
    }, (e) => {
      progress.fail((e as Error).message);
      Object.assign(r, { state: 'failed', error: (e as Error).message });
    });
    return { data: refreshView() };
  };

  try {
    say.plan([byUrl ? 'pull request' : 'branch', ...buildSteps(opts.chains), 'history']);
    say.step(byUrl ? 'pull request' : 'branch');
    const t = await resolve(say);
    const n = names(t);
    say.finish();
    say.title(n.title, n.where);
    // One untangle serves a review: this one takes it, unless another took it first.
    if (run) {
      writeRun(run = { ...run, repoKey: t.repoKey, key: n.snapshotKey, claimed: new Date().toISOString() });
      const other = holder(run, t.pr ? prKey(t.pr.owner, t.pr.repo, t.pr.number) : null);
      if (other && (await serves(other))) return giveWay(other, n.title);
    }
    t.notes.forEach((x) => say.note(x));
    if (exporting) {
      const built = await buildReview(t, { noCache: opts.noCache, label: n.base.replace(' ', ' · '), title: n.title, chains: opts.chains }, say);
      built.data = await withHistory(t, built.data, say);
      const file = path.resolve(opts.exportTo!);
      fs.writeFileSync(file, reviewPage(built.data, n.title, 'export')({ served: false, key: n.key, state: null, url: t.pr ? t.pr.url : null, where: n.where }));
      say.finish();
      say.note(`wrote ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
      return 0;
    }
    const built = await open(t, say, opts.noCache);
    target = t;
    live = built.live;
    session = built.session;
    render = built.render;
    attachNotes(t, built.session);
    say.note(`marks go to ${session.snapshot.name}`);
    say.ready(url, opts.autoclose);
    void notice?.then((line) => { if (line) say.note(line); });
    // Start live navigation after extraction and grouping have finished.
    live.ensure().catch((e) => say.note(`live go to definition is off: ${(e as Error).message}`));
  } catch (e) {
    say.fail((e as Error).message);
    if (opts.verbose && e instanceof Error && e.stack) say.verbose(e.stack);
    // A moment for the page to show the error.
    if (server) {
      await new Promise((r) => setTimeout(r, 1500));
      await server.close();
    }
    await live?.stop();
    return 1;
  }
  return new Promise<number>(() => {});
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`untangle: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
