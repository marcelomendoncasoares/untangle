import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeRun } from '../../dist/runs.js';
import { feedbackFixture, type FeedbackFixture } from './feedback-fixture.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { untangleCommand } from '../helpers/run.ts';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const author: Person = { name: 'Ada', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
let f: FeedbackFixture;
let repo: TempRepo | null = null;
let socket: Duplex | null = null;
let hung: http.Server | null = null;
afterEach(async () => {
  socket?.destroy();
  socket = null;
  hung?.closeAllConnections();
  if (hung) await new Promise<void>((resolve) => hung!.close(() => resolve()));
  hung = null;
  await f?.remove();
  repo?.remove();
  repo = null;
});

function runFile(url = f.url) {
  repo = TempRepo.create();
  repo.write('a.txt', 'a');
  repo.commit({ subject: 'Start', author, committer: author });
  writeRun({ pid: process.pid, url, token: new URL(f.url).searchParams.get('token')!, dir: fs.realpathSync(repo.dir), pr: 'acme/widget#9', started: new Date().toISOString() });
}

function cliCommand(args: string[]) {
  return untangleCommand(args, { cwd: repo?.dir ?? f.root, cacheDir: f.env.UNTANGLE_CACHE, gh: f.gh, env: { UNTANGLE_FEEDBACK_REPO: 'fixture/feedback' } });
}

async function presence() {
  const url = new URL(f.url);
  const frame = await new Promise<{ socket: Duplex; frame: Promise<unknown> }>((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, path: '/api/presence?id=feedback-test', headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'), 'x-untangle-token': url.searchParams.get('token')!,
    } });
    request.once('error', reject);
    request.once('upgrade', (_response, held, head) => {
      let bytes = head;
      const frame = new Promise<unknown>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('No draft broadcast')), 3000);
        const parse = () => {
          if (bytes.length < 2) return;
          const size = bytes[1] & 127;
          if (size === 126 && bytes.length < 4) return;
          const length = size === 126 ? bytes.readUInt16BE(2) : size;
          const start = size === 126 ? 4 : 2;
          if (bytes.length < start + length) return;
          clearTimeout(timer);
          done(JSON.parse(bytes.subarray(start, start + length).toString('utf8')));
        };
        held.on('data', (chunk) => { bytes = Buffer.concat([bytes, Buffer.from(chunk)]); parse(); });
        held.on('error', fail);
        parse();
      });
      resolve({ socket: held, frame });
    });
    request.end();
  });
  socket = frame.socket;
  return frame;
}

describe('Given an open page and an agent’s draft, ', () => {
  describe('when the agent posts it and the page takes it, ', () => {
    it('then the draft is broadcast, made a report with its title, retained with its timestamp, and cleared on request.', async () => {
      f = await feedbackFixture();
      const page = await presence();
      const draft = { kind: 'bug', text: 'The review hangs', details: [{ k: 'untangle', v: '0.1.0' }], running: [{ command: 'git hash-object -w --stdin', pid: 68131, seconds: 314 }] };
      const response = await f.client.call('feedback/draft', { method: 'POST', body: draft });
      assert.deepEqual(response.data, { pages: 1 });
      const sent = await page.frame as { feedback: { draft: typeof draft & { at: string } } };
      assert.deepEqual({ ...sent.feedback.draft, at: undefined }, { ...draft, title: 'The review hangs', body: '', at: undefined });
      assert.ok(Number.isFinite(Date.parse(sent.feedback.draft.at)));
      const context = (await f.client.call('feedback')).data as { draft: unknown };
      assert.deepEqual(context.draft, sent.feedback.draft);
      assert.deepEqual((await f.client.call('feedback/draft', { method: 'DELETE' })).data, { ok: true });
      assert.equal(((await f.client.call('feedback')).data as { draft: unknown }).draft, null);
    });
  });

  describe('when a later draft arrives before any page takes the first, ', () => {
    it('then the context holds only the newest draft.', async () => {
      f = await feedbackFixture();
      const draft = { kind: 'bug', text: 'First report', details: [], running: [] };
      await f.client.call('feedback/draft', { method: 'POST', body: draft });
      await f.client.call('feedback/draft', { method: 'POST', body: { ...draft, text: 'Second report' } });
      assert.equal(((await f.client.call('feedback')).data as { draft: { text: string } }).draft.text, 'Second report');
    });
  });

  describe('when the draft is malformed, ', () => {
    it('then it is rejected without replacing a valid pending draft.', async () => {
      f = await feedbackFixture();
      await f.client.call('feedback/draft', { method: 'POST', body: { kind: 'bug', text: 'First', details: [], running: [] } });
      assert.equal((await f.client.call('feedback/draft', { method: 'POST', body: { kind: 'bug' } })).status, 400);
      assert.equal(((await f.client.call('feedback')).data as { draft: { text: string } }).draft.text, 'First');
    });
  });
});

describe('Given a review’s run file, ', () => {
  describe('when untangle feedback finds the answering review for this directory, ', () => {
    it('then it leaves a draft and says that no page is open without filing an issue.', async () => {
      f = await feedbackFixture();
      runFile();
      const result = await cliCommand(['feedback', 'The review hangs']);
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /the report is on the review’s page, for you to check and send/);
      assert.match(result.out, /No page is open/);
      const draft = ((await f.client.call('feedback')).data as { draft: { text: string; details: Array<{ k: string; v: string }> } }).draft;
      assert.equal(draft.text, 'The review hangs');
      assert.ok(draft.details.find((d) => d.k === 'untangle')!.v.startsWith('0.1.0, at '));
      assert.equal(f.gh.calls().some((c) => ['issue', 'gist'].includes(c.args[0])), false);
    });
  });

  describe('when a pull request is named explicitly, ', () => {
    it('then that review receives the idea draft.', async () => {
      f = await feedbackFixture();
      runFile();
      const result = await cliCommand(['feedback', 'A new idea', '-idea', 'https://github.com/acme/widget/pull/9']);
      assert.equal(result.code, 0, result.err);
      assert.equal(((await f.client.call('feedback')).data as { draft: { kind: string } }).draft.kind, 'idea');
    });
  });

  describe('when the review never answers, ', () => {
    it('then the command gives up after three seconds and prints its running commands and filled form.', async () => {
      f = await feedbackFixture();
      hung = http.createServer(() => {});
      await new Promise<void>((resolve) => hung!.listen(0, '127.0.0.1', resolve));
      const address = hung.address();
      assert.ok(address && typeof address !== 'string');
      runFile(`http://127.0.0.1:${address.port}/`);
      const started = Date.now();
      const result = await cliCommand(['feedback', 'The review hangs']);
      assert.equal(result.code, 0, result.err);
      assert.ok(Date.now() - started < 7000);
      assert.match(result.out, /review isn’t answering/);
      assert.match(result.out, /pid \d+, \d+m \d+s/);
      const url = new URL(result.out.trim().split('\n').at(-1)!);
      assert.equal(url.origin, 'https://github.com');
      assert.equal(url.pathname, '/fixture/feedback/issues/new');
      assert.equal(url.searchParams.get('what'), 'The review hangs');
      assert.equal(url.searchParams.get('template'), 'bug.yml');
      assert.ok(url.href.length <= 6000);
      assert.equal(f.gh.calls().some((c) => ['issue', 'gist'].includes(c.args[0])), false);
    });
  });
});

describe('Given no review for this directory, ', () => {
  describe('when a long report arrives through stdin, ', () => {
    it('then the draft exits successfully with a bounded link to the idea form.', async () => {
      f = await feedbackFixture();
      const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'feedback', '-', '-idea'], { cwd: f.root, env: { ...process.env, ...f.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.setEncoding('utf8').on('data', (s: string) => { out += s; });
        child.stderr.resume();
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, out }));
        child.stdin.end('An idea\n' + '🧩'.repeat(10000));
      });
      assert.equal(result.code, 0);
      const url = new URL(result.out.trim().split('\n').at(-1)!);
      assert.ok(url.href.length <= 6000);
      assert.equal(url.searchParams.get('template'), 'idea.yml');
      assert.equal(url.searchParams.get('title'), 'An idea');
      assert.equal(f.gh.calls().some((c) => ['issue', 'gist'].includes(c.args[0])), false);
    });
  });
});

describe('Given feedback gists and unrelated gists in the user’s account, ', () => {
  describe('when untangle feedback -list runs, ', () => {
    it('then it prints only the marked gists with their dates and deletion instructions, without changing any.', async () => {
      f = await feedbackFixture(null, [{ match: ['gist', 'list', '--limit', '1000'], stdout: [
        'a123\tuntangle feedback: fixture/feedback#5 The review hangs\t2 files\tsecret\t2026-10-22T12:00:00Z',
        'b123\tRecipe\t1 file\tpublic\t2026-10-21T12:00:00Z',
        'c123\tuntangle feedback: Another report\t2 files\tsecret\t2026-10-20T12:00:00Z',
        'd123\tMention of untangle feedback: elsewhere\t1 file\tsecret\t2026-10-19T12:00:00Z',
      ].join('\n') }]);
      const result = await cliCommand(['feedback', '-list']);
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /https:\/\/gist.github.com\/a123\t2026-10-22T12:00:00Z\tuntangle feedback: fixture\/feedback#5 The review hangs/);
      assert.match(result.out, /https:\/\/gist.github.com\/c123/);
      assert.match(result.out, /gh gist delete <id>/);
      assert.doesNotMatch(result.out, /Recipe|elsewhere|\/b123|\/d123/);
      assert.deepEqual(f.gh.calls().map((c) => c.args), [['gist', 'list', '--limit', '1000']]);
    });
  });

  describe('when none have the feedback mark, ', () => {
    it('then the command says there are no feedback pictures.', async () => {
      f = await feedbackFixture(null, [{ match: ['gist', 'list'], stdout: 'a123\tRecipe\t1 file\tsecret\t2026-10-22T12:00:00Z' }]);
      const result = await cliCommand(['feedback', '-list']);
      assert.equal(result.code, 0);
      assert.match(result.out, /no feedback pictures/);
      assert.deepEqual(f.gh.calls().map((c) => c.args), [['gist', 'list', '--limit', '1000']]);
    });
  });

  describe('when gh is not available or signed in, ', () => {
    it('then the command explains that listing needs gh.', async () => {
      f = await feedbackFixture(null, []);
      const result = await cliCommand(['feedback', '-list']);
      assert.equal(result.code, 1);
      assert.match(result.err, /needs gh, signed in to github.com/);
      assert.deepEqual(f.gh.calls().map((c) => c.args), [['gist', 'list', '--limit', '1000']]);
    });
  });
});
