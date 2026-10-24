// The Serverpod models a review changes, for the page's Models view. Each model is read on both
// sides, field by field, for what can break (warnings anchored on the line they're about) and for
// a folded model's summary; the page shows its diff. It links to its generated files, to its
// migration's statements for its table, and to the code that uses it. Models in test packages
// come apart, with no warnings.
import '../viewer/core.js';

const C = globalThis.ReviewCore;
export const MODEL_FILE = /\.spy(\.ya?ml)?$/;
// A test package's folder, or a package whose name has test as a word.
const TEST_DIR = /^(test|tests|test_[a-z0-9_]+|integration_test)$/;
const TEST_WORD = /(^|_)test(_|$)/;
const MIGRATION = /(^|\/)migrations\/([^/]+)\/migration\.json$/;

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');

/** A field's definition split at its top-level commas: Map<String, int> and relation(a, b) stay whole. */
export function splitTop(def) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of def) {
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if ('<([{'.includes(ch)) depth++;
    else if ('>)]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ',' && !depth) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const typeOf = (def) => splitTop(def)[0] || '';
// Data from before a change that lacks a field won't deserialize unless the model has a default
// for it: a nullable type, or default (or defaultModel) on its side. defaultPersist only fills the
// table.
const wireRequired = (def) => { const [type, ...mods] = splitTop(def); return !type.endsWith('?') && !mods.some((m) => /^(default|defaultModel)\s*=/.test(m)); };
const persisted = (def) => !splitTop(def).slice(1).some((m) => /^!persist$/.test(m));

/**
 * A model, read line by line so its ### doc comments stay with what they document: its kind and
 * name, top-level keys, fields, indexes and enum values, each with its line. Null for no file.
 */
export function parseModel(text) {
  if (text == null) return null;
  const m = { kind: 'class', name: null, line: 0, doc: [], keys: new Map(), fields: new Map(), indexes: new Map(), values: [] };
  let doc = [], block = null, level = null, index = null;
  text.split('\n').forEach((raw, i) => {
    const line = i + 1, t = raw.replace(/\s+$/, '');
    if (!t.trim()) return;
    const d = /^\s*###\s?(.*)$/.exec(t);
    if (d) { doc.push(d[1]); return; }
    if (/^\s*#/.test(t)) return;
    const top = /^([A-Za-z_]\w*):\s*(.*)$/.exec(t);
    if (top) {
      const [, k, v] = top;
      if ((k === 'class' || k === 'exception' || k === 'enum') && !m.name) Object.assign(m, { kind: k, name: unquote(v.trim()), line, doc });
      else if (k !== 'fields' && k !== 'indexes' && k !== 'values') m.keys.set(k, { v: unquote(v.trim()), line });
      doc = [];
      block = k === 'fields' || k === 'indexes' || k === 'values' ? k : null;
      level = null;
      return;
    }
    if (!block) return;
    const indent = /^\s*/.exec(t)[0].length;
    if (level == null) level = indent;
    if (block === 'values') {
      const v = /^\s*-\s*([A-Za-z_]\w*)/.exec(t);
      if (v && indent === level) { m.values.push({ name: v[1], line, doc }); doc = []; }
      return;
    }
    const kv = /^\s*([A-Za-z_]\w*):\s*(.*)$/.exec(t);
    if (!kv) return;
    if (indent === level) {
      if (block === 'fields') m.fields.set(kv[1], { def: kv[2].trim(), line, doc });
      else { index = { props: {}, line }; m.indexes.set(kv[1], index); }
      doc = [];
    } else if (block === 'indexes' && index) index.props[kv[1]] = unquote(kv[2].trim());
  });
  return m;
}

const docOf = (x) => (x ? x.doc.join('\n') : '');
const indexText = (name, ix) => `${name} (${(ix.props.fields || '').split(',').map((s) => s.trim()).filter(Boolean).join(', ')})`;
const indexWord = (ix) => (ix.props.unique === 'true' ? 'unique index' : 'index');

/**
 * What changed between two sides of a model (null for none: added or removed), as rows the
 * summaries read ({ s: add | del | chg | doc, f, t, o }), and the warnings, each a template's key
 * and the names it's filled in with, on the line it's about ({ side: RIGHT | LEFT, line }) or on
 * the whole model. A test model gets none.
 */
export function compareModels(o, n, { test = false } = {}) {
  const rows = [], warns = [];
  const cls = (n || o).name;
  if (!n) {
    if (!test) warns.push({ k: 'removed', cls });
    return { rows, warns };
  }
  const fresh = !o;
  o = o || parseModel('');
  if (!fresh && docOf(o) !== docOf(n)) rows.push({ s: 'doc', f: 'doc' });
  if (!fresh) {
    for (const k of new Set([...n.keys.keys(), ...o.keys.keys()])) {
      const a = o.keys.get(k), b = n.keys.get(k);
      if ((a && a.v) !== (b && b.v)) rows.push({ s: a ? (b ? 'chg' : 'del') : 'add', f: k, o: a ? a.v : undefined, t: b ? b.v : undefined });
    }
  }
  const required = [];
  for (const [f, d] of n.fields) {
    const was = o.fields.get(f);
    if (!was) {
      rows.push({ s: 'add', f, t: d.def });
      if (!fresh && !test && wireRequired(d.def)) required.push([f, d.line]);
    } else if (was.def !== d.def) {
      rows.push({ s: 'chg', f, o: was.def, t: d.def });
      // A type that only became nullable still reads what was written before.
      const from = typeOf(was.def), to = typeOf(d.def);
      if (!test && from !== to && to !== from + '?') warns.push({ k: 'retyped', cls, from, to, side: 'RIGHT', line: d.line });
    } else if (docOf(was) !== docOf(d)) rows.push({ s: 'chg', f, doc: true });
  }
  for (const [f, d] of o.fields) {
    if (n.fields.has(f)) continue;
    rows.push({ s: 'del', f, t: d.def });
    if (!test && wireRequired(d.def)) warns.push({ k: 'field-removed', cls, field: f, side: 'LEFT', line: d.line });
  }
  if (required.length) warns.push({ k: 'required', cls, fields: required.map(([f]) => f), side: 'RIGHT', line: required[required.length - 1][1] });
  for (const [name, ix] of n.indexes) {
    const was = o.indexes.get(name);
    if (!was) rows.push({ s: 'add', f: indexWord(ix), t: indexText(name, ix) });
    else if (JSON.stringify(was.props) !== JSON.stringify(ix.props)) rows.push({ s: 'chg', f: indexWord(ix), o: indexText(name, was), t: indexText(name, ix) });
  }
  for (const [name, ix] of o.indexes) if (!n.indexes.has(name)) rows.push({ s: 'del', f: indexWord(ix), t: indexText(name, ix) });
  const before = o.values.map((v) => v.name), after = n.values.map((v) => v.name);
  if (before.join() !== after.join()) {
    const added = after.filter((v) => !before.includes(v)), gone = before.filter((v) => !after.includes(v));
    if (added.length) rows.push({ s: 'add', f: 'values', t: added.join(', ') });
    if (gone.length) rows.push({ s: 'del', f: 'values', t: gone.join(', ') });
    // By index, a value means its place: one removed, put in between or moved shifts the values
    // after it. Values added at the end shift none.
    const i = before.findIndex((v, k) => after[k] !== v);
    if (!fresh && !test && i >= 0 && (n.keys.get('serialized') || {}).v !== 'byName') {
      const at = !after.includes(before[i]) ? { v: before[i], side: 'LEFT', line: o.values[i].line }
        : after[i] && !before.includes(after[i]) ? { v: after[i], side: 'RIGHT', line: n.values[i].line }
          : { v: before[i], side: 'RIGHT', line: n.values[after.indexOf(before[i])].line };
      warns.push({ k: 'enum-order', cls, value: at.v, side: at.side, line: at.line });
    }
  }
  return { rows, warns };
}

/** What a folded model's line says changed: "~ doc, + spaces", "new · + batchId", "removed". */
export function summary(rows, status) {
  if (status === 'D') return 'removed';
  const sign = { add: '+', del: '−', chg: '~', doc: '~' };
  const parts = rows.map((r) => `${sign[r.s]} ${r.f}`);
  const s = parts.slice(0, 4).join(', ') + (parts.length > 4 ? `, and ${parts.length - 4} more` : '');
  return status === 'A' ? (s ? `new · ${s}` : 'new') : s;
}

/** Whether a change reaches the model's table: its name, a stored field, an index, or the model itself. */
function tableChanged(o, n) {
  if (!o || !n) return true;
  if ((o.keys.get('table') || {}).v !== (n.keys.get('table') || {}).v) return true;
  const ix = (m) => JSON.stringify([...m.indexes].map(([k, v]) => [k, v.props]));
  if (ix(o) !== ix(n)) return true;
  const stored = (m) => JSON.stringify([...m.fields].filter(([, d]) => persisted(d.def)).map(([f, d]) => [f, d.def]));
  return stored(o) !== stored(n);
}

/**
 * A migration's statements for a table, as Serverpod writes migration.sql: from the "-- ACTION"
 * header that names it to the next header, with the lines that name a column the model adds.
 */
export function migrationAction(sql, table, added = []) {
  const lines = sql.split('\n');
  const heads = [];
  for (let i = 1; i < lines.length; i++) if (/^-- [A-Z]/.test(lines[i]) && lines[i - 1] === '--') heads.push(i);
  for (let k = 0; k < heads.length; k++) {
    if (!lines[heads[k]].startsWith('-- ACTION')) continue;
    const start = heads[k] - 1;
    let end = k + 1 < heads.length ? heads[k + 1] - 1 : lines.length;
    if (!lines.slice(start, end).some((l) => l.includes(`"${table}"`))) continue;
    while (end > start && !lines[end - 1].trim()) end--;
    const hits = [];
    for (let i = start; i < end; i++) if (added.some((c) => lines[i].includes(`"${c}"`))) hits.push(i + 1);
    return { start: start + 1, end, hits };
  }
  return null;
}

/**
 * Test models: under a folder named test, tests, test_* or integration_test, in a package whose
 * folder has test as a word in its name, or under a folder .review.yaml's tests names.
 */
export function isTestModel(file, pkg, extra = []) {
  const dirs = file.split('/').slice(0, -1);
  if (dirs.some((d) => TEST_DIR.test(d))) return true;
  if (TEST_WORD.test(pkg.split('/').pop() || '')) return true;
  return extra.some((glob) => C.globToRegExp(glob).test(file) || C.globToRegExp(glob.replace(/\/?$/, '/**')).test(file));
}

/**
 * The models a comparison changes, for the page. files: its reviewed files, with both sides' text;
 * generated: its generated files; show(side, path): a file at 'left' or 'right'; grep(side,
 * pattern, pathspecs): the matching lines, as { p, text }; repoPaths: the head's paths; review:
 * .review.yaml; usersOf(path): the changed code that uses the model, as { p, l, m, test };
 * index(file): the file's place in the page's list.
 */
export function readModels({ files, generated, show, grep, repoPaths, review, usersOf, index }) {
  const changed = files.filter((f) => MODEL_FILE.test(f.p));
  if (!changed.length) return [];
  const have = new Set(repoPaths);
  const packageOf = (p) => {
    for (let dir = p.slice(0, p.lastIndexOf('/')); dir; dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')))) if (have.has(dir + '/pubspec.yaml')) return dir;
    return have.has('pubspec.yaml') ? '' : p.includes('/lib/') ? p.slice(0, p.indexOf('/lib/')) : '';
  };
  const extra = Array.isArray(review && review.tests) ? review.tests.filter((g) => typeof g === 'string') : [];

  // Which generated files declare which classes, on each side: a model's own generated files, and
  // whether they still declare a model that's gone.
  const DECL = '^((abstract|sealed|final|base|interface) )*(class|enum) [A-Z][A-Za-z0-9_]*';
  // A generated folder's files are all searched; other generated files (.gitattributes says) by name.
  const loose = (g) => !/(^|\/)generated\//.test(g.p);
  const genPaths = { left: generated.filter((g) => g.s === 'D' && loose(g)).map((g) => g.p), right: generated.filter((g) => g.s !== 'D' && loose(g)).map((g) => g.p) };
  const declares = { left: new Map(), right: new Map() };
  for (const side of ['left', 'right']) {
    for (const { p, text } of grep(side, DECL, [':(glob)**/generated/**', ...genPaths[side]])) {
      const name = /(?:class|enum) ([A-Za-z0-9_]+)/.exec(text);
      if (!name) continue;
      if (!declares[side].has(name[1])) declares[side].set(name[1], new Set());
      declares[side].get(name[1]).add(p);
    }
  }
  const genChanged = new Map(generated.map((g) => [g.p, g]));

  // The migrations this review adds, by Serverpod's migration.json: the tables each changes, and
  // the warnings Serverpod wrote.
  const migrations = generated.filter((g) => g.s === 'A' && MIGRATION.test(g.p)).flatMap((g) => {
    try {
      const json = JSON.parse(show('right', g.p) || '');
      const dir = g.p.slice(0, g.p.lastIndexOf('/'));
      const tables = new Set((json.actions || []).map((a) => { const x = a && a[a.type]; return typeof x === 'string' ? x : x && x.name; }).filter(Boolean));
      return [{ dir, v: dir.slice(dir.lastIndexOf('/') + 1), pkg: packageOf(g.p), sql: dir + '/migration.sql', tables, warnings: Array.isArray(json.warnings) ? json.warnings : [] }];
    } catch {
      return [];
    }
  }).sort((a, b) => Number(isTestModel(a.dir + '/x', a.pkg)) - Number(isTestModel(b.dir + '/x', b.pkg)) || (a.dir < b.dir ? -1 : 1));
  const keepsMigrations = repoPaths.some((p) => MIGRATION.test(p));

  const out = [];
  for (const f of changed) {
    const o = parseModel(f.oldSrc), n = parseModel(f.newSrc), m = n || o;
    if (!m || !m.name) continue;
    const pkg = packageOf(f.p);
    const test = isTestModel(f.p, pkg, extra);
    const { rows, warns } = compareModels(o, n, { test });
    const cls = m.name;
    // Two packages can each have a model of a name: its own package's files, when it has any.
    const near = (paths) => { const mine = paths.filter((p) => !pkg || p.startsWith(pkg + '/')); return mine.length ? mine : paths; };
    const item = { f: index(f), name: cls, type: m.kind, st: f.s, pkg, rel: f.p.slice(pkg ? pkg.length + 1 : 0).replace(/^lib\/(src\/)?/, ''), test, sum: summary(rows, f.s), rows, warns };
    const table = ((n && n.keys.get('table')) || (o && o.keys.get('table')) || {}).v;
    if (table) item.table = table;
    if (m.kind === 'enum') item.en = (m.keys.get('serialized') || {}).v === 'byName' ? 'byName' : 'byIndex';
    if (f.s !== 'M' && m.keys.get('extends')) item.ext = m.keys.get('extends').v;

    // Its generated files: those that declare its class, then a protocol.dart whose changed lines
    // name it (the page shows those hunks alone).
    const own = new Set(near([...(declares.right.get(cls) || [])].concat([...(declares.left.get(cls) || [])].filter((p) => genChanged.get(p)?.s === 'D'))));
    const gen = [...own].filter((p) => genChanged.has(p)).sort().map((p) => (genChanged.get(p).s === 'D' ? { p, gone: true } : { p }));
    const word = new RegExp(`\\b${cls}\\b`);
    const naming = generated.filter((g) => !own.has(g.p) && /(^|\/)protocol\.dart$/.test(g.p) && g.hunks && g.hunks.some((h) => h.l.some((l) => l[0] !== ' ' && word.test(l))));
    near(naming.map((g) => g.p)).forEach((p) => gen.push({ p, only: true }));
    if (gen.length) item.gen = gen;
    if (!test) {
      const stillDeclared = near([...(declares.right.get(cls) || [])]);
      const keepsGenerated = have.has((pkg ? pkg + '/' : '') + 'lib/src/generated/protocol.dart');
      const stale = f.s === 'D' ? stillDeclared.length > 0 : f.s === 'A' ? keepsGenerated && !stillDeclared.length : stillDeclared.length > 0 && !stillDeclared.some((p) => genChanged.has(p));
      if (stale) warns.push({ k: 'not-regenerated', cls });
    }

    if (table) {
      const named = migrations.filter((x) => x.tables.has(table));
      if (named.length) {
        const first = named[0];
        const added = n ? [...n.fields.keys()].filter((x) => !o || !o.fields.has(x)) : [];
        const at = migrationAction(show('right', first.sql) || '', table, added);
        item.mig = { v: first.v, p: first.sql, ...(at || {}) };
        if (named.length > 1) item.mig.more = named.slice(1).map((x) => x.pkg);
        if (!test) {
          const said = new Set();
          for (const x of named) for (const w of x.warnings) if (w && w.table === table && w.message && !said.has(w.message)) { said.add(w.message); warns.push({ k: 'serverpod', text: String(w.message) }); }
        }
      } else if (!test && keepsMigrations && tableChanged(o, n)) warns.push({ k: 'no-migration', table });
    }
    const used = usersOf(f.p);
    if (used.length) item.used = used;
    out.push(item);
  }
  // By package, then by file, as in the Files tab.
  return out.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
