import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';

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

describe('Given a review no agent holds, in the manager inside Orca, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo;
  let gh: GhStub;
  let cache = '', bin = '', orcaLog = '';
  let run: UntangleRun;
  let page: Browser;
  const env = (): NodeJS.ProcessEnv => ({ PATH: [bin, gh.binDir, process.env.PATH].join(path.delimiter), ORCA_CLI_COMMAND: 'orca-ide', ORCA_STUB_LOG: orcaLog });
  const calls = (): string[][] => (fs.existsSync(orcaLog) ? fs.readFileSync(orcaLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    orcaLog = path.join(bin, 'orca.log');
    fs.writeFileSync(path.join(bin, 'orca-ide'), `#!/bin/sh\nexec node ${JSON.stringify(orcaStub)} "$@"\n`, { mode: 0o755 });
    for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main', env: { ...env(), BROWSER: '/bin/true' } });
    const client = reviewClient(run.url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: cache, gh, cwd: repo.dir, env: env() });
    assert.equal(started.code, 0, started.err);
    page = await launchBrowser(1440, 900);
    await page.reducedMotion(true);
    await page.goto(/http:\/\/\S+/.exec(started.out)![0]);
    await page.until(`document.querySelectorAll('.row.running').length === 1`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    await stopRuns(cache);
    gh.remove();
    repo.remove();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when Add an agent is chosen in its row, '
    + 'then the form asks which agent, a new chat or one to resume, and an optional first message, with how it starts folded.',
    async () => {
      await page.click('.row.running');
      await page.until(`!!document.querySelector('[data-act="add-agent"]')`);
      await page.click('[data-act="add-agent"]');
      await page.until(`!!document.querySelector('.pal .opts')`);
      assert.deepEqual(await page.eval(`[[...document.querySelectorAll('.pal .field > :first-child')].map((e) => e.textContent), [...document.querySelectorAll('.pal .opt')].map((o) => o.textContent), document.querySelector('.pal .chk').textContent, document.querySelector('#f-msg').value, !!document.querySelector('#f-cmd'), document.querySelector('.pal-foot .btn.primary').textContent]`), [
        ['Chat', '', 'First messageoptional', 'In Orca', ''],
        ['New chatnamed Review ' + path.basename(repo.dir), 'Resume a chatnone held a review before'],
        'Request an initial review from Claude',
        '',
        false,
        'Start Claude⏎',
      ]);
    },
  );

  it(
    'when the initial review is requested and Advanced opened, '
    + 'then the first message is the review template, yours to change, and the command shows it after the review.',
    async () => {
      await page.click('.pal .chk');
      await page.until(`document.querySelector('#f-msg').value.startsWith('Do an initial review of this branch.')`);
      await page.click('.pal .adv');
      await page.until(`!!document.querySelector('#f-cmd')`);
      // Typed at the message's end.
      await page.eval(`(() => { const t = document.querySelector('#f-msg'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
      await page.type(' And the docs.');
      await page.until(`document.querySelector('#f-cmd').textContent.endsWith(' And the docs.\\'')`);
      assert.match(String(await page.eval(`document.querySelector('#f-cmd').textContent`)), new RegExp(`^claude --session-id [0-9a-f-]{36} -n 'Review ${path.basename(repo.dir)}' '/untangle ${fs.realpathSync(repo.dir)} Do an initial review of this branch\\. Read the whole change`));
    },
  );

  it(
    'when Claude is started, '
    + 'then its chat starts in a terminal of the Reviews workspace, with the message as written.',
    async () => {
      await page.click('.pal-foot .btn.primary');
      const created = await until('the terminal', () => calls().find((c) => c[0] === 'terminal' && c[1] === 'create'));
      assert.equal(created[created.indexOf('--title') + 1], `${path.basename(repo.dir)} · Claude`);
      assert.match(created.at(-1)!, / And the docs\.'$/);
      await page.until(`!document.querySelector('.pal') && !!document.querySelector('.toast')`);
      assert.equal(await page.eval(`document.querySelector('.toast').textContent`), 'Claude is starting, in Orca');
    },
  );
});
