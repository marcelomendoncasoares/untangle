import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, stopRuns, untangleCommand } from '../helpers/run.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const orcaStub = path.join(path.dirname(fileURLToPath(import.meta.url)), '../helpers/orca-stub.mjs');

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Given a review Claude works on, in the manager inside Orca, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', orcaLog = '', config = '';
  let manager: ReviewClient;
  let page: Browser;
  const chat = 'c1a0de00-0000-4000-8000-0000000000bb';
  const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', PATH: [bin, gh.binDir, process.env.PATH].join(path.delimiter), ORCA_CLI_COMMAND: 'orca-ide', ORCA_STUB_LOG: orcaLog, ...more });
  const calls = (): string[][] => (fs.existsSync(orcaLog) ? fs.readFileSync(orcaLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // Claude's word on its session: in the Reviews workspace's folder, busy or idle.
  const session = (status: 'busy' | 'idle') => fs.writeFileSync(path.join(config, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: chat, cwd: path.join(cache, 'chats', 'Reviews'), status, statusUpdatedAt: Date.now() }));
  const name = () => path.basename(repo.dir);

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    const head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    orcaLog = path.join(bin, 'orca.log');
    config = path.join(cache, 'claude');
    fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'orca-ide'), `#!/bin/sh\nexec node ${JSON.stringify(orcaStub)} "$@"\n`, { mode: 0o755 });
    for (const n of ['claude', 'codex']) fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
    assert.equal(started.code, 0, started.err);
    const url = /http:\/\/\S+/.exec(started.out)![0];
    manager = reviewClient(url);
    await manager.open();
    // The manager starts the review and Claude's chat; Claude holds it, and works on a note it read.
    const r = await manager.call('start', { method: 'POST', body: { target: fs.realpathSync(repo.dir), agent: { kind: 'claude', resume: null, session: chat, flags: '', message: '' } } });
    assert.equal(r.status, 200, r.text);
    const client = reviewClient(runsIn(cache)[0].url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    session('busy');
    const watching = untangleCommand(['watch'], { cacheDir: cache, gh, cwd: repo.dir, env: env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), CLAUDE_CONFIG_DIR: config, ORCA_TERMINAL_HANDLE: 'term_1' }) });
    await until('Claude to listen', async () => ((await client.call('notes')).data as { agents: Array<{ state: string }> }).agents.some((a) => a.state === 'listening'));
    await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
    assert.equal((await watching).code, 0);
    page = await launchBrowser(1440, 900);
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.row.running .lab[data-st="working"]')`);
  });

  after(async () => {
    await page?.close();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when Pause is clicked in its row, '
    + 'then the row says it pauses after Claude’s turn; once the turn ends, the review is paused, with Claude’s chat kept and Resume.',
    async () => {
      await page.click('.row.running');
      await page.until(`!!document.querySelector('.peek [data-act="pause"]')`);
      await page.click('.peek [data-act="pause"]');
      await page.until(`!!document.querySelector('.row.running .lab[data-st="pausing"]')`);
      assert.deepEqual(await page.eval(`[document.querySelector('.row.running .lab').textContent, document.querySelector('.peek [data-act="pause"]').disabled, document.querySelector('.toast').textContent]`), [
        'Pausing after Claude’s turn',
        true,
        `${name()} pauses when Claude’s turn ends`,
      ]);
      session('idle');
      await page.until(`!!document.querySelector('.row.paused')`, 30_000);
      assert.deepEqual(await page.eval(`[document.querySelector('.row.paused .l2').textContent.split(' · ')[0], document.querySelector('.row.paused .lab').textContent, document.querySelector('.peek .pk-act .btn.primary').textContent]`), [
        'Paused a moment ago',
        'Claude’s chat, kept',
        'ResumeR',
      ]);
    },
  );

  it(
    'when R is pressed on it, '
    + 'then it runs again in the same row, and Claude’s chat resumes by its id in the Reviews workspace.',
    async () => {
      const before = calls().length;
      await page.key('r');
      const created = await until('the terminal', () => calls().slice(before).find((c) => c[0] === 'terminal' && c[1] === 'create'));
      assert.equal(created.at(-1), `claude --resume ${chat} 'untangle: the review of ${name()} is open again. Run untangle watch to hold it.'`);
      await page.until(`!document.querySelector('.row.paused') && document.querySelectorAll('.row').length === 1 && !!document.querySelector('.row.running')`, 30_000);
      await page.until(`[...document.querySelectorAll('.toast')].some((t) => t.textContent === ${JSON.stringify(`${name()} is starting again, with Claude’s chat`)})`);
    },
  );
});
