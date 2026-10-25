// Command-line flags, written and printed the way Go's flag package does (as px0's are):
// -name value, -name=value, --name, and booleans as -name or -name=false.

interface Flag {
  name: string;
  type: 'string' | 'int' | 'bool' | 'duration';
  usage: string;
  default?: string | number | boolean;
}

const FLAGS: Flag[] = [
  { name: 'autoclose', type: 'bool', usage: 'stop once the review’s last open page closes (a reload keeps it)', default: true },
  { name: 'base', type: 'string', usage: 'compare with this branch or commit instead of the pull request’s base' },
  { name: 'base-path', type: 'string', usage: 'base URL path prefix to serve endpoints and assets from (e.g. /rev-123/)' },
  { name: 'chains', type: 'string', usage: 'what chains follow: "history", the commits that started each change, or "structure", the code alone', default: 'history' },
  { name: 'editor', type: 'string', usage: 'open locations with this command, or this URL, where {file}, {line} and {col} are replaced (e.g. "code -g {file}:{line}:{col}"); VS Code\'s vscode:// link when omitted' },
  { name: 'export', type: 'string', usage: 'write the review to this HTML file, to share it read-only, and exit' },
  { name: 'host', type: 'string', usage: 'address to bind', default: '127.0.0.1' },
  { name: 'no-cache', type: 'bool', usage: 'build the review again, even when an analysis of the same commits is cached' },
  { name: 'no-color', type: 'bool', usage: 'disable colour output' },
  { name: 'no-open', type: 'bool', usage: 'do not launch a browser' },
  { name: 'port', type: 'int', usage: 'port to listen on (0 picks a free one)', default: 7778 },
  { name: 'quiet', type: 'bool', usage: 'suppress narration; print only the review’s URL' },
  { name: 'v', type: 'bool', usage: 'print version and exit (shorthand)' },
  { name: 'verbose', type: 'bool', usage: 'log the language server, pub get and requests to the terminal' },
  { name: 'version', type: 'bool', usage: 'print version and exit' },
];

export interface Options {
  target: string;
  autoclose: boolean;
  base: string | null;
  basePath: string;
  chains: 'history' | 'structure';
  editor: string | null;
  exportTo: string | null;
  host: string;
  port: number;
  portExplicit: boolean;
  noCache: boolean;
  color: boolean;
  open: boolean;
  quiet: boolean;
  verbose: boolean;
  version: boolean;
  help: boolean;
}

export class UsageError extends Error {}

export function usage(version: string): string {
  return [
    `untangle ${version} - review a pull request chain by chain`,
    '',
    'usage:',
    '  untangle [flags] [directory]',
    '  untangle [flags] <pr-url>',
    '  untangle watch | reply | note | notes | stop | feedback | skill | upgrade | reviews ...',
    '',
    'A directory reviews its branch’s pull request, or else what the branch adds to the default branch.',
    'A pull request URL is cloned into the cache first. The review opens in your browser.',
    '',
    'A coding agent holds a review with these commands (-h after one lists its flags):',
    '  watch [directory | pr-url]  start the review if it isn’t running, wait for the notes and replies',
    '                              the agent hasn’t read, print them and exit',
    '  reply <N> <text>            answer in note N’s thread',
    '  note [path:line] <text>     write a note of its own: on lines, or on the review with its text alone',
    '  notes                       print the open notes, as Copy for agent gives them',
    '  stop                        close the review',
    '  feedback [text | -] [-idea] [pr-url]  draft a report for the user to check and send',
    '  feedback -list              list your feedback pictures and how to delete one',
    '',
    'untangle skill -install teaches Claude and Codex those commands, so asking for a review in their',
    'chat is enough: “review this in untangle”.',
    '',
    'untangle upgrade pulls the latest untangle into a clone in the cache, builds it and links it on',
    'PATH, then updates the skill where it’s installed.',
    '',
    'untangle reviews opens a page with the reviews on this machine: running, paused and closed, with',
    'their progress, their agents, and what each holds in memory or on disk.',
    '',
    'flags:',
    ...flagLines(FLAGS),
  ].join('\n') + '\n';
}

/** Flags as Go's flag package prints them. */
function flagLines(flags: Flag[]): string[] {
  const lines: string[] = [];
  for (const f of flags) {
    const def = f.default !== undefined ? ` (default ${typeof f.default === 'string' && f.type !== 'duration' ? JSON.stringify(f.default) : f.default})` : '';
    if (f.name.length === 1 && f.type === 'bool') lines.push(`  -${f.name}\t${f.usage}${def}`);
    else lines.push(`  -${f.name}${f.type === 'bool' ? '' : ' ' + f.type}`, `    \t${f.usage}${def}`);
  }
  return lines;
}

/**
 * Reads flags the way Go's flag package does. Flags may come anywhere unless `stop` is set, when the
 * first argument that isn't one ends them (so a note's text may start with a dash).
 */
function readFlags(argv: string[], flags: Flag[], stop: boolean): { values: Map<string, string | boolean>; rest: string[]; raw: string[] } {
  const values = new Map<string, string | boolean>();
  const rest: string[] = [];
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') {
      if (stop) { rest.push(...argv.slice(i)); break; }
      rest.push(arg);
      continue;
    }
    const body = arg.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const name = eq < 0 ? body : body.slice(0, eq);
    if (name === 'h' || name === 'help') { values.set('help', true); continue; }
    const flag = flags.find((f) => f.name === name);
    if (!flag) throw new UsageError(`flag provided but not defined: -${name}`);
    if (flag.type === 'bool') {
      const v = eq < 0 ? 'true' : body.slice(eq + 1);
      if (!/^(true|false|1|0)$/.test(v)) throw new UsageError(`invalid boolean value "${v}" for -${name}`);
      values.set(name, v === 'true' || v === '1');
      raw.push(arg);
    } else {
      const v = eq >= 0 ? body.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new UsageError(`flag needs an argument: -${name}`);
      if (flag.type === 'int' && !/^\d+$/.test(v)) throw new UsageError(`invalid value "${v}" for flag -${name}: parse error`);
      if (flag.type === 'duration' && duration(v) === null) throw new UsageError(`invalid value "${v}" for flag -${name}: parse error`);
      values.set(name, v);
      raw.push(eq >= 0 ? arg : `-${name}=${v}`);
    }
  }
  return { values, rest, raw };
}

/**
 * A command's own flags among the words after its first one, as an agent may write them
 * (untangle reply N2 -resolve -): taken out when they're whole flags, the other words left in
 * order. A word that only starts with a dash, as text may, stays a word.
 */
function laterFlags(words: string[], flags: Flag[], values: Map<string, string | boolean>): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^--?([a-z]+)(?:=(.*))?$/.exec(words[i]);
    const flag = m && flags.find((f) => f.name === m[1]);
    const v = !m || !flag ? undefined : m[2] ?? (flag.type === 'bool' ? 'true' : words[i + 1]);
    if (!flag || v === undefined || (flag.type === 'bool' && !/^(true|false|1|0)$/.test(v))) { out.push(words[i]); continue; }
    values.set(flag.name, flag.type === 'bool' ? v === 'true' || v === '1' : v);
    if (flag.type !== 'bool' && m![2] === undefined) i++;
  }
  return out;
}

/** A duration as Go writes one (300ms, 90s, 10m, 1h30m), in milliseconds. */
export function duration(text: string): number | null {
  if (text === '0') return 0;
  if (!/^(\d+(\.\d+)?(ms|s|m|h))+$/.test(text)) return null;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) total += Number(m[1]) * unit[m[2]];
  return Math.round(total);
}

export function parseArgs(argv: string[]): Options {
  const { values, rest } = readFlags(argv, FLAGS, false);
  if (rest.length > 1) throw new UsageError(`one directory or pull request URL at a time (got ${rest.length})`);
  return options(values, rest[0] || '.');
}

function options(values: Map<string, string | boolean>, target: string): Options {
  const str = (k: string) => (values.has(k) ? String(values.get(k)) : null);
  const bool = (k: string) => values.get(k) === true;
  let basePath = str('base-path') || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';
  const port = values.has('port') ? Number(values.get('port')) : 7778;
  if (port > 65535) throw new UsageError(`invalid value "${port}" for flag -port: out of range`);
  const chains = str('chains') || 'history';
  if (chains !== 'history' && chains !== 'structure') throw new UsageError(`invalid value "${chains}" for flag -chains: history or structure`);
  return {
    target,
    autoclose: values.has('autoclose') ? bool('autoclose') : true,
    base: str('base'),
    basePath,
    chains,
    editor: str('editor'),
    exportTo: str('export'),
    host: str('host') || '127.0.0.1',
    port,
    portExplicit: values.has('port'),
    noCache: bool('no-cache'),
    color: !bool('no-color'),
    open: !bool('no-open'),
    quiet: bool('quiet'),
    verbose: bool('verbose'),
    version: bool('v') || bool('version'),
    help: bool('help'),
  };
}

// ---- The commands a coding agent runs to hold a review.

const AGENT: Flag = { name: 'agent', type: 'string', usage: 'the agent’s name, shown with its answers (default: from the environment, else "Agent")' };
const REVIEW: Flag = { name: 'review', type: 'string', usage: 'the review’s directory or pull request URL', default: '.' };
const WATCH_FLAGS: Flag[] = [AGENT, { name: 'timeout', type: 'duration', usage: 'stop waiting after this long (e.g. 9m), for an agent whose commands have a time limit; 0 waits until something comes', default: '0s' }];
const REPLY_FLAGS: Flag[] = [AGENT, { name: 'resolve', type: 'bool', usage: 'resolve the note too, once it’s done' }, REVIEW];
const NOTE_FLAGS: Flag[] = [AGENT, { name: 'removed', type: 'bool', usage: 'the lines are ones the change removed, numbered as on the base' }, REVIEW];
const NOTES_FLAGS: Flag[] = [AGENT, { name: 'all', type: 'bool', usage: 'the resolved notes too' }, REVIEW];
const STOP_FLAGS: Flag[] = [REVIEW];
const FEEDBACK_FLAGS: Flag[] = [
  { name: 'idea', type: 'bool', usage: 'draft an idea instead of a bug report' },
  { name: 'list', type: 'bool', usage: 'list your feedback gists and how to delete one, without changing anything' },
];
const REVIEWS_FLAGS: Flag[] = [
  { name: 'list', type: 'bool', usage: 'print the reviews in the terminal, instead of opening the page' },
  { name: 'no-open', type: 'bool', usage: 'do not open the page: print its link' },
  { name: 'port', type: 'int', usage: 'the port the manager listens on, when it starts (0 picks a free one)', default: 7777 },
  { name: 'serve', type: 'bool', usage: 'serve the page from this process, in the foreground, until it stops' },
];
const SKILL_FLAGS: Flag[] = [
  { name: 'install', type: 'bool', usage: 'put it where Claude and Codex read skills, and let untangle run outside Codex’s sandbox' },
  { name: 'update', type: 'bool', usage: 'rewrite it where it’s installed, and only there' },
];

export type Command =
  | { cmd: 'review'; opts: Options }
  | { cmd: 'help'; text: string }
  /** `forward`: the review's flags as given, for a review watch starts. `given`: a target was named. */
  | { cmd: 'watch'; opts: Options; forward: string[]; agent: string | null; timeout: number; given: boolean }
  | { cmd: 'reply'; review: string | null; agent: string | null; resolve: boolean; note: number; text: string | null }
  /** A note of the agent's own: on lines of a file (from startLine to line), on the whole file (line null), or on the review itself (path null). */
  | { cmd: 'note'; review: string | null; agent: string | null; removed: boolean; path: string | null; line: number | null; startLine: number | null; text: string }
  | { cmd: 'notes'; review: string | null; agent: string | null; all: boolean }
  | { cmd: 'stop'; review: string | null }
  | { cmd: 'skill'; install: boolean; update: boolean }
  | { cmd: 'upgrade' }
  | { cmd: 'feedback'; kind: 'bug' | 'idea'; text: string; target: string | null; list: boolean }
  /** port: null unless it was given. */
  | { cmd: 'reviews'; list: boolean; open: boolean; port: number | null; serve: boolean };

const commandUsage = (name: string, what: string, line: string, about: string[], flags: Flag[], more: string[] = []) => [
  `untangle ${name} - ${what}`, '', 'usage:', `  untangle ${name}${line ? ` ${line}` : ''}`, '', ...about, ...(flags.length ? ['', 'flags:', ...flagLines(flags)] : []), ...more,
].join('\n') + '\n';

export const watchUsage = () => commandUsage('watch', 'hold a review as a coding agent', '[flags] [directory | pr-url]', [
  'Starts the review if it isn’t running, and opens its page (in Orca’s browser, inside Orca). Then it',
  'waits for the notes and replies this agent hasn’t read, prints them and exits: run it again after',
  'each answer, in the background if the agent can. A directory named watch is ./watch.',
], WATCH_FLAGS, ['', 'The review’s own flags (untangle -h) go to a review watch starts.']);
export const replyUsage = () => commandUsage('reply', 'answer in a note’s thread', '[flags] <N> <text>', [
  'N is the note’s number (N2, or 2). The text is the rest of the line; - reads it from stdin.',
  'Flags may come after N too, each as a word of its own: untangle reply N2 -resolve -.',
], REPLY_FLAGS);
export const noteUsage = () => commandUsage('note', 'write a note of your own, on the review’s lines or on the review', '[flags] [<path>[:<line>[-<line>]]] <text>', [
  'Writes a note on the lines, from the agent’s own review of the change: the person reviewing answers',
  'in its thread, and untangle watch brings the answers. The path is the file’s in the repository, and',
  'its lines are numbered as on the review’s commit (with -removed, as on its base). A path alone is',
  'a note on the whole file. The text is the rest of the line; - reads it from stdin.',
  'Its text alone, quoted, is a note on the review itself, for what has no line: a summary, a',
  'question, or that a review found nothing to change.',
], NOTE_FLAGS);
export const notesUsage = () => commandUsage('notes', 'print a review’s notes, as Copy for agent gives them', '[flags]', ['Prints the open notes, with their code and threads.'], NOTES_FLAGS);
export const stopUsage = () => commandUsage('stop', 'close a review', '[flags]', ['Stops the review: its page closes and a waiting untangle watch says so.'], STOP_FLAGS);
export const feedbackUsage = () => commandUsage('feedback', 'draft a report for the user to check and send', "['what happened' | -] [-idea] [pr-url]", [
  'Puts a draft on the running review’s page, with the system and what the review is running.',
  'With no answer, prints GitHub’s form, filled in. It never files an issue; the user sends it.',
  'The text is one argument: its first line is the report’s title, and the lines after it say what',
  'happened; - reads it from stdin. Without pr-url, finds this directory’s review.',
  'With -list, lists your feedback gists and how to delete one; it changes nothing.',
], FEEDBACK_FLAGS);
export const skillUsage = () => commandUsage('skill', 'teach Claude and Codex to hold a review', '[flags]', [
  'Prints the untangle skill: how an agent holds a review with watch, reply, notes and stop. With',
  '-install, it goes where each agent on this machine reads skills (~/.claude/skills for Claude,',
  '~/.agents/skills for Codex), with a rule in ~/.codex/rules that lets untangle run outside Codex’s',
  'sandbox. Then asking for a review in their chat is enough: “review this in untangle”. With',
  '-update, it’s rewritten only where it’s installed, as untangle upgrade does.',
], SKILL_FLAGS);
export const upgradeUsage = () => commandUsage('upgrade', 'bring the latest untangle, from GitHub', '', [
  'Pulls the latest untangle into its clone in the cache (the first upgrade clones it), installs its',
  'packages when they changed, builds it, and links it with npm, so the untangle command runs it.',
  'Then the new untangle rewrites its skill where it’s installed, as untangle skill -update does.',
], []);

export const reviewsUsage = () => commandUsage('reviews', 'the reviews on this machine', '[flags]', [
  'Opens a page with every review untangle remembers: the ones running, the ones paused (stopped, with',
  'their notes, marks and chats kept, to pick up again), and the closed ones, with their progress,',
  'where each one’s agent is, and what each holds in memory or on disk. A small process serves it,',
  'started the first time and stopped once the page has been closed a while. With -list, the same',
  'reviews print in the terminal. A directory named reviews is ./reviews.',
], REVIEWS_FLAGS);

/**
 * A review's arguments again, for the untangle that takes it over on a restart: at the same port,
 * opening no page (the open one reloads into it). What follows -- is the target's, and stays.
 */
export function restartArgs(argv: string[], port: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.push(...argv.slice(i));
      break;
    }
    const m = /^--?(port|no-open)(=.*)?$/.exec(a);
    if (!m) out.push(a);
    else if (m[1] === 'port' && !m[2]) i++;
  }
  return [`-port=${port}`, '-no-open', ...out];
}

/** The command line: a review, or one of the agent's commands (its first word). */
export function parseCommand(argv: string[]): Command {
  const [first, ...more] = argv;
  if (first === 'help') return { cmd: 'review', opts: parseArgs(['-h']) };
  if (first === 'feedback') {
    const { values, rest } = readFlags(more, FEEDBACK_FLAGS, false);
    if (values.get('help')) return { cmd: 'help', text: feedbackUsage() };
    const last = rest.at(-1);
    const target = last && /^(?:https?:\/\/)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:[/?#].*)?$/.test(last) ? rest.pop()! : null;
    if (rest.length > 1) throw new UsageError('the report text is one argument: quote it, or use - for stdin');
    if (values.get('list') && (rest.length || target || values.get('idea'))) throw new UsageError('-list takes no report text, pull request or -idea');
    return { cmd: 'feedback', kind: values.get('idea') ? 'idea' : 'bug', text: rest[0] ?? '', target, list: values.get('list') === true };
  }
  if (first === 'watch') {
    const both = [...WATCH_FLAGS, ...FLAGS.filter((f) => !['export', 'v', 'version'].includes(f.name))];
    const { values, rest, raw } = readFlags(more, both, false);
    if (values.get('help')) return { cmd: 'help', text: watchUsage() };
    if (rest.length > 1) throw new UsageError(`one directory or pull request URL at a time (got ${rest.length})`);
    const own = new Set(WATCH_FLAGS.map((f) => '-' + f.name));
    return {
      cmd: 'watch', opts: options(values, rest[0] || '.'),
      forward: raw.filter((r) => !own.has(r.replace(/^-+/, '-').replace(/=.*$/, ''))),
      agent: values.has('agent') ? String(values.get('agent')) : null,
      timeout: duration(String(values.get('timeout') ?? '0')) ?? 0,
      given: rest.length > 0,
    };
  }
  if (first === 'reply') {
    const { values, rest } = readFlags(more, REPLY_FLAGS, true);
    if (values.get('help')) return { cmd: 'help', text: replyUsage() };
    const m = /^[Nn]?(\d+)$/.exec(rest[0] || '');
    if (!m) throw new UsageError(rest.length ? `${rest[0]} is not a note: say which, as N2 or 2` : 'which note? untangle reply <N> <text>');
    const text = laterFlags(rest.slice(1), REPLY_FLAGS, values).join(' ');
    if (!text && !values.get('resolve')) throw new UsageError('what to answer? untangle reply <N> <text>, or -resolve alone');
    return { cmd: 'reply', review: values.has('review') ? String(values.get('review')) : null, agent: values.has('agent') ? String(values.get('agent')) : null, resolve: values.get('resolve') === true, note: Number(m[1]), text: text || null };
  }
  if (first === 'note') {
    const { values, rest: given } = readFlags(more, NOTE_FLAGS, true);
    if (values.get('help')) return { cmd: 'help', text: noteUsage() };
    const rest = given.length ? [given[0], ...laterFlags(given.slice(1), NOTE_FLAGS, values)] : given;
    const who = { review: values.has('review') ? String(values.get('review')) : null, agent: values.has('agent') ? String(values.get('agent')) : null };
    // Its text alone (words, or - for stdin) is a note on the review itself; a lone path still asks for its text.
    if (rest.length === 1 && (rest[0] === '-' || /\s/.test(rest[0].trim()))) return { cmd: 'note', ...who, removed: false, path: null, line: null, startLine: null, text: rest[0] };
    const at = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(rest[0] || '');
    if (!at) throw new UsageError('on which lines? untangle note <path>[:<line>[-<line>]] <text>, or untangle note \'<text>\' on the review');
    const text = rest.slice(1).join(' ');
    if (!text) throw new UsageError('what to write? untangle note <path>[:<line>[-<line>]] <text>, or untangle note \'<text>\' on the review');
    const [from, to] = [at[2] ? Number(at[2]) : null, at[3] ? Number(at[3]) : null];
    return {
      cmd: 'note', review: values.has('review') ? String(values.get('review')) : null, agent: values.has('agent') ? String(values.get('agent')) : null,
      removed: values.get('removed') === true, path: at[1], line: to ?? from, startLine: to != null ? from : null, text,
    };
  }
  if (first === 'notes' || first === 'stop') {
    const { values, rest } = readFlags(more, first === 'notes' ? NOTES_FLAGS : STOP_FLAGS, true);
    if (values.get('help')) return { cmd: 'help', text: first === 'notes' ? notesUsage() : stopUsage() };
    if (rest.length) throw new UsageError(`untangle ${first} takes no arguments (got ${rest.join(' ')}): the review is -review`);
    const review = values.has('review') ? String(values.get('review')) : null;
    return first === 'notes' ? { cmd: 'notes', review, agent: values.has('agent') ? String(values.get('agent')) : null, all: values.get('all') === true } : { cmd: 'stop', review };
  }
  if (first === 'skill') {
    const { values, rest } = readFlags(more, SKILL_FLAGS, true);
    if (values.get('help')) return { cmd: 'help', text: skillUsage() };
    if (rest.length) throw new UsageError(`untangle skill takes no arguments (got ${rest.join(' ')})`);
    return { cmd: 'skill', install: values.get('install') === true, update: values.get('update') === true };
  }
  if (first === 'upgrade') {
    const { values, rest } = readFlags(more, [], true);
    if (values.get('help')) return { cmd: 'help', text: upgradeUsage() };
    if (rest.length) throw new UsageError(`untangle upgrade takes no arguments (got ${rest.join(' ')})`);
    return { cmd: 'upgrade' };
  }
  if (first === 'reviews') {
    const { values, rest } = readFlags(more, REVIEWS_FLAGS, true);
    if (values.get('help')) return { cmd: 'help', text: reviewsUsage() };
    if (rest.length) throw new UsageError(`untangle reviews takes no arguments (got ${rest.join(' ')})`);
    const port = values.has('port') ? Number(values.get('port')) : null;
    if (port != null && port > 65535) throw new UsageError(`invalid value "${port}" for flag -port: out of range`);
    return { cmd: 'reviews', list: values.get('list') === true, open: values.get('no-open') !== true, port, serve: values.get('serve') === true };
  }
  return { cmd: 'review', opts: parseArgs(argv) };
}
