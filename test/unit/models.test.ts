import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { compareModels, isTestModel, migrationAction, modelOpenings, parseModel, splitTop, summary, type ModelItem, type ModelWarning } from '../../analysis/models.js';
import { has } from '../../dist/exec.js';
import { buildDartReview, type BuiltReview } from '../helpers/review.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';

/** The warnings of a change between two versions of a model, one per line: key, names and line. */
function warningsOf(before: string | null, after: string | null, test = false): string {
  const { warns } = compareModels(parseModel(before), parseModel(after), { test });
  return warns.map((w: ModelWarning) => [w.k, w.fields?.join('+') || w.field || w.value || (w.from ? `${w.from}>${w.to}` : ''), w.side ? `${w.side}:${w.line}` : 'model'].filter(Boolean).join(' ')).join('\n');
}

const invoice = (fields: string) => `class: Invoice\ntable: invoices\nfields:\n${fields}`;

describe('Given field definitions with generics, relations and defaults, ', () => {
  it('then each splits at its top-level commas only.', () => {
    assert.deepEqual(splitTop('Map<String, int>?, default={}'), ['Map<String, int>?', 'default={}']);
    assert.deepEqual(splitTop('CrdtScope?, relation(name=scope_nodes, onDelete=Cascade)'), ['CrdtScope?', 'relation(name=scope_nodes, onDelete=Cascade)']);
    assert.deepEqual(splitTop("String, default='a, b', !persist"), ['String', "default='a, b'", '!persist']);
  });
});

describe('Given a model with docs, a table, fields, an index and an enum, ', () => {
  const model = parseModel([
    '### An invoice.',
    '### Sent once.',
    'class: Invoice',
    "table: 'invoices'",
    'fields:',
    '  ### Its total.',
    '  amount: int',
    '  cache: String?, !persist',
    'indexes:',
    '  invoice_amount_idx:',
    '    fields: amount, cache',
    '    unique: true',
  ].join('\n'))!;
  const color = parseModel('enum: Color\nserialized: byName\nvalues:\n  ### The first.\n  - red\n  - green\n')!;

  it('then the class keeps its doc, unquoted keys and each field with its line and doc.', () => {
    assert.equal(model.name, 'Invoice');
    assert.deepEqual(model.doc, ['An invoice.', 'Sent once.']);
    assert.equal(model.keys.get('table')?.v, 'invoices');
    assert.deepEqual([...model.fields].map(([f, d]) => `${f} ${d.def} L${d.line} ${d.doc.join(' ')}`), ['amount int L7 Its total.', 'cache String?, !persist L8 ']);
    assert.deepEqual(model.indexes.get('invoice_amount_idx')?.props, { fields: 'amount, cache', unique: 'true' });
  });

  it('then the enum keeps its values in order, each with its line, and how it serializes.', () => {
    assert.equal(color.kind, 'enum');
    assert.deepEqual(color.values.map((v) => `${v.name} L${v.line}`), ['red L5', 'green L6']);
    assert.equal(color.keys.get('serialized')?.v, 'byName');
  });
});

describe('Given a model file with blocks, a comment at the margin and lines ending in CRLF, ', () => {
  const lines = ['class: Invoice', 'fields:', '  amount: int', '', '  ### Its currency.', '  currency: String', '# Kept apart.', '  note: String?', 'indexes:\r', '  invoice_idx:\r', '    fields: amount\r'];

  it('then each line starts inside the last line at the margin above it, and a line at the margin on its own.', () => {
    assert.deepEqual(modelOpenings(lines.join('\n')).map((open, i) => `${i + 1} ${open || 'margin'}`), [
      '1 margin', '2 margin', '3 fields:', '4 fields:', '5 fields:', '6 fields:', '7 margin', '8 # Kept apart.', '9 margin', '10 indexes:', '11 indexes:',
    ]);
  });
});

describe('Given fields added to a model, ', () => {
  it('then a required one with no default warns on its line, naming each such field once.', () => {
    assert.equal(warningsOf(invoice('  amount: int\n'), invoice('  amount: int\n  currency: String\n  rate: double\n')), 'required currency+rate RIGHT:6');
  });

  it('then a nullable one, or one with default or defaultModel, doesn’t.', () => {
    assert.equal(warningsOf(invoice('  amount: int\n'), invoice('  amount: int\n  note: String?\n  rate: double, default=1.0\n  tax: double, defaultModel=0.0\n')), '');
  });

  it('then one with only defaultPersist warns: it fills the table, not data on the wire.', () => {
    assert.equal(warningsOf(invoice('  amount: int\n'), invoice('  amount: int\n  rate: double, defaultPersist=1.0\n')), 'required rate RIGHT:5');
  });

  it('then a new model warns of nothing.', () => {
    assert.equal(warningsOf(null, invoice('  amount: int\n')), '');
  });
});

describe('Given fields removed and retyped, ', () => {
  it('then a removed field the old version requires warns on its old line; a nullable one doesn’t.', () => {
    assert.equal(warningsOf(invoice('  amount: int\n  note: String?\n'), invoice('')), 'field-removed amount LEFT:4');
  });

  it('then a new type warns, and so does one made required; one made nullable doesn’t.', () => {
    assert.equal(warningsOf(invoice('  amount: int\n  rate: double?\n  tax: int\n'), invoice('  amount: String\n  rate: double\n  tax: int?\n')), 'retyped int>String RIGHT:4\nretyped double?>double RIGHT:5');
  });

  it('then a removed model warns on the whole model.', () => {
    assert.equal(warningsOf(invoice('  amount: int\n'), null), 'removed model');
  });

  it('then a test model warns of none of it.', () => {
    assert.equal(warningsOf(invoice('  amount: int\n'), invoice('  amount: String\n  currency: String\n'), true), '');
  });
});

describe('Given an enum serialized by index, ', () => {
  const color = (values: string[], extra = '') => `enum: Color\n${extra}values:\n${values.map((v) => `  - ${v}\n`).join('')}`;

  it('then a value removed in the middle warns on it: the values after it shift.', () => {
    assert.equal(warningsOf(color(['red', 'green', 'blue']), color(['red', 'blue'])), 'enum-order green LEFT:4');
  });

  it('then a value put in between warns on it.', () => {
    assert.equal(warningsOf(color(['red', 'blue']), color(['red', 'green', 'blue'])), 'enum-order green RIGHT:4');
  });

  it('then a value added at the end doesn’t, and neither does any change by name.', () => {
    assert.equal(warningsOf(color(['red']), color(['red', 'green'])), '');
    assert.equal(warningsOf(color(['red', 'green'], 'serialized: byName\n'), color(['green'], 'serialized: byName\n')), '');
  });
});

describe('Given what changed in models, ', () => {
  it('then a folded model’s line says it in short: its doc, fields, indexes and values.', () => {
    const rows = compareModels(parseModel('### Old.\n' + invoice('  amount: int\n  note: String?\n')), parseModel('### New.\n' + invoice('  amount: int, default=0\n  currency: String\n')), {}).rows;
    assert.equal(summary(rows, 'M'), '~ doc, ~ amount, + currency, − note');
    assert.equal(summary(compareModels(null, parseModel(invoice('  a: int\n  b: int\n  c: int\n  d: int\n  e: int\n')), {}).rows, 'A'), 'new · + a, + b, + c, + d, and 1 more');
    assert.equal(summary([], 'D'), 'removed');
  });
});

describe('Given a migration.sql with actions on two tables, ', () => {
  const sql = ['BEGIN;', '', '--', '-- ACTION CREATE TABLE', '--', 'CREATE TABLE "other" ("id" bigserial);', '', '--', '-- ACTION ALTER TABLE', '--', 'ALTER TABLE "invoices" ADD COLUMN "currency" text;', 'ALTER TABLE "invoices" ADD COLUMN "rate" double precision;', '', '--', '-- MIGRATION VERSION FOR sample', '--', 'INSERT INTO "serverpod_migrations" VALUES (1);', '', 'COMMIT;'].join('\n');

  it('then a table’s statements run from its action’s header to the next, with its added columns marked.', () => {
    assert.deepEqual(migrationAction(sql, 'invoices', ['currency']), { start: 8, end: 12, hits: [11] });
  });

  it('then a table it doesn’t name has none.', () => {
    assert.equal(migrationAction(sql, 'receipts'), null);
  });
});

describe('Given models in several folders and packages, ', () => {
  it('then those under a test folder, or in a package with test as a word in its name, are test models.', () => {
    assert.equal(isTestModel('test/app_test_server/lib/src/models/a.spy.yaml', 'test/app_test_server'), true);
    assert.equal(isTestModel('tests/serverpod_test_server/lib/src/a.spy.yaml', 'tests/serverpod_test_server'), true);
    assert.equal(isTestModel('packages/app_test_tools/lib/src/a.spy.yaml', 'packages/app_test_tools'), true);
    assert.equal(isTestModel('packages/contest/lib/src/a.spy.yaml', 'packages/contest'), false);
    assert.equal(isTestModel('app_server/lib/src/models/a.spy.yaml', 'app_server'), false);
  });

  it('then .review.yaml’s tests adds folders, as globs or as folders.', () => {
    assert.equal(isTestModel('examples/shop/lib/src/a.spy.yaml', 'examples/shop', ['examples/**']), true);
    assert.equal(isTestModel('fixtures/x/lib/a.spy.yaml', 'fixtures/x', ['fixtures']), true);
    assert.equal(isTestModel('app/lib/a.spy.yaml', 'app', ['fixtures']), false);
  });
});

describe('Given a review that changes a model with its generated code and migration, removes another and changes a test model, ', { skip: skipDart }, () => {
  const generated = (cls: string, fields: string[]) => `abstract class ${cls} {\n  ${cls}({${fields.map((f) => `required this.${f.split(' ')[1]}`).join(', ')}});\n${fields.map((f) => `  ${f};\n`).join('')}}\n`;
  const files = {
    base: {
      'lib/src/models/invoice.spy.yaml': '### An invoice.\n' + invoice('  amount: int\n'),
      'lib/src/models/receipt.spy.yaml': 'class: Receipt\nfields:\n  total: int\n',
      'lib/src/generated/invoice.dart': generated('Invoice', ['int amount']),
      'lib/src/generated/receipt.dart': generated('Receipt', ['int total']),
      'lib/src/generated/protocol.dart': "const models = [\n  'Invoice',\n  'Receipt',\n];\n",
      'lib/app.dart': "import 'src/generated/invoice.dart';\n\nint amountOf(Invoice invoice) => invoice.amount;\n",
      'migrations/20240101000000/migration.json': JSON.stringify({ actions: [{ type: 'createTable', createTable: { name: 'invoices' } }], warnings: [] }),
      'migrations/20240101000000/migration.sql': 'BEGIN;\nCOMMIT;\n',
      'test/sample_test_server/pubspec.yaml': 'name: sample_test_server\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
      'test/sample_test_server/lib/src/models/thing.spy.yaml': 'class: Thing\nfields:\n  name: String\n',
    },
    head: {
      'lib/src/models/invoice.spy.yaml': '### An invoice.\n' + invoice('  amount: int\n  currency: String\n'),
      'lib/src/models/receipt.spy.yaml': null as unknown as string,
      'lib/src/generated/invoice.dart': generated('Invoice', ['int amount', 'String currency']),
      'lib/src/generated/receipt.dart': null as unknown as string,
      'lib/src/generated/protocol.dart': "const models = [\n  'Invoice',\n];\n",
      'lib/app.dart': "import 'src/generated/invoice.dart';\n\nint amountOf(Invoice invoice) => invoice.amount;\n\nString currencyOf(Invoice invoice) => invoice.currency;\n",
      'migrations/20240201000000/migration.json': JSON.stringify({ actions: [{ type: 'alterTable', alterTable: { name: 'invoices' } }], warnings: [{ type: 'columnAdded', message: 'Column "currency" has no default.', table: 'invoices', columns: ['currency'] }] }),
      'migrations/20240201000000/migration.sql': 'BEGIN;\n\n--\n-- ACTION ALTER TABLE\n--\nALTER TABLE "invoices" ADD COLUMN "currency" text NOT NULL;\n\n--\n-- MIGRATION VERSION FOR sample\n--\nINSERT INTO "serverpod_migrations" VALUES (1);\n\nCOMMIT;\n',
      'test/sample_test_server/lib/src/models/thing.spy.yaml': 'class: Thing\nfields:\n  name: String\n  scopeId: int\n',
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;
    let models: ModelItem[] = [];

    before(async () => {
      review = await buildDartReview(files);
      models = (review.data.model.compares.base.models || []) as ModelItem[];
    });

    after(() => review?.remove());

    it('then the models come by package, the test package’s last.', () => {
      assert.deepEqual(models.map((m) => `${m.name} ${m.st} ${m.pkg || '.'} ${m.rel}${m.test ? ' test' : ''}`), ['Invoice M . models/invoice.spy.yaml', 'Receipt D . models/receipt.spy.yaml', 'Thing M test/sample_test_server models/thing.spy.yaml test']);
    });

    it('then the changed model warns on its new required field, and of what Serverpod wrote for its table.', () => {
      assert.deepEqual(models[0].warns, [{ k: 'required', cls: 'Invoice', fields: ['currency'], side: 'RIGHT', line: 6 }, { k: 'serverpod', text: 'Column "currency" has no default.' }]);
    });

    it('then it links its generated file and its migration’s statements for its table.', () => {
      assert.deepEqual(models[0].gen, [{ p: 'lib/src/generated/invoice.dart' }]);
      assert.deepEqual(models[0].mig, { v: '20240201000000', p: 'migrations/20240201000000/migration.sql', start: 3, end: 6, hits: [6] });
    });

    it('then it links the changed code that uses its new field.', () => {
      assert.deepEqual(models[0].used?.map((u) => `${u.p} ${u.m}`), ['lib/app.dart currencyOf']);
    });

    it('then the removed model warns, with its generated file gone and the protocol lines that named it.', () => {
      assert.deepEqual(models[1].warns, [{ k: 'removed', cls: 'Receipt' }]);
      assert.deepEqual(models[1].gen, [{ p: 'lib/src/generated/receipt.dart', gone: true }, { p: 'lib/src/generated/protocol.dart', only: true }]);
    });

    it('then the test model says what changed, and warns of nothing.', () => {
      assert.equal(models[2].sum, '+ scopeId');
      assert.deepEqual(models[2].warns, []);
    });
  });
});
