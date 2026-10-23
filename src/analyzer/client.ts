// A short-lived, bulk analyzer process. Keep only the facts the review needs in JavaScript.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { runAsync } from '../exec.js';
import { ROOT } from '../version.js';

export type Location = [string, number, number];

export interface Declaration {
  id: string;
  name: string;
  kind: string;
  offset: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  signatureEndLine: number;
  nameOffset: number;
  position: string;
  owner: string | null;
  elementOwner: string | null;
  field: Location | null;
}

export interface Structure {
  directives: Array<{ startLine: number; endLine: number }>;
  declarations: Declaration[];
  scenarios: Array<{
    name: string;
    title: string;
    offset: number;
    end: number;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>;
  arguments: Array<{
    target: Location;
    callable: Location | null;
    named: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>;
}

export interface FileFacts extends Structure {
  path: string;
  references: Record<string, { length: number; target: Location; kind: string }>;
  unresolved: Record<string, number>;
  calls: Record<string, Location[]>;
  supers: Record<string, Location>;
  diagnostics: Array<{ code: string; severity: string; offset: number; message: string }>;
}

/** A file the analyzer won't resolve, and what it answered instead. */
interface Refused {
  path: string;
  refused: string;
}

export class Analyzer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 0;
  private failure: Error | null = null;
  private stderr = '';
  private readonly kill = () => {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGKILL');
  };

  private constructor(executable: string, private readonly log: (line: string) => void) {
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    process.once('exit', this.kill);

    const fail = (error: Error) => {
      this.failure = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };

    this.closed = new Promise((resolve) => {
      this.child.once('error', (error) => fail(error));
      this.child.once('close', (code) => {
        fail(new Error(`Dart extractor exited ${code}${this.stderr ? ': ' + this.stderr.trim() : ''}`));
        process.off('exit', this.kill);
        resolve();
      });
    });

    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
      log(chunk.trim());
    });
    this.child.stdin.on('error', fail);

    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const response = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        const pending = this.pending.get(response.id);
        this.pending.delete(response.id);
        if (response.error) pending?.reject(new Error(response.error));
        else pending?.resolve(response.result);
      } catch (error) {
        fail(new Error(`Invalid Dart extractor response: ${String(error)}`));
        this.kill();
      }
    });
  }

  static async start(paths: string[], log: (line: string) => void = () => {}): Promise<Analyzer> {
    const executable = path.join(ROOT, 'dist', process.platform === 'win32' ? 'dart-analyzer.exe' : 'dart-analyzer');
    if (!fs.existsSync(executable)) throw new Error('The Dart extractor is not built. Install Dart 3.12+ and run npm run build.');
    const sdk = (await runAsync('dart', [path.join(ROOT, 'scripts/dart-sdk.dart')])).trim();
    const analyzer = new Analyzer(executable, log);

    try {
      await analyzer.request('initialize', { paths, sdk });
      return analyzer;
    } catch (error) {
      await analyzer.stop();
      throw error;
    }
  }

  private async request<T>(method: string, params: object): Promise<T> {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    let timer: NodeJS.Timeout | undefined;

    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Dart extractor timed out during ${method}`));
          this.kill();
        }, method === 'shutdown' ? 5000 : 120_000);
        this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
        this.child.stdin.write(JSON.stringify({ id, method, ...params }) + '\n');
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** A file's facts, or null when the analyzer won't resolve it. */
  async file(file: string): Promise<FileFacts | null> {
    const [facts] = await this.request<Array<FileFacts | Refused>>('files', { paths: [file] });
    return this.resolved(facts);
  }

  async calls(file: string): Promise<FileFacts['calls']> {
    const [facts] = await this.request<Array<Pick<FileFacts, 'calls'> | Refused>>('files', { paths: [file], callsOnly: true });
    return this.resolved(facts)?.calls ?? {};
  }

  private resolved<T extends object>(facts: T | Refused): T | null {
    if (!('refused' in facts)) return facts;
    this.log(`${facts.path}: the analyzer answered ${facts.refused}`);
    return null;
  }

  async stop(): Promise<void> {
    try {
      if (!this.failure) await this.request('shutdown', {});
    } catch {
      // A failed extraction still has to release its analyzer process.
    } finally {
      this.child.stdin.end();
      const timer = setTimeout(this.kill, 1000);
      await this.closed;
      clearTimeout(timer);
    }
  }
}
