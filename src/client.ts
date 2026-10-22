// Calls to a running review's API, from untangle's other commands: the agent's (watch, reply,
// note, notes, stop) and untangle reviews. The review's run file has its link and token.
import http from 'node:http';
import type { RunInfo } from './runs.js';

/** The review isn't there: it stopped, or never answered. */
export class Gone extends Error {}

/** A call to a running review, with its token. Rejects with Gone when the review isn't there. */
export function call(run: Pick<RunInfo, 'url' | 'token'>, method: string, route: string, opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal; timeout?: number } = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = new URL(run.url);
  const base = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
  const query = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, method, path: `${base}api/${route}${query}`, signal: opts.signal, timeout: opts.timeout,
      headers: { 'x-untangle-token': run.token, ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d: string) => { text += d; }).on('end', () => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text.trim() || `untangle answered ${res.statusCode}` };
        }
        resolve({ status: res.statusCode || 0, data });
      }).on('error', () => reject(new Gone()));
    });
    // A review that takes longer than asked to answer counts as gone. A call that asks no time, as a
    // watch's, waits as long as it takes: Node's own agent times its sockets out after 5 seconds.
    if (opts.timeout) req.on('timeout', () => req.destroy(new Gone()));
    req.on('error', (e) => reject((e as Error).name === 'AbortError' ? e : new Gone()));
    req.end(body);
  });
}

/** The error a call's answer says, or null. */
export const failed = (r: { status: number; data: Record<string, unknown> }) => (r.status >= 400 ? String(r.data.error || `untangle answered ${r.status}`) : null);
