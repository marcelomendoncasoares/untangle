// Reports stay on the page for the person reviewing to check and send.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { cacheRoot } from './cache.js';
import { call } from './client.js';
import { runAsync } from './exec.js';
import { findRun, wantedDir, wantedUrl } from './runs.js';
import { isPrUrl, type Target } from './target.js';
import { ROOT, VERSION } from './version.js';

const TIMEOUT = 3000;
const UPLOAD_TIMEOUT = 30_000;
const MAX_PICTURE = 12 * 1024 * 1024;
const DEFAULT_REPO = 'marcelomendoncasoares/untangle';
const REPO = /^[\w.-]+\/[\w.-]+$/;
const LOGIN = /^[\w-]+$/;
const log: string[] = [];

export type FeedbackKind = 'bug' | 'idea';
export interface FeedbackDraft {
  kind: FeedbackKind;
  text: string;
  /** The agent's words as a report: its title, and what happened. */
  title?: string;
  body?: string;
  details: Array<{ k: string; v: string }>;
  running: Array<{ command: string; pid: number; seconds: number }>;
  at?: string;
}

// As long as a report's title gets: past it, words are what happened.
const TITLE = 100;

/**
 * A report's title and what happened, from an agent's words: their first line, and the lines after
 * it. Words with no line break are split too: after their first sentence, when it's short enough
 * for a title. Otherwise one short sentence is all title, and longer words are all what happened,
 * under their start, cut at a word.
 */
export function reportParts(text: string): { title: string; body: string } {
  const t = text.replace(/\r/g, '').trim();
  const nl = t.indexOf('\n');
  if (nl >= 0) return { title: t.slice(0, nl).trim(), body: t.slice(nl + 1).trim() };
  const first = /^.+?[.!?](?=\s)/.exec(t)?.[0];
  if (first && first.length <= TITLE) return { title: first.replace(/\.$/, ''), body: t.slice(first.length).trim() };
  if (t.length <= TITLE) return { title: t.replace(/\.$/, ''), body: '' };
  return { title: t.slice(0, TITLE).replace(/\s+\S*$/, '') + '…', body: t };
}

export const feedbackRepo = () => process.env.UNTANGLE_FEEDBACK_REPO || DEFAULT_REPO;

export function scrubFeedback(text: string): string {
  return stripVTControlCharacters(text)
    .split(cacheRoot()).join('<cache>')
    .split(os.homedir()).join('~')
    .replace(/token=[^\s&#"'<>)]*/gi, 'token=…');
}

/** The last printed lines, including verbose output, without local paths or page tokens. */
export function rememberFeedback(text: string): void {
  log.push(...scrubFeedback(text).split(/\r?\n/).map((line) => line.slice(0, 4000)));
  if (log.length > 40) log.splice(0, log.length - 40);
}

const quiet = (cmd: string, args: string[], cwd?: string) => runAsync(cmd, args, { cwd, timeout: TIMEOUT }).then((s) => s.trim(), () => null);
const gh = (args: string[], cwd?: string) => runAsync('gh', args, { cwd, timeout: UPLOAD_TIMEOUT, env: { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } });

async function facts() {
  const [git, ghVersion, commit, login] = await Promise.all([
    quiet('git', ['--version']),
    quiet('gh', ['--version']),
    // A package installed inside another checkout must not report that checkout's HEAD.
    fs.existsSync(path.join(ROOT, '.git')) ? quiet('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']) : null,
    runAsync('gh', ['api', '--hostname', 'github.com', 'user'], { timeout: TIMEOUT, env: { GH_PROMPT_DISABLED: '1' } })
      .then((s) => { const value: unknown = JSON.parse(s).login; return typeof value === 'string' && LOGIN.test(value) ? value : null; }, () => null).catch(() => null),
  ]);
  return {
    version: VERSION,
    commit,
    system: { platform: process.platform, arch: process.arch, release: os.release(), node: process.versions.node, git: git?.match(/git version (\S+)/)?.[1] ?? null, gh: ghVersion?.match(/gh version (\S+)/)?.[1] ?? null },
    gh: { ready: !!ghVersion && !!login, login },
  };
}

/** The remote actually compared with can be upstream rather than a fork's origin. */
export async function reviewFeedbackRepo(target: Target | null, input: string, base: string | null): Promise<string | null> {
  const pr = target?.pr;
  if (pr) return `${pr.owner}/${pr.repo}`;
  const named = isPrUrl(input) ? wantedUrl(input) : null;
  if (named) return named.repoKey!.slice('github.com/'.length);
  const cwd = target?.repo ?? input;
  const ref = target?.baseRef ?? base;
  if (!ref) return null;
  const full = await quiet('git', ['rev-parse', '--symbolic-full-name', ref], cwd);
  let selected = target?.baseRemote;
  if (!selected && full?.startsWith('refs/remotes/')) {
    const remotes = (await quiet('git', ['remote'], cwd))?.split('\n') ?? [];
    selected = remotes.sort((a, b) => b.length - a.length).find((r) => full.startsWith(`refs/remotes/${r}/`));
  }
  if (!selected && full?.startsWith('refs/heads/')) selected = await quiet('git', ['for-each-ref', '--format=%(upstream:remotename)', full], cwd);
  if (!selected || selected === '.') return null;
  const url = await quiet('git', ['config', '--get', `remote.${selected}.url`], cwd);
  return url?.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

type Answer = { status?: number; data: unknown };
class FeedbackError extends Error {
  constructor(message: string, readonly status = 502, readonly web = true) { super(message); }
}

/** One server's pending draft; command answers and repository visibility are kept for its life. */
export class Feedback {
  private information: ReturnType<typeof facts> | null = null;
  private readonly visibility = new Map<string, Promise<boolean | null>>();
  private draft: FeedbackDraft | null = null;

  constructor(private readonly page: {
    review: (() => Promise<string | null>) | null;
    broadcast(value: unknown): void;
    pages(): number;
  }) {}

  private info() { return this.information ??= facts(); }

  async context() {
    const [info, repo] = await Promise.all([this.info(), this.page.review?.() ?? null]);
    let publicRepo: boolean | null = null;
    if (repo && info.gh.ready) {
      let known = this.visibility.get(repo);
      if (!known) {
        known = runAsync('gh', ['api', '--hostname', 'github.com', `repos/${repo}`], { timeout: TIMEOUT, env: { GH_PROMPT_DISABLED: '1' } })
          .then((s) => { const value: unknown = JSON.parse(s).private; return typeof value === 'boolean' ? !value : null; }).catch(() => null);
        this.visibility.set(repo, known);
      }
      publicRepo = await known;
    }
    return { repo: feedbackRepo(), ...info, review: this.page.review ? { repo, public: publicRepo } : null, log: [...log], draft: this.draft };
  }

  async call(route: string, method: string, body: unknown): Promise<Answer> {
    try {
      if (route === 'feedback' && method === 'GET') return { data: await this.context() };
      if (route === 'feedback' && method === 'POST') {
        const request = submission(body);
        return { data: await this.file(request) };
      }
      if (route === 'feedback/draft' && method === 'POST') {
        this.draft = draftFrom(body);
        this.page.broadcast({ feedback: { draft: this.draft } });
        return { data: { pages: this.page.pages() } };
      }
      if (route === 'feedback/draft' && method === 'DELETE') {
        this.draft = null;
        return { data: { ok: true } };
      }
      return { status: 404, data: { error: `no such call: ${method} ${route}`, web: true } };
    } catch (e) {
      return { status: e instanceof FeedbackError ? e.status : 502, data: { error: e instanceof FeedbackError ? e.message : 'The report could not be sent; open it on GitHub instead.', web: e instanceof FeedbackError ? e.web : true } };
    }
  }

  private async gist(title: string, dir: string): Promise<string> {
    await fs.promises.writeFile(path.join(dir, 'README.md'), gistReadme());
    let output: string;
    try { output = await gh(['gist', 'create', '--desc', `untangle feedback: ${title}`, 'README.md'], dir); }
    catch { throw new FeedbackError('The feedback gist could not be created; open the report on GitHub instead.'); }
    const id = output.match(/https:\/\/gist\.github\.com\/(?:[\w-]+\/)?([a-f\d]+)\b/i)?.[1];
    if (!id) throw new FeedbackError('GitHub did not return a feedback gist; open the report on GitHub instead.');
    return id;
  }

  private async picture(png: Buffer, login: string, title: string, dir: string): Promise<{ picture: string; gist: string }> {
    const id = await this.gist(title, dir);
    const checkout = path.join(dir, 'gist');
    const git = (args: string[], cwd = dir) => runAsync('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], {
      cwd, timeout: UPLOAD_TIMEOUT, env: { GIT_TERMINAL_PROMPT: '0', GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
    });
    try {
      await git(['clone', '--quiet', `https://gist.github.com/${id}.git`, checkout]);
      const name = `untangle-feedback-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.png`;
      await fs.promises.writeFile(path.join(checkout, name), png);
      await fs.promises.writeFile(path.join(checkout, 'README.md'), gistReadme(id));
      await git(['add', '--', name, 'README.md'], checkout);
      await git(['-c', `user.name=${login}`, '-c', `user.email=${login}@users.noreply.github.com`, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Add an untangle feedback picture'], checkout);
      await git(['push', '--quiet', 'origin', 'HEAD'], checkout);
      const sha = (await git(['rev-parse', 'HEAD'], checkout)).trim();
      if (!/^[a-f\d]{40,64}$/.test(sha)) throw new Error('No picture commit');
      return { picture: `https://gist.githubusercontent.com/${login}/${id}/raw/${sha}/${name}`, gist: `https://gist.github.com/${id}` };
    } catch { throw new FeedbackError('The picture could not be uploaded; open the report on GitHub instead.'); }
  }

  private async file(request: Submission) {
    const info = await this.info();
    if (!info.gh.ready || !info.gh.login) throw new FeedbackError('gh isn’t signed in: open it on GitHub instead.', 409);
    const repo = feedbackRepo();
    if (!REPO.test(repo)) throw new FeedbackError('The feedback repository must be owner/repo.', 400);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'untangle-feedback-'));
    try {
      const uploaded = request.png ? await this.picture(request.png, info.gh.login, request.title, dir) : null;
      const picture = uploaded?.picture ?? null;
      const image = picture ? `![Picture from untangle](${picture})` : '';
      let body = request.body;
      if (body.includes('{{picture}}')) body = body.replaceAll('{{picture}}', image);
      else if (image) {
        const at = body.search(/\r?\n\s*\r?\n/);
        body = at < 0 ? `${body}\n\n${image}` : `${body.slice(0, at)}\n\n${image}${body.slice(at)}`;
      }
      // Only the selected kind can ask the workflow for a feedback label.
      body = body.replace(/<!--\s*untangle-feedback\s+kind=(?:bug|idea)\s*-->/g, '').trimEnd();
      body += `\n\n<!-- untangle-feedback kind=${request.kind} -->\n`;
      const file = path.join(dir, 'issue.md');
      await fs.promises.writeFile(file, body);
      let output: string;
      try { output = await gh(['issue', 'create', '-R', repo, '--title', request.title, '--body-file', file]); }
      catch { throw new FeedbackError('The issue could not be filed; open the report on GitHub instead.'); }
      const url = output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+\b/)?.[0];
      if (!url || !url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/issues/`)) throw new FeedbackError('GitHub did not return the issue link; check GitHub before sending again.');
      const number = Number(url.split('/').at(-1));
      if (uploaded) await gh(['gist', 'edit', uploaded.gist.split('/').at(-1)!, '--desc', `untangle feedback: ${repo}#${number} ${request.title}`]).catch(() => {});
      return { number, url, picture, gist: uploaded?.gist ?? null };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
}

function gistReadme(id = '<id>'): string {
  return `A picture from untangle's Feedback button, for an issue on ${feedbackRepo()}.\n\n`
    + 'This gist is secret, but anyone with its link can see it.\n\n'
    + 'List your feedback pictures with `untangle feedback -list`.\n'
    + `Delete this one with \`gh gist delete ${id}\`, or Delete on the gist's page.\n`
    + 'After deletion, the issue shows a broken picture.\n';
}

interface Submission { kind: FeedbackKind; title: string; body: string; png: Buffer | null }

function submission(value: unknown): Submission {
  const b = value as Record<string, unknown> | null;
  if (b && b.picture !== undefined && b.picture !== null && b.approved !== true) throw new FeedbackError('Uploading the picture needs your approval first.', 400, false);
  if (!b || (b.kind !== 'bug' && b.kind !== 'idea')) throw new FeedbackError('kind must be bug or idea.', 400);
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 256 || /[\0\r\n\u2028\u2029]/.test(b.title)) throw new FeedbackError('title must be one line, from 1 to 256 characters.', 400);
  if (typeof b.body !== 'string' || b.body.length > 60_000) throw new FeedbackError('body must be markdown of at most 60,000 characters.', 400);
  let png: Buffer | null = null;
  if (b.picture !== undefined && b.picture !== null) {
    if (typeof b.picture !== 'string' || b.picture.length > MAX_PICTURE || !b.picture.startsWith('data:image/png;base64,')) throw new FeedbackError('picture must be a PNG data URL of at most 12 MB.', 400);
    const encoded = b.picture.slice('data:image/png;base64,'.length);
    if (encoded.length % 4 || !/^[A-Za-z\d+/]*={0,2}$/.test(encoded)) throw new FeedbackError('picture must contain base64 PNG data.', 400);
    png = Buffer.from(encoded, 'base64');
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new FeedbackError('picture must contain a PNG image.', 400);
  }
  return { kind: b.kind, title: b.title.trim(), body: b.body, png };
}

function draftFrom(value: unknown): FeedbackDraft {
  const b = value as FeedbackDraft | null;
  if (!b || (b.kind !== 'bug' && b.kind !== 'idea') || typeof b.text !== 'string' || b.text.length > 60_000
    || !Array.isArray(b.details) || b.details.length > 100 || !b.details.every((d) => d && typeof d.k === 'string' && typeof d.v === 'string' && d.k.length <= 256 && d.v.length <= 4000)
    || !Array.isArray(b.running) || b.running.length > 1000 || !b.running.every((r) => r && typeof r.command === 'string' && r.command.length <= 4000 && Number.isSafeInteger(r.pid) && r.pid > 0 && Number.isFinite(r.seconds) && r.seconds >= 0)) {
    throw new FeedbackError('A draft needs kind, text, details (k and v), and running commands (command, pid and seconds).', 400);
  }
  return { kind: b.kind, text: b.text, ...reportParts(b.text), details: b.details.map(({ k, v }) => ({ k, v: scrubFeedback(v) })), running: b.running.map(({ command, pid, seconds }) => ({ command: scrubFeedback(command), pid, seconds })), at: new Date().toISOString() };
}

/** ps uses [[dd-]hh:]mm:ss on Linux and macOS. */
export function elapsedSeconds(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  return m ? Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0;
}

export function runningCommands(text: string, parent: number): FeedbackDraft['running'] {
  const rows = text.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), seconds: elapsedSeconds(m[3]), command: scrubFeedback(m[4]).slice(0, 4000) }] : [];
  });
  const found: Array<FeedbackDraft['running'][number] & { depth: number }> = [], visited = new Set([parent]);
  const descend = (pid: number, depth: number) => {
    for (const row of rows.filter((r) => r.parent === pid && !visited.has(r.pid))) {
      visited.add(row.pid);
      descend(row.pid, depth + 1);
      found.push({ command: row.command, pid: row.pid, seconds: row.seconds, depth });
    }
  };
  descend(parent, 0);
  return found.sort((a, b) => b.depth - a.depth).slice(0, 1000).map(({ command, pid, seconds }) => ({ command, pid, seconds }));
}

export function feedbackForm(draft: FeedbackDraft): string {
  const url = new URL(`https://github.com/${feedbackRepo()}/issues/new`);
  url.searchParams.set('template', `${draft.kind}.yml`);
  const { title, body } = reportParts(draft.text);
  url.searchParams.set('title', (title || (draft.kind === 'idea' ? 'An idea for untangle' : 'untangle is not answering')).slice(0, 256));
  url.searchParams.set('what', body || draft.text);
  url.searchParams.set('details', [...draft.details.map((d) => `${d.k}: ${d.v}`), ...draft.running.map((r) => `${r.command}   pid ${r.pid}, ${duration(r.seconds)}`)].join('\n'));
  // Trim diagnostics first, then the description; URL encoding can make each character much longer.
  for (const key of ['details', 'what', 'title']) {
    const chars = Array.from(url.searchParams.get(key) || '');
    while (url.href.length > 6000 && chars.length) {
      chars.splice(Math.max(0, chars.length - Math.max(1, Math.ceil((url.href.length - 6000) / 12))));
      url.searchParams.set(key, chars.join(''));
    }
  }
  return url.href;
}

const duration = (seconds: number) => `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;

/** The agent only offers a draft, even when the page is hung or no review is running. */
export async function feedbackCommand(opts: { kind: FeedbackKind; text: string; target: string | null; list: boolean }): Promise<number> {
  if (opts.list) return listFeedback();
  let text = opts.text;
  if (text === '-') {
    text = '';
    for await (const chunk of process.stdin) text += chunk.toString();
  }
  const wanted = opts.target ? wantedUrl(opts.target) : wantedDir(process.cwd());
  const run = wanted ? findRun(wanted) : null;
  const [info, ps] = await Promise.all([facts(), run ? quiet('ps', ['-A', '-o', 'pid=,ppid=,etime=,args=']) : null]);
  const draft: FeedbackDraft = {
    kind: opts.kind, text: text.slice(0, 60_000),
    details: [{ k: 'untangle', v: `${info.version}${info.commit ? `, at ${info.commit}` : ''}` }, ...Object.entries(info.system).map(([k, v]) => ({ k, v: v ?? 'unavailable' }))],
    running: run && ps ? runningCommands(ps, run.pid) : [],
  };
  if (run) {
    try {
      const reply = await call(run, 'POST', 'feedback/draft', { body: draft, timeout: TIMEOUT, signal: AbortSignal.timeout(TIMEOUT) });
      if (reply.status === 200 && typeof reply.data.pages === 'number') {
        process.stdout.write('untangle: the report is on the review’s page, for you to check and send.\n');
        if (!reply.data.pages) process.stdout.write(`No page is open; open ${run.url}\n`);
        return 0;
      }
    } catch { /* A hung review cannot take a draft. */ }
  }
  process.stdout.write('untangle: the review isn’t answering; check and send the report on GitHub.\n');
  for (const r of draft.running) process.stdout.write(`${r.command}   pid ${r.pid}, ${duration(r.seconds)}\n`);
  process.stdout.write(feedbackForm(draft) + '\n');
  return 0;
}

/** Only lists gists; deleting one is always a separate command the person chooses to run. */
async function listFeedback(): Promise<number> {
  let output: string;
  try { output = await gh(['gist', 'list', '--limit', '1000']); }
  catch {
    process.stderr.write('untangle: listing feedback pictures needs gh, signed in to github.com.\n');
    return 1;
  }
  const rows = output.split('\n').flatMap((line) => {
    const [id, description, , , date] = line.split('\t');
    return /^[a-f\d]+$/i.test(id) && description?.startsWith('untangle feedback: ') ? [{ id, description, date: date ?? '' }] : [];
  });
  if (!rows.length) process.stdout.write('untangle: no feedback pictures among your latest 1,000 gists.\n');
  else {
    for (const row of rows) process.stdout.write(`https://gist.github.com/${row.id}\t${row.date}\t${row.description}\n`);
    process.stdout.write('\nDelete one with gh gist delete <id>, or Delete on its page; its issue will show a broken picture.\n');
  }
  return 0;
}
