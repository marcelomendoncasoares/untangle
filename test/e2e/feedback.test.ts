import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhReply, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, startUntangle, untangleCommand, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const signedIn: GhReply[] = [
  { match: ['--version'], stdout: 'gh version 2.93.0' },
  { match: ['api', '--hostname', 'github.com', 'user'], stdout: { login: 'octocat' } },
  { match: ['gist', 'create'], stdout: 'https://gist.github.com/octocat/a123b456' },
  { match: ['issue', 'create'], stdout: 'https://github.com/fixture/feedback/issues/5' },
  { match: ['gist', 'edit'], stdout: '' },
];
const signedOut: GhReply[] = [
  { match: ['--version'], stdout: 'gh version 2.93.0' },
  { match: ['api', '--hostname', 'github.com', 'user'], stderr: 'not logged in', code: 1 },
];

interface Served { root: string; repo: TempRepo; gh: GhStub; cache: string; run: UntangleRun; page: Browser; bodies(): string[]; gist(...args: string[]): string; remove(): Promise<void> }

// A review of a small branch whose gh, gist and issues all stay here: gh is the stub (through a
// wrapper that keeps each issue's body), and git's insteadOf sends the gist's clone and push to a
// bare repository in this folder.
async function served(replies: GhReply[]): Promise<Served> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-feedback-e2e-'));
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/cart.dart', 'int total(List<int> prices) => prices.fold(0, (sum, price) => sum + price);\n');
  repo.commit({ subject: 'Start the cart', author: ada('2020-09-01T15:00:00Z'), committer: ada('2020-09-01T15:00:00Z') });
  repo.branch('feature');
  repo.write('lib/cart.dart', 'int total(List<int> prices) => prices.fold(0, (sum, price) => sum + price * 2);\n');
  repo.commit({ subject: 'Double every price', author: ada('2020-09-02T15:00:00Z'), committer: ada('2020-09-02T15:00:00Z') });

  const gh = stubGh(replies);
  const bodies = path.join(root, 'bodies.jsonl');
  const stub = path.join(path.dirname(fileURLToPath(import.meta.url)), '../helpers/gh-stub.mjs');
  const wrapper = path.join(gh.binDir, 'keep-body.mjs');
  fs.writeFileSync(wrapper, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const at = args.indexOf('--body-file');
if (at >= 0) fs.appendFileSync(${JSON.stringify(bodies)}, JSON.stringify(fs.readFileSync(args[at + 1], 'utf8')) + '\\n');
process.exit(spawnSync(process.execPath, [${JSON.stringify(stub)}, ...args], { stdio: 'inherit' }).status ?? 1);
`);
  fs.writeFileSync(path.join(gh.binDir, 'gh'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(wrapper)} "$@"\n`, { mode: 0o755 });

  const gist = path.join(root, 'a123b456.git');
  const seed = TempRepo.create();
  seed.write('README.md', 'A picture from untangle\n');
  seed.commit({ subject: 'Start the gist', author: ada('2020-09-03T15:00:00Z'), committer: ada('2020-09-03T15:00:00Z') });
  execFileSync('git', ['clone', '--quiet', '--bare', seed.dir, gist]);
  seed.remove();

  const cache = path.join(root, 'cache');
  fs.mkdirSync(cache);
  const env = {
    UNTANGLE_FEEDBACK_REPO: 'fixture/feedback', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${root}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://gist.github.com/',
    GIT_CONFIG_KEY_1: 'url./nonexistent/untangle-feedback/.insteadOf', GIT_CONFIG_VALUE_1: 'https://github.com/',
  };
  // Not quiet: what a review prints is the log its reports carry.
  const run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, env, quiet: false });
  await waitForReview(reviewClient(run.url));
  const page = await launchBrowser();
  await page.reducedMotion(true);
  await page.goto(run.url);
  await page.until(`!!document.querySelector('.t-head') && !document.querySelector('#vw-fb').hidden`, 30_000);
  // No browser tab or download opens: GitHub's form is only noted.
  await page.eval(`window.open = (url) => { window.__opened = url; return null; }`);
  return {
    root, repo, gh, cache, run, page,
    bodies: () => (fs.existsSync(bodies) ? fs.readFileSync(bodies, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []),
    gist: (...args: string[]) => execFileSync('git', ['-C', gist, ...args], { encoding: 'utf8' }).trim(),
    async remove() {
      await page.close();
      await run.stop();
      gh.remove();
      repo.remove();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// The panel, open on its picture.
async function openPanel(page: Browser): Promise<void> {
  await page.click('#vw-fb');
  await page.until(`!!document.querySelector('.fbk') && document.querySelector('.fbk .fbk-wait').hidden && document.querySelector('.fbk canvas.pic').width > 0`, 30_000);
}
const write = (title: string, text: string) => `(() => { for (const [sel, value] of [['#fbk-title', ${JSON.stringify(title)}], ['.fbk textarea', ${JSON.stringify(text)}]]) { const t = document.querySelector(sel); t.value = value; t.dispatchEvent(new Event('input', { bubbles: true })); } })()`;
const report = ['Space skips the change under a folded section', 'I folded Outside the tests and pressed Space from the top.'] as const;
const size = `(() => { const r = document.querySelector('.fbk').getBoundingClientRect(); return Math.round(r.width) + '×' + Math.round(r.height); })()`;
// What moves as a button turns the panel from your words to the issue, or back, read the moment
// it's pressed, and whether the dialog keeps its size.
const turn = (button: string) => `(() => {
  const before = ${size};
  document.querySelector('.fbk [data-fb="${button}"]').click();
  const moves = (sel) => (document.querySelector(sel)?.getAnimations() ?? []).some((a) => /translate.*scale/.test(a.effect.getKeyframes()[0].transform || ''));
  const fades = (sel) => (document.querySelector(sel)?.getAnimations() ?? []).some((a) => a.effect.getKeyframes()[0].opacity != null);
  const seen = [];
  if (moves('.fbk-shot')) seen.push('the picture moves from the board into the issue');
  if (moves('.fbk-b:not(.fbk-ghost) .fbk-board')) seen.push('the picture moves back to the board');
  if (fades('.fbk-ghost.fbk-b')) seen.push('a stand-in of the words fades out');
  if (fades('.fbk-ghost.fbk-c')) seen.push('a stand-in of the issue fades out');
  if (fades('.fbk-card h3')) seen.push('the issue rises around it');
  if (fades('.fbk-c:not(.fbk-ghost) .fbk-ok')) seen.push('what Send does slides in');
  if (fades('.fbk-b:not(.fbk-ghost) .fbk-form')) seen.push('the words slide back in');
  seen.push(${size} === before ? 'the dialog stays ' + before : 'the dialog goes from ' + before + ' to ' + ${size});
  return seen.join('; ');
})()`;
const still = `!document.querySelector('.fbk-ghost') && !document.querySelector('.fbk').getAnimations({ subtree: true }).length`;

describe('Given a served review, with gh signed in as octocat, and the gist and the issue kept on this machine, ', { skip, timeout: 240_000 }, () => {
  let s: Served | undefined;

  before(async () => {
    s = await served(signedIn);
  });

  after(async () => {
    await s?.remove();
  });

  describe('when Feedback is pressed, ', () => {
    let shown = '';
    let goes = '';

    before(async () => {
      await rest(s!.page);
      await openPanel(s!.page);
      shown = await read(s!.page, `[document.querySelector('.fbk [data-fb="include"]').checked ? 'the picture included' : 'no picture', document.querySelector('.fbk [data-fb="hidden"]').checked ? 'its text hidden' : 'its text shown', document.querySelector('.fbk-dest').textContent].join(' · ')`);
      goes = await read(s!.page, `[...document.querySelectorAll('.fbk-goes label b')].map((b) => b.textContent).join(', ')`);
    });

    it('then the panel opens on a picture of the page, its text hidden, as untangle can’t tell this repository is public.', () => {
      assert.equal(shown, 'the picture included · its text hidden · An issue on fixture/feedback, which is public, filed as you through gh (octocat). Send shows it as it will read, and waits for your yes.');
    });

    it('then what goes with it is untangle, the system, the browser, the review, the view, the page’s errors and untangle’s log.', () => {
      assert.equal(goes, 'untangle, System, Browser, The review, The view, Errors, Its log');
    });
  });

  describe('when the report is written and Send is pressed, ', () => {
    let asked = '';
    let issue = '';
    let log = '';
    let back = '';
    let sizes = '';
    let forth = '';
    let home = '';
    let calls = '';

    before(async () => {
      await s!.page.eval(write(...report));
      const writing = await read(s!.page, size);
      await s!.page.click('.fbk [data-fb="send"]');
      await s!.page.until(`!!document.querySelector('.fbk-c:not([hidden])')`);
      asked = await read(s!.page, `document.querySelector('.fbk-ok').innerText`);
      issue = await read(s!.page, `(() => { const c = document.querySelector('.fbk-card'); return [c.querySelector('h3').textContent, c.querySelector('.fbk-meta').textContent, c.querySelector('.fbk-desc').textContent, c.querySelector('.fbk-shot canvas') ? 'the picture' : 'no picture', [...c.querySelectorAll('.fbk-more dt')].map((d) => d.textContent).join(', ')].join(' | '); })()`);
      // The log's lines wrap: nothing in the panel scrolls sideways.
      log = await read(s!.page, `(() => { const lines = [...document.querySelectorAll('.fbk-ll')], step = document.querySelector('.fbk-c'), said = /the last (\\d+) lines/.exec(document.querySelector('.fbk-goes').textContent); return [lines.length === Number(said && said[1]) ? 'every line of its log' : lines.length + ' lines of ' + (said && said[1]), lines.every((l) => l.scrollWidth <= l.clientWidth) && step.scrollWidth <= step.clientWidth ? 'wrapped' : 'too wide'].join(', '); })()`);
      const checking = await read(s!.page, `${size} + (document.querySelector('.fbk-c').scrollHeight > document.querySelector('.fbk-c').clientHeight ? ', scrolling inside' : ', all in view')`);
      await s!.page.key('Escape');
      back = await read(s!.page, `[document.querySelector('.fbk') ? 'the panel open' : 'the panel closed', document.querySelector('.fbk-b').hidden ? 'not on the words' : 'on the words', document.querySelector('#fbk-title').value].join(', ')`);
      sizes = [writing, checking, await read(s!.page, size)].join(' | ');
      await s!.page.reducedMotion(false);
      try {
        forth = await read(s!.page, turn('send'));
        await s!.page.until(still);
        home = await read(s!.page, turn('back'));
        await s!.page.until(still);
      } finally {
        await s!.page.reducedMotion(true);
      }
      await s!.page.click('.fbk [data-fb="send"]');
      await s!.page.until(`!!document.querySelector('.fbk-c:not([hidden])')`);
      calls = s!.gh.calls().map((c) => c.args.slice(0, 2).join(' ')).filter((c) => /^(gist|issue)/.test(c)).join(', ');
    });

    it('then it shows the issue as it will read: the title, its labels, the words, the picture, what untangle adds, and every line of its log, wrapped.', () => {
      assert.equal(issue, 'Space skips the change under a folded section | bugfrom untangleon fixture/feedback, by octocat | I folded Outside the tests and pressed Space from the top. | the picture | untangle, System, Browser, The review, The view, Errors');
      assert.equal(log, 'every line of its log, wrapped');
    });

    it('then Esc goes back to the words, and the panel stays open.', () => {
      assert.equal(back, 'the panel open, on the words, Space skips the change under a folded section');
    });

    it('then the dialog keeps its size on the words, on the issue, which scrolls inside it, and back.', () => {
      assert.equal(sizes, '1180×640 | 1180×640, scrolling inside | 1180×640');
    });

    it('with motion, then the picture moves from the board into the issue, which rises around it, and back to the board, each step fading out where it was.', () => {
      assert.equal(forth, 'the picture moves from the board into the issue; a stand-in of the words fades out; the issue rises around it; what Send does slides in; the dialog stays 1180×640');
      assert.equal(home, 'the picture moves back to the board; a stand-in of the issue fades out; the words slide back in; the dialog stays 1180×640');
    });

    it('then it says what it will upload and file, as octocat, and gh has made nothing yet.', () => {
      assert.equal(asked, [
        'Before anything leaves this machine',
        'untangle makes a new secret gist in your GitHub account, octocat, with this picture. Secret means unlisted: anyone with its link can open it.',
        'It files a public issue on fixture/feedback, as octocat, that shows the picture.',
        'The gist stays yours: untangle feedback -list lists them, and you can delete one any time. Its issue then shows a broken picture.',
        'Back',
        'Upload the picture and file it',
      ].join('\n'));
      assert.equal(calls, '');
    });
  });

  describe('when the upload is approved, ', () => {
    let told = '';
    let calls = '';
    let body = '';
    let files = '';

    before(async () => {
      await s!.page.click('.fbk [data-fb="approve"]');
      await s!.page.until(`!document.querySelector('.fbk') && (document.querySelector('.fbk-toast.on') || {}).textContent`, 30_000);
      told = await read(s!.page, `[document.querySelector('.fbk-toast').textContent, ...[...document.querySelectorAll('.fbk-toast a')].map((a) => a.textContent + ' ' + a.getAttribute('href'))].join(' | ')`);
      calls = s!.gh.calls().map((c) => c.args.slice(0, 2).join(' ')).filter((c) => /^(gist|issue)/.test(c)).join(', ');
      body = s!.bodies()[0] ?? '';
      files = s!.gist('ls-tree', '--name-only', 'HEAD');
    });

    it('then gh makes a new gist, the picture is pushed to it, the issue is filed, and the gist is named after it.', () => {
      assert.equal(calls, 'gist create, issue create, gist edit');
      assert.match(files, /^README\.md\nuntangle-feedback-\d{8}-\d{6}\.png$/);
    });

    it('then the issue holds the words, the picture from the gist, what untangle adds, and the marker the workflow labels it by.', () => {
      assert.match(body, /^I folded Outside the tests and pressed Space from the top\.\n\n!\[Picture from untangle\]\(https:\/\/gist\.githubusercontent\.com\/octocat\/a123b456\/raw\/[0-9a-f]{40}\/untangle-feedback-\d{8}-\d{6}\.png\)\n\n<details><summary>untangle /);
      assert.match(body, /\| The review \| a branch · 1 file · 0 chains · 1 change, 1 to review \|/);
      assert.match(body, /```\n(?:.*\n)*  ✓ diff +\d/);
      assert.match(body, /<!-- untangle-feedback kind=bug -->\n$/);
    });

    it('then the page says the issue’s number, with links to the issue and to the picture’s gist.', () => {
      assert.equal(told, 'Filed as #5 on fixture/feedbackOpen the issueThe picture’s gist | Open the issue https://github.com/fixture/feedback/issues/5 | The picture’s gist https://gist.github.com/a123b456');
    });
  });
});

describe('Given a served review whose gh isn’t signed in, ', { skip, timeout: 240_000 }, () => {
  let s: Served | undefined;
  let send = '';
  let form: Record<string, string> = {};

  before(async () => {
    s = await served(signedOut);
    await openPanel(s.page);
    await s.page.eval(write(...report));
    send = await read(s.page, `(() => { const b = document.querySelector('.fbk [data-fb="send"]'); return (b.disabled ? 'Send off: ' : 'Send on: ') + b.title; })()`);
    await s.page.click('.fbk [data-fb="web"]');
    const opened = String(await s.page.eval(`window.__opened || ''`));
    form = Object.fromEntries(new URL(opened).searchParams);
    form.at = opened.split('?')[0];
  });

  after(async () => {
    await s?.remove();
  });

  describe('when the report is opened on GitHub instead, ', () => {
    it('then Send waits for gh, and GitHub’s form opens with the words, what untangle adds, and the marker.', () => {
      assert.equal(send, 'Send off: gh isn’t signed in: open it on GitHub instead');
      assert.equal(form.at, 'https://github.com/fixture/feedback/issues/new');
      assert.equal(form.template, 'bug.yml');
      assert.equal(form.title, 'Space skips the change under a folded section');
      assert.equal(form.what, 'I folded Outside the tests and pressed Space from the top.');
      assert.match(form.details, /^\| \| \|\n\| --- \| --- \|\n\| untangle \| /);
      assert.match(form.details, /<!-- untangle-feedback kind=bug -->$/);
    });
  });
});

describe('Given a served review, signed in to gh, ', { skip, timeout: 240_000 }, () => {
  let s: Served | undefined;

  before(async () => {
    s = await served(signedIn);
  });

  after(async () => {
    // A paused review goes on, so it can stop.
    for (const r of s ? runsIn(s.cache) : []) { try { process.kill(r.pid, 'SIGCONT'); } catch { /* gone */ } }
    await s?.remove();
  });

  describe('when an agent drafts a report with untangle feedback, ', () => {
    let said = '';
    let alarm = '';
    let words = '';

    before(async () => {
      const out = await untangleCommand(['feedback', 'untangle note hangs. It gave no answer in 5 minutes, and the page said nothing.'], { cacheDir: s!.cache, gh: s!.gh, cwd: s!.repo.dir });
      said = out.out.trim();
      await s!.page.until(`!document.querySelector('#vw-alarm').hidden`, 10_000);
      alarm = await read(s!.page, `document.querySelector('#vw-alarm').textContent`);
      await s!.page.click('#vw-alarm button');
      await s!.page.until(`!!document.querySelector('#fbk-title') && document.querySelector('#fbk-title').value`, 30_000);
      words = await read(s!.page, `document.querySelector('#fbk-title').value + ' | ' + document.querySelector('.fbk textarea').value`);
      await s!.page.key('Escape');
      await s!.page.until(`!document.querySelector('.fbk')`);
    });

    it('then the command says the report is on the page, the bar offers it, and it opens with the agent’s first sentence as its title and the rest as what happened.', () => {
      assert.equal(said, 'untangle: the report is on the review’s page, for you to check and send.');
      assert.equal(alarm, 'A report is drafted · for you to checkOpen it');
      assert.equal(words, 'untangle note hangs | It gave no answer in 5 minutes, and the page said nothing.');
    });
  });

  describe('when untangle stops answering, ', () => {
    let alarm = '';
    let panel = '';
    let back = '';

    before(async () => {
      const [r] = runsIn(s!.cache);
      process.kill(r.pid, 'SIGSTOP');
      try {
        await s!.page.until(`/isn’t answering/.test(document.querySelector('#vw-alarm').textContent)`, 40_000);
        alarm = await read(s!.page, `document.querySelector('#vw-alarm').textContent.replace(/\\d+ s/, 'N s')`);
        await s!.page.click('#vw-alarm button');
        await s!.page.until(`!!document.querySelector('.fbk') && document.querySelector('.fbk .fbk-wait').hidden`, 30_000);
        panel = await read(s!.page, `[document.querySelector('.fbk [data-fb="send"]').disabled ? 'Send off' : 'Send on', document.querySelector('.fbk [data-fb="hidden"]').checked ? 'its text hidden' : 'its text shown'].join(' · ')`);
        await s!.page.key('Escape');
      } finally {
        process.kill(r.pid, 'SIGCONT');
      }
      await s!.page.until(`document.querySelector('#vw-alarm').hidden`, 20_000);
      back = 'the bar gone';
    });

    it('then the bar says so and offers to report it, from the page alone, and goes when untangle answers again.', () => {
      assert.equal(alarm, 'untangle isn’t answering · N sReport it');
      assert.equal(panel, 'Send off · its text hidden');
      assert.equal(back, 'the bar gone');
    });
  });
});
