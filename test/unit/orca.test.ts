import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { orcaHere } from '../../dist/orca.js';

describe('Given Orca’s command in a folder of its own, ', () => {
  let dir = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-orca-bin-'));
    fs.writeFileSync(path.join(dir, 'orca'), '#!/bin/sh\n', { mode: 0o755 });
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when Orca names its command, as it does in WSL, then untangle runs the one named.', () => {
    assert.equal(orcaHere({ ORCA_CLI_COMMAND: 'orca-ide', ORCA_CLI_BIN_DIR: dir }), 'orca-ide');
  });

  it('when Orca names only that folder, as it does on macOS and Linux, then untangle runs the orca in it.', () => {
    assert.equal(orcaHere({ ORCA_CLI_BIN_DIR: dir }), path.join(dir, 'orca'));
  });

  it('when the folder named has no orca, then untangle finds no Orca.', () => {
    assert.equal(orcaHere({ ORCA_CLI_BIN_DIR: path.join(dir, 'gone') }), null);
  });

  it('when Orca names neither, as outside its terminals, then untangle finds no Orca.', () => {
    assert.equal(orcaHere({}), null);
  });
});
