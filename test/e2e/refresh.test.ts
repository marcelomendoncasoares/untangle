import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, pendingAnswer, pendingLookup } from '../helpers/conversation.ts';
import type { GhStub } from '../helpers/gh.ts';
import { stubGh } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest, waitForSave } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const prUrl = 'https://github.com/acme/sample/pull/7';

const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');
const notes = ['// start', '// pad 1', '// pad 2', ''].join('\n');

/** Points every stub answer from the old head at the new one, so the rebuilt review can still comment. */
function followHead(gh: GhStub, from: string, to: string): void {
  const config = String(gh.env.UNTANGLE_GH_CONFIG);
  const data = JSON.parse(fs.readFileSync(config, 'utf8')) as { replies: Array<{ stdout?: string }> };
  for (const reply of data.replies) {
    if (typeof reply.stdout === 'string') reply.stdout = reply.stdout.replaceAll(from, to);
  }
  fs.writeFileSync(config, JSON.stringify(data));
}

describe('Given a served review of a greeting and a notes file, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let head = '';
  let glowed = '';

  before(async () => {
    const author = ada('2020-07-01T15:00:00Z');
    const later = ada('2020-07-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.write('lib/notes.dart', notes);
    repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    repo.write('lib/notes.dart', ['// edited', '// pad 1', '// pad 2', ''].join('\n'));
    head = repo.commit({ subject: 'Name the greeting', author: later, committer: later });
    const spec = { number: 7, title: 'Add a greeting', url: prUrl, head };
    gh = stubGh([
      {
        match: ['pr', 'view'],
        stdout: {
          number: 7, title: 'Add a greeting', url: prUrl, state: 'OPEN',
          baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head,
        },
      },
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
      { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) },
      { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
      { match: ['api', 'markdown'], stdout: '<p>ok</p>' },
      { match: ['api', 'graphql'], stdout: conversationOf(spec) },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  // The head the stub gh reports: each scenario lands its own commit on top of it.
  let current = '';

  /** Commits on the branch, and has the stub gh report the new head. */
  function land(file: string, lines: string[], subject: string, day: string): string {
    const author = ada(`2020-07-${day}T15:00:00Z`);
    repo!.write(file, [...lines, ''].join('\n'));
    const sha = repo!.commit({ subject, author, committer: author });
    followHead(gh!, current || head, sha);
    current = sha;
    return sha;
  }

  describe('when a commit lands on the branch, ', () => {
    let landed = '';
    let banner: string;

    before(async () => {
      landed = land('lib/extra.dart', ['void extra() {}'], 'Add an extra file', '03');
      await rest(page!);
      await page!.until(`!document.querySelector('#vw-fresh')?.hidden && (document.querySelector('#vw-fresh')?.textContent || '').includes(${JSON.stringify(landed.slice(0, 7))})`, 90_000);
      banner = await read(page!, `document.querySelector('#vw-fresh')?.textContent ?? ''`);
    });

    // Back on the branch's head: a review left behind GitHub takes no comments on lines.
    after(async () => {
      await page!.click('#vw-fresh [data-act="refresh"]');
      await page!.until(`(document.querySelector('.t-head')?.textContent || '').includes(${JSON.stringify(landed.slice(0, 7))})`, 120_000);
    });

    it('then a banner names the new commit and offers to refresh.', () => {
      assert.equal(banner, `New commits: ${landed.slice(0, 7)}Refresh`);
    });
  });

  describe('when Refresh is clicked after a commit lands, with the greeting marked and a note left unsent, ', () => {
    let where: string;
    let glow: string;
    let marked: string;
    let draft: string;
    let pill: Array<[number, string]>;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.until(`!!document.querySelector('[data-chain]')`);
      const id = await read(page!, `([...document.querySelectorAll('[data-chain]')].find((el) => (el.textContent || '').includes('greet(name)')) || {}).dataset?.chain ?? ''`);
      await page!.click(`[data-chain="${id}"]`);
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('greet(name)')`);
      await page!.click('.sec-h b');
      await page!.key(' ');
      await waitForSave(page!);
      await page!.click('[data-tab="files"]');
      await page!.click('[data-open="lib/notes.dart"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/notes.dart"]')`);
      await page!.hover('[data-c="R:1"]');
      await page!.until(`document.querySelector('.cm-add')?.classList.contains('on')`);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      await page!.click('.th.new textarea.cmp-ta');
      await page!.type('Not yet');
      glowed = land('lib/notes.dart', ['// edited', '// pad 1', '// glowed'], 'Glow a line', '04').slice(0, 7);
      await page!.until(`!document.querySelector('#vw-fresh')?.hidden && (document.querySelector('#vw-fresh')?.textContent || '').includes(${JSON.stringify(glowed)})`, 90_000);
      // What the pill says and how wide it is, at each change, kept past the reload.
      await page!.eval(`(() => { const el = document.querySelector('#vw-fresh'), log = []; const note = () => { if (el.hidden) return; const t = el.querySelector('.fr-t'), n = el.querySelector('.fr-pct'); log.push([Math.round(el.getBoundingClientRect().width), (t ? t.textContent : el.textContent) + (n ? ' · n%' : '')]); try { sessionStorage.setItem('fresh-log', JSON.stringify(log)); } catch (e) {} }; new MutationObserver(note).observe(el, { childList: true, subtree: true, characterData: true, attributes: true }); note(); })()`);
      await page!.click('#vw-fresh [data-act="refresh"]');
      await page!.until(`(document.querySelector('.t-head')?.textContent || '').includes('${glowed}')`, 120_000);
      pill = JSON.parse(await read(page!, `sessionStorage.getItem('fresh-log') || '[]'`)) as Array<[number, string]>;
      where = await read(page!, `document.querySelector('.crumbs')?.textContent ?? ''`);
      await page!.until(`!!document.querySelector('.code[data-p="lib/notes.dart"] .glow')`, 30_000);
      await page!.until(`!!document.querySelector('.code[data-p="lib/notes.dart"] span[class*=" k"]')`, 30_000);
      glow = await read(page!, `[...document.querySelectorAll('.code[data-p="lib/notes.dart"] .glow')].map((el) => el.querySelector('.tx')?.textContent ?? el.textContent).join('\\n')`);
      await page!.click('[data-tab="chains"]');
      const chainId = await read(page!, `([...document.querySelectorAll('[data-chain]')].find((el) => (el.textContent || '').includes('greet(name)')) || {}).dataset?.chain ?? ''`);
      await page!.click(`[data-chain="${chainId}"]`);
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('greet(name)')`);
      // The chain reads the greeting and its call together, in one section of their file.
      marked = await read(page!, `[...([...document.querySelectorAll('.sec')].find((el) => (el.querySelector('.sec-h b')?.textContent || '').split(', ')[0] === 'greet')?.querySelectorAll('.tick[data-block]') ?? [])].filter((t) => !t.closest('.other')).map((t) => t.getAttribute('aria-pressed')).join(' ')`);
      await page!.click('[data-tab="files"]');
      await page!.click('[data-open="lib/notes.dart"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/notes.dart"]')`);
      await page!.hover('[data-c="R:1"]');
      await page!.until(`document.querySelector('.cm-add')?.classList.contains('on')`);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th.new textarea.cmp-ta')`);
      draft = await read(page!, `document.querySelector('.th.new textarea.cmp-ta')?.value ?? ''`);
    });

    it('then the pill that offered it keeps its size as it updates, saying only how far it is.', () => {
      assert.deepEqual([...new Set(pill.map(([w]) => w))], [236]);
      const said = new Set(pill.map(([, t]) => t));
      assert.ok(said.has(`Updating to ${glowed} · n%`), [...said].join(' / '));
      // Once it's built, the page may hear that untangle moved on before it reloads.
      assert.deepEqual([...said].filter((t) => ![`New commits: ${glowed}`, 'Looking for new commits', `Updating to ${glowed}`, `Updating to ${glowed} · n%`, `Now on ${glowed}`].includes(t)), []);
    });

    it('then the page reloads on the notes file.', () => {
      assert.equal(where, 'Files/lib/notes.dart');
    });

    it('then the greeting stays reviewed, and its call open.', () => {
      assert.equal(marked, 'true false');
    });

    it('then the unsent note is kept.', () => {
      assert.equal(draft, 'Not yet');
    });

    it('then only the new line glows.', () => {
      assert.equal(glow, '// glowed');
    });
  });
});
