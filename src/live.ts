// The page's live requests: go to definition anywhere, whole files at either revision or from
// outside the repository (a package, the SDK), search over the repository, and opening a
// location in the editor. A Dart language server serves live requests after bulk extraction.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { prepareCheckouts, type Checkouts, type Progress } from './build.js';
import { git, gitMaybe, inputFile, run } from './exec.js';
import { diffHunks } from './history.js';
import { DartServer, type Location } from './lsp/dart.js';
import type { LspState } from './metrics.js';
import type { Target } from './target.js';
import { VERSION } from './version.js';
import { ModelDefinitions } from './model-definitions.js';

export type Side = 'head' | 'base';

/** A definition as the page's peek shows it. */
export interface LiveTarget {
  /** Where it is: a side of the review (with a path inside it) or a file outside the repository. */
  side: Side | null;
  p: string;
  /** For a file outside the repository: its id for api/file and api/definition, and its absolute path. */
  ext?: number;
  abs: string;
  w: 'repo' | 'package' | 'sdk' | 'other';
  /** Line (1-based) and column of the name, first line of the snippet, and the snippet. */
  l: number;
  c: number;
  s: number;
  code: string[];
}

/** A line that uses a name, or that declares what implements it, as the page lists it. */
export interface LiveUsage {
  side: Side | null;
  p: string;
  ext?: number;
  w: LiveTarget['w'];
  /** Line (1-based) and column of the line's first use, and the line. */
  l: number;
  c: number;
  text: string;
  /** For a member that implements a name: the class (or mixin, enum, extension type) it's in. */
  in?: string;
}

const MAX_FILE = 4 << 20;
const SEARCH_MAX = 500;
const SYMBOLS_MAX = 200;
const USAGES_MAX = 300;

export class LiveSession {
  private server: DartServer | null = null;
  private starting: Promise<DartServer> | null = null;
  private failure: string | null = null;
  private dirs: { headDir: string; baseDir: string } | null = null;
  // Files outside the repository that a definition led to: only these can be read by id.
  private readonly external: string[] = [];
  private readonly models = new Map<string, ModelDefinitions>();

  constructor(
    private readonly target: Target,
    private readonly progress: Progress,
    built: Checkouts | null,
  ) {
    if (built) {
      this.dirs = { headDir: built.headDir, baseDir: built.baseDir };
    }
  }

  /** The checkouts, made when the review came from the cache. */
  async checkouts(): Promise<{ headDir: string; baseDir: string }> {
    this.dirs ??= await prepareCheckouts(this.target, this.progress);
    return this.dirs;
  }

  /** The checkouts as they will be, for links to the editor before they exist. */
  get roots(): { head: string; base: string } | null {
    return this.dirs && { head: this.dirs.headDir, base: this.dirs.baseDir };
  }

  /** The language server, started on first use. */
  ensure(): Promise<DartServer> {
    if (this.server) return Promise.resolve(this.server);
    this.starting ??= (async () => {
      const { headDir, baseDir } = await this.checkouts();
      this.server = await DartServer.start([{ name: 'head', dir: headDir }, { name: 'base', dir: baseDir }], { clientVersion: VERSION, log: this.progress.verbose });
      return this.server;
    })().catch((e) => {
      this.starting = null;
      this.failure = (e as Error).message;
      throw e;
    });
    return this.starting;
  }

  /** Whether the language server is up, for the page's status bar. */
  state(): LspState {
    if (this.server && this.server.pid) return { state: 'ready', pid: this.server.pid };
    if (this.starting) return { state: 'starting', pid: null };
    return this.failure ? { state: 'failed', pid: null, error: this.failure } : { state: 'off', pid: null };
  }

  async stop() {
    await this.server?.stop();
    this.server = null;
  }

  /**
   * The language server started over, at once: it lets go of what it loaded for the definitions
   * gone to (another package's files, the SDK's), which it otherwise holds until untangle stops.
   * One still starting is fresh already.
   */
  async restart(): Promise<void> {
    if (this.starting && !this.server) return;
    const old = this.server;
    this.server = null;
    this.starting = null;
    this.failure = null;
    // The new one starts as the old one goes: the page reads it starting from the click on.
    this.ensure().catch((e) => this.progress.note(`live go to definition is off: ${(e as Error).message}`));
    await old?.stop();
  }

  private externalId(abs: string): number {
    const at = this.external.indexOf(abs);
    if (at >= 0) return at;
    this.external.push(abs);
    return this.external.length - 1;
  }

  /** The absolute path of a file the page asks about, or null when it isn't one it may read. */
  private async resolve(where: { side?: string; p?: string; ext?: number }): Promise<string | null> {
    if (where.ext != null) return this.external[where.ext] ?? null;
    if ((where.side !== 'head' && where.side !== 'base') || !where.p || where.p.split('/').includes('..') || path.isAbsolute(where.p)) return null;
    const { headDir, baseDir } = await this.checkouts();
    return path.join(where.side === 'head' ? headDir : baseDir, where.p);
  }

  /** Where the identifier at a position is defined, with a snippet. */
  async definition(where: { side?: string; p?: string; ext?: number }, line: number, col: number): Promise<LiveTarget | null> {
    const file = await this.resolve(where);
    if (!file) throw new Error('not a file of this review');
    const server = await this.ensure();
    // Imported packages and SDK files often resolve in an existing context. Try that first
    // so an onward jump does not rebuild every context just to open another dependency.
    let loc: Location | null = await server.definition(file, line - 1, col, where.ext == null).catch(() => null);
    if (!loc && where.ext != null) loc = await server.definition(file, line - 1, col).catch(() => null);
    if (where.side === 'head' || where.side === 'base') {
      const roots = await this.checkouts();
      const root = where.side === 'head' ? roots.headDir : roots.baseDir;
      if (!this.models.has(root)) this.models.set(root, new ModelDefinitions(root));
      loc = this.models.get(root)!.resolve(file, line - 1, col, loc) || loc;
    }
    return loc && this.describe(loc);
  }

  private async describe(loc: Location): Promise<LiveTarget> {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(loc.path, 'utf8').split('\n');
    } catch {
      // A definition in a file that can't be read gets no snippet.
    }
    let start = loc.line;
    while (start > 0 && start > loc.line - 6 && /^(\/\/\/|@|#)/.test((lines[start - 1] || '').trim())) start--;
    const snippet = { l: loc.line + 1, c: loc.col, s: start + 1, code: lines.slice(start, Math.min(lines.length, loc.line + 12)).map((x) => x.slice(0, 400)) };
    return { ...(await this.place(loc.path)), ...snippet };
  }

  /** A file as the page names it: by its path at a side of the review, or outside the repository. */
  private async place(abs: string): Promise<Pick<LiveTarget, 'side' | 'p' | 'ext' | 'abs' | 'w'>> {
    const { headDir, baseDir } = await this.checkouts();
    for (const [side, root] of [['head', headDir], ['base', baseDir]] as const) {
      if (abs.startsWith(root + '/')) return { side, p: abs.slice(root.length + 1), abs, w: 'repo' };
    }
    const pub = abs.indexOf('/.pub-cache/');
    const sdk = /\/(?:dart-sdk|pkg\/sky_engine)\/lib\/(.+)$/.exec(abs);
    const [p, w] = pub >= 0 ? [abs.slice(pub + 12).split('/').slice(2).join('/'), 'package' as const]
      : sdk ? ['dart:' + sdk[1], 'sdk' as const] : [path.basename(abs), 'other' as const];
    return { side: null, p, ext: this.externalId(abs), abs, w };
  }

  /**
   * The lines that use the name at a position, from the language server: it finds them in the
   * packages it has loaded, so the packages of the review's files at that side load first. A
   * name in a file outside the repository is looked up from the head.
   */
  async usages(where: { side?: string; p?: string; ext?: number }, line: number, col: number, files: string[]): Promise<{ usages: LiveUsage[]; truncated: boolean }> {
    const { list, truncated } = await this.lines(where, files, (server, file, load) => server.references(file, line - 1, col, load));
    return { usages: list, truncated };
  }

  /** The declarations that implement the name at a position (a class's subtypes, a member's overrides), found as its usages are. */
  async implementations(where: { side?: string; p?: string; ext?: number }, line: number, col: number, files: string[]): Promise<{ implementations: LiveUsage[]; truncated: boolean }> {
    const { list, truncated } = await this.lines(where, files, (server, file, load) => server.implementations(file, line - 1, col, load), true);
    return { implementations: list, truncated };
  }

  private async lines(where: { side?: string; p?: string; ext?: number }, files: string[], ask: (server: DartServer, file: string, load: boolean) => Promise<Location[]>, members = false): Promise<{ list: LiveUsage[]; truncated: boolean }> {
    const file = await this.resolve(where);
    if (!file) throw new Error('not a file of this review');
    const server = await this.ensure();
    const side: Side = where.side === 'base' ? 'base' : 'head';
    const roots = await this.checkouts();
    const root = side === 'head' ? roots.headDir : roots.baseDir;
    await server.loadAll(files.filter((p) => p.endsWith('.dart')).map((p) => path.join(root, p)).filter((f) => fs.existsSync(f)));
    const found = await ask(server, file, where.ext == null);
    const texts = new Map<string, string[]>();
    const textOf = (abs: string, at: number) => {
      if (!texts.has(abs)) {
        try {
          texts.set(abs, fs.readFileSync(abs, 'utf8').split('\n'));
        } catch {
          texts.set(abs, []);
        }
      }
      return (texts.get(abs)![at] || '').replace(/\r$/, '').slice(0, 400);
    };
    // A member's type: the nearest declaration above it at the margin, where Dart's formatter puts them.
    const typeOf = (abs: string, at: number): string | undefined => {
      const all = texts.get(abs) || [];
      if (!/^\s/.test(all[at] || '')) return undefined;
      for (let i = at - 1; i >= 0; i--) {
        if (!/^[^\s}/@*]/.test(all[i])) continue;
        return /^(?:(?:abstract|sealed|base|interface|final)\s+)*(?:mixin\s+)?(?:class|mixin|enum|extension\s+type(?:\s+const)?)\s+([A-Za-z_$][\w$]*)/.exec(all[i])?.[1];
      }
      return undefined;
    };
    // One row a line, at its first use; the review's side first, then files outside the repository.
    const seen = new Set<string>();
    const out: LiveUsage[] = [];
    for (const loc of found.sort((a, b) => a.line - b.line || a.col - b.col)) {
      const key = loc.path + ':' + loc.line;
      if (seen.has(key)) continue;
      seen.add(key);
      const at = await this.place(loc.path);
      if (at.side && at.side !== side) continue;
      const text = textOf(loc.path, loc.line), type = members ? typeOf(loc.path, loc.line) : undefined;
      out.push({ side: at.side, p: at.p, ...(at.ext != null ? { ext: at.ext } : {}), w: at.w, l: loc.line + 1, c: loc.col, text, ...(type ? { in: type } : {}) });
    }
    out.sort((a, b) => Number(!a.side) - Number(!b.side) || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0) || a.l - b.l);
    return { list: out.slice(0, USAGES_MAX), truncated: out.length > USAGES_MAX };
  }

  /**
   * Declarations at the head whose name matches a query, from the language server. It knows the
   * packages loaded so far, so load the review's packages first.
   */
  async symbols(q: string, files: string[]): Promise<Array<{ name: string; kind: number; container: string | null; p: string; l: number; c: number }>> {
    const server = await this.ensure();
    const { headDir } = await this.checkouts();
    await server.loadAll(files.filter((p) => p.endsWith('.dart')).map((p) => path.join(headDir, p)).filter((f) => fs.existsSync(f)));
    const found = await server.symbols(q);
    const out: Array<{ name: string; kind: number; container: string | null; p: string; l: number; c: number }> = [];
    for (const x of found) {
      if (!x.location.path.startsWith(headDir + '/')) continue;
      out.push({ name: x.name, kind: x.kind, container: x.container, p: x.location.path.slice(headDir.length + 1), l: x.location.line + 1, c: x.location.col });
      if (out.length >= SYMBOLS_MAX) break;
    }
    return out;
  }

  /** A whole file: at a side's commit (from git, so a checkout that moved on doesn't matter), or one outside the repository. */
  async file(where: { side?: string; p?: string; ext?: number }): Promise<{ text: string; abs: string | null } | { error: string }> {
    if (where.ext != null) {
      const abs = this.external[where.ext];
      if (!abs) return { error: 'not a file of this review' };
      const st = fs.statSync(abs, { throwIfNoEntry: false });
      if (!st) return { error: 'the file is gone' };
      if (st.size > MAX_FILE) return { error: `${Math.round(st.size / 1024)} KB: too large to show` };
      return { text: fs.readFileSync(abs, 'utf8'), abs };
    }
    if ((where.side !== 'head' && where.side !== 'base') || !where.p) return { error: 'which file?' };
    const sha = where.side === 'head' ? this.target.headSha : this.target.baseSha;
    const out = this.fileAt(sha, where.p);
    if ('error' in out) return out;
    const abs = this.dirs ? path.join(where.side === 'head' ? this.dirs.headDir : this.dirs.baseDir, where.p) : null;
    return { ...out, abs };
  }

  /** A file at a revision already authorized by the session, also used by commit peeks. */
  fileAt(sha: string, p: string): { text: string; abs: null } | { error: string } {
    const rawSize = gitMaybe(this.target.repo, 'cat-file', '-s', `${sha}:${p}`);
    if (rawSize == null) return { error: `${p} doesn't exist at ${sha.slice(0, 7)}` };
    const size = Number(rawSize.trim());
    if (size > MAX_FILE) return { error: `${Math.round(size / 1024)} KB: too large to show` };
    const text = git(this.target.repo, 'show', `${sha}:${p}`);
    if (text.slice(0, 8000).includes('\0')) return { error: 'a binary file' };
    return { text, abs: null };
  }

  /**
   * The repository at a side's commit, searched with git grep for a fixed string: case-insensitive
   * when the query is all lower case.
   */
  search(side: Side, q: string): { results: Array<{ p: string; l: number; text: string }>; truncated: boolean } {
    const sha = side === 'head' ? this.target.headSha : this.target.baseSha;
    const args = ['grep', '-n', '-I', '--full-name', '--null', '-F', '--max-count=50', ...(q === q.toLowerCase() ? ['-i'] : []), '-e', q, sha, '--'];
    let out = '';
    try {
      out = run('git', ['-C', this.target.repo, ...args]);
    } catch {
      // No match: git grep exits with 1.
    }
    const results: Array<{ p: string; l: number; text: string }> = [];
    const prefix = sha + ':';
    for (const row of out.split('\n')) {
      if (!row) continue;
      // <sha>:<path>\0<line>\0<text>
      const [where, line, ...text] = row.split('\0');
      if (!where.startsWith(prefix) || !line) continue;
      results.push({ p: where.slice(prefix.length), l: +line, text: text.join('\0').slice(0, 400) });
      if (results.length >= SEARCH_MAX) break;
    }
    return { results, truncated: results.length >= SEARCH_MAX };
  }

  /** Every file in the repository at the head: the page's folder menus list them. */
  files(): string[] {
    return git(this.target.repo, 'ls-tree', '-r', '-z', '--name-only', this.target.headSha).split('\0').filter(Boolean);
  }

  /** Lines in each file at the head (a file that isn't there is left out), with one git call. */
  lineCounts(paths: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    const list = paths.filter((p) => !p.includes('\n'));
    if (!list.length) return out;
    let buf: Buffer;
    const input = inputFile(list.map((p) => `${this.target.headSha}:${p}\n`).join(''));
    try {
      buf = execFileSync('git', ['-C', this.target.repo, 'cat-file', '--batch'], { maxBuffer: 1 << 30, stdio: [input.fd, 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return out;
    } finally {
      input.close();
    }
    // Each answer: "<oid> blob <size>\n<content>\n", or "<name> missing\n".
    let at = 0;
    for (const p of list) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) break;
      const m = / blob (\d+)$/.exec(buf.toString('utf8', at, nl));
      at = nl + 1;
      if (!m) continue;
      const size = Number(m[1]);
      let lines = 0;
      for (let i = at; i < at + size; i++) if (buf[i] === 10) lines++;
      if (size && buf[at + size - 1] !== 10) lines++;
      out[p] = lines;
      at += size + 1;
    }
    return out;
  }

  /** The absolute path behind a location, for the editor. */
  async absolute(where: { side?: string; p?: string; ext?: number }): Promise<string | null> {
    const file = await this.resolve(where);
    return file && fs.existsSync(file) ? file : null;
  }
}

/**
 * The lines at `to` that changed since `from`, by file: [first, last] ranges, for the page to show
 * after it moves to newer commits. Empty when `from` isn't in the repository.
 */
export function changedSince(repo: string, from: string, to: string): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {};
  const diff = gitMaybe(repo, 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', from, to, '--');
  if (!diff) return out;
  diffHunks(diff, 'plus').forEach((list, file) => { out[file] = list.map(([first, count]) => [first, first + count - 1]); });
  return out;
}

/** Opens a location with the editor command: {file}, {line} and {col} are replaced in its words. */
export function openInEditor(template: string, file: string, line: number, col: number): void {
  const words = template.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const argv = words.map((w) => w.replace(/^["']|["']$/g, '').replace(/\{file\}/g, file).replace(/\{line\}/g, String(line)).replace(/\{col\}/g, String(col + 1)));
  if (!argv.length) return;
  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
