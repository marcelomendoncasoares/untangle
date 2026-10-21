import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';

const skip = e2eSkip();
// A process standing in for an untangle that runs: it runs until it's stopped.
const standIn = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
const listen = (server: http.Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));

// What a review that's built says of itself.
const summary = (done: number, waiting: unknown[]) => ({
  title: '#5 feat: Retry calls', phase: 'ready', step: { label: 'history', state: 'done', notes: [] }, plan: ['pull request', 'history'], error: null,
  head: 'a'.repeat(40), progress: { done, total: 301 }, notes: { open: 5, waiting: waiting.length }, waiting, agents: [],
  memory: { untangle: 100e6, lsp: 500e6 }, pages: 0, active: Date.now(), refreshing: null,
});

// Each row: its number and title, what it says under them, what happened, and how far it is.
const rowsText = `[...document.querySelectorAll('.row')].map((r) => [r.querySelector('.num').textContent, r.querySelector('.ttl').textContent, r.querySelector('.l2').textContent, r.querySelector('.l3') ? r.querySelector('.l3').textContent : '', r.querySelector('.prog').textContent.replace(/\\s+/g, ' ').trim()].join(' | '))`;

describe('Given a review two untangles serve, started before untangle checked for one, in the manager, ', { skip, timeout: 300_000 }, () => {
  let gh: GhStub;
  let cache = '', cwd = '', bin = '', opened = '', file = '';
  let holder: ChildProcess, twin: ChildProcess;
  let holderUrl = '';
  const servers: http.Server[] = [];
  let page: Browser;
  const record = (pid: number) => ({
    version: 1, target: 'https://github.com/acme/app/pull/5', pr: 'acme/app#5', dir: null, repoKey: 'github.com/acme/app', key: 'pr-5', repo: '/repo',
    title: '#5 feat: Retry calls', author: 'ada', url: 'https://github.com/acme/app/pull/5', size: { add: 9, del: 2, files: 3 }, base: 'b'.repeat(40), head: 'a'.repeat(40),
    progress: { done: 42, total: 301 }, notes: { open: 5, waiting: 1 }, chats: [], pid,
    started: '2026-10-21T10:00:00.000Z', opened: '2026-10-21T10:00:00.000Z', updated: '2026-10-21T10:05:00.000Z',
    stopped: null, closed: null, github: null, checkouts: [], analyses: [], freed: null,
  });

  // Its run file, and its answers: a summary, and stop, which writes its record as untangle did then.
  async function serve(child: ChildProcess, said: unknown, started: string) {
    const server = http.createServer((req, res) => {
      const stop = req.method === 'POST' && req.url === '/api/stop';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(stop ? { stopping: true } : said));
      if (stop) {
        const at = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify({ ...record(child.pid!), stopped: { at, why: 'stop' }, closed: at, updated: at }));
        setTimeout(() => child.kill(), 100);
      }
    });
    servers.push(server);
    const url = `http://127.0.0.1:${await listen(server)}/`;
    fs.writeFileSync(path.join(cache, 'run', `${child.pid}.json`), JSON.stringify({
      pid: child.pid, url, token: 't', dir: null, pr: 'acme/app#5', repoKey: 'github.com/acme/app', branch: 'retry', title: '#5 feat: Retry calls', head: 'a'.repeat(40), started,
    }));
    return url;
  }

  before(async () => {
    const found = { number: 5, title: 'feat: Retry calls', url: 'https://github.com/acme/app/pull/5', updatedAt: '2026-10-21T10:00:00Z', isDraft: false, repository: { nameWithOwner: 'acme/app' }, author: { login: 'ada' } };
    gh = stubGh([{ match: ['search', 'prs', '--review-requested=@me'], stdout: [found] }, { match: ['search', 'prs', '--author=@me'], stdout: [] }]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cwd-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    opened = path.join(bin, 'opened.log');
    fs.writeFileSync(path.join(bin, 'browser.sh'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(cache, 'run'), { recursive: true });
    file = path.join(cache, 'sessions', 'github.com', 'acme', 'app', 'pr-5.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The first one started it; the second, started after, took its record.
    twin = standIn();
    holder = standIn();
    await serve(twin, summary(40, []), new Date(Date.now() - 7200_000).toISOString());
    holderUrl = await serve(holder, summary(42, [{ n: 6, path: 'lib/a.dart', line: 3, by: 'Codex', wrote: false }]), new Date(Date.now() - 3600_000).toISOString());
    fs.writeFileSync(file, JSON.stringify(record(holder.pid!)));
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd, env: { BROWSER: path.join(bin, 'browser.sh') } });
    assert.equal(started.code, 0, started.err);
    page = await launchBrowser(1440, 900);
    await page.goto(/http:\/\/\S+/.exec(started.out)![0]);
    await page.until(`document.querySelectorAll('.row').length === 2`);
  });

  after(async () => {
    await page?.close();
    holder.kill();
    twin.kill();
    servers.forEach((s) => s.close());
    await stopRuns(cache);
    gh.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when the reviews are listed, '
    + 'then the second untangle comes right after the review, and its row says it’s open twice, to close; '
    + 'what’s left to review counts the review once.',
    async () => {
      assert.deepEqual(await page.eval(rowsText), [
        '#5 | Retry calls | acme/app · ada · +9 −2 in 3 files | Codex answered N6 | 42 of 301',
        '#5 | Retry calls | acme/app · a second untangle of this review | Open twice: close this one | 40 of 301',
      ]);
      assert.equal(await page.eval(`document.querySelector('#side .big').textContent`), '259changes left to review42 of 301 reviewed, in 1 open review');
    },
  );

  it(
    'when its row is opened, '
    + 'then it says why, and offers to open it or close it: not to pause it, or to add an agent.',
    async () => {
      await page.click(`.row[data-id="run:${twin.pid}"]`);
      await page.until(`!!document.querySelector('.rw.open .peek')`);
      assert.deepEqual(await page.eval(`(() => { const p = document.querySelector('.rw.open .peek'); return [p.querySelector('.pk-h b').textContent, p.querySelector('.pk-text').textContent, [...p.querySelectorAll('.pk-act .btn')].map((b) => b.textContent).join(' · ')]; })()`), [
        'Open twice',
        'Two untangles serve this review: this one and the one above, which keeps its record. Close this one: its notes may be behind, and what it saves could undo the other’s. A review can’t be started twice any more.',
        'Open review⏎ · Close this one',
      ]);
    },
  );

  it(
    'when New review is opened, '
    + 'then the pull request it reviews says it runs, and so does its link pasted: choosing it brings the review, rather than starting it again.',
    async () => {
      await page.key('k', { ctrl: true });
      await page.until(`document.querySelectorAll('.pal-r').length === 1`);
      const items = `[...document.querySelectorAll('.pal-g, .pal-r')].map((e) => e.className === 'pal-g' ? '[' + e.textContent + ']' : [...e.children].map((c) => c.textContent).join(' | '))`;
      assert.deepEqual(await page.eval(items), ['[Asked to review you1]', '#5 | feat: Retry calls | running · Open']);
      await page.type('https://github.com/acme/app/pull/5');
      await page.until(`document.querySelector('.pal-g').textContent === 'Link'`);
      assert.deepEqual(await page.eval(items), ['[Link]', '#5 | Retry calls | running · Open']);
      await page.key('Enter');
      await page.until(`!document.querySelector('.pal') && !!document.querySelector('.toast')`);
      assert.equal(await page.eval(`document.querySelector('.toast').textContent`), 'Opened app#5 in the browser');
      assert.equal(fs.readFileSync(opened, 'utf8').trim(), holderUrl);
    },
  );

  it(
    'when Close this one is clicked, '
    + 'then the second untangle stops, and the review runs on in the one that holds it.',
    async () => {
      await page.click(`.rw.open [data-act="close"][data-id="run:${twin.pid}"]`);
      await page.until(`document.querySelectorAll('.row').length === 1 && document.querySelector('.toast').textContent.startsWith('Closed')`);
      assert.deepEqual([await page.eval(`document.querySelector('.toast').textContent`), await page.eval(rowsText)], [
        'Closed app#5’s second untangle: the other one stays',
        ['#5 | Retry calls | acme/app · ada · +9 −2 in 3 files | Codex answered N6 | 42 of 301'],
      ]);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, holder.pid);
    },
  );
});
