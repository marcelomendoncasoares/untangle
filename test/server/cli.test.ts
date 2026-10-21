import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../dist/version.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

function run(flag: string): string {
  return execFileSync(process.execPath, [cli, flag], { encoding: 'utf8' });
}

// The help, word for word: the flags with their types, defaults and descriptions.
const usageText = [
  `untangle ${VERSION} - review a pull request chain by chain`,
  '',
  'usage:',
  '  untangle [flags] [directory]',
  '  untangle [flags] <pr-url>',
  '  untangle watch | reply | note | notes | stop | skill | upgrade | reviews ...',
  '',
  'A directory reviews its branch’s pull request, or else what the branch adds to the default branch.',
  'A pull request URL is cloned into the cache first. The review opens in your browser.',
  '',
  'A coding agent holds a review with these commands (-h after one lists its flags):',
  '  watch [directory | pr-url]  start the review if it isn’t running, wait for the notes and replies',
  '                              the agent hasn’t read, print them and exit',
  '  reply <N> <text>            answer in note N’s thread',
  '  note <path:line> <text>     write a note of its own, from its review of the change',
  '  notes                       print the open notes, as Copy for agent gives them',
  '  stop                        close the review',
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
  '  -autoclose',
  '    \tstop once the review’s last open page closes (a reload keeps it) (default true)',
  '  -base string',
  '    \tcompare with this branch or commit instead of the pull request’s base',
  '  -base-path string',
  '    \tbase URL path prefix to serve endpoints and assets from (e.g. /rev-123/)',
  '  -chains string',
  '    \twhat chains follow: "history", the commits that started each change, or "structure", the code alone (default "history")',
  '  -editor string',
  '    \topen locations with this command, or this URL, where {file}, {line} and {col} are replaced (e.g. "code -g {file}:{line}:{col}"); VS Code\'s vscode:// link when omitted',
  '  -export string',
  '    \twrite the review to this HTML file, to share it read-only, and exit',
  '  -host string',
  '    \taddress to bind (default "127.0.0.1")',
  '  -no-cache',
  '    \tbuild the review again, even when an analysis of the same commits is cached',
  '  -no-color',
  '    \tdisable colour output',
  '  -no-open',
  '    \tdo not launch a browser',
  '  -port int',
  '    \tport to listen on (0 picks a free one) (default 7778)',
  '  -quiet',
  '    \tsuppress narration; print only the review’s URL',
  '  -v\tprint version and exit (shorthand)',
  '  -verbose',
  '    \tlog the language server, pub get and requests to the terminal',
  '  -version',
  '    \tprint version and exit',
  '',
].join('\n');

describe('Given the untangle command, ', () => {
  it('when -h is asked, then the usage lists the flags.', () => {
    assert.equal(run('-h'), usageText);
  });

  it('when -help is asked, then the usage lists the flags.', () => {
    assert.equal(run('-help'), usageText);
  });

  it(
    'when an unknown flag is given, '
    + 'then the command exits 2 with the error and the usage on stderr.',
    () => {
      let code = 0;
      let stderr = '';
      try {
        execFileSync(process.execPath, [cli, '-nope'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        const failed = error as { status?: number; stderr?: string };
        code = failed.status ?? 0;
        stderr = failed.stderr ?? '';
      }
      assert.equal(`${code}\n${stderr}`, `2\nflag provided but not defined: -nope\n${usageText}`);
    },
  );

  it('when -v is asked, then the version and the platform are printed.', () => {
    assert.equal(run('-v'), `untangle ${VERSION} (${process.platform}/${process.arch})\n`);
  });
});
