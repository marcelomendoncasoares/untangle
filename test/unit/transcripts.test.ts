import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
const { chatTail } = await import('../../dist/transcripts.js');
const { kindOf } = await import('../../dist/manager.js');

const lines = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('Given the transcripts of a Claude chat and a Codex thread, ', () => {
  let home = '';
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-chats-'));
    // Claude: one file per session, in the folder named after where it ran.
    fs.mkdirSync(path.join(home, 'claude', 'projects', '-work-my-app'), { recursive: true });
    fs.writeFileSync(path.join(home, 'claude', 'projects', '-work-my-app', 'chat-1.jsonl'), lines([
      { type: 'user', message: { role: 'user', content: 'Review this in untangle\nplease' } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'a hook said so' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/work/my-app/lib/src/a.dart' } }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'a subagent’s words' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: '1\tvoid greet() {\n2\t}' }] }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Read it.\n\nIt   greets.' }] } },
    ]));
    // Codex: one log per thread, under the day its id says (a UUIDv7: 2026-10-21).
    const day = path.join(home, 'codex', 'sessions', '2026', '10', '21');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-2026-10-21T10-00-00-01a15de7-4500-7000-8000-000000000001.jsonl'), lines([
      { type: 'session_meta', payload: { id: '01a15de7-4500-7000-8000-000000000001', cwd: '/work/my-app' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '$untangle the pull request' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['untangle', 'watch'] }) } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'untangle: nothing to read yet\nmore' } },
      { type: 'event_msg', payload: { type: 'token_count' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({ cmd: "git status" });\nreturn r;' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', output: { output: 'clean' } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The review is open.' }] } },
    ]));
  });
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  it(
    'when Claude’s chat is read, '
    + 'then its last lines are what you said, the tools it ran and their first line out, and its words, without its thinking, hooks, commands or subagents.',
    () => {
      assert.deepEqual(chatTail({ kind: 'claude', id: 'chat-1', home: path.join(home, 'claude'), folder: '/work/my-app' }, 10), [
        { kind: 'you', text: 'Review this in untangle' },
        { kind: 'tool', text: 'Read(lib/src/a.dart)' },
        { kind: 'out', text: '1\tvoid greet() {' },
        { kind: 'say', text: 'Read it. It greets.' },
      ]);
    },
  );

  it(
    'when its folder isn’t known, '
    + 'then the chat is found by its id in any of Claude’s project folders, and only the last lines asked for come back.',
    () => {
      assert.deepEqual(chatTail({ kind: 'claude', id: 'chat-1', home: path.join(home, 'claude') }, 2), [
        { kind: 'out', text: '1\tvoid greet() {' },
        { kind: 'say', text: 'Read it. It greets.' },
      ]);
      assert.equal(chatTail({ kind: 'claude', id: 'chat-none', home: path.join(home, 'claude') }), null);
    },
  );

  it(
    'when Codex’s thread is read, '
    + 'then its last lines come from its log: your message, what it ran, the first line out, and its words, without its context.',
    () => {
      assert.deepEqual(chatTail({ kind: 'codex', id: '01a15de7-4500-7000-8000-000000000001', home: path.join(home, 'codex') }, 10), [
        { kind: 'you', text: '$untangle the pull request' },
        { kind: 'tool', text: 'Ran untangle watch' },
        { kind: 'out', text: 'untangle: nothing to read yet' },
        { kind: 'tool', text: 'Ran const r = await tools.exec_command({ cmd: "git status" });' },
        { kind: 'out', text: 'clean' },
        { kind: 'say', text: 'The review is open.' },
      ]);
    },
  );
});

describe('Given pull request titles, ', () => {
  it(
    'when their conventional type is taken apart, '
    + 'then a type and its scope come off the title, and a title without one stays whole.',
    () => {
      assert.deepEqual([kindOf('feat: Add the install script'), kindOf('refactor(cli): Remove the hardcoded id'), kindOf('fix!: Break it'), kindOf('feature against main')], [
        { kind: 'feat', title: 'Add the install script' },
        { kind: 'refactor', title: 'Remove the hardcoded id' },
        { kind: 'fix', title: 'Break it' },
        { kind: null, title: 'feature against main' },
      ]);
    },
  );
});
