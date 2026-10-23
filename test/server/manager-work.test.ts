import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { stopRuns, untangleCommand } from '../helpers/run.ts';
import { workingFixture } from './working-fixture.ts';

const orcaStub = path.join(path.dirname(fileURLToPath(import.meta.url)), '../helpers/orca-stub.mjs');

describe('Given the manager inside Orca, and pull requests on GitHub, ', { timeout: 300_000 }, () => {
  let f: ReturnType<typeof workingFixture>;
  let bin = '', orcaLog = '';
  let manager: ReviewClient;
  const env = (): NodeJS.ProcessEnv => ({ ...f.env, PATH: [bin, f.gh.binDir, process.env.PATH].join(path.delimiter), ORCA_CLI_COMMAND: 'orca-ide', ORCA_STUB_LOG: orcaLog });
  const calls = (): string[][] => (fs.existsSync(orcaLog) ? fs.readFileSync(orcaLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // The command each terminal Orca was asked for runs, in order.
  const commands = () => calls().filter((c) => c[0] === 'terminal' && c[1] === 'create').map((c) => c.at(-1)!);

  before(async () => {
    f = workingFixture();
    // #8 is merged: it has no working copy.
    f.gh.setReplies([
      { match: ['config', 'get', 'git_protocol'], stdout: 'https' },
      { match: ['pr', 'view', '8'], stdout: { ...f.pr, number: 8, url: 'https://github.com/acme/sample/pull/8', state: 'MERGED' } },
      { match: ['pr', 'view'], stdout: f.pr },
    ]);
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-bin-'));
    orcaLog = path.join(bin, 'orca.log');
    fs.writeFileSync(path.join(bin, 'orca-ide'), `#!/bin/sh\nexec node ${JSON.stringify(orcaStub)} "$@"\n`, { mode: 0o755 });
    // Claude and Codex, there to be found: the commands are typed into Orca's terminals, not run here.
    for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cacheDir: f.cache, gh: f.gh, cwd: f.author.dir, env: env() });
    assert.equal(started.code, 0, started.err);
    const url = /http:\/\/\S+/.exec(started.out)![0];
    manager = reviewClient(url);
    await manager.open();
    spawnSync(path.join(bin, 'orca-ide'), ['tab', 'create', '--url', url.replace(/\?.*$/, ''), '--worktree', 'id:wt-me', '--json'], { env: { ...process.env, ORCA_STUB_LOG: orcaLog } });
  });

  after(async () => {
    await stopRuns(f.cache);
    f.remove();
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it(
    'when an open one’s review starts with Codex, '
    + 'then Codex may write the review’s working copy and the clone its commits go into, as the start form’s command shows.',
    async () => {
      const work = path.join(f.cache, 'work/github.com/acme/sample/7'), clone = path.join(f.cache, 'repos/github.com/acme/sample.git');
      const shown = (await manager.call('dirs', { query: { target: f.url } })).data;
      const r = await manager.call('start', { method: 'POST', body: { target: f.url, agent: { kind: 'codex', resume: null, flags: '', message: '' } } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([shown, commands(), fs.existsSync(path.join(work, '.git'))], [
        { dirs: [work, clone] },
        [`codex --add-dir ${work} --add-dir ${clone} --no-daemon '$untangle ${f.url}'`],
        true,
      ]);
    },
  );

  it(
    'when a merged one’s review starts with Claude, '
    + 'then Claude starts once the review is built without a working copy, with no folder to write.',
    async () => {
      const link = 'https://github.com/acme/sample/pull/8', session = 'c1a0de00-0000-4000-8000-00000000c1a8';
      const r = await manager.call('start', { method: 'POST', body: { target: link, agent: { kind: 'claude', resume: null, session, flags: '', message: '' } } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([commands().at(-1), fs.existsSync(path.join(f.cache, 'work/github.com/acme/sample/8'))], [`claude --session-id ${session} -n 'Review sample#8' '/untangle ${link}'`, false]);
    },
  );
});
