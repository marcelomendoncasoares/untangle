// One Dart analysis server serves both checkouts. An open file loads its whole package, so
// keep one representative per package instead of making every queried file a priority file.
// Loading another package rebuilds contexts; wait for its representative to resolve before
// asking, and retry only answers interrupted by another load.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node.js';

export interface Location {
  /** Absolute path. */
  path: string;
  line: number;
  col: number;
}

export interface CallHierarchyItem {
  name: string;
  uri: string;
  selectionRange: { start: { line: number; character: number } };
  [key: string]: unknown;
}

interface LspRange { start: { line: number; character: number } }
type LspLocation = { uri: string; range: LspRange } | { targetUri: string; targetRange: LspRange; targetSelectionRange?: LspRange };

const REQUEST_TIMEOUT_MS = 600_000;
const PRIORITY_AT = 256;

// `dart` is often a wrapper (Flutter's bin/dart) and the analysis server a process of its own
// under it, so each server starts in its own process group and stops as a group. Servers still
// running when untangle exits (Ctrl+C during a build, say) go with it.
const GROUPS = process.platform !== 'win32';
const running = new Set<ChildProcess>();
function killTree(child: ChildProcess) {
  try {
    if (GROUPS && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {
    // Gone already.
  }
}
process.on('exit', () => running.forEach(killTree));

export const fileUri = (p: string) => pathToFileURL(p).href;
export const uriPath = (u: string) => fileURLToPath(u);

export class DartServer {
  private exited: Error | null = null;
  private readonly opened = new Set<string>();
  private readonly packages = new Map<string, string>();
  private readonly packageDirs = new Map<string, string | null>();
  private readonly pending = new Set<string>();
  private loading: Promise<void> | null = null;
  private generation = 0;
  // Settles (as a rejection) when the server process goes away; every request races it.
  private readonly gone: Promise<never>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly conn: MessageConnection,
    private readonly log?: (line: string) => void,
  ) {
    this.gone = new Promise<never>((_, reject) => {
      child.once('exit', (code) => reject((this.exited ??= new Error(`the Dart analysis server exited (code ${code})`))));
      child.once('error', (e) => reject((this.exited ??= new Error(`could not start the Dart analysis server: ${e.message}`))));
    });
    this.gone.catch(() => {});
  }

  static async start(folders: Array<{ name: string; dir: string }>, opts: { clientVersion: string; log?: (line: string) => void }): Promise<DartServer> {
    const child = spawn('dart', ['language-server', '--protocol=lsp', '--client-id', 'untangle', '--client-version', opts.clientVersion], {
      cwd: folders[0].dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: GROUPS,
      windowsHide: true,
    });
    running.add(child);
    child.on('exit', () => running.delete(child));
    const conn = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
    const server = new DartServer(child, conn, opts.log);
    child.stderr!.setEncoding('utf8').on('data', (d: string) => opts.log?.(d.trimEnd()));
    child.on('error', () => conn.dispose());
    // Symbol search only needs the review's analyzed packages, not every dependency.
    conn.onRequest((method: string, params: unknown) => {
      if (method === 'workspace/configuration') return ((params as { items?: Array<{ section?: string }> }).items || []).map((item) => item.section === 'dart' ? { includeDependenciesInWorkspaceSymbols: false } : {});
      return null;
    });
    conn.onNotification((method: string, params: unknown) => {
      if (method === 'window/logMessage' || method === 'window/showMessage') opts.log?.(String((params as { message?: string }).message ?? ''));
    });
    conn.listen();
    await server.request('initialize', {
      processId: process.pid,
      rootUri: fileUri(folders[0].dir),
      workspaceFolders: folders.map((f) => ({ uri: fileUri(f.dir), name: f.name })),
      initializationOptions: { onlyAnalyzeProjectsWithOpenFiles: true },
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { definition: { linkSupport: false }, callHierarchy: {} },
      },
    });
    conn.sendNotification('initialized', {});
    return server;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.conn.sendRequest(method, params) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timed out`)), REQUEST_TIMEOUT_MS);
      }),
      this.gone,
    ]).finally(() => clearTimeout(timer));
  }

  /** The server's process (the language server's own memory and CPU show in the page). */
  get pid(): number | null {
    return this.exited ? null : this.child.pid ?? null;
  }

  /** Where the identifier at a position is defined. */
  async definition(file: string, line: number, col: number, load = true): Promise<Location | null> {
    if (load) this.load(file);
    const answer = await this.query<LspLocation | LspLocation[] | null>('textDocument/definition', { textDocument: { uri: fileUri(file) }, position: { line, character: col } });
    const res = Array.isArray(answer) ? answer[0] : answer;
    if (!res) return null;
    const uri = 'targetUri' in res ? res.targetUri : res.uri;
    const range = 'targetUri' in res ? res.targetSelectionRange || res.targetRange : res.range;
    if (!uri.startsWith('file:')) return null;
    return { path: uriPath(uri), line: range.start.line, col: range.start.character };
  }

  /** Where the name at a position is used, in the packages analyzed so far, its declaration left out. */
  async references(file: string, line: number, col: number, load = true): Promise<Location[]> {
    if (load) this.load(file);
    const res = await this.query<Array<{ uri: string; range: LspRange }> | null>('textDocument/references', { textDocument: { uri: fileUri(file) }, position: { line, character: col }, context: { includeDeclaration: false } });
    return (res || []).filter((x) => x.uri.startsWith('file:')).map((x) => ({ path: uriPath(x.uri), line: x.range.start.line, col: x.range.start.character }));
  }

  /** What implements the name at a position, in the packages analyzed so far: a class's subtypes, a member's overrides. */
  async implementations(file: string, line: number, col: number, load = true): Promise<Location[]> {
    if (load) this.load(file);
    const res = await this.query<Array<{ uri: string; range: LspRange }> | null>('textDocument/implementation', { textDocument: { uri: fileUri(file) }, position: { line, character: col } });
    return (res || []).filter((x) => x.uri.startsWith('file:')).map((x) => ({ path: uriPath(x.uri), line: x.range.start.line, col: x.range.start.character }));
  }

  /** Declarations whose name matches a query, in the packages analyzed so far (workspace/symbol). */
  async symbols(query: string): Promise<Array<{ name: string; kind: number; container: string | null; location: Location }>> {
    type Info = { name: string; kind: number; containerName?: string; location: { uri: string; range?: LspRange } };
    const res = (await this.query<Info[] | null>('workspace/symbol', { query })) || [];
    return res.filter((x) => x.location && x.location.uri.startsWith('file:')).map((x) => ({
      name: x.name,
      kind: x.kind,
      container: x.containerName || null,
      location: { path: uriPath(x.location.uri), line: x.location.range ? x.location.range.start.line : 0, col: x.location.range ? x.location.range.start.character : 0 },
    }));
  }

  /** The declaration that the one at a position overrides (dart/textDocument/super). */
  async superOf(file: string, line: number, col: number): Promise<Location | null> {
    this.load(file);
    const res = await this.query<{ uri: string; range: LspRange } | null>('dart/textDocument/super', { textDocument: { uri: fileUri(file) }, position: { line, character: col } });
    if (!res || !res.uri.startsWith('file:')) return null;
    return { path: uriPath(res.uri), line: res.range.start.line, col: res.range.start.character };
  }

  async prepareCallHierarchy(file: string, line: number, col: number): Promise<CallHierarchyItem[]> {
    this.load(file);
    return (await this.query<CallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', { textDocument: { uri: fileUri(file) }, position: { line, character: col } })) || [];
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyItem[]> {
    if (item.uri.startsWith('file:')) this.load(uriPath(item.uri));
    const res = await this.query<Array<{ to: CallHierarchyItem }> | null>('callHierarchy/outgoingCalls', { item });
    return (res || []).map((c) => c.to);
  }

  /** Asks the server to shut down, and ends its process group when it doesn't in time. */
  async stop(): Promise<void> {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (!this.exited) {
      const exit = new Promise((resolve) => this.child.once('exit', resolve));
      try {
        await Promise.race([this.conn.sendRequest('shutdown'), wait(10_000)]);
        this.conn.sendNotification('exit');
      } catch {
        // Gone already.
      }
      await Promise.race([exit, wait(5_000)]);
    }
    this.conn.dispose();
    killTree(this.child);
    running.delete(this.child);
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream?.destroy();
  }

  get packageCount(): number {
    return this.packages.size;
  }

  async loadAll(files: Iterable<string>): Promise<void> {
    for (const file of files) this.load(file);
    await this.ready();
  }

  // Sparse files resolve once when asked together. Dense files were faster and used less
  // memory with a temporary priority file, which lets Dart reuse its resolved unit.
  async askFiles<T, R>(items: T[], fileOf: (item: T) => string, fn: (item: T) => Promise<R>, onDone?: (done: number) => void): Promise<R[]> {
    const groups = new Map<string, number[]>();
    items.forEach((item, i) => {
      const file = fileOf(item);
      const group = groups.get(file) ?? [];
      group.push(i);
      groups.set(file, group);
    });
    await this.loadAll(groups.keys());
    const results = new Array<R>(items.length);
    let done = 0;
    for (const [file, indices] of groups) {
      const alreadyOpen = this.opened.has(file);
      const temporary = indices.length >= PRIORITY_AT && !alreadyOpen && this.open(file);
      try {
        const answers = await pool(indices, temporary || alreadyOpen ? 64 : PRIORITY_AT, (i) => fn(items[i]), () => onDone?.(++done));
        indices.forEach((i, k) => { results[i] = answers[k]; });
      } finally {
        if (temporary) {
          this.conn.sendNotification('textDocument/didClose', { textDocument: { uri: fileUri(file) } });
          this.opened.delete(file);
        }
      }
    }
    return results;
  }

  /** The nearest pubspec owns a file, including a member of a pub workspace. */
  private packageOf(file: string): string | null {
    const dirs: string[] = [];
    let dir = path.dirname(file);
    while (!this.packageDirs.has(dir)) {
      dirs.push(dir);
      if (fs.existsSync(path.join(dir, 'pubspec.yaml'))) {
        this.packageDirs.set(dir, dir);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        this.packageDirs.set(dir, null);
        break;
      }
      dir = parent;
    }
    const root = this.packageDirs.get(dir)!;
    for (const item of dirs) this.packageDirs.set(item, root);
    return root;
  }

  /** Keeps one file open for each package; loose files stand for themselves. */
  load(file: string) {
    const key = this.packageOf(file) ?? file;
    if (this.packages.has(key) || !this.open(file)) return;
    this.packages.set(key, file);
    this.pending.add(file);
    this.generation++;
  }

  private open(file: string): boolean {
    if (this.opened.has(file)) return true;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    this.opened.add(file);
    this.conn.sendNotification('textDocument/didOpen', { textDocument: { uri: fileUri(file), languageId: 'dart', version: 1, text } });
    return true;
  }

  /** A resolved document proves its context exists, even when it declares no symbols. */
  private async ready(): Promise<void> {
    while (this.loading || this.pending.size) {
      this.loading ??= (async () => {
        while (this.pending.size) {
          const files = [...this.pending];
          this.pending.clear();
          await pool(files, 8, async (file) => {
            const probe = () => this.request('textDocument/documentSymbol', { textDocument: { uri: fileUri(file) } });
            try {
              await probe();
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 100));
              try {
                await probe();
              } catch (error) {
                // A representative the server can't resolve still keeps its package loaded.
                this.log?.(`could not resolve ${file}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          });
        }
      })().finally(() => { this.loading = null; });
      await this.loading;
    }
  }

  private async query<T>(method: string, params: unknown): Promise<T> {
    for (;;) {
      await this.ready();
      const generation = this.generation;
      try {
        const answer = await this.request<T>(method, params);
        const empty = answer == null || (Array.isArray(answer) && !answer.length);
        if (!empty || generation === this.generation) return answer;
      } catch (error) {
        if (generation === this.generation) throw error;
      }
    }
  }

  /** Adds a checkout to the workspace. */
  addFolder(name: string, dir: string) {
    this.conn.sendNotification('workspace/didChangeWorkspaceFolders', { event: { added: [{ uri: fileUri(dir), name }], removed: [] } });
  }
}

/** Runs fn over items with at most `width` in flight, keeping the results in item order. */
export async function pool<T, R>(items: T[], width: number, fn: (item: T, i: number) => Promise<R>, onDone?: (done: number) => void): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}
