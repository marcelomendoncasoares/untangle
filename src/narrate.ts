// Narration: what untangle is doing, in the terminal and on the page that waits for the review.
import type { Progress } from './build.js';

export interface StepStatus {
  label: string;
  state: 'running' | 'done' | 'failed';
  ms?: number;
  detail?: string;
  /** How far the step is through what it counts: done, of total. */
  count?: [number, number];
  notes: string[];
}

export interface Status {
  phase: 'starting' | 'building' | 'ready' | 'failed';
  title: string;
  /** Where the review compares: repo · base → head. */
  where?: string;
  /** The steps the run expects, in order: the page shows those still to come. */
  plan?: string[];
  steps: StepStatus[];
  notes: string[];
  error?: string;
  /** Another untangle serves this review: its link, for the page to go to. */
  moved?: string;
  /** Counts the changes, so the page can wait for the next one. */
  rev: number;
}

export class Narrator implements Progress {
  readonly status: Status = { phase: 'starting', title: '', steps: [], notes: [], rev: 0 };
  private current: { step: StepStatus; start: number } | null = null;
  private waiters = new Set<() => void>();
  private soon: NodeJS.Timeout | null = null;
  // Notes of the running step print under it once it ends, so the step line stays in place.
  private pending: string[] = [];
  private drawn = false;
  private ticker: NodeJS.Timeout | null = null;
  private readonly tty: boolean;
  private readonly c: (code: string, s: string) => string;

  constructor(private readonly opts: { quiet: boolean; verbose: boolean; color: boolean }) {
    this.tty = !!process.stderr.isTTY && !opts.quiet;
    const color = opts.color && !!process.stderr.isTTY && !process.env.NO_COLOR;
    this.c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  }

  /** Calls back once, on the status's next change. Returns a function that cancels it. */
  next(fn: () => void): () => void {
    this.waiters.add(fn);
    return () => this.waiters.delete(fn);
  }

  // A step starting or ending is told at once; details at most every 150 ms.
  private changed(now = false) {
    if (!now) {
      this.soon ??= setTimeout(() => this.changed(true), 150);
      this.soon.unref();
      return;
    }
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
    this.status.rev++;
    const waiting = [...this.waiters];
    this.waiters.clear();
    waiting.forEach((fn) => fn());
  }

  private write(line: string) {
    this.clear();
    process.stderr.write(line + '\n');
    this.draw();
  }

  private clear() {
    if (this.drawn) process.stderr.write('\r\x1b[K');
    this.drawn = false;
  }

  // The running step, redrawn in place on a terminal. Its detail is cut to fit the row: `\r` goes
  // back only to the start of the row it's on, so a line that wraps leaves a row behind each redraw.
  private draw() {
    if (!this.tty || !this.current) return;
    const { step, start } = this.current;
    const elapsed = `${Math.round((Date.now() - start) / 1000)} s`;
    // The row but its last column, where some terminals already wrap.
    const room = (process.stderr.columns || 100) - 1 - `  … ${step.label.padEnd(16)} ${elapsed}  `.length;
    const detail = step.detail && room > 0 ? '  ' + fit(step.detail, room) : '';
    process.stderr.write(`\r\x1b[K  ${this.c('2', '…')} ${step.label.padEnd(16)} ${this.c('2', elapsed + detail)}`);
    this.drawn = true;
  }

  header(lines: string[]) {
    if (this.opts.quiet) return;
    lines.forEach((l, i) => this.write(i ? '  ' + this.c('2', l) : l));
  }

  title(text: string, sub: string) {
    this.status.title = text;
    this.status.where = sub;
    this.changed(true);
    if (!this.opts.quiet) {
      this.write('  ' + this.c('1', text));
      this.write('  ' + this.c('2', sub));
    }
  }

  /** The steps the run expects, in order. A step it skips (a cached one) is passed by a later one. */
  plan(labels: string[]) {
    this.status.plan = labels;
    this.changed(true);
  }

  // Arrow functions: callers pass these around as callbacks.
  step = (label: string) => {
    this.end(false);
    this.status.phase = 'building';
    const step: StepStatus = { label, state: 'running', ms: 0, notes: [] };
    this.status.steps.push(step);
    this.current = { step, start: Date.now() };
    this.ticker = setInterval(() => {
      if (!this.current) return;
      this.current.step.ms = Date.now() - this.current.start;
      this.draw();
    }, 1000);
    this.ticker.unref();
    if (!this.tty && !this.opts.quiet) process.stderr.write(`  … ${label}\n`);
    this.draw();
    this.changed(true);
  }

  detail = (text: string, count?: [number, number]) => {
    if (!this.current) return;
    this.current.step.detail = text;
    this.current.step.count = count;
    this.draw();
    this.changed();
  }

  note = (text: string) => {
    (this.current ? this.current.step.notes : this.status.notes).push(text);
    this.changed();
    if (this.opts.quiet) return;
    if (this.current) this.pending.push(text);
    else this.write('    ' + this.c('2', text));
  }

  verbose = (text: string) => {
    if (this.opts.verbose && text.trim()) this.write('      ' + this.c('2', text));
  }

  /** Ends the running step. */
  finish(failed = false) {
    this.end(failed);
    this.changed(true);
  }

  private end(failed: boolean) {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (!this.current) return;
    const { step, start } = this.current;
    step.ms = Date.now() - start;
    step.state = failed ? 'failed' : 'done';
    step.detail = undefined;
    step.count = undefined;
    this.current = null;
    if (!this.opts.quiet) {
      this.write(`  ${failed ? this.c('31', '✗') : this.c('32', '✓')} ${step.label.padEnd(16)} ${this.c('2', seconds(step.ms))}`);
      this.pending.forEach((n) => this.write('    ' + this.c('2', n)));
    }
    this.pending = [];
  }

  ready(url: string, autoclose = false) {
    this.end(false);
    this.status.phase = 'ready';
    this.changed(true);
    if (this.opts.quiet) return;
    this.write('');
    this.write(`  Review at ${this.c('1', url)}`);
    this.write(this.c('2', autoclose ? '  Closing its page stops untangle, as Ctrl+C does.' : '  Ctrl+C to stop.'));
  }

  /** Another untangle serves this review: where its page is. The page that waits here goes there. */
  already(title: string, url: string, where: 'orca' | 'browser' | null) {
    this.end(false);
    this.status.moved = url;
    this.changed(true);
    if (this.opts.quiet) return;
    this.write(`  ${title} is open already${where === 'orca' ? ', in Orca’s browser' : where === 'browser' ? ', in the browser' : ''}.`);
    this.write(`  Review at ${this.c('1', url)}`);
  }

  /** Says why untangle stops now, leaving a running step unfinished. */
  stopping(why: string) {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.current = null;
    if (!this.opts.quiet) this.write(`  ${why}`);
  }

  serving(url: string) {
    if (!this.opts.quiet) this.write(`  ${this.c('2', 'Serving at')} ${url}`);
  }

  fail(message: string) {
    this.end(true);
    this.status.phase = 'failed';
    this.status.error = message;
    this.changed(true);
    this.write(`  ${this.c('31', 'error:')} ${message}`);
  }
}

// Text cut to a width with an ellipsis. After a colon a detail names a path, whose end names the
// file, so there its start goes instead.
const fit = (text: string, width: number): string => {
  const chars = [...text];
  if (chars.length <= width) return text;
  const colon = text.indexOf(': ');
  const kept = colon < 0 ? 0 : [...text.slice(0, colon + 2)].length;
  if (kept && kept < width) return chars.slice(0, kept).join('') + '…' + chars.slice(chars.length - (width - kept - 1)).join('');
  return chars.slice(0, width - 1).join('') + '…';
};

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
