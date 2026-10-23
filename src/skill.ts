// The untangle skill: what Claude and Codex read to hold a review when you ask for one in their
// chat. `untangle skill` prints it, and `untangle skill -install` puts it where each agent on this
// machine reads skills, with the rule that lets untangle run outside Codex's sandbox. `-update`
// rewrites it only where it's installed: untangle upgrade has the new untangle run it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tilde } from './cache.js';
import { has } from './exec.js';

export const SKILL = `---
name: untangle
description: Hold a code review with the user in untangle, a review page for this branch or a pull request, where the user writes notes on the code and the agent answers in each note's thread, or writes notes of its own from a review of the change. Use when the user asks for a review in untangle, to review a change in untangle, to open or continue the untangle review, or when a message or a command's output says there are new notes on the untangle review.
allowed-tools: Bash(untangle:*)
---

# Hold an untangle review

The user writes notes on the code in untangle's page. Read them with \`untangle watch\` and answer
each in its thread with \`untangle reply\`. When asked for a review of the change, write notes with
\`untangle note\`, and the user answers in their threads.

## Start

Run \`untangle watch\` in the repository, or \`untangle watch <pr-url>\` for a pull request. It starts
the review if needed and opens its page.

- Claude: run it in the background (the Bash tool's \`run_in_background\`). It ends when there is
  something new, starting a new turn.
- Codex: it returns at once, and from then on untangle puts a line in this chat when there is
  something new.

For a pull request opened from its link, the watch names untangle's checkout of it, which is for
reading only, since untangle builds the review from it. When a note asks for a change there,
propose it in the reply instead. When asked for a review of the change, do it now, as described
below. Then tell the user the review is open and end the turn.

## Reviewing the change

Read the change against the review's base: \`git diff <base>...HEAD\` for a branch, or \`gh pr diff\`
for a pull request. For a big change, start from the files it touches and read the parts that
matter most. Write one note per point on the lines it's about, saying what to change and why.

- For lines, run \`untangle note lib/a.dart:42 'the note'\`; a range is \`lib/a.dart:40-42\`, and a
  path alone is the whole file. Lines are numbered as on the review's commit. For lines the change
  removed, add \`-removed\` and number them as on the base.
- For a point that isn't about any line (a summary, a question, or that nothing needs changing),
  write a note on the review itself: \`untangle note 'the note'\`.

## Each round

When \`untangle watch\` prints notes, or untangle says there are new ones (run \`untangle watch\` to
read them):

1. Read them all, starting with the line they open with, and follow it. Unless it says otherwise,
   change code only where a note explicitly asks for it, and discuss everything else first.
2. Answer each note in its thread: \`untangle reply N2 'the answer'\`. For an answer with quotes or
   backticks, pass it through stdin: \`untangle reply N2 - <<'EOF'\`, the answer, then \`EOF\`
   (\`untangle note\` takes \`-\` too). After making a change a note asked for, commit it and add
   \`-resolve\`.
3. When a note asks for a draft comment (the watch says so), reply with the comment alone, as it
   should read on GitHub: no preamble, no quotes around it. untangle posts it as a pending comment
   for the user to edit and send, so don't post it.
4. Claude: before ending the turn, start the next \`untangle watch\` in the background.

When the user explicitly asks to post something on GitHub, post it with \`gh\`. Otherwise, don't
post to GitHub.

## The end

- When the watch says the review closed, or another chat took it over, tell the user and stop
  watching.
- \`untangle notes\` prints the open notes again.
- When the user asks to close the review, run \`untangle stop\`, and not before.

## When untangle misbehaves

If an untangle command hangs or fails, run \`untangle feedback '<what happened>'\`. It drafts a bug
report for the user to check and send; tell them about it.
`;

export const RULE = `# untangle runs outside Codex's sandbox: it writes its cache, serves the review's page and puts
# a line in this chat when there are notes. Written by untangle skill -install.
prefix_rule(pattern=["untangle"], decision="allow")
`;

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const codexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/** Where each agent reads its skills (Codex: ~/.agents, as other agents do), and Codex's rule. */
export const skillFiles = () => ({
  claude: path.join(claudeDir(), 'skills', 'untangle', 'SKILL.md'),
  codex: path.join(os.homedir(), '.agents', 'skills', 'untangle', 'SKILL.md'),
  rule: path.join(codexDir(), 'rules', 'untangle.rules'),
});

/** The agent's installed skill, when it isn't this untangle's: where it is. */
export function outdatedSkill(kind: 'claude' | 'codex'): string | null {
  const file = skillFiles()[kind];
  try {
    return fs.readFileSync(file, 'utf8') === SKILL ? null : tilde(file);
  } catch {
    return null;
  }
}

const say = (line: string) => process.stdout.write(`untangle: ${line}\n`);

/** Writes a file unless it holds that already: whether it was new, changed or the same. */
function put(file: string, text: string): 'new' | 'changed' | 'same' {
  let was: string | null = null;
  try {
    was = fs.readFileSync(file, 'utf8');
  } catch {
    // Not there yet.
  }
  if (was === text) return 'same';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return was === null ? 'new' : 'changed';
}

export function skill(o: { install: boolean; update: boolean }): number {
  if (!o.install && !o.update) {
    process.stdout.write(SKILL);
    return 0;
  }
  const files = skillFiles();
  // Installing, for each agent on this machine; updating, for each agent that has the skill.
  const found = o.install
    ? { claude: has('claude') || !!process.env.CLAUDE_CONFIG_DIR || fs.existsSync(claudeDir()), codex: has('codex') || !!process.env.CODEX_HOME || fs.existsSync(codexDir()) }
    : { claude: fs.existsSync(files.claude), codex: fs.existsSync(files.codex) };
  if (!found.claude && !found.codex) {
    if (o.install) throw new Error('found neither Claude nor Codex here: untangle skill prints the skill, to put where your agent reads skills');
    say('the untangle skill isn’t installed: untangle skill -install installs it.');
    return 0;
  }
  // Where skills are shared between agents, one folder links to the other: one file serves both.
  const real = (file: string) => {
    try {
      return path.join(fs.realpathSync(path.dirname(path.dirname(file))), 'untangle', 'SKILL.md');
    } catch {
      return file;
    }
  };
  const shared = found.claude && found.codex && real(files.claude) === real(files.codex);
  const rows: Array<[string, string]> = [];
  const done: string[] = [];
  if (found.claude) {
    done.push(put(files.claude, SKILL));
    rows.push([files.claude, 'Claude: /untangle, or ask for a review in untangle']);
  }
  if (found.codex) {
    if (!shared) done.push(put(files.codex, SKILL));
    rows.push([files.codex, `Codex: $untangle, or ask ${found.claude ? 'the same' : 'for a review in untangle'}`]);
  }
  const width = Math.max(...rows.map(([f]) => tilde(f).length));
  const verb = done.includes('new') ? 'installed the untangle skill' : done.includes('changed') ? 'updated the untangle skill' : 'the untangle skill is up to date';
  say(`${verb}${shared ? ', one SKILL.md for both agents' : found.claude && found.codex ? ', for both agents' : found.claude ? ', for Claude' : ', for Codex'}:`);
  rows.forEach(([f, what]) => process.stdout.write(`  ${tilde(f).padEnd(width)}   ${what}\n`));
  // An update tells of the rule only when it changed, and leaves out how to ask for a review.
  const rule = found.codex ? put(files.rule, RULE) : null;
  if (rule && (o.install || rule !== 'same')) {
    say('Codex’s sandbox can’t write untangle’s cache or serve its page, so untangle runs outside it:');
    process.stdout.write(`  ${tilde(files.rule)}   ${RULE.trim().split('\n').pop()}\n`);
  }
  if (o.install) say(`ask for a review in ${found.claude && found.codex ? 'either chat' : 'its chat'}: “review this in untangle”.`);
  return 0;
}
