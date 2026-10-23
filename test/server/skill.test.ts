import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { untangleCommand } from '../helpers/run.ts';

// untangle skill in a home of its own, where only what the test makes says Claude or Codex is here.
describe('Given a home where Claude and Codex keep their folders, ', () => {
  let gh: GhStub;
  let home = '';
  const run = (args: string[], at = home) => untangleCommand(['skill', ...args], { cacheDir: path.join(at, 'cache'), gh, cwd: at, env: { HOME: at, PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` } });
  const fresh = (...dirs: string[]) => {
    const at = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-home-'));
    dirs.forEach((d) => fs.mkdirSync(path.join(at, d), { recursive: true }));
    return at;
  };
  const homes: string[] = [];

  before(() => {
    gh = stubGh();
    home = fresh('.claude', '.codex');
    homes.push(home);
  });

  after(() => {
    gh.remove();
    homes.forEach((h) => fs.rmSync(h, { recursive: true, force: true }));
  });

  it('when the skill is read, then it tells the agent to make the changes the user requests in the working copy, commit them there, and push only when asked.', async () => {
    const r = await run([]);
    assert.ok(r.out.includes(`For a pull request opened from its link, the watch names untangle's checkout of the reviewed
commit, for reading only, and, for an open pull request, a working copy of its branch, for
changes. Make the changes the user requests in the working copy and commit them there. Push only
when the user asks. Without a working copy, propose a change in the reply instead. When asked for
a review of the change, do it now, as described below. Then tell the user the review is open and
end the turn.`));
  });

  it(
    'when the skill is installed, '
    + 'then it goes where each agent reads skills, with the rule that lets untangle run outside Codex’s sandbox.',
    async () => {
      const r = await run(['-install']);
      const skill = (await run([])).out;
      assert.deepEqual([r.code, r.out.split('\n')], [0, [
        'untangle: installed the untangle skill, for both agents:',
        '  ~/.claude/skills/untangle/SKILL.md   Claude: /untangle, or ask for a review in untangle',
        '  ~/.agents/skills/untangle/SKILL.md   Codex: $untangle, or ask the same',
        'untangle: Codex’s sandbox can’t write untangle’s cache or serve its page, so untangle runs outside it:',
        '  ~/.codex/rules/untangle.rules   prefix_rule(pattern=["untangle"], decision="allow")',
        'untangle: ask for a review in either chat: “review this in untangle”.',
        '',
      ]]);
      assert.deepEqual([skill.split('\n').slice(0, 2), fs.readFileSync(path.join(home, '.claude/skills/untangle/SKILL.md'), 'utf8') === skill, fs.readFileSync(path.join(home, '.agents/skills/untangle/SKILL.md'), 'utf8') === skill], [['---', 'name: untangle'], true, true]);
      assert.match(fs.readFileSync(path.join(home, '.codex/rules/untangle.rules'), 'utf8'), /\nprefix_rule\(pattern=\["untangle"\], decision="allow"\)\n$/);
    },
  );

  it(
    'when it is installed again, '
    + 'then it says the skill is up to date.',
    async () => {
      const r = await run(['-install']);
      assert.equal(r.out.split('\n')[0], 'untangle: the untangle skill is up to date, for both agents:');
    },
  );

  it(
    'when Claude’s skill is from another untangle, '
    + 'then -update rewrites it, for both agents, without telling again of Codex’s rule or how to ask for a review.',
    async () => {
      fs.writeFileSync(path.join(home, '.claude/skills/untangle/SKILL.md'), 'An older skill\n');
      const r = await run(['-update']);
      const skill = (await run([])).out;
      assert.deepEqual([r.code, r.out.split('\n'), fs.readFileSync(path.join(home, '.claude/skills/untangle/SKILL.md'), 'utf8') === skill], [0, [
        'untangle: updated the untangle skill, for both agents:',
        '  ~/.claude/skills/untangle/SKILL.md   Claude: /untangle, or ask for a review in untangle',
        '  ~/.agents/skills/untangle/SKILL.md   Codex: $untangle, or ask the same',
        '',
      ], true]);
    },
  );

  it(
    'when Codex’s rule is gone, '
    + 'then -update writes it again, and tells of it.',
    async () => {
      fs.rmSync(path.join(home, '.codex/rules/untangle.rules'));
      const r = await run(['-update']);
      assert.deepEqual(r.out.split('\n').slice(3), [
        'untangle: Codex’s sandbox can’t write untangle’s cache or serve its page, so untangle runs outside it:',
        '  ~/.codex/rules/untangle.rules   prefix_rule(pattern=["untangle"], decision="allow")',
        '',
      ]);
    },
  );

  it(
    'when only Claude has the skill, though Codex is here too, '
    + 'then -update rewrites Claude’s, and leaves Codex without it.',
    async () => {
      const at = fresh('.claude/skills/untangle', '.codex');
      homes.push(at);
      fs.writeFileSync(path.join(at, '.claude/skills/untangle/SKILL.md'), 'An older skill\n');
      const r = await run(['-update'], at);
      assert.deepEqual([r.code, r.out.split('\n'), fs.existsSync(path.join(at, '.agents')), fs.readdirSync(path.join(at, '.codex'))], [0, [
        'untangle: updated the untangle skill, for Claude:',
        '  ~/.claude/skills/untangle/SKILL.md   Claude: /untangle, or ask for a review in untangle',
        '',
      ], false, []]);
    },
  );

  it(
    'when no agent has the skill, '
    + 'then -update says it isn’t installed, and writes nothing.',
    async () => {
      const at = fresh('.claude', '.codex');
      homes.push(at);
      const r = await run(['-update'], at);
      assert.deepEqual([r.code, r.out, fs.readdirSync(path.join(at, '.claude')), fs.readdirSync(path.join(at, '.codex'))], [0, 'untangle: the untangle skill isn’t installed: untangle skill -install installs it.\n', [], []]);
    },
  );

  it(
    'when Claude’s skills folder links to the one Codex reads, '
    + 'then one file serves both.',
    async () => {
      const at = fresh('.agents/skills', '.codex');
      homes.push(at);
      fs.mkdirSync(path.join(at, '.claude'));
      fs.symlinkSync(path.join(at, '.agents/skills'), path.join(at, '.claude/skills'));
      const r = await run(['-install'], at);
      assert.deepEqual([r.out.split('\n')[0], fs.readdirSync(path.join(at, '.agents/skills'))], ['untangle: installed the untangle skill, one SKILL.md for both agents:', ['untangle']]);
    },
  );

  it(
    'when neither agent is here, '
    + 'then it says so, and that the skill prints.',
    async () => {
      const at = fresh();
      homes.push(at);
      const r = await run(['-install'], at);
      assert.deepEqual([r.code, r.err], [1, 'untangle: found neither Claude nor Codex here: untangle skill prints the skill, to put where your agent reads skills\n']);
    },
  );
});
