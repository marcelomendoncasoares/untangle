import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { describe, it, mock } from 'node:test';
import { parse } from 'yaml';
import { Feedback, elapsedSeconds, feedbackForm, reportParts, runningCommands, scrubFeedback, type FeedbackDraft } from '../../dist/feedback.js';
import { parseCommand } from '../../dist/args.js';
import { Narrator } from '../../dist/narrate.js';
import { cacheRoot } from '../../dist/cache.js';
import { stubGh, useStub } from '../helpers/gh.ts';

const draft: FeedbackDraft = { kind: 'bug', text: 'The review hangs', details: [{ k: 'untangle', v: '0.1.0' }], running: [] };

describe('Given narration containing local paths and a page token, ', () => {
  describe('when the feedback log is read, ', () => {
    it('then only the last forty scrubbed printed lines remain, including verbose lines.', async () => {
      const write = mock.method(process.stderr, 'write', () => true);
      const gh = stubGh();
      const restore = useStub(gh);
      try {
        const say = new Narrator({ quiet: false, verbose: true, color: false });
        say.header(Array.from({ length: 45 }, (_, i) => `line ${i}`));
        say.verbose(`${cacheRoot()}/worktrees ${os.homedir()}/project http://localhost/?token=secret&x=1`);
        const feedback = new Feedback({ review: null, broadcast() {}, pages: () => 0 });
        const context = await feedback.context();
        assert.equal(context.log.length, 40);
        assert.equal(context.log[0], '  line 6');
        assert.equal(context.log.at(-1), '      <cache>/worktrees ~/project http://localhost/?token=…&x=1');
        assert.equal(scrubFeedback('\x1b[31mtoken=abc\x1b[0m\nTOKEN=def'), 'token=…\ntoken=…');
      } finally { write.mock.restore(); restore(); gh.remove(); }
    });
  });
});

describe('Given ps output with nested child processes, ', () => {
  describe('when the report collects the review’s commands, ', () => {
    it('then descendants come deepest first and unrelated processes are left out.', () => {
      const running = runningCommands([
        '10 1 01:00 untangle',
        '11 10 05:14 shell',
        '12 11 05:14 git hash-object -w --stdin',
        '13 10 1-02:03:04 dart language-server',
        '14 1 00:03 unrelated',
      ].join('\n'), 10);
      assert.deepEqual(running, [
        { command: 'git hash-object -w --stdin', pid: 12, seconds: 314 },
        { command: 'shell', pid: 11, seconds: 314 },
        { command: 'dart language-server', pid: 13, seconds: 93784 },
      ]);
    });
  });

  describe('when ps prints hours without a day, ', () => {
    it('then the elapsed time retains all hours.', () => {
      assert.equal(elapsedSeconds('27:02:01'), 97321);
    });
  });
});

describe('Given an agent’s words for a report, ', () => {
  // As Codex wrote one, in a paragraph.
  const paragraph = 'While reviewing https://github.com/serverpod/serverpod/pull/5905, untangle watch had returned successfully and said this chat held the review. After the review work, untangle note -review https://github.com/serverpod/serverpod/pull/5905 - failed with: no review of https://github.com/serverpod/serverpod/pull/5905 is running.';

  describe('when they come in lines, or in one short line, ', () => {
    it('then the first line is the title, and the lines after it what happened.', () => {
      assert.deepEqual([reportParts('untangle note fails\r\nIt says no review is running.\n\nThe watch works.\n'), reportParts('  untangle note hangs.  ')], [
        { title: 'untangle note fails', body: 'It says no review is running.\n\nThe watch works.' },
        { title: 'untangle note hangs', body: '' },
      ]);
    });
  });

  describe('when they come in one paragraph, ', () => {
    it('then a first sentence short enough is the title, and the rest what happened; a longer one is cut at a word, with all of the words below it.', () => {
      assert.deepEqual([reportParts('untangle note hangs. The page says nothing.'), reportParts(paragraph)], [
        { title: 'untangle note hangs', body: 'The page says nothing.' },
        { title: 'While reviewing https://github.com/serverpod/serverpod/pull/5905, untangle watch had returned…', body: paragraph },
      ]);
    });
  });

  describe('when they go through GitHub’s form, ', () => {
    it('then the form’s title and what happened are those parts.', () => {
      const url = new URL(feedbackForm({ ...draft, text: paragraph }));
      assert.deepEqual([url.searchParams.get('title'), url.searchParams.get('what')], [reportParts(paragraph).title, paragraph]);
    });
  });
});

describe('Given a report that must go through GitHub’s form, ', () => {
  describe('when the diagnostics alone exceed the link limit, ', () => {
    it('then they are trimmed before any of the user’s description.', () => {
      const url = new URL(feedbackForm({ ...draft, details: [{ k: 'log', v: '🧩'.repeat(10000) }] }));
      assert.ok(url.href.length <= 6000);
      assert.equal(url.searchParams.get('what'), draft.text);
      assert.equal(url.searchParams.get('template'), 'bug.yml');
      assert.equal(url.searchParams.get('title'), draft.text);
    });
  });

  describe('when the user’s description is also too long, ', () => {
    it('then the form still fits within six thousand characters and keeps the idea template.', () => {
      const url = new URL(feedbackForm({ ...draft, kind: 'idea', text: 'An idea\n' + '🧩'.repeat(10000) }));
      assert.ok(url.href.length <= 6000);
      assert.equal(url.searchParams.get('template'), 'idea.yml');
      assert.equal(url.searchParams.get('title'), 'An idea');
      assert.equal(url.searchParams.get('details'), '');
    });
  });
});

describe('Given the feedback command line, ', () => {
  describe('when text, a kind and a pull request are supplied, ', () => {
    it('then they describe a draft rather than a review launch.', () => {
      assert.deepEqual(parseCommand(['feedback', 'Make this clearer', '-idea', 'https://github.com/acme/widget/pull/9']), {
        cmd: 'feedback', kind: 'idea', text: 'Make this clearer', target: 'https://github.com/acme/widget/pull/9', list: false,
      });
    });
  });

  describe('when the text is a dash, ', () => {
    it('then stdin remains the text source.', () => {
      assert.deepEqual(parseCommand(['feedback', '-']), { cmd: 'feedback', kind: 'bug', text: '-', target: null, list: false });
    });
  });
});

describe('Given GitHub’s feedback forms, ', () => {
  describe('when a bug form is opened, ', () => {
    it('then the link’s field ids exist and only the description is required.', () => {
      const form = parse(fs.readFileSync(new URL('../../.github/ISSUE_TEMPLATE/bug.yml', import.meta.url), 'utf8'));
      assert.deepEqual(form.labels, ['bug']);
      assert.deepEqual(form.body.map((field: { id: string }) => field.id), ['what', 'picture', 'details']);
      assert.equal(form.body[0].validations.required, true);
      assert.equal(form.body[0].attributes.label, 'What happened');
      assert.equal(form.body[1].attributes.description, 'Paste the picture untangle copied, or drop one here.');
    });
  });

  describe('when an idea form is opened, ', () => {
    it('then the same fields are available under the idea label.', () => {
      const form = parse(fs.readFileSync(new URL('../../.github/ISSUE_TEMPLATE/idea.yml', import.meta.url), 'utf8'));
      assert.deepEqual(form.labels, ['idea']);
      assert.deepEqual(form.body.map((field: { id: string }) => field.id), ['what', 'picture', 'details']);
      assert.equal(form.body[0].attributes.label, 'Your idea');
      assert.equal(form.body[0].validations.required, true);
    });
  });
});
