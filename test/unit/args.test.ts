import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duration, parseArgs, parseCommand, UsageError, type Options } from '../../dist/args.js';

function shown(options: Options): string {
  return [
    `target ${options.target}`,
    `autoclose ${options.autoclose}`,
    `base ${options.base ?? 'none'}`,
    `basePath ${options.basePath}`,
    `chains ${options.chains}`,
    `editor ${options.editor ?? 'none'}`,
    `export ${options.exportTo ?? 'none'}`,
    `host ${options.host}`,
    `port ${options.port}`,
    `portExplicit ${options.portExplicit}`,
    `noCache ${options.noCache}`,
    `color ${options.color}`,
    `open ${options.open}`,
    `quiet ${options.quiet}`,
    `verbose ${options.verbose}`,
    `version ${options.version}`,
    `help ${options.help}`,
  ].join('\n');
}

describe('Given no arguments, ', () => {
  it(
    'when the flags are read, '
    + 'then the defaults review the current directory on port 7778, chains following the commits, open it, and stop once it closes.',
    () => {
      assert.equal(shown(parseArgs([])), [
        'target .',
        'autoclose true',
        'base none',
        'basePath /',
        'chains history',
        'editor none',
        'export none',
        'host 127.0.0.1',
        'port 7778',
        'portExplicit false',
        'noCache false',
        'color true',
        'open true',
        'quiet false',
        'verbose false',
        'version false',
        'help false',
      ].join('\n'));
    },
  );
});

describe('Given flags for a quiet review written to a file, ', () => {
  const argv = [
    '-autoclose=false',
    '-base', 'main',
    '-base-path', 'rev',
    '-chains', 'structure',
    '-editor', 'code -g {file}:{line}:{col}',
    '-export', 'out.html',
    '-host', '127.0.0.1',
    '-port', '0',
    '-no-cache',
    '-no-color',
    '-no-open',
    '-quiet',
    'feature',
  ];

  it(
    'when the flags are read, '
    + 'then each flag replaces its default.',
    () => {
      assert.equal(shown(parseArgs(argv)), [
        'target feature',
        'autoclose false',
        'base main',
        'basePath /rev/',
        'chains structure',
        'editor code -g {file}:{line}:{col}',
        'export out.html',
        'host 127.0.0.1',
        'port 0',
        'portExplicit true',
        'noCache true',
        'color false',
        'open false',
        'quiet true',
        'verbose false',
        'version false',
        'help false',
      ].join('\n'));
    },
  );
});

describe('Given -- before a value that starts with a dash, ', () => {
  it(
    'when the flags are read, '
    + 'then the value is the directory.',
    () => {
      assert.equal(parseArgs(['--', '-nope']).target, '-nope');
    },
  );
});

describe('Given an unknown flag, ', () => {
  it(
    'when the flags are read, '
    + 'then the flag is refused.',
    () => {
      assert.throws(() => parseArgs(['-nope']), (error: unknown) => error instanceof UsageError && error.message === 'flag provided but not defined: -nope');
    },
  );
});

describe('Given -chains with a value that is neither history nor structure, ', () => {
  it(
    'when the flags are read, '
    + 'then the value is refused.',
    () => {
      assert.throws(() => parseArgs(['-chains', 'commits']), (error: unknown) => error instanceof UsageError && error.message === 'invalid value "commits" for flag -chains: history or structure');
    },
  );
});

describe('Given -v, ', () => {
  it(
    'when the flags are read, '
    + 'then the version is asked for.',
    () => {
      assert.equal(parseArgs(['-v']).version, true);
    },
  );
});

describe('Given -version, ', () => {
  it(
    'when the flags are read, '
    + 'then the version is asked for.',
    () => {
      assert.equal(parseArgs(['-version']).version, true);
    },
  );
});

describe('Given the agent’s commands, ', () => {
  it(
    'when watch is given its flags, the review’s and a pull request, '
    + 'then its own flags are read and the review’s are kept for the review it starts.',
    () => {
      const c = parseCommand(['watch', '-agent', 'Codex', '-timeout', '9m', '-base', 'main', '-no-open', 'https://github.com/acme/app/pull/7']);
      assert.deepEqual(c.cmd === 'watch' && [c.opts.target, c.given, c.agent, c.timeout, c.forward], ['https://github.com/acme/app/pull/7', true, 'Codex', 540_000, ['-base=main', '-no-open']]);
    },
  );

  it(
    'when watch is given nothing, '
    + 'then it watches the current directory, as long as it takes.',
    () => {
      const c = parseCommand(['watch']);
      assert.deepEqual(c.cmd === 'watch' && [c.opts.target, c.given, c.agent, c.timeout, c.forward], ['.', false, null, 0, []]);
    },
  );

  it(
    'when reply’s text starts with a dash, '
    + 'then the text is the rest of the line, after the note.',
    () => {
      assert.deepEqual(parseCommand(['reply', '-resolve', 'N2', '-1', 'is', 'the', 'sentinel']), { cmd: 'reply', review: null, agent: null, resolve: true, note: 2, text: '-1 is the sentinel' });
    },
  );

  it(
    'when reply names no note, '
    + 'then it is refused.',
    () => {
      assert.throws(() => parseCommand(['reply', 'soon']), (error: unknown) => error instanceof UsageError && error.message === 'soon is not a note: say which, as N2 or 2');
    },
  );

  it(
    'when reply has no text and doesn’t resolve, '
    + 'then it is refused.',
    () => {
      assert.throws(() => parseCommand(['reply', '2']), (error: unknown) => error instanceof UsageError && error.message === 'what to answer? untangle reply <N> <text>, or -resolve alone');
    },
  );

  it(
    'when notes and stop are given a review, '
    + 'then they are about it.',
    () => {
      assert.deepEqual([parseCommand(['notes', '-all', '-review', '../app']), parseCommand(['stop'])], [{ cmd: 'notes', review: '../app', agent: null, all: true }, { cmd: 'stop', review: null }]);
    },
  );

  it(
    'when note is given lines, a range of removed lines, or a file alone, '
    + 'then it writes on them, the rest of the line its text.',
    () => {
      assert.deepEqual([parseCommand(['note', 'lib/a.dart:42', 'Why', 'here?']), parseCommand(['note', '-removed', '-agent', 'Codex', 'lib/a.dart:40-42', '-1', 'is', 'gone']), parseCommand(['note', 'lib/a.dart', 'A doc comment?'])], [
        { cmd: 'note', review: null, agent: null, removed: false, path: 'lib/a.dart', line: 42, startLine: null, text: 'Why here?' },
        { cmd: 'note', review: null, agent: 'Codex', removed: true, path: 'lib/a.dart', line: 42, startLine: 40, text: '-1 is gone' },
        { cmd: 'note', review: null, agent: null, removed: false, path: 'lib/a.dart', line: null, startLine: null, text: 'A doc comment?' },
      ]);
    },
  );

  it(
    'when note has no text, '
    + 'then it asks what to write.',
    () => {
      assert.throws(() => parseCommand(['note', 'lib/a.dart:3']), (error: unknown) => error instanceof UsageError && error.message === 'what to write? untangle note <path>[:<line>[-<line>]] <text>');
    },
  );

  it(
    'when skill is given -install, or nothing, '
    + 'then it installs the skill, or prints it.',
    () => {
      assert.deepEqual([parseCommand(['skill', '-install']), parseCommand(['skill'])], [{ cmd: 'skill', install: true, update: false }, { cmd: 'skill', install: false, update: false }]);
    },
  );

  it(
    'when skill is given -update, '
    + 'then it rewrites the skill where it’s installed.',
    () => {
      assert.deepEqual(parseCommand(['skill', '-update']), { cmd: 'skill', install: false, update: true });
    },
  );

  it(
    'when upgrade is given, alone, with -h, or with an argument, '
    + 'then it upgrades untangle, shows its usage, or is refused.',
    () => {
      const help = parseCommand(['upgrade', '-h']);
      assert.deepEqual([parseCommand(['upgrade']), help.cmd === 'help' && help.text.split('\n')], [{ cmd: 'upgrade' }, [
        'untangle upgrade - bring the latest untangle, from GitHub',
        '',
        'usage:',
        '  untangle upgrade',
        '',
        'Pulls the latest untangle into its clone in the cache (the first upgrade clones it), installs its',
        'packages when they changed, builds it, and links it with npm, so the untangle command runs it.',
        'Then the new untangle rewrites its skill where it’s installed, as untangle skill -update does.',
        '',
      ]]);
      assert.throws(() => parseCommand(['upgrade', 'now']), (error: unknown) => error instanceof UsageError && error.message === 'untangle upgrade takes no arguments (got now)');
    },
  );

  it(
    'when reviews is given, alone, with its flags, with -h, or with an argument, '
    + 'then it opens the manager, prints the list, serves the page, shows its usage, or is refused.',
    () => {
      const help = parseCommand(['reviews', '-h']);
      assert.deepEqual([parseCommand(['reviews']), parseCommand(['reviews', '-list']), parseCommand(['reviews', '-serve', '-port', '0', '-no-open']), help.cmd === 'help' && help.text.split('\n')], [
        { cmd: 'reviews', list: false, open: true, port: null, serve: false },
        { cmd: 'reviews', list: true, open: true, port: null, serve: false },
        { cmd: 'reviews', list: false, open: false, port: 0, serve: true },
        [
          'untangle reviews - the reviews on this machine',
          '',
          'usage:',
          '  untangle reviews [flags]',
          '',
          'Opens a page with every review untangle remembers: the ones running, the ones paused (stopped, with',
          'their notes, marks and chats kept, to pick up again), and the closed ones, with their progress,',
          'where each one’s agent is, and what each holds in memory or on disk. A small process serves it,',
          'started the first time and stopped once the page has been closed a while. With -list, the same',
          'reviews print in the terminal. A directory named reviews is ./reviews.',
          '',
          'flags:',
          '  -list',
          '    \tprint the reviews in the terminal, instead of opening the page',
          '  -no-open',
          '    \tdo not open the page: print its link',
          '  -port int',
          '    \tthe port the manager listens on, when it starts (0 picks a free one) (default 7777)',
          '  -serve',
          '    \tserve the page from this process, in the foreground, until it stops',
          '',
        ],
      ]);
      assert.throws(() => parseCommand(['reviews', 'all']), (error: unknown) => error instanceof UsageError && error.message === 'untangle reviews takes no arguments (got all)');
    },
  );

  it(
    'when skill is given an argument, '
    + 'then it is refused.',
    () => {
      assert.throws(() => parseCommand(['skill', 'claude']), (error: unknown) => error instanceof UsageError && error.message === 'untangle skill takes no arguments (got claude)');
    },
  );

  it(
    'when a directory is named like a command, '
    + 'then ./ reaches it as a review.',
    () => {
      const c = parseCommand(['./watch']);
      assert.deepEqual(c.cmd === 'review' && c.opts.target, './watch');
    },
  );

  it(
    'when watch is given a timeout that isn’t a duration, '
    + 'then it is refused.',
    () => {
      assert.throws(() => parseCommand(['watch', '-timeout', 'ten']), (error: unknown) => error instanceof UsageError && error.message === 'invalid value "ten" for flag -timeout: parse error');
    },
  );
});

describe('Given durations as Go writes them, ', () => {
  it('when they are read, then each is its milliseconds.', () => {
    assert.deepEqual(['0', '300ms', '90s', '1h30m', '1.5m'].map(duration), [0, 300, 90_000, 5_400_000, 90_000]);
  });
});
