import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { provenance, type Provenance } from '../../dist/provenance.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const nothingGenerated = () => false;

/** Each reviewed line with the commit that started it, moved it and changed it; then who revised whom. */
function provenanceText(p: Provenance): string {
  const name = (i: number) => (i < 0 ? 'no commit' : p.commits[i].subject);
  const files = Object.keys(p.files).sort().map((file) => {
    const f = p.files[file];
    const minus = Object.entries(f.minus).map(([line, c]) => `-${line} changed first by ${name(c)}`);
    const plus = Object.entries(f.plus).map(([line, [origin, by, ...changed]]) => {
      const moved = by >= 0 ? `, moved by ${name(by)}` : '';
      const edits = changed.length ? `, changed by ${changed.map(name).join(', ')}` : '';
      return `+${line} started by ${name(origin)}${moved}${edits}`;
    });
    return [file, ...minus, ...plus].join('\n');
  });
  const revised = p.revised.flatMap((r, i) => Object.entries(r).map(([origin, n]) => `${name(i)} revised ${n} of ${name(Number(origin))}`));
  return [...files, ...revised].join('\n');
}

describe('Given a commit that adds two functions and a later commit that edits one of them, ', () => {
  let repo: TempRepo | undefined;
  let base = '';
  let head = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void keep() {}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', "void keep() {}\nvoid greet() => print('hello there');\nvoid part() => print('goodbye');\n");
    repo.commit({ subject: 'adds greet and part', author: ada, committer: ada });
    repo.write('lib/a.dart', "void keep() {}\nvoid greet() => print('hi there');\nvoid part() => print('goodbye');\n");
    head = repo.commit({ subject: 'greets shorter', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  describe('when the commits are replayed, ', () => {
    let replayed: Provenance | undefined;

    before(async () => {
      replayed = await provenance(repo!.dir, base, head, nothingGenerated);
    });

    it('then both lines keep the commit that started them, and the edited one names the commit that changed it.', () => {
      assert.equal(provenanceText(replayed!), [
        'lib/a.dart',
        '+2 started by adds greet and part, changed by adds greet and part, greets shorter',
        '+3 started by adds greet and part, changed by adds greet and part',
        'greets shorter revised 1 of adds greet and part',
      ].join('\n'));
    });
  });
});

describe('Given a commit that only reformats a line an earlier commit added, ', () => {
  let repo: TempRepo | undefined;
  let base = '';
  let head = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void keep() {}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'void keep() {}\nint total(int price, int quantity) => price * quantity;\n');
    repo.commit({ subject: 'adds total', author: ada, committer: ada });
    repo.write('lib/a.dart', 'void keep() {}\nint total(\n  int price,\n  int quantity,\n) => price * quantity;\n');
    head = repo.commit({ subject: 'formats', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  describe('when the commits are replayed, ', () => {
    let replayed: Provenance | undefined;

    before(async () => {
      replayed = await provenance(repo!.dir, base, head, nothingGenerated);
    });

    it('then every reformatted line keeps the commit that wrote it, and the formatting revises nothing.', () => {
      assert.equal(provenanceText(replayed!), [
        'lib/a.dart',
        '+2 started by adds total, changed by adds total',
        '+3 started by adds total, changed by adds total',
        '+4 started by adds total, changed by adds total',
        '+5 started by adds total, changed by adds total',
      ].join('\n'));
    });
  });
});

describe('Given a commit that moves lines an earlier commit added into another file, ', () => {
  let repo: TempRepo | undefined;
  let base = '';
  let head = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void keep() {}\n');
    repo.write('lib/b.dart', 'void other() {}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'void keep() {}\nint total(int price, int quantity) {\n  final sum = price * quantity;\n  return sum;\n}\n');
    repo.commit({ subject: 'adds total', author: ada, committer: ada });
    repo.write('lib/a.dart', 'void keep() {}\n');
    repo.write('lib/b.dart', 'void other() {}\nint total(int price, int quantity) {\n  final sum = price * quantity;\n  return sum;\n}\n');
    head = repo.commit({ subject: 'moves total', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  describe('when the commits are replayed, ', () => {
    let replayed: Provenance | undefined;

    before(async () => {
      replayed = await provenance(repo!.dir, base, head, nothingGenerated);
    });

    it('then the moved lines keep the commit that started them and name the commit that moved them.', () => {
      assert.equal(provenanceText(replayed!), [
        'lib/b.dart',
        '+2 started by adds total, moved by moves total, changed by adds total, moves total',
        '+3 started by adds total, moved by moves total, changed by adds total, moves total',
        '+4 started by adds total, moved by moves total, changed by adds total, moves total',
        '+5 started by adds total, moved by moves total, changed by adds total, moves total',
        'moves total revised 3 of adds total',
      ].join('\n'));
    });
  });
});

describe('Given a commit that removes a line of the base and another that renames a file, ', () => {
  let repo: TempRepo | undefined;
  let base = '';
  let head = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void keep() {}\nvoid drop() {}\n');
    repo.write('lib/old.dart', 'void moved() {}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'void keep() {}\n');
    repo.commit({ subject: 'drops drop', author: ada, committer: ada });
    repo.rename('lib/old.dart', 'lib/new.dart');
    head = repo.commit({ subject: 'renames old', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  describe('when the commits are replayed, ', () => {
    let replayed: Provenance | undefined;

    before(async () => {
      replayed = await provenance(repo!.dir, base, head, nothingGenerated);
    });

    it('then the removed line names the commit that removed it, and the renamed file, moved as it was, has no lines in the review\'s diff.', () => {
      assert.equal(provenanceText(replayed!), [
        'lib/a.dart',
        '-2 changed first by drops drop',
        'lib/new.dart',
      ].join('\n'));
    });
  });
});

describe('Given a branch that adds a line and then merges main, which added a file, ', () => {
  let repo: TempRepo | undefined;
  let base = '';
  let head = '';

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void one() {}\n');
    repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', 'void one() {}\nvoid two() {}\n');
    repo.commit({ subject: 'adds two', author: ada, committer: ada });
    repo.checkout('main');
    repo.write('lib/main_only.dart', 'void elsewhere() {}\n');
    base = repo.commit({ subject: 'main adds a file', author: ada, committer: ada });
    repo.checkout('feature');
    head = repo.merge({ ref: 'main', subject: 'merges main', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  describe('when the commits are replayed against main, ', () => {
    let replayed: Provenance | undefined;

    before(async () => {
      replayed = await provenance(repo!.dir, base, head, nothingGenerated);
    });

    it('then the branch\'s line keeps its commit, and the merge is a merge that started nothing.', () => {
      assert.equal(`${provenanceText(replayed!)}\n${replayed!.commits.map((c) => `${c.subject} ${c.merge ? 'merge' : 'commit'}`).join('\n')}`, [
        'lib/a.dart',
        '+2 started by adds two, changed by adds two',
        'adds two commit',
        'merges main merge',
      ].join('\n'));
    });
  });
});
