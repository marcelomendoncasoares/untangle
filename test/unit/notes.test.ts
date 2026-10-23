import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TempRepo, type Person } from '../helpers/repo.ts';
import type { Bell, Chat } from '../../dist/chats.js';
import type { At, NotesContext, NotesGitHub } from '../../dist/notes.js';

// A burst of notes reaches an agent this long after the last one.
process.env.UNTANGLE_NOTES_QUIET = '150';
const { Notes, follow, mapLine, parseDiff } = await import('../../dist/notes.js');

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const short = (sha: string) => sha.slice(0, 7);

const v1 = ['void greet() {', "  print('hi');", '}', ''].join('\n');
const v2 = ['/// Greets someone.', 'void greet(String name) {', "  final message = 'Hello, $name!';", '  print(message);', '}', ''].join('\n');
const v3 = ['/// Greets someone.', 'void greet(String name) {', "  print('Hello, $name!');", '}', ''].join('\n');

/** main has v1; feature has v2, then v3 (which drops lib/todo.dart and splits a line of lib/list.dart in three). */
function greeting() {
  const repo = TempRepo.create();
  repo.write('lib/app.dart', v1);
  repo.write('lib/todo.dart', '// Later.\n');
  repo.write('lib/list.dart', 'final a = 1;\nfinal all = [a, b, c];\nfinal c = 3;\n');
  const base = repo.commit({ subject: 'Start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
  repo.branch('feature');
  repo.write('lib/app.dart', v2);
  repo.write('lib/todo.dart', '// Later.\n// Sooner.\n');
  const head = repo.commit({ subject: 'Greet by name', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  repo.write('lib/app.dart', v3);
  repo.delete('lib/todo.dart');
  repo.write('lib/list.dart', 'final a = 1;\nfinal all = [\n  a, b, c,\n];\nfinal c = 3;\n');
  const next = repo.commit({ subject: 'Inline the message', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
  return { repo, base, head, next };
}

/** What the notes asked of GitHub, in order. */
interface Posted { kind: 'thread' | 'reply' | 'conversation' | 'summary' | 'edit'; at?: At; thread?: string; id?: string; body: string; mode?: string }

/** GitHub as the notes see it: what they post is kept, with ids, as GitHub would. */
class FakeGitHub implements NotesGitHub {
  readonly posted: Posted[] = [];
  readonly comments = new Map<string, { body: string; pending: boolean }>();
  summaryNow: { id: string; body: string } | null = null;
  /** Set to make every post fail, as a logged-out gh does. */
  failing: string | null = null;
  private k = 0;
  private post(p: Posted) {
    if (this.failing) throw new Error(this.failing);
    this.posted.push(p);
    return { posted: this.posted.length };
  }
  async thread(at: At, body: string, mode: 'single' | 'review') { const conversation = this.post({ kind: 'thread', at, body, mode }); const n = ++this.k; this.comments.set(`C${n}`, { body, pending: mode === 'review' }); return { conversation, thread: `T${n}`, comment: `C${n}` }; }
  async reply(thread: string, body: string, mode: 'single' | 'review') { const conversation = this.post({ kind: 'reply', thread, body, mode }); const n = ++this.k; this.comments.set(`C${n}`, { body, pending: mode === 'review' }); return { conversation, comment: `C${n}` }; }
  async conversation(body: string) { const conversation = this.post({ kind: 'conversation', body }); const n = ++this.k; this.comments.set(`IC${n}`, { body, pending: false }); return { conversation, comment: `IC${n}` }; }
  async summary(body: string) { const conversation = this.post({ kind: 'summary', body }); this.summaryNow = { id: 'REVIEW_1', body }; return { conversation, review: 'REVIEW_1' }; }
  async edit(id: string, body: string) { const conversation = this.post({ kind: 'edit', id, body }); this.comments.get(id)!.body = body; return { conversation }; }
  current(id: string) { return this.comments.get(id) ?? null; }
  pending() { return this.summaryNow; }
  stale() { return false; }
}

function context(repo: TempRepo, base: string, head: string, gh: NotesGitHub | null = new FakeGitHub()): NotesContext {
  return {
    repo: repo.dir, base, head, name: 'acme/app#7', branch: 'feature', checkout: null,
    change: (p, side, line) => (p === 'lib/app.dart' && side === 'RIGHT' && line === 3 ? { name: 'Greet by name', sha: head } : null),
    gh,
  };
}

describe('Given a diff that changes, renames, deletes and adds files, ', () => {
  const text = [
    'diff --git a/lib/a.dart b/lib/a.dart',
    'index 1..2 100644',
    '--- a/lib/a.dart',
    '+++ b/lib/a.dart',
    '@@ -3,2 +3 @@ void a() {',
    "--- a removed line that looks like a header",
    '-  b();',
    '+  c();',
    '@@ -10,0 +11,2 @@',
    '+x',
    '+y',
    'diff --git a/lib/old.dart b/lib/new.dart',
    'similarity index 100%',
    'rename from lib/old.dart',
    'rename to lib/new.dart',
    'diff --git a/lib/gone.dart b/lib/gone.dart',
    'deleted file mode 100644',
    '--- a/lib/gone.dart',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
    'diff --git a/lib/fresh.dart b/lib/fresh.dart',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/lib/fresh.dart',
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');

  it('when it is read, then each old file says where it went and its hunks, and a new file has no old one.', () => {
    assert.deepEqual(Object.fromEntries(parseDiff(text)), {
      'lib/a.dart': { to: 'lib/a.dart', hunks: [[3, 2, 3, 1], [10, 0, 11, 2]], binary: false },
      'lib/old.dart': { to: 'lib/new.dart', hunks: [], binary: false },
      'lib/gone.dart': { to: null, hunks: [[1, 1, 0, 0]], binary: false },
    });
  });
});

describe('Given hunks that replace lines 3 and 4 with one line, and add two lines after line 10, ', () => {
  const hunks: Array<[number, number, number, number]> = [[3, 2, 3, 1], [10, 0, 11, 2]];

  it('when lines are followed, then the lines above stay, the lines between shift up one, and the lines after the insertion down one more.', () => {
    assert.deepEqual([1, 2, 5, 10, 11].map((l) => mapLine(hunks, l)), [1, 2, 4, 9, 12]);
  });

  it('when a replaced line is followed, then it has no place of its own.', () => {
    assert.equal(mapLine(hunks, 4), null);
  });

  it('when a range over the replaced lines is followed, then it lands on the line that replaced them, changed.', () => {
    assert.deepEqual(follow(hunks, 3, 4), { from: 3, to: 3, changed: true });
  });

  it('when a range around the insertion is followed, then it stretches over the new lines, changed.', () => {
    assert.deepEqual(follow(hunks, 9, 11), { from: 8, to: 12, changed: true });
  });

  it('when a range the hunks don’t touch is followed, then it shifts, unchanged.', () => {
    assert.deepEqual(follow(hunks, 6, 8), { from: 5, to: 7, changed: false });
  });

  it('when lines a hunk only removed are followed, then they are gone.', () => {
    assert.equal(follow([[3, 2, 2, 0]], 3, 4), null);
  });
});

describe('Given notes on the greeting’s message and print, and a note on a file the next commit deletes, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  const gh = new FakeGitHub();

  before(async () => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'pr-7.json'));
    notes.attach(context(g.repo, g.base, g.head, gh));
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 3, body: 'Why a local?' });
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', startLine: 4, line: 5, body: 'Print it once.' });
    await notes.act({ action: 'reply', n: 2, body: 'And flush.' });
    await notes.act({ action: 'add', path: 'lib/todo.dart', side: 'RIGHT', line: 2, body: 'Sooner than what?' });
    await notes.act({ action: 'resolve', n: 3, resolved: true });
    await notes.act({ action: 'add', path: 'lib/list.dart', side: 'RIGHT', line: 2, body: 'One per line?' });
    await notes.act({ action: 'resolve', n: 4, resolved: true });
  });

  after(() => {
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when the open notes are copied, then each comes with its lines, its code, the change it is in and its thread.', () => {
    assert.equal(notes.exportText('open'), [
      `My review notes on acme/app#7 (branch feature, at ${short(g.head)}). Line numbers are on that commit.`,
      '',
      'Where a note explicitly asks for a change, make it. Otherwise, discuss it with me before changing anything.',
      '',
      'N1 · lib/app.dart:3',
      `In the change "Greet by name" (${short(g.head)})`,
      '```dart',
      "  final message = 'Hello, $name!';",
      '```',
      'Why a local?',
      '',
      'N2 · lib/app.dart:4-5',
      '```dart',
      '  print(message);',
      '}',
      '```',
      'Print it once.',
      'You: And flush.',
      '',
    ].join('\n'));
  });

  it('when all the notes are copied, then the resolved ones come too, said so.', () => {
    assert.match(notes.exportText('all'), /\nN3 · lib\/todo\.dart:2 \(resolved\)\n```dart\n\/\/ Sooner\.\n```\nSooner than what\?\n\nN4 · lib\/list\.dart:2 \(resolved\)\n/);
  });

  it('when the notes are read again from their file, then they are the same.', () => {
    const again = new Notes(notes.file);
    again.attach(context(g.repo, g.base, g.head));
    assert.equal(again.exportText('all'), notes.exportText('all'));
  });

  describe('and the review moves to the next commit, ', () => {
    let moved: InstanceType<typeof Notes>;

    before(() => {
      moved = new Notes(notes.file);
      moved.attach(context(g.repo, g.base, g.next));
    });

    it('when the notes are listed, then the message’s note is on the line that replaced it, the print’s on the lines after, the split line’s on its three, all changed, and the deleted file’s note is gone.', () => {
      const view = moved.view();
      assert.deepEqual(view.notes.map((n) => [n.n, n.path, n.startLine, n.line, n.changed, n.gone, n.code]), [
        [1, 'lib/app.dart', null, 3, true, false, ["  print('Hello, $name!');"]],
        [2, 'lib/app.dart', 3, 4, true, false, ["  print('Hello, $name!');", '}']],
        [3, 'lib/todo.dart', null, 2, false, true, ['// Sooner.']],
        [4, 'lib/list.dart', 2, 4, true, false, ['final all = [', '  a, b, c,', '];']],
      ]);
    });

    it('when the message’s note is copied, then it says its lines changed since it was written, and shows the new ones.', () => {
      const n1 = moved.view().notes[0];
      assert.equal(n1.text, [
        `N1 · lib/app.dart:3`,
        `In the change "Greet by name" (${short(g.next)})`,
        `Changed since ${short(g.head)}, where I wrote this. The lines below are the new ones.`,
        '```dart',
        "  print('Hello, $name!');",
        '```',
        'Why a local?',
        '',
      ].join('\n'));
    });

    it('when the gone note is copied, then it shows the lines it was written on.', () => {
      assert.equal(moved.view().notes[2].text, [
        'N3 · lib/todo.dart:2 (resolved)',
        `Gone since ${short(g.head)}, where I wrote this. The lines below are the ones it was on then.`,
        '```dart',
        '// Sooner.',
        '```',
        'Sooner than what?',
        '',
      ].join('\n'));
    });
  });

  it('when the open notes are posted to GitHub, then each says its first words in the pending review, on its lines, and stays, in the thread it made.', async () => {
    const out = await notes.act({ action: 'post', ns: [1, 2] });
    assert.deepEqual(gh.posted, [
      { kind: 'thread', at: { path: 'lib/app.dart', line: 3, side: 'RIGHT' }, body: 'Why a local?', mode: 'review' },
      { kind: 'thread', at: { path: 'lib/app.dart', line: 5, side: 'RIGHT', startLine: 4, startSide: 'RIGHT' }, body: 'Print it once.', mode: 'review' },
    ]);
    assert.deepEqual([out.notes.map((n) => `N${n.n}${n.said.map((x) => ` ${x.kind} ${x.thread} ${x.id}${x.pending ? ' pending' : ''}`).join('')}`), out.conversation], [['N1 thread T1 C1 pending', 'N2 thread T2 C2 pending', 'N3', 'N4'], { posted: 2 }]);
  });
});

describe('Given notes an agent watches, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  let pushed = 0;

  before(() => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'feature.json'), () => { pushed++; });
    notes.attach(context(g.repo, g.base, g.head));
  });

  after(() => {
    notes.close();
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when two notes come in a burst, then the waiting watch gets both at once, with the opening line, and says how to go on the first time.', async () => {
    const waiting = notes.watch('Claude', { timeout: 10_000 });
    assert.deepEqual(notes.agents().map((a) => [a.name, a.state]), [['Claude', 'listening']]);
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 3, body: 'Why a local?' });
    await new Promise((r) => setTimeout(r, 60));
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 4, body: 'Flush after it.' });
    const got = await waiting;
    assert.ok('text' in got);
    assert.deepEqual([got.notes, got.replies, got.first], [2, 0, true]);
    assert.equal(got.text.split('\n').slice(0, 3).join('\n'), `untangle: 2 notes you haven’t read, on acme/app#7 at ${short(g.head)}. Line numbers are on that commit.\n\nWhere a note explicitly asks for a change, make it. Otherwise, discuss it with me before changing anything.`);
    assert.match(got.text, /\nN1 · lib\/app\.dart:3\n[\s\S]*\nN2 · lib\/app\.dart:4\n/);
  });

  it('when the page lists the notes, then the agent read them, and works on them until it answers.', () => {
    const view = notes.view();
    assert.deepEqual([view.notes.map((n) => n.status), view.agents.map((a) => [a.name, a.state, a.on])], [[{ read: 'Claude' }, { read: 'Claude' }], [['Claude', 'working', [1, 2]]]]);
  });

  it('when the agent answers and resolves a note, then the page shows its answer and who resolved it, and its own watch doesn’t get them back.', async () => {
    await notes.reply('Claude', 2, 'Done in abc1234.', true);
    const n2 = notes.view().notes[1];
    assert.deepEqual([n2.comments.map((c) => [c.by, c.body]), n2.resolved?.by], [[[null, 'Flush after it.'], ['Claude', 'Done in abc1234.']], 'Claude']);
    const again = await notes.watch('Claude', { timeout: 300 });
    assert.deepEqual(again, { idle: true, first: false });
  });

  it('when you answer, reopen and edit, then the next watch gets your reply and what changed on the notes it read.', async () => {
    await notes.act({ action: 'reply', n: 1, body: 'Keep the doc comment.' });
    await notes.act({ action: 'resolve', n: 2, resolved: false });
    await notes.act({ action: 'edit', n: 2, id: notes.view().notes[1].comments[0].id, body: 'Flush after it, always.' });
    const got = await notes.watch('Claude', { timeout: 5_000 });
    assert.ok('text' in got);
    assert.equal(got.text.slice(got.text.indexOf('\n\n') + 2), [
      'N1 · lib/app.dart:3 · a reply in its thread',
      '> Why a local?',
      'You: Keep the doc comment.',
      '',
      'N2 · lib/app.dart:4 · reopened by you.',
      '',
      'N2 · lib/app.dart:4 · you edited the note:',
      'Flush after it, always.',
      '',
    ].join('\n'));
  });

  it('when you answer in a thread and resolve its note, or reopen a note and answer in it, then the thread says so.', async () => {
    await notes.reply('Claude', 2, 'Flushed on every path.', true);
    await notes.act({ action: 'reply', n: 1, body: 'Leave it as it is.' });
    await notes.act({ action: 'resolve', n: 1, resolved: true });
    await notes.act({ action: 'resolve', n: 2, resolved: false });
    await notes.act({ action: 'reply', n: 2, body: 'Not yet: the error path skips it.' });
    const got = await notes.watch('Claude', { timeout: 5_000 });
    assert.ok('text' in got);
    assert.deepEqual([got.notes, got.replies], [0, 2]);
    assert.equal(got.text.slice(got.text.indexOf('\n\n') + 2), [
      'N1 · lib/app.dart:3 · replies in its thread · resolved by you',
      '> Why a local?',
      'You: Keep the doc comment.',
      'You: Leave it as it is.',
      '',
      'N2 · lib/app.dart:4 · replies in its thread · reopened by you',
      '> Flush after it, always.',
      'Claude: Done in abc1234.',
      'Claude: Flushed on every path.',
      'You: Not yet: the error path skips it.',
      '',
    ].join('\n'));
  });

  it('when you resolve a note and nothing else, then no watch wakes for it, and the next news brings it.', async () => {
    await notes.act({ action: 'resolve', n: 2, resolved: true });
    const quiet = await notes.watch('Claude', { timeout: 300 });
    await notes.act({ action: 'reply', n: 1, body: 'Thanks.' });
    const got = await notes.watch('Claude', { timeout: 5_000 });
    assert.ok('text' in got);
    assert.deepEqual(quiet, { idle: true, first: false });
    assert.equal(got.text.slice(got.text.indexOf('\n\n') + 2), [
      'N1 · lib/app.dart:3 · replies in its thread',
      '> Why a local?',
      'You: Keep the doc comment.',
      'You: Leave it as it is.',
      'You: Thanks.',
      '',
      'N2 · lib/app.dart:4 · resolved by you.',
      '',
    ].join('\n'));
  });

  it('when live review is off, then a new note waits, held, until you send it.', async () => {
    await notes.act({ action: 'settings', live: false });
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 2, body: 'Name it person?' });
    assert.deepEqual([notes.view().held, notes.view().notes[2].status], [1, 'held']);
    assert.deepEqual(await notes.watch('Claude', { timeout: 300 }), { idle: true, first: false });
    await notes.act({ action: 'send' });
    const got = await notes.watch('Claude', { timeout: 5_000 });
    assert.ok('text' in got && /\nN3 · lib\/app\.dart:2\n/.test(got.text));
    assert.equal(notes.view().held, 0);
  });

  it('when another agent watches for the first time, then it gets every note, the first agent’s answer with them.', async () => {
    const got = await notes.watch('Codex', { timeout: 5_000 });
    assert.ok('text' in got);
    assert.deepEqual([got.notes, got.first, /\nClaude: Done in abc1234\.\n/.test(got.text)], [3, true, true]);
  });

  it('when the agent stops asking, then it is no longer listening, but still working on what it read.', async () => {
    const stop = new AbortController();
    const state = () => notes.agents().find((a) => a.name === 'Codex')?.state;
    void notes.watch('Codex', { timeout: 10_000, signal: stop.signal });
    const waiting = state();
    stop.abort();
    assert.deepEqual([waiting, state()], ['listening', 'working']);
  });

  it('when the review closes, then a waiting watch hears so.', async () => {
    const waiting = notes.watch('Claude', { timeout: 10_000 });
    notes.close();
    assert.deepEqual(await waiting, { closed: true });
    assert.ok(pushed > 0);
  });
});

/** A stand-in for how untangle learns about chats and reaches them: each chat's state, and the lines it got. */
function standIn() {
  const chats = new Map<string, { alive?: boolean; busy?: { busy: boolean; since: number }; fails?: string }>();
  const rung: Array<[string, string]> = [], woke: Array<[string, string]> = [];
  const bell: Bell = {
    alive: (c) => chats.get(c.id)?.alive ?? true,
    busy: (c) => chats.get(c.id)?.busy ?? null,
    ring: async (c, line) => { rung.push([c.id, line]); return chats.get(c.id)?.fails ?? null; },
    wake: async (c, line) => { woke.push([c.id, line]); return null; },
  };
  return { chats, rung, woke, bell };
}
const claude = (id: string): Chat => ({ kind: 'claude', id, pid: 4242, started: null, home: '/nowhere', bin: null, orca: { cli: '/opt/orca/orca-ide', handle: `term_${id}`, pane: null } });
const codex = (id: string): Chat => ({ kind: 'codex', id, pid: 4343, started: null, home: '/nowhere', bin: '/opt/codex/codex', orca: null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const add = (notes: InstanceType<typeof Notes>, line: number, body: string) => notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line, body });

describe('Given notes a Claude chat holds, in an Orca terminal, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  const s = standIn();

  before(() => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'feature.json'), () => {}, s.bell);
    notes.attach(context(g.repo, g.base, g.head));
  });

  after(() => {
    notes.close();
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when its watch waits, then Claude is listening; when the watch brings a note, it works on it while its chat is busy.', async () => {
    const waiting = notes.watch('Claude', { timeout: 10_000, chat: claude('a') });
    const listening = notes.agents()[0].state;
    await add(notes, 3, 'Why a local?');
    const got = await waiting;
    s.chats.set('a', { busy: { busy: true, since: Date.now() } });
    const a = notes.agents()[0];
    assert.deepEqual([listening, 'text' in got, a.state, a.on, a.kind, a.chat, a.orca], ['listening', true, 'working', [1], 'claude', 'a', true]);
  });

  it('when its turn ends without another watch, then Claude isn’t listening; once there’s news for it, the page can wake it with a line, and the note reaches nobody.', async () => {
    s.chats.set('a', { busy: { busy: false, since: Date.now() } });
    const deaf = notes.agents()[0];
    await add(notes, 4, 'Flush after it.');
    const a = notes.agents()[0];
    assert.deepEqual([deaf.state, deaf.wake, a.state, a.wake, notes.view().notes[1].status], ['deaf', null, 'deaf', 'untangle: 1 new note on the review of #7. Run untangle watch to read it.', 'nobody']);
  });

  it('when the page wakes it, then the line is typed into its chat and the note waits for its turn, until a turn that doesn’t read it.', async () => {
    await notes.wake('Claude');
    const queued = notes.agents()[0];
    s.chats.set('a', { busy: { busy: false, since: Date.now() + 5 } });
    assert.deepEqual([s.woke, queued.state, queued.on, notes.agents()[0].state], [[['a', 'untangle: 1 new note on the review of #7. Run untangle watch to read it.']], 'queued', [2], 'deaf']);
  });

  it('when another Claude chat watches, then the first chat’s watch hears it was taken over, and the new one gets every open note with its thread, told how the review works.', async () => {
    await notes.act({ action: 'reply', n: 1, body: 'Keep the doc comment.' });
    await notes.watch('Claude', { timeout: 5_000, chat: claude('a') });
    const first = notes.watch('Claude', { timeout: 10_000, chat: claude('a') });
    const second = await notes.watch('Claude', { timeout: 10_000, chat: claude('b') });
    assert.deepEqual(await first, { taken: true });
    assert.ok('text' in second && second.first);
    assert.equal(second.text.split('\n').slice(0, 5).join('\n'), [
      `untangle: you hold this review now: another Claude chat held it. Here are its 2 open notes, on acme/app#7 at ${short(g.head)}. Line numbers are on that commit.`,
      '',
      'Where a note explicitly asks for a change, make it. Otherwise, discuss it with me before changing anything.',
      '',
      'N1 · lib/app.dart:3',
    ].join('\n'));
    assert.match(second.text, /\nWhy a local\?\nYou: Keep the doc comment\.\n\nN2 · lib\/app\.dart:4\n/);
    assert.deepEqual([notes.agents()[0].chat, (await notes.reply('Claude', 2, 'From the old chat.', false, 'a')).other], ['b', true]);
  });

  it('when the chat ends, then the page says Claude left, and a new note reaches nobody.', async () => {
    s.chats.set('b', { alive: false });
    await add(notes, 2, 'Name it person?');
    assert.deepEqual([notes.agents()[0].state, notes.view().notes.at(-1)?.status], ['left', 'nobody']);
  });
});

describe('Given notes a Codex chat holds, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  const s = standIn();
  const watch = () => notes.watch('Codex', { timeout: 10_000, chat: codex('t'), brief: true });

  before(() => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'feature.json'), () => {}, s.bell);
    notes.attach(context(g.repo, g.base, g.head));
  });

  after(() => {
    notes.close();
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when its watch finds nothing to read, then it returns at once, and Codex is listening.', async () => {
    const t0 = Date.now();
    const got = await watch();
    assert.deepEqual([got, Date.now() - t0 < 1000, notes.agents()[0].state], [{ idle: true, first: true }, true, 'listening']);
  });

  it('when a burst of notes is written, then untangle puts one line in its chat a moment after the last, and the notes wait for its turn.', async () => {
    await add(notes, 3, 'Why a local?');
    await sleep(60);
    await add(notes, 4, 'Flush after it.');
    const early = s.rung.length;
    await sleep(400);
    const a = notes.agents()[0];
    assert.deepEqual([early, s.rung, a.state, a.on, notes.view().notes.map((n) => n.status)], [0, [['t', 'untangle: 2 new notes on the review of #7. Run untangle watch to read them.']], 'queued', [1, 2], ['queued', 'queued']]);
  });

  it('when you reply while that line waits unread, then no second line goes.', async () => {
    await notes.act({ action: 'reply', n: 1, body: 'And the doc comment?' });
    await sleep(400);
    assert.equal(s.rung.length, 1);
  });

  it('when its watch reads them, then it works on what it hasn’t answered, and listens again once it has.', async () => {
    const got = await watch();
    const working = notes.agents()[0];
    await notes.reply('Codex', 1, 'It names the greeting.', false);
    const one = notes.agents()[0];
    await notes.reply('Codex', 2, 'Done.', true);
    assert.ok('text' in got && /\nWhy a local\?\nYou: And the doc comment\?\n/.test(got.text));
    assert.deepEqual([working.state, working.on, one.on, notes.agents()[0].state], ['working', [1, 2], [2], 'listening']);
  });

  it('when its log says its turn ended after the watch, then it listens, and works while a turn runs.', async () => {
    await add(notes, 2, 'Name it person?');
    await sleep(400);
    await watch();
    s.chats.set('t', { busy: { busy: true, since: Date.now() - 1000 } });
    const busy = notes.agents()[0].state;
    s.chats.set('t', { busy: { busy: false, since: Date.now() + 5 } });
    assert.deepEqual([busy, notes.agents()[0].state], ['working', 'listening']);
  });

  it('when a line can’t reach its chat, then the page says why, and the next note tries again.', async () => {
    const idle = s.chats.get('t')!;
    s.chats.set('t', { ...idle, fails: 'no rollout found for thread id t' });
    await add(notes, 1, 'A doc comment for the file?');
    await sleep(400);
    const failed = notes.agents()[0];
    s.chats.set('t', idle);
    await notes.act({ action: 'reply', n: 4, body: 'Or for the library?' });
    await sleep(400);
    assert.deepEqual([failed.state, failed.error, s.rung.length, notes.agents()[0].error], ['listening', 'untangle couldn’t put a line in Codex’s chat: no rollout found for thread id t', 4, null]);
  });

  it('when its chat ended, then untangle puts no line in it, and says Codex left.', async () => {
    await watch();
    s.chats.set('t', { alive: false });
    await add(notes, 2, 'Or name it guest?');
    await sleep(400);
    assert.deepEqual([s.rung.length, notes.agents()[0].state], [4, 'left']);
  });
});

describe('Given notes a review keeps, and an agent that reviews the change too, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;

  before(() => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'feature.json'), () => {}, standIn().bell);
    notes.attach(context(g.repo, g.base, g.head));
  });

  after(() => {
    notes.close();
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when the agent writes a note on lines, then it is a thread of its own on them, said to be its, with no read status.', () => {
    const wrote = notes.write('Claude', { path: 'lib/app.dart', side: 'RIGHT', startLine: 3, line: 4, body: 'Print the message directly?' });
    const n1 = notes.view().notes[0];
    assert.deepEqual([wrote, n1.comments.map((c) => [c.by, c.body]), n1.status], [
      { n: 1, where: 'lib/app.dart:3-4', head: short(g.head), code: ["  final message = 'Hello, $name!';", '  print(message);'], other: false },
      [['Claude', 'Print the message directly?']],
      null,
    ]);
    assert.match(n1.text, /\n```\nClaude: Print the message directly\?\n$/);
  });

  it('when the agent writes a note past the file’s end, then it hears how long the file is.', () => {
    assert.throws(() => notes.write('Claude', { path: 'lib/app.dart', side: 'RIGHT', line: 40, body: 'Here?' }), (e: Error) => e.message === `lib/app.dart has 5 lines at ${short(g.head)}`);
  });

  it('when another agent watches, then the note comes as a new one, said to be the first agent’s.', async () => {
    const got = await notes.watch('Codex', { timeout: 5_000 });
    assert.ok('text' in got && /\nN1 · lib\/app\.dart:3-4\n[\s\S]*\nClaude: Print the message directly\?\n/.test(got.text));
  });

  it('when you answer in its thread, then the agent’s next watch brings your answer, and not its own note.', async () => {
    await notes.act({ action: 'reply', n: 1, body: 'Yes, inline it.' });
    const got = await notes.watch('Claude', { timeout: 5_000 });
    assert.ok('text' in got);
    assert.equal(got.text.slice(got.text.indexOf('\n\n') + 2), ['N1 · lib/app.dart:3-4 · a reply in its thread', '> Claude: Print the message directly?', 'You: Yes, inline it.', ''].join('\n'));
  });
});

describe('Given where comments go, before you choose, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  const book = (name: string, byAgent: boolean) => {
    const notes = new Notes(path.join(dir, name), () => {}, standIn().bell, byAgent);
    notes.attach(context(g.repo, g.base, g.head));
    return notes;
  };

  before(() => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
  });

  after(() => {
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when a review an agent’s session started, or one with notes, is opened, then comments go to notes; else to GitHub, until you choose.', async () => {
    const started = book('agent.json', true), plain = book('plain.json', false), noted = book('noted.json', false);
    await noted.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 3, body: 'Why a local?' });
    const before = [started.view().mode, plain.view().mode, noted.view().mode];
    await started.act({ action: 'settings', mode: 'github' });
    assert.deepEqual([before, started.view().mode], [['local', null, 'local'], 'github']);
    [started, plain, noted].forEach((n) => n.close());
  });
});

describe('Given a note on a pull request reviewed from its link, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  const checkout = '/cache/worktrees/github.com/acme/app/0123456789ab';

  before(() => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'feature.json'), () => {});
    notes.attach({ ...context(g.repo, g.base, g.head), checkout });
  });

  after(() => {
    notes.close();
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when a watch brings it, or the notes are printed, then they say where untangle checked the head out, to read its code there.', async () => {
    await add(notes, 3, 'Why a local?');
    const got = await notes.watch('Claude', { timeout: 5_000 });
    assert.ok('text' in got);
    const there = ` That commit is checked out at ${checkout}, for reading only, since untangle builds the review from it: propose any change in a reply.`;
    assert.deepEqual([got.text.split('\n')[0], notes.exportText('open').split('\n')[0]], [
      `untangle: 1 note you haven’t read, on acme/app#7 at ${short(g.head)}. Line numbers are on that commit.${there}`,
      `My review notes on acme/app#7 (branch feature, at ${short(g.head)}). Line numbers are on that commit.${there}`,
    ]);
  });
});

describe('Given notes kept with the opening line untangle once gave them, and notes with one of your own, ', () => {
  let dir = '';
  const kept = (opening: string) => {
    const file = path.join(dir, `${encodeURIComponent(opening.slice(0, 12))}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', live: true, opening, scope: 'open', base: null, head: null, next: 1, seq: 0, notes: [], events: [], agents: {} }));
    return new Notes(file).exportText('open').split('\n')[2];
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when they are read, then the former defaults give way to today’s, which changes code only where a note explicitly asks, and yours stays.', () => {
    assert.deepEqual([kept('Discuss these with me before changing anything.'), kept('Where a note asks for a change, make it. Where it asks a question, or isn’t clear, answer it before changing anything.'), kept('Only answer: change nothing.')], [
      'Where a note explicitly asks for a change, make it. Otherwise, discuss it with me before changing anything.',
      'Where a note explicitly asks for a change, make it. Otherwise, discuss it with me before changing anything.',
      'Only answer: change nothing.',
    ]);
  });
});

describe('Given notes on a pull request on GitHub, and Claude watching, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  const gh = new FakeGitHub();
  const watch = async () => {
    const r = await notes.watch('Claude', { timeout: 5_000 });
    return 'text' in r ? r.text : JSON.stringify(r);
  };

  before(async () => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'pr-7.json'));
    notes.attach(context(g.repo, g.base, g.head, gh));
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 3, body: 'Why a local?' });
    await watch();
    await notes.reply('Claude', 1, 'It names the message before printing it.', false);
  });

  after(() => {
    notes.close();
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('when you ask for a draft with no words of your own, ', () => {
    let text: string;

    before(async () => {
      await notes.act({ action: 'reply', n: 1, body: '', draft: true });
      text = await watch();
    });

    it('then Claude reads the ask in your stead, and that its answer goes to GitHub as it is, pending on the note’s lines.', () => {
      assert.equal(text.split('\n').slice(2).join('\n'), [
        'N1 · lib/app.dart:3 · replies in its thread · you ask for a draft comment',
        '> Why a local?',
        'Claude: It names the message before printing it.',
        'You: Draft a comment for GitHub from this talk, in a natural tone.',
        'This asks for a draft comment for GitHub. Answer with the comment alone, as untangle reply N1 \'…\': untangle posts your answer as it is, on its lines, pending in your user’s review, for them to edit and send.',
        '',
      ].join('\n'));
    });
  });

  describe('when Claude answers it, ', () => {
    let answer: Awaited<ReturnType<InstanceType<typeof Notes>['reply']>>;

    before(async () => {
      answer = await notes.reply('Claude', 1, 'The local names the message; inlining it reads as well.', false);
    });

    it('then its answer is a pending comment of yours on the note’s lines, not a reply in the note, and the answer says where it went.', () => {
      const n1 = notes.view().notes[0];
      assert.deepEqual([gh.posted, answer.drafted, n1.comments.length, n1.said.map((x) => `${x.by} ${x.kind} ${x.id}${x.pending ? ' pending' : ''}`)], [
        [{ kind: 'thread', at: { path: 'lib/app.dart', line: 3, side: 'RIGHT' }, body: 'The local names the message; inlining it reads as well.', mode: 'review' }],
        'on its lines on GitHub, pending in your user’s review',
        3,
        ['Claude thread C1 pending'],
      ]);
    });
  });

  describe('when you edit the draft on GitHub and ask again, ', () => {
    let text: string;

    before(async () => {
      gh.comments.get('C1')!.body = 'The local names the message: inline it.';
      await notes.act({ action: 'reply', n: 1, body: 'Shorter, and ask for a test.', draft: true });
      text = await watch();
      await notes.reply('Claude', 1, 'Inline the message, and add a test for the greeting.', false);
    });

    it('then Claude reads the draft as it is now, and its answer rewrites that draft instead of adding one.', () => {
      assert.match(text, /You: Shorter, and ask for a test\.\nThis asks for a draft comment for GitHub\. Answer with the comment alone, as untangle reply N1 '…': untangle posts your answer as it is, as a reply in its thread on GitHub, pending in your user’s review, for them to edit and send\.\nYour earlier draft is there now, pending \(they may have edited it\):\n> The local names the message: inline it\.\nWrite it again, taking in both what they ask and what’s there: your answer replaces it\.\n/);
      assert.deepEqual([gh.posted.slice(1), notes.view().notes[0].said.length], [[{ kind: 'edit', id: 'C1', body: 'Inline the message, and add a test for the greeting.' }], 1]);
    });
  });

  describe('when a note on the review asks for a draft, and Claude answers, ', () => {
    before(async () => {
      await notes.act({ action: 'add', path: '', review: true, body: 'Sum the review up for the author.', draft: true });
      await watch();
      await notes.reply('Claude', 2, 'Clear change; inline the message and test the greeting.', false);
    });

    it('then the answer is your pending review’s summary, as GitHub keeps no comment on the conversation pending.', () => {
      assert.deepEqual([gh.posted.slice(2), notes.view().notes[1].said.map((x) => `${x.kind} ${x.id}`)], [[{ kind: 'summary', body: 'Clear change; inline the message and test the greeting.' }], ['summary REVIEW_1']]);
    });
  });

  describe('when what a note said goes on GitHub from the page (Comment this), ', () => {
    let quiet: string;
    let text: string;

    before(async () => {
      await notes.act({ action: 'comment', n: 1, body: 'Inline the message.', mode: 'single' });
      const r = await notes.watch('Claude', { timeout: 400, brief: true });
      quiet = 'idle' in r ? 'idle' : JSON.stringify(r);
      await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 4, body: 'And this print?' });
      text = await watch();
    });

    it('then it’s a reply in the note’s thread, and Claude hears of it with its next news, which it doesn’t wake for.', () => {
      assert.deepEqual([gh.posted.slice(3), quiet], [[{ kind: 'reply', thread: 'T1', body: 'Inline the message.', mode: 'single' }], 'idle']);
      assert.match(text, /\nN1 · lib\/app\.dart:3 · you commented on GitHub from it:\n> Inline the message\.\n/);
    });
  });

  describe('when GitHub can’t take a draft, ', () => {
    let answer: Awaited<ReturnType<InstanceType<typeof Notes>['reply']>>;

    before(async () => {
      await notes.act({ action: 'reply', n: 3, body: 'Draft it.', draft: true });
      await watch();
      gh.failing = 'gh is not logged in to GitHub: run `gh auth login`';
      answer = await notes.reply('Claude', 3, 'Print the name once.', false);
      gh.failing = null;
    });

    it('then the answer stays in the note’s thread, and says why.', () => {
      const n3 = notes.view().notes[2];
      assert.deepEqual([answer.drafted, answer.error, n3.comments.map((c) => `${c.by ?? 'You'}: ${c.body}`).pop(), n3.said.length], [null, 'gh is not logged in to GitHub: run `gh auth login`', 'Claude: Print the name once.', 0]);
    });
  });

  describe('when a note is about a comment of the conversation, ', () => {
    let text: string;

    before(async () => {
      await notes.act({ action: 'add', path: '', body: 'Is this right?', about: { kind: 'comment', comment: 'IC_9', author: 'grace', body: 'The benchmark is slower.', url: 'https://github.com/acme/app/pull/7#issuecomment-9' } });
      text = await watch();
    });

    it('then it’s on the review, and Claude reads the comment, quoted.', () => {
      assert.equal(notes.view().notes[3].review, true);
      assert.match(text, /\nN4 · on the review\nAbout grace’s comment on GitHub \(https:\/\/github\.com\/acme\/app\/pull\/7#issuecomment-9\):\n> The benchmark is slower\.\nIs this right\?\n/);
    });
  });
});

describe('Given a notes file from before notes knew what they made on GitHub, ', () => {
  it('when it’s read, then a note that quoted a thread is about it, and has made nothing.', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    const file = path.join(dir, 'pr-7.json');
    const comment = { id: 'a1', by: null, body: 'Why?', at: '2020-06-01T00:00:00Z', edited: null, sent: 1 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'local', live: true, opening: 'Go.', scope: 'open', base: null, head: null, next: 2, seq: 1, events: [], agents: {}, notes: [
      { n: 1, path: 'lib/app.dart', file: false, side: 'RIGHT', line: 3, startSide: null, startLine: null, code: [], wrote: { head: 'h', path: 'lib/app.dart', line: 3, startLine: null, code: [] }, changed: false, gone: false, resolved: null, copied: false, quote: { thread: 'THREAD_1', author: 'grace', body: 'Rename it.', url: 'https://github.com/x' }, comments: [comment] },
    ] }));
    const note = new Notes(file).view().notes[0] as Record<string, unknown>;
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual([note.about, note.said, 'quote' in note], [{ kind: 'thread', thread: 'THREAD_1', author: 'grace', body: 'Rename it.', url: 'https://github.com/x' }, [], false]);
  });
});
