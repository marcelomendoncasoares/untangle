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
description: Hold a code review with the user in untangle, a review page for this branch or a pull request, where they write notes on the code and you answer in each note's thread, or write notes of your own from your review of the change. Use when the user asks for a review in untangle, to review a change in untangle, to open or continue the untangle review, or when a message or a command's output says there are new notes on the untangle review.
allowed-tools: Bash(untangle:*)
---

# Hold an untangle review

The user writes notes on the code in untangle's page. You read them with \`untangle watch\` and
answer in their threads with \`untangle reply\`. When the user asks you to review the change, you
write notes too, with \`untangle note\`, and the user answers in their threads.

## Start

Run \`untangle watch\` in the repository, or \`untangle watch <pr-url>\` for a pull request. It
starts the review if it isn't running and opens its page. For a pull request, untangle clones its
repository, and the watch says where the head is checked out: read and search the code there
(\`rg\`, \`git log\`) rather than through \`gh api\`, and change nothing in it.

- Claude: run it in the background (the Bash tool's \`run_in_background\`). It ends when there are
  notes or replies you haven't read and prints them, and its end wakes you.
- Codex: it returns at once. untangle then puts a line in this chat each time there's something
  new: "untangle: 2 new notes on the review of ...". untangle runs outside the sandbox: it writes
  its cache and serves the page.

When the user asked you to review the change, review it now (Your own review, below). Then tell
the user the review is open, and end your turn.

## Your own review

Read the change (its diff against the review's base: \`git diff <base>...HEAD\` for a branch,
\`gh pr diff\` for a pull request), and write each comment as a note on its lines:
\`untangle note lib/a.dart:42 'your comment'\`. A range is \`lib/a.dart:40-42\`, a path alone
is a note on the whole file, and \`-removed\` puts it on lines the change removed, numbered as on
the base. Lines are numbered as on the review's commit: \`untangle note\` prints the lines it put
the note on. Write one note per point, where it applies, and say what you'd change and why. A
point that isn't about a line (a summary, a question, or that you found nothing to change) goes in
a note on the review itself: \`untangle note 'your note'\`, its text alone. The user answers in
each note's thread, and \`untangle watch\` brings the answers.

## Each round

When \`untangle watch\` prints notes, or a line from untangle says there are new ones (run
\`untangle watch\` to read them):

1. Read them all. The review's opening line comes first: follow it. By default it says to make
   the changes the notes ask for, and to answer a note that asks a question, or isn't clear,
   before changing anything.
2. Answer each note in its thread: \`untangle reply N2 'your answer'\`. An answer with quotes or
   backticks reads from stdin instead: \`untangle reply N2 - <<'EOF'\`, the answer, then \`EOF\`
   (\`untangle note\` takes \`-\` too). Once you've made the change a note asks for, add
   \`-resolve\`. Commit as you go: the page shows your commits, and the notes follow their lines.
3. A note that asks for a draft comment (the watch says so) wants the comment for GitHub. Answer
   it with \`untangle reply\` and the comment alone, as you'd post it, in a natural tone: no
   preamble, no quotes around it. untangle posts your answer to GitHub as it is, pending in the
   user's review, for them to edit and send. Asked again while your draft is pending, the watch
   shows that draft as it is now: write the comment again from both. Never post to GitHub yourself.
4. Claude: start the next \`untangle watch\` in the background before you end your turn.

## The end

- When \`untangle watch\` says the review closed, or that another chat took it over, tell the user
  and stop watching.
- \`untangle notes\` prints the open notes again.
- Run \`untangle stop\` only when the user asks to close the review.

## When untangle misbehaves

If an untangle command hangs or fails, run \`untangle feedback '<what you saw>'\`. It drafts
a bug report with what untangle was running, for the user to check and send. Tell the user, and
never file the issue yourself.
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
