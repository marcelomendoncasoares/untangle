import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it, mock } from 'node:test';
import { Narrator } from '../../dist/narrate.js';

// stderr's width is set even when none is given, so the tests don't depend on the terminal they run in.
function running(terminal: boolean, columns?: number) {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const descriptors = { isTTY: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'), columns: Object.getOwnPropertyDescriptor(process.stderr, 'columns') };
  Object.defineProperty(process.stderr, 'isTTY', { value: terminal, configurable: true });
  Object.defineProperty(process.stderr, 'columns', { value: columns, configurable: true, writable: true });
  let output = '';
  mock.method(process.stderr, 'write', (chunk: string) => { output += chunk; return true; });
  const narrator = new Narrator({ quiet: false, verbose: false, color: false });
  narrator.step('language server');
  output = '';
  return {
    narrator,
    output: () => output,
    remove() {
      narrator.finish();
      mock.reset();
      mock.timers.reset();
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(process.stderr, key, descriptor);
        else Reflect.deleteProperty(process.stderr, key);
      }
    },
  };
}

type Running = ReturnType<typeof running>;

describe('Given a running step on a terminal, ', () => {
  let run: Running;

  before(() => { run = running(true); });
  after(() => run.remove());

  describe('when a second passes, ', () => {
    let status = '';
    let output = '';

    before(() => {
      mock.timers.tick(1000);
      status = JSON.stringify(run.narrator.status.steps[0]);
      output = run.output();
    });

    it('then the serialized status carries the elapsed millisecond count.', () => {
      assert.equal(status, '{"label":"language server","state":"running","ms":1000,"notes":[]}');
    });

    it('then the terminal redraws with the elapsed second.', () => {
      assert.equal(output, '\r\x1b[K  … language server  1 s');
    });
  });
});

describe('Given a running step on a terminal 72 columns wide, ', () => {
  let run: Running;

  before(() => { run = running(true, 72); });
  after(() => run.remove());

  describe('when it reads a file whose path is longer than the row has room for, ', () => {
    let output = '';

    before(() => {
      const start = run.output().length;
      run.narrator.detail('Dart files 3 of 105: packages/shop_server/lib/src/generated/protocol.dart', [3, 105]);
      output = run.output().slice(start);
    });

    it('then the line fills the row but its last column, keeping the count and the end of the path.', () => {
      assert.equal(output, '\r\x1b[K  … language server  0 s  Dart files 3 of 105: …generated/protocol.dart');
    });
  });

  describe('when it says something longer that names no path, ', () => {
    let output = '';

    before(() => {
      const start = run.output().length;
      run.narrator.detail('cloning acme-industries/shop-platform-monorepo (blobs on demand)');
      output = run.output().slice(start);
    });

    it('then the line fills the row but its last column, keeping the start.', () => {
      assert.equal(output, '\r\x1b[K  … language server  0 s  cloning acme-industries/shop-platform-monore…');
    });
  });
});

describe('Given a running step on a pipe, ', () => {
  let run: Running;

  before(() => { run = running(false); });
  after(() => run.remove());

  describe('when a second passes, ', () => {
    let status = '';
    let output = '';

    before(() => {
      mock.timers.tick(1000);
      status = JSON.stringify(run.narrator.status.steps[0]);
      output = run.output();
    });

    it('then the serialized status carries the elapsed millisecond count.', () => {
      assert.equal(status, '{"label":"language server","state":"running","ms":1000,"notes":[]}');
    });

    it('then no further output is written to the pipe.', () => {
      assert.equal(output, '');
    });
  });
});

describe('Given a step finished after one second, ', () => {
  let run: Running;

  before(() => {
    run = running(false);
    mock.timers.tick(1000);
    run.narrator.finish();
  });
  after(() => run.remove());

  describe('when five more seconds pass, ', () => {
    let status = '';

    before(() => {
      mock.timers.tick(5000);
      status = JSON.stringify(run.narrator.status.steps[0]);
    });

    it('then it stays done at one second.', () => {
      assert.equal(status, '{"label":"language server","state":"done","ms":1000,"notes":[]}');
    });
  });
});

describe('Given a step that failed after one second, ', () => {
  let run: Running;

  before(() => {
    run = running(false);
    mock.timers.tick(1000);
    run.narrator.fail('analysis failed');
  });
  after(() => run.remove());

  describe('when five more seconds pass, ', () => {
    let status = '';

    before(() => {
      mock.timers.tick(5000);
      status = JSON.stringify(run.narrator.status.steps[0]);
    });

    it('then it stays failed at one second.', () => {
      assert.equal(status, '{"label":"language server","state":"failed","ms":1000,"notes":[]}');
    });
  });
});

describe('Given a step ended by the review becoming ready after one second, ', () => {
  let run: Running;

  before(() => {
    run = running(false);
    mock.timers.tick(1000);
    run.narrator.ready('http://localhost/');
  });
  after(() => run.remove());

  describe('when five more seconds pass, ', () => {
    let status = '';

    before(() => {
      mock.timers.tick(5000);
      status = JSON.stringify(run.narrator.status.steps[0]);
    });

    it('then it stays done at one second.', () => {
      assert.equal(status, '{"label":"language server","state":"done","ms":1000,"notes":[]}');
    });
  });
});

/** A quiet narrator, and what a page waiting on its status hears each time it asks. */
function waited() {
  mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000 });
  const narrator = new Narrator({ quiet: true, verbose: false, color: false });
  const heard: string[] = [];
  const ask = () => narrator.next(() => {
    const { rev, steps } = narrator.status;
    const step = steps[steps.length - 1];
    heard.push(`rev ${rev}: ${step.label} ${step.state}${step.detail ? `, ${step.detail}` : ''}${step.count ? `, ${step.count.join(' of ')}` : ''}`);
  });
  return {
    narrator,
    heard,
    ask,
    remove() {
      narrator.finish();
      mock.timers.reset();
    },
  };
}

describe('Given the page waiting for the status to change, ', () => {
  let run: ReturnType<typeof waited>;

  before(() => {
    run = waited();
    run.ask();
  });
  after(() => run.remove());

  describe('when a step starts, ', () => {
    before(() => run.narrator.step('analyzer'));

    it('then the page hears at once, with the step running.', () => {
      assert.deepEqual(run.heard, ['rev 1: analyzer running']);
    });
  });
});

describe('Given a running step that counts its files, and the page waiting, ', () => {
  let run: ReturnType<typeof waited>;

  before(() => {
    run = waited();
    run.narrator.step('analyzer');
    run.ask();
  });
  after(() => run.remove());

  describe('when two files are read within 150 ms, ', () => {
    let early = '';

    before(() => {
      run.narrator.detail('Dart files 1 of 116: lib/a.dart', [1, 116]);
      mock.timers.tick(50);
      run.narrator.detail('Dart files 2 of 116: lib/b.dart', [2, 116]);
      mock.timers.tick(99);
      early = run.heard.join('\n');
      mock.timers.tick(1);
    });

    it('then the page hears once, 150 ms after the first, with the second and its count.', () => {
      assert.equal(`${early}|${run.heard.join('\n')}`, '|rev 2: analyzer running, Dart files 2 of 116: lib/b.dart, 2 of 116');
    });
  });

  describe('when the step ends, ', () => {
    let status = '';

    before(() => {
      run.narrator.finish();
      status = JSON.stringify(run.narrator.status.steps[0]);
    });

    it('then it keeps neither what it was reading nor its count.', () => {
      assert.equal(status, '{"label":"analyzer","state":"done","ms":150,"notes":[]}');
    });
  });
});

describe('Given a script with only a narration timer, ', () => {
  let script = '';

  before(() => {
    script = `import { Narrator } from ${JSON.stringify(new URL('../../dist/narrate.js', import.meta.url).href)};\nnew Narrator({ quiet: true, verbose: false, color: false }).step('waiting');\n`;
  });

  describe('when the script runs, ', () => {
    let exit = '';

    before(() => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
      exit = `${child.status}\n${child.signal}\n${child.stderr}`;
    });

    it('then the timer lets the process exit cleanly.', () => {
      assert.equal(exit, '0\nnull\n');
    });
  });
});
