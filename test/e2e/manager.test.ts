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
  const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(bin, 'browser.sh'), PATH: [bin, gh.binDir, process.env.PATH].join(path.delimiter), ...more });
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
    const found = { number: 12, title: 'feat: Retry calls', url: 'https://github.com/acme/app/pull/12', updatedAt: '2026-10-21T10:00:00Z', isDraft: false, repository: { nameWithOwner: 'acme/app' }, author: { login: 'ada' } };
    gh = stubGh([{ match: ['search', 'prs', '--review-requested=@me'], stdout: [found] }, { match: ['search', 'prs', '--author=@me'], stdout: [] }]);
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
        '1 needs youGo to ' + path.basename(repo.dir) + 'Space',
        '(1) Reviews · untangle',
      ]);
    },
  );

  it(
    'when the running row is clicked, '
    + 'then it opens as a peek: Claude’s last lines, the note that waits for you, and the review’s memory and head, to open or pause.',
    async () => {
      await page.click('.row.running');
      await page.until(`!!document.querySelector('.peek .tail')`);
      assert.deepEqual(await page.eval(`[[...document.querySelectorAll('.peek .tl')].map((l) => l.querySelector('i').textContent + ' ' + l.querySelector('span').textContent), [...document.querySelectorAll('.peek .wn')].map((w) => w.textContent), [...document.querySelectorAll('.peek .kv')].map((k) => k.firstElementChild.textContent), document.querySelector('.peek .pk-act').textContent]`), [
        ['● Bash(untangle reply N1 \'Because it’s friendlier.\')', '● Answered N1 in its thread.'],
        ['N1a.dart:2Claude answered'],
        ['untangle', 'Language server', 'On disk', 'Head'],
        'Open review⏎PauseP',
      ]);
    },
  );

  it(
    'when the page asks for the reviews again, '
    + 'then the open row keeps its elements: its peek doesn’t open again, its dot and the row under the pointer aren’t made anew.',
    async () => {
      await page.eval(`window.__kept = [document.querySelector('.peek'), document.querySelector('.row.running'), document.querySelector('.row.running .st'), document.querySelector('.peek .tail')]`);
      // Two rounds of asking, and of reading the chat's last lines.
      await page.eval(`new Promise((r) => setTimeout(r, 4500))`);
      assert.deepEqual(await page.eval(`[document.querySelector('.peek'), document.querySelector('.row.running'), document.querySelector('.row.running .st'), document.querySelector('.peek .tail')].map((e, i) => e === window.__kept[i])`), [true, true, true, true]);
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
    'when the paused row is clicked too, '
    + 'then both rows stay open, each with its details; clicked again, only the paused one closes.',
    async () => {
      await page.click('.row.paused');
      await page.until(`document.querySelectorAll('.rw.open .peek').length === 2`);
      assert.deepEqual(await page.eval(`[...document.querySelectorAll('.rw.open .row')].map((r) => r.classList.contains('running') ? 'running' : 'paused')`), ['running', 'paused']);
      await page.click('.row.paused');
      await page.until(`document.querySelectorAll('.rw.open').length === 1`);
      assert.equal(await page.eval(`!!document.querySelector('.rw.open .row.running')`), true);
    },
  );

  it(
    'when the pointer rests on the memory chip, '
    + 'then its menu opens; it closes as the pointer leaves, unless a click kept it open.',
    async () => {
      await page.hover('#mem');
      await page.until(`!!document.querySelector('.mem-pop')`);
      await page.hover('.head h1');
      await page.until(`!document.querySelector('.mem-pop')`);
      await page.click('#mem');
      await page.until(`!!document.querySelector('.mem-pop')`);
      await page.hover('.head h1');
      await page.eval(`new Promise((r) => setTimeout(r, 500))`);
      assert.equal(await page.eval(`!!document.querySelector('.mem-pop')`), true);
      await page.click('#mem');
      await page.until(`!document.querySelector('.mem-pop')`);
    },
  );

  it(
    'when the cache is being measured, '
    + 'then its line says so with a circle after its words, all on one line; measured, the circle goes.',
    async () => {
      // Every list the page gets says the cache is being measured.
      await page.eval(`(() => { const f = window.fetch; window.__fetch = f; window.fetch = (u, i) => f(u, i).then((r) => (String(u) === 'api/reviews' ? r.json().then((d) => new Response(JSON.stringify({ ...d, disk: { ...d.disk, measuring: true } }))) : r)); })()`);
      await page.until(`!!document.querySelector('.disk-h .meas')`, 10_000);
      assert.deepEqual(await page.eval(`(() => { const h = document.querySelector('.disk-h'), top = (e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2); return [h.querySelector('span').textContent, h.getBoundingClientRect().height < 20, Math.abs(top(h.querySelector('span')) - top(h.querySelector('.meas'))) <= 2]; })()`), ['in untangle’s cache', true, true]);
      await page.eval(`window.fetch = window.__fetch`);
      await page.until(`!document.querySelector('.disk-h .meas')`, 10_000);
    },
  );

  it(
    'when Paused is chosen in the side, '
    + 'then only the paused review is listed, with its chat-less agent cell and what it holds on disk.',
    async () => {
      await page.click('.nr[data-key="paused"]');
      await page.until(`document.querySelectorAll('.row').length === 1 && document.querySelector('.memc button').textContent === 'Resume' && document.querySelector('.memc small').textContent.endsWith(' on disk')`);
      assert.equal(await page.eval(`document.querySelector('.head h1').textContent + ' | ' + document.querySelector('.row .l2').textContent`), `Paused | Stopped a moment ago · ${path.basename(other.dir)}`);
    },
  );

  it(
    'when Ctrl K is pressed, '
    + 'then the palette opens on the pull requests asked of you, and the paused review to resume; typing narrows it.',
    async () => {
      await page.click('.nr[data-key="all"]');
      await page.key('k', { ctrl: true });
      await page.until(`!!document.querySelector('.pal') && document.querySelectorAll('.pal-r').length === 2`);
      assert.deepEqual(await page.eval(`[...document.querySelectorAll('.pal-g, .pal-r')].map((e) => e.className === 'pal-g' ? '[' + e.textContent + ']' : [...e.children].map((c) => c.textContent).join(' | '))`), [
        '[Asked to review you1]', '#12 | feat: Retry calls | ada · app',
        '[Paused]', `${path.basename(other.dir)} | feature against main | Resume`,
      ]);
      await page.type('retry');
      await page.until(`document.querySelectorAll('.pal-r').length === 1`);
      await page.key('Escape');
      await page.until(`!document.querySelector('.pal')`);
    },
  );

  it(
    'when a branch’s review goes by its folder’s long name, '
    + 'then the name never runs into what’s next: in the palette it stays on one line before the title, and in a narrow window it gives way to the title, ending in an ellipsis.',
    async () => {
      await page.key('k', { ctrl: true });
      await page.until(`!!document.querySelector('.pal-r.dir')`);
      assert.deepEqual(await page.eval(`(() => { const r = document.querySelector('.pal-r.dir'), n = r.querySelector('.num'), b = n.getBoundingClientRect(); return [n.title === n.textContent, b.height < 20, b.right <= r.querySelector('.t').getBoundingClientRect().left]; })()`), [true, true, true]);
      await page.key('Escape');
      await page.until(`!document.querySelector('.pal')`);
      await page.setViewport(800, 900);
      try {
        await page.until(`innerWidth === 800`);
        assert.deepEqual(await page.eval(`[...document.querySelectorAll('.row')].map((r) => { const n = r.querySelector('.num'), w = n.getBoundingClientRect(); return [w.right <= r.querySelector('.main').getBoundingClientRect().right + 0.5, n.scrollWidth > n.clientWidth, r.querySelector('.ttl').getBoundingClientRect().width > w.width]; })`), [[true, true, true], [true, true, true]]);
      } finally {
        await page.setViewport(1440, 900);
      }
    },
  );

  it(
    'when the pull request asked of you is started from the palette, '
    + 'then its row shows at once, being built, with what GitHub said of it; when it doesn’t start, the row goes and the toast says why.',
    async () => {
      // The start waits in the page: what shows meanwhile, untangle hasn't heard of.
      await page.eval(`(() => { const f = window.fetch; window.__fetch = f; window.fetch = (u, i) => (String(u) === 'api/start' ? new Promise((r) => { window.__start = r; }) : f(u, i)); })()`);
      await page.key('k', { ctrl: true });
      await page.until(`document.querySelectorAll('.pal-r').length === 2`);
      await page.key('Enter');
      await page.until(`!!document.querySelector('.pal [data-act="f-start"]')`);
      await page.key('Enter');
      await page.until(`!!window.__start && !document.querySelector('.pal')`);
      assert.deepEqual(await page.eval(`(() => { const r = document.querySelector('.row'); return [r.className, r.hasAttribute('data-act'), r.querySelector('.st').className, r.querySelector('.l1').textContent, r.querySelector('.l2').textContent, r.querySelector('.prog').textContent.replace(/\\s+/g, ' ').trim(), document.querySelectorAll('.row').length]; })()`), [
        'row running pending', false, 'st build', '#12featRetry calls', 'acme/app · ada', '5% starting', 3,
      ]);
      await page.eval(`window.__start(new Response(JSON.stringify({ error: 'the review didn’t start: gh isn’t logged in' }), { status: 502 }))`);
      await page.until(`!document.querySelector('.row.pending') && !!document.querySelector('.toast.bad')`);
      assert.deepEqual(await page.eval(`[document.querySelectorAll('.row').length, document.querySelector('.toast').textContent]`), [2, 'the review didn’t start: gh isn’t logged in']);
      await page.eval(`window.fetch = window.__fetch`);
    },
  );

  it(
    'when the paused review is chosen in the palette, '
    + 'then it starts again, and is listed running.',
    async () => {
      await page.key('k', { ctrl: true });
      await page.until(`document.querySelectorAll('.pal-r').length === 2`);
      await page.key('ArrowDown');
      await page.key('Enter');
      await page.until(`!document.querySelector('.pal') && [...document.querySelectorAll('.row.running')].length === 2 && !document.querySelector('.st.build')`, 120_000);
    },
  );

  it(
    'when the other review’s Reviews menu is opened, '
    + 'then it counts the review that needs you, lists it with what came, and brings it to the front on a click.',
    async () => {
      const runs = fs.readdirSync(path.join(cache, 'run')).filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(cache, 'run', f), 'utf8')) as { url: string; dir: string });
      const url = runs.find((x) => x.dir === fs.realpathSync(other.dir))!.url;
      await page.goto(url);
      await page.until(`!!document.getElementById('vw-revs') && !document.getElementById('vw-revs').hidden && !document.getElementById('vw-revs-n').hidden`, 60_000);
      assert.equal(await page.eval(`document.getElementById('vw-revs').textContent`), 'Reviews1');
      await page.click('#vw-revs');
      await page.until(`!!document.querySelector('.menu.revs-pop .rv-it')`);
      assert.deepEqual(await page.eval(`[...document.querySelectorAll('.rv-it')].map((i) => [...i.children].map((c) => c.textContent).join(' | '))`), [` | ${path.basename(repo.dir)} | feature against main | Claude answered N1`]);
      const before = fs.readFileSync(opened, 'utf8');
      await page.click('.rv-it');
      await until('the other review to open', () => fs.readFileSync(opened, 'utf8').length > before.length && fs.readFileSync(opened, 'utf8').trim().split('\n').at(-1) === run.url);
    },
  );
});
