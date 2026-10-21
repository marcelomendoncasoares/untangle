import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// What a row shows: its status dot, its number and title, what happened, the agent's label, progress and size.
const rowsText = `[...document.querySelectorAll('.row')].map((r) => [r.querySelector('.st').className.replace('st', '').trim() || 'run', r.querySelector('.ttl').textContent, r.querySelector('.l3') ? r.querySelector('.l3').textContent : '', r.querySelector('.lab').textContent, r.querySelector('.prog').textContent.replace(/\\s+/g, ' ').trim()].join(' | ')).join('\\n')`;

describe('Given a review Claude answered in, another paused, and the manager open, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo;
  let other: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', opened = '';
  let run: UntangleRun;
  let client: ReviewClient;
  let page: Browser;
  const chat = 'cccccccc-0000-4000-8000-000000000011';
  const claude = () => path.join(cache, 'claude');
  const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(bin, 'browser.sh'), PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...more });
  const branch = (r: TempRepo, said: string) => {
    r.write('pubspec.yaml', pubspec);
    r.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    r.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    r.branch('feature');
    r.write('lib/a.dart', `void greet() {\n  print('${said}');\n}\n`);
    return r.commit({ subject: `Say ${said}`, author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  };

  before(async () => {
    repo = TempRepo.create();
    other = TempRepo.create();
    const head = branch(repo, 'hello');
    branch(other, 'hey');
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    opened = path.join(bin, 'opened.log');
    fs.writeFileSync(path.join(bin, 'browser.sh'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(claude(), 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(claude(), 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: chat, cwd: '/work/app', status: 'idle', statusUpdatedAt: Date.now() }));
    fs.mkdirSync(path.join(claude(), 'projects', '-work-app'), { recursive: true });
    fs.writeFileSync(path.join(claude(), 'projects', '-work-app', `${chat}.jsonl`), [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: "untangle reply N1 'Because it’s friendlier.'" } }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answered N1 in its thread.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    // The paused review: started, then stopped.
    const paused = await startUntangle(other.dir, { cacheDir: cache, gh, base: 'main', env: env() });
    const pausedClient = reviewClient(paused.url);
    await pausedClient.open();
    await until('the other review', async () => (await pausedClient.call('notes')).status === 200);
    await untangleCommand(['stop'], { cacheDir: cache, gh, cwd: other.dir, env: env() });
    await paused.exited;

    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main', env: env() });
    client = reviewClient(run.url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
    await untangleCommand(['watch', '-timeout', '1s'], { cacheDir: cache, gh, cwd: repo.dir, env: env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: claude() }) });
    await client.call('notes/agent', { method: 'POST', body: { agent: 'Claude', n: 1, body: 'Because it’s friendlier.', chat } });

    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
    assert.equal(started.code, 0, started.err);
    page = await launchBrowser(1440, 900);
    await page.reducedMotion(true);
    await page.goto(/http:\/\/\S+/.exec(started.out)![0]);
    await page.until(`document.querySelectorAll('.row').length === 2 && !!document.querySelector('.l3')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    other.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when the page opens, '
    + 'then it lists the review running with Claude’s answer first, the paused one under it, the changes left, and who needs you.',
    async () => {
      assert.equal(await page.eval(rowsText), [
        'need | feature against main | Claude answered N1 | Claude isn’t listening | 0 of 1',
        'paused | feature against main |  | No agent | 0 of 1',
      ].join('\n'));
      assert.deepEqual(await page.eval(`[[...document.querySelectorAll('.big > *')].map((e) => e.textContent).join(' | '), [...document.querySelectorAll('.gh')].map((g) => g.textContent).join(' / '), document.querySelector('.nr[data-key="need"]').textContent, document.querySelector('.pill').textContent, document.title]`), [
        '2 | changes left to review |  | 0 of 2 reviewed, in 2 open reviews',
        'Running1 / Paused1',
        'Need you1',
        '1 needs youGo to ' + path.basename(repo.dir) + ' · Claude answered N1Space',
        '(1) Reviews · untangle',
      ]);
    },
  );

  it(
    'when the running row is clicked, '
    + 'then it opens as a peek: Claude’s last lines, the note that waits for you, and the review’s memory and head.',
    async () => {
      await page.click('.row.running');
      await page.until(`!!document.querySelector('.peek .tail')`);
      assert.deepEqual(await page.eval(`[[...document.querySelectorAll('.peek .tl')].map((l) => l.querySelector('i').textContent + ' ' + l.querySelector('span').textContent), [...document.querySelectorAll('.peek .wn')].map((w) => w.textContent), [...document.querySelectorAll('.peek .kv')].map((k) => k.firstElementChild.textContent), document.querySelector('.peek .pk-act').textContent]`), [
        ['● Bash(untangle reply N1 \'Because it’s friendlier.\')', '● Answered N1 in its thread.'],
        ['N1a.dart:2Claude answered'],
        ['untangle', 'Language server', 'On disk', 'Head'],
        'Open review⏎',
      ]);
    },
  );

  it(
    'when Space is pressed, '
    + 'then the review that needs you opens: here in the browser, since it has no tab in Orca.',
    async () => {
      await page.key(' ');
      await until('the review to open', () => fs.existsSync(opened) && fs.readFileSync(opened, 'utf8').includes(run.url));
      await page.until(`!!document.querySelector('.toast') && document.querySelector('.toast').textContent.startsWith('Opened ')`);
    },
  );

  it(
    'when Paused is chosen in the side, '
    + 'then only the paused review is listed, with its chat-less agent cell and what it holds on disk.',
    async () => {
      await page.click('.nr[data-key="paused"]');
      await page.until(`document.querySelectorAll('.row').length === 1 && document.querySelector('.memc small').textContent === 'on disk' && document.querySelector('.memc b').textContent !== '—'`);
      assert.equal(await page.eval(`document.querySelector('.head h1').textContent + ' | ' + document.querySelector('.row .l2').textContent`), `Paused | Stopped a moment ago · ${path.basename(other.dir)}`);
    },
  );
});
