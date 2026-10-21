import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
const { agentCommand, firstLine, sh } = await import('../../dist/agents.js');

const link = 'https://github.com/acme/app/pull/12';

describe('Given an agent to start for a review, ', () => {
  it(
    'when its first line is made, '
    + 'then it names the skill as each agent does, the review, and your message, trimmed.',
    () => {
      assert.deepEqual([firstLine('claude', link, '  Look at the tests.\n'), firstLine('codex', link, ''), firstLine('codex', '/work/app', 'Go')], [
        `/untangle ${link} Look at the tests.`,
        `$untangle ${link}`,
        '$untangle /work/app Go',
      ]);
    },
  );

  it(
    'when a new Claude chat starts, '
    + 'then it starts with the session id it was given, named after the review, its flags, and the first line quoted for the shell.',
    () => {
      const id = 'c1a0de00-0000-4000-8000-00000000c1a0';
      assert.deepEqual(agentCommand({ kind: 'claude', resume: null, session: id, flags: ' --model opus ', message: "It's yours" }, link, 'app#12'), {
        command: `claude --session-id ${id} -n 'Review app#12' --model opus '/untangle ${link} It'\\''s yours'`,
        id,
      });
      assert.match(agentCommand({ kind: 'claude', resume: null, flags: '', message: '' }, link, 'app#12').id!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    },
  );

  it(
    'when a chat is resumed, '
    + 'then Claude resumes it by its id, and Codex by its thread, each with the first line.',
    () => {
      assert.deepEqual(agentCommand({ kind: 'claude', resume: 'aaaa-bbbb', flags: '', message: '' }, link, 'app#12'), { command: `claude --resume aaaa-bbbb '/untangle ${link}'`, id: 'aaaa-bbbb' });
      assert.deepEqual(agentCommand({ kind: 'codex', resume: '019a-thread', flags: '-m o4', message: '' }, link, 'app#12'), { command: `codex resume 019a-thread -m o4 '$untangle ${link}'`, id: '019a-thread' });
      assert.deepEqual(agentCommand({ kind: 'codex', resume: null, flags: '', message: '' }, link, 'app#12'), { command: `codex --no-daemon '$untangle ${link}'`, id: null });
    },
  );

  it(
    'when words are quoted for the shell, '
    + 'then plain ones stay as they are, and others go in single quotes, theirs closed and reopened.',
    () => {
      assert.deepEqual([sh('--model'), sh('a b'), sh("it's"), sh('$untangle')], ['--model', "'a b'", "'it'\\''s'", "'$untangle'"]);
    },
  );
});
