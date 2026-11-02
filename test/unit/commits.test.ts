import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { buildDartHistory, type BuiltReview, type FeatureCommit } from '../helpers/review.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';

interface Chain { name: string; kind: string; blocks: string[]; ext?: Array<{ name: string; chain: number }> }
interface Family {
  same?: boolean;
  kind: string;
  subject: string;
  body: string;
  commits: Array<{ subject: string; role: string }>;
  revisedBy: Array<{ subject: string; lines: number }>;
  buildsOn: number | null;
  chains: number[];
}
interface Model { compares: { base: { chainsBy: string; families?: Family[]; chains: Chain[] } } }

/**
 * The commits' chains: each commit's message, its commits and roles, its chains (with what they use
 * of other chains' changes), and how it relates to the others; then the renames.
 */
function familiesOf(review: BuiltReview): string {
  const base = (review.data.model as Model).compares.base;
  const uses = (c: Chain) => (c.ext?.length ? ` uses ${c.ext.map((x) => `${x.name} of ${base.chains[x.chain].name}`).join(', ')}` : '');
  const chain = (id: number) => `${base.chains[id].kind} ${base.chains[id].name} [${base.chains[id].blocks.join(' ')}]${uses(base.chains[id])}`;
  const lines = [`by ${base.chainsBy}`];
  for (const f of base.families ?? []) {
    if (f.same) {
      lines.push(`renames: ${f.chains.map(chain).join('; ') || 'none'}`);
      continue;
    }
    lines.push(`${f.kind ? f.kind + ' ' : ''}${f.subject}${f.body ? ` | ${f.body}` : ''}`);
    lines.push(`  commits: ${f.commits.map((c) => `${c.subject} (${c.role})`).join(', ')}`);
    lines.push(`  chains: ${f.chains.map(chain).join('; ') || 'none'}`);
    if (f.buildsOn != null) lines.push(`  builds on: ${base.families![f.buildsOn].subject}`);
    if (f.revisedBy.length) lines.push(`  changed later by: ${f.revisedBy.map((r) => `${r.subject} (${r.lines})`).join(', ')}`);
  }
  return lines.join('\n');
}

const report = (first: string, second: string) => `void keep() {}\n\nvoid report(int total) {\n  print('${first}: $total');\n  print('${second}');\n}\n`;

describe('Given two commits that change unrelated functions, ', { skip: skipDart }, () => {
  const base = {
    'lib/price.dart': 'int price(int amount) => amount;\n',
    'lib/greet.dart': "String greet(String name) => 'hello $name';\n",
  };
  const commits: FeatureCommit[] = [
    { subject: 'feat: Double the price', files: { 'lib/price.dart': 'int price(int amount) => amount * 2;\n' } },
    { subject: 'fix(greet): Say hi', body: 'Hello is too formal.', files: { 'lib/greet.dart': "String greet(String name) => 'hi $name';\n" } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then each commit is one chain, named after its subject and carrying its message.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'feat Double the price',
        '  commits: feat: Double the price (start)',
        '  chains: commit Double the price [lib/price.dart#0]',
        'fix(greet) Say hi | Hello is too formal.',
        '  commits: fix(greet): Say hi (start)',
        '  chains: commit Say hi [lib/greet.dart#0]',
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that adds a function and a later commit that only edits a line of it, ', { skip: skipDart }, () => {
  const base = { 'lib/report.dart': 'void keep() {}\n' };
  const commits: FeatureCommit[] = [
    { subject: 'feat: Add a report', files: { 'lib/report.dart': report('total', 'done') } },
    { subject: 'fix: Label the sum', files: { 'lib/report.dart': report('sum', 'done') } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then the later commit is a follow-up in the first one\'s chain.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'feat Add a report',
        '  commits: feat: Add a report (start), fix: Label the sum (follow-up)',
        '  chains: commit Add a report [lib/report.dart#0]',
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that adds a function and a later commit that tests it and edits one of its lines, ', { skip: skipDart }, () => {
  const base = { 'lib/report.dart': 'void keep() {}\n' };
  const test = "import 'package:sample/report.dart';\n\nvoid main() {\n  report(1);\n  report(2);\n  report(3);\n}\n";
  const commits: FeatureCommit[] = [
    { subject: 'feat: Add a report', files: { 'lib/report.dart': report('total', 'done') } },
    { subject: 'test: Cover the report', files: { 'lib/report.dart': report('total', 'finished'), 'test/report_test.dart': test } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then the tests are their own chain, which builds on the function\'s and links to it, and the edit stays with the function.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'feat Add a report',
        '  commits: feat: Add a report (start)',
        '  chains: commit Add a report [lib/report.dart#0]',
        '  changed later by: test: Cover the report (1)',
        'test Cover the report',
        '  commits: test: Cover the report (builds-on)',
        '  chains: commit Cover the report [test/report_test.dart#0 test/report_test.dart#1] uses report of Add a report',
        '  builds on: Add a report',
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that changes a function and a later commit that calls it from another one, ', { skip: skipDart }, () => {
  const base = {
    'lib/total.dart': 'int total(int amount) => amount;\n',
    'lib/report.dart': "import 'total.dart';\n\nint report() => 0;\n",
  };
  const commits: FeatureCommit[] = [
    { subject: 'feat: Double the total', files: { 'lib/total.dart': 'int total(int amount) => amount * 2;\n' } },
    { subject: 'feat: Report the total', files: { 'lib/report.dart': "import 'total.dart';\n\nint report() => total(3);\n" } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then each commit is its own chain, and the call links to the function in the first one\'s.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'feat Double the total',
        '  commits: feat: Double the total (start)',
        '  chains: commit Double the total [lib/total.dart#0]',
        'feat Report the total',
        '  commits: feat: Report the total (start)',
        '  chains: commit Report the total [lib/report.dart#0] uses total of Double the total',
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that only rewrites a paragraph of a document, ', { skip: skipDart }, () => {
  const base = { 'lib/a.dart': 'void a() {}\n', 'docs/guide.md': '# Guide\n\nStart the server first.\n' };
  const commits: FeatureCommit[] = [
    { subject: 'docs: Explain the order', files: { 'docs/guide.md': '# Guide\n\nStart the server, then the app.\n' } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then the document\'s change is that commit\'s chain.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'docs Explain the order',
        '  commits: docs: Explain the order (start)',
        '  chains: commit Explain the order [docs/guide.md#0]',
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that only replaces one call with another in two places, ', { skip: skipDart }, () => {
  const helpers = "void log(String text) {}\n\nvoid record(String text) {}\n";
  const base = {
    'lib/helpers.dart': helpers,
    'lib/a.dart': "import 'helpers.dart';\n\nvoid a() {\n  log('a');\n}\n",
    'lib/b.dart': "import 'helpers.dart';\n\nvoid b() {\n  log('b');\n}\n",
  };
  const commits: FeatureCommit[] = [
    { subject: 'refactor: Record instead of logging', files: { 'lib/a.dart': "import 'helpers.dart';\n\nvoid a() {\n  record('a');\n}\n", 'lib/b.dart': "import 'helpers.dart';\n\nvoid b() {\n  record('b');\n}\n" } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then the rename keeps its own chain, and the commit has no chain of its own.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'refactor Record instead of logging',
        '  commits: refactor: Record instead of logging (start)',
        '  chains: none',
        'renames: group log → record [lib/a.dart#0 lib/b.dart#0]',
      ].join('\n'));
    });
  });
});

describe('Given one commit with more than thirty changes, six of them a parameter\'s ripple, ', { skip: skipDart }, () => {
  const callers = (pass: (i: number) => string) => "import 'price.dart';\n" + [1, 2, 3, 4, 5, 6].map((i) => `\nint a${i}() => price(${pass(i)});\n`).join('');
  const values = (value: (i: number) => number) => Array.from({ length: 30 }, (_, i) => `int v${i}() => ${value(i)};\n`).join('\n');
  const base = {
    'lib/price.dart': 'int price(int amount) => amount;\n',
    'lib/callers.dart': callers((i) => `${i}`),
    'lib/values.dart': values((i) => i),
  };
  const commits: FeatureCommit[] = [
    {
      subject: 'feat: Tax every price',
      files: {
        'lib/price.dart': 'int price(int amount, int tax) => amount + tax;\n',
        'lib/callers.dart': callers((i) => `${i}, ${i * 10}`),
        'lib/values.dart': values((i) => i + 100),
      },
    },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then the commit is one chain, however large: the ripple reads with the rest of it.', () => {
      const callerBlocks = [0, 1, 2, 3, 4, 5].map((i) => `lib/callers.dart#${i}`).join(' ');
      const valueBlocks = Array.from({ length: 30 }, (_, i) => `lib/values.dart#${i}`).sort().join(' ');
      assert.equal(familiesOf(review!), [
        'by history',
        'feat Tax every price',
        '  commits: feat: Tax every price (start)',
        `  chains: commit Tax every price [${callerBlocks} lib/price.dart#0 ${valueBlocks}]`,
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that adds the same call to three functions, ', { skip: skipDart }, () => {
  const helpers = "void log(String text) {}\n";
  const work = (call: string) => ['a', 'b', 'c'].map((x) => `void ${x}() {\n${call}  print('${x}');\n}\n`).join('\n');
  const base = { 'lib/helpers.dart': helpers, 'lib/work.dart': `import 'helpers.dart';\n\n${work('')}` };
  const commits: FeatureCommit[] = [
    { subject: 'feat: Log every step', files: { 'lib/work.dart': `import 'helpers.dart';\n\n${work("  log('step');\n")}` } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then the repeated call is that commit\'s chain, not a chain apart.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'feat Log every step',
        '  commits: feat: Log every step (start)',
        '  chains: commit Log every step [lib/work.dart#0 lib/work.dart#1 lib/work.dart#2]',
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that renames a call in a function and in a test\'s setup, ', { skip: skipDart }, () => {
  const helpers = "void log(String text) {}\n\nvoid record(String text) {}\n";
  const test = (call: string) => `import 'package:sample/helpers.dart';\n\nvoid main() {\n  setUp(() {\n    ${call}('setup');\n  });\n}\n`;
  const base = {
    'lib/helpers.dart': helpers,
    'lib/a.dart': "import 'helpers.dart';\n\nvoid a() {\n  log('a');\n}\n",
    'test/a_test.dart': test('log'),
  };
  const commits: FeatureCommit[] = [
    { subject: 'refactor: Record instead of logging', files: { 'lib/a.dart': "import 'helpers.dart';\n\nvoid a() {\n  record('a');\n}\n", 'test/a_test.dart': test('record') } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then both places are the rename\'s chain.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'refactor Record instead of logging',
        '  commits: refactor: Record instead of logging (start)',
        '  chains: none',
        'renames: group log → record [lib/a.dart#0 test/a_test.dart#0]',
      ].join('\n'));
    });
  });
});

describe('Given a commit that adds a field before a class\'s closing brace and a later commit that drops the blank line after it, ', { skip: skipDart }, () => {
  const base = { 'lib/receipt.dart': 'class Receipt {\n  final int total = 1;\n}\n\nint other() => 2;\n' };
  const commits: FeatureCommit[] = [
    { subject: 'feat: Add a note', files: { 'lib/receipt.dart': "class Receipt {\n  final int total = 1;\n\n  final String note = 'none';\n}\n\nint other() => 2;\n" } },
    { subject: 'style: Drop the blank line', files: { 'lib/receipt.dart': "class Receipt {\n  final int total = 1;\n\n  final String note = 'none';\n}\nint other() => 2;\n" } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then the brace that git\'s diff removes, though no commit did, goes with the field after it.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'feat Add a note',
        '  commits: feat: Add a note (start)',
        '  chains: commit Add a note [lib/receipt.dart#0 lib/receipt.dart#1]',
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that adds a test file and a later commit that adds a test to it, ', { skip: skipDart }, () => {
  const tests = (more: string) => `import 'package:sample/report.dart';\n\nvoid main() {\n  test('reports one', () {\n    report(1);\n  });\n${more}}\n`;
  const base = { 'lib/report.dart': 'void report(int total) {}\n' };
  const commits: FeatureCommit[] = [
    { subject: 'test: Cover the report', files: { 'test/report_test.dart': tests('') } },
    { subject: 'test: Cover an empty report', files: { 'test/report_test.dart': tests("\n  test('reports none', () {\n    report(0);\n  });\n") } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then each test is whole, in the chain of the commit that wrote it.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'test Cover the report',
        '  commits: test: Cover the report (start)',
        '  chains: commit Cover the report [test/report_test.dart#0 test/report_test.dart#1 test/report_test.dart#2]',
        'test Cover an empty report',
        '  commits: test: Cover an empty report (start)',
        '  chains: commit Cover an empty report [test/report_test.dart#3]',
        'renames: none',
      ].join('\n'));
    });
  });
});

describe('Given a commit that adds a test under a Given and a later commit that moves it under a new Given beside a new test, ', { skip: skipDart }, () => {
  const tests = (given: string, more: string) => `import 'package:sample/report.dart';\n\nvoid main() {\n  group(\n    '${given}',\n    () {\n      test('then it reports one.', () {\n        report(1);\n      });\n${more}    },\n  );\n}\n`;
  const base = { 'lib/report.dart': 'void report(int total) {}\n' };
  const commits: FeatureCommit[] = [
    { subject: 'test: Cover the report', files: { 'test/report_test.dart': tests('Given a report of a total taken from a single long import,', '') } },
    { subject: 'test: Name the empty ledger', files: { 'test/report_test.dart': tests('Given an empty ledger,', "\n      test('then it reports none.', () {\n        report(0);\n      });\n") } },
  ];

  describe('when the review follows the commits, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartHistory(base, commits);
    });

    after(() => review?.remove());

    it('then the Given goes with the commit that wrote its title, though its group( line kept the first one\'s origin.', () => {
      assert.equal(familiesOf(review!), [
        'by history',
        'test Cover the report',
        '  commits: test: Cover the report (start)',
        '  chains: commit Cover the report [test/report_test.dart#0 test/report_test.dart#1 test/report_test.dart#3]',
        '  changed later by: test: Name the empty ledger (1)',
        'test Name the empty ledger',
        '  commits: test: Name the empty ledger (builds-on)',
        '  chains: commit Name the empty ledger [test/report_test.dart#2 test/report_test.dart#4]',
        '  builds on: Cover the report',
        'renames: none',
      ].join('\n'));
    });
  });
});
