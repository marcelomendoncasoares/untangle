// The analysis pass. Deterministic: the same commits, grammar and analyzer facts always
// produce the same model. Ported from docs/prototype/analyze.js, with the same rules.
//
// 1. Edits: tokens of each change block are diffed (core.js). For Dart, tree-sitter names
//    each run of changed tokens: one token replaced by another ("spaceId → userId in
//    label"), or whole syntax nodes inserted, removed or replaced. Runs whose syntax nodes
//    overlap are one edit; a run of punctuation only joins an edit of its statement.
// 2. Same change: edits with the same tree-sitter description form a group. Punctuation
//    alone never does.
// 3. Chains: changes linked by the language server (a changed line uses something declared
//    on another changed line). Parameters and locals carry a chain across changes;
//    functions, methods, fields and types start their own chain.
// 4. With the review's provenance (which commit started each changed line), chains follow the
//    commits instead (commits.js): one chain per commit and its follow-ups, however large.
//    Renames keep their own chains.
import '../viewer/core.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { ADAPTERS } from './adapters.js';
import { dartOpenings, dartParser } from './dart.js';
import { readingUnits, testCall } from './units.js';
import { testOutline } from './outline.js';
import { assembleIntroducedChains } from './chains.js';
import { commitFamilies, subjectParts } from './commits.js';
import { CALLABLE_KINDS, TYPE_KINDS, declarationAt, indexOf, memberAt as resolvedMemberAt, memberName } from './structure.js';

const C = globalThis.ReviewCore;
// ---------- generated code
// Generated files are set aside: listed, peekable, never reviewed. A usage that resolves into
// generated code links to the change of what it was generated from. Each generator has an
// adapter that switches on by what the repository contains; .review.yaml at the root can add
// generated patterns, turn an adapter on or off, or declare a YAML-model mapping of its own.
const PEEK_MAX_LINES = 2000;
const compileMapping = (name, m) => ({ name, kind: m.kind || 'yaml', generated: [].concat(m.generated || []).map(C.globToRegExp), source: [].concat(m.source || []).map(C.globToRegExp), classSuffixes: m.classSuffixes ? new RegExp('(' + m.classSuffixes + ')$') : null, fields: new Map() });

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const CODE_KINDS = new Set(['id', 'ty', 'kw', 'num', 'ann', 'key']);
const SIGNATURES = new Set(['method_signature', 'function_signature', 'getter_signature', 'setter_signature', 'constructor_signature', 'factory_constructor_signature', 'operator_signature', 'redirecting_factory_constructor_signature', 'constant_constructor_signature']);
const TYPES = new Set(['class_definition', 'mixin_declaration', 'extension_declaration', 'enum_declaration', 'extension_type_declaration']);
const BODIES = new Set(['class_body', 'extension_body', 'enum_body']);
// A test file: *_test.dart, or anything under a test/, test_*/ or integration_test/ directory.
const TEST_FILE = /(^|\/)(test|test_[a-z0-9_]+|integration_test)\/|_test\.dart$/;

// repo: the git repository. headDir: the head checkout. diff: the exported diff. defsRaw: where
// each identifier on the head side is defined ("path:line:col" -> [file, line0, col0]). old: per
// comparison, the old side's checkout and its definitions. calls: outgoing calls reachable from
// what changed tests call. supers: what each changed declaration overrides.
export async function analyze({ repo, headDir, diff, defsRaw, old: oldSides = {}, structure = null, calls = null, supers = null, provenance = null, log = () => {} }) {
  const REPO = repo;
  const HEAD = path.resolve(headDir) + '/';
  const CALLS = calls;
  const SUPERS = supers;
  const PROVENANCE = provenance;
  const OLD = Object.fromEntries(Object.entries(oldSides).map(([name, o]) => [name, { dir: path.resolve(o.dir) + '/', raw: o.raw, structure: o.structure }]));
  const gitShow = (rev, p) => { try { return execFileSync('git', ['-C', REPO, 'show', `${rev}:${p}`], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  const parser = await dartParser();
  const trees = new Set();
  const parse = (src) => {
    if (src == null) return null;
    const tree = parser.parse(src);
    trees.add(tree);
    return tree;
  };
  const out = { compares: {} };
  const structures = new WeakMap();

  // ---------- tree-sitter helpers
  const pos = (line, col) => ({ row: line - 1, column: col });
  function spanNode(tree, a, b) { return tree.rootNode.descendantForPosition(a, b); }
  // The smallest run of complete sibling nodes that covers [a, b].
  const cmpPos = (p, q) => (p.row - q.row) || (p.column - q.column);
  function completeRegion(tree, src, a, b) {
    const lca = spanNode(tree, a, b);
    if (lca.childCount === 0 || (cmpPos(a, lca.startPosition) <= 0 && cmpPos(lca.endPosition, b) <= 0)) {
      return { parentType: lca.parent ? lca.parent.type : 'program', type: lca.type, start: lca.startPosition, end: lca.endPosition, text: src.slice(lca.startIndex, lca.endIndex) };
    }
    // Children of the common ancestor that overlap [a, b]: complete nodes only.
    const kids = [];
    for (let i = 0; i < lca.childCount; i++) {
      const k = lca.child(i);
      if (cmpPos(k.endPosition, a) > 0 && cmpPos(k.startPosition, b) < 0) kids.push(k);
    }
    if (!kids.length) return { parentType: lca.parent ? lca.parent.type : 'program', type: lca.type, start: lca.startPosition, end: lca.endPosition, text: src.slice(lca.startIndex, lca.endIndex) };
    return { parentType: lca.type, type: kids.map((k) => k.type).join('+'), start: kids[0].startPosition, end: kids[kids.length - 1].endPosition, text: src.slice(kids[0].startIndex, kids[kids.length - 1].endIndex) };
  }
  // The innermost statement or declaration around a region, or null outside of one.
  const STATEMENTS = new Set(['expression_statement', 'assert_statement', 'switch_statement_case', 'switch_statement_default', 'do_statement', 'break_statement', 'continue_statement', 'yield_statement', 'yield_each_statement', 'return_statement', 'try_statement', 'if_statement', 'while_statement', 'for_statement', 'local_variable_declaration', 'pattern_variable_declaration', 'local_function_declaration', 'import_or_export', 'part_directive', 'part_of_directive', 'annotation', 'declaration', 'static_final_declaration', 'initializer_list_entry', 'enum_constant', 'comment', 'documentation_comment', ...SIGNATURES]);
  const STATEMENT_STOP = new Set(['function_body', 'class_body', 'block', 'program', 'enum_body', 'extension_body']);
  function statementOf(tree, r) {
    if (!tree || !r) return null;
    for (let n = tree.rootNode.descendantForPosition(r.start, r.end); n; n = n.parent) {
      if (STATEMENTS.has(n.type)) return n.startIndex + '-' + n.endIndex;
      if (STATEMENT_STOP.has(n.type)) return null;
    }
    return null;
  }
  // Declaration units: each top-level declaration (consecutive directives count as one), each
  // member of a class, mixin, extension or enum, and each test(...)/group(...) call. A unit
  // starts at its doc comments and annotations. Change blocks are split where a unit starts.
  const TEST_CALLS = /^(test|group|setUp|setUpAll|tearDown|tearDownAll|testWidgets)\s*\(/;
  // In a test file, a call whose first argument is a string and which holds tests (Serverpod's
  // withServerpod, say) is a group by another name, so it starts a unit too.
  const LABELLED = /^[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(\s*r?['"]/, HOLDS_TESTS = /\b(test|testWidgets|group)\s*\(/;
  const isLead = (n) => n.type === 'comment' || n.type === 'documentation_comment' || n.type === 'annotation' || n.type === 'marker_annotation';
  const isDirective = (n) => /directive|import_or_export|library_name/.test(n.type);
  function unitStart(n) {
    let start = n.startPosition.row;
    for (let p = n.previousSibling; p && isLead(p) && p.endPosition.row >= start - 1; p = p.previousSibling) start = p.startPosition.row;
    return start + 1;
  }
  function unitStarts(tree, tests) {
    const out = new Set();
    if (!tree) return out;
    const visit = (n) => {
      const container = n.type === 'program' || n.type === 'class_body' || n.type === 'extension_body' || n.type === 'enum_body' || n.type === 'block';
      let prevDirective = false, prevEnd = -2;
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        let unit = false;
        if (n.type === 'program') {
          if (isDirective(c)) { unit = !prevDirective; prevDirective = true; }
          else if (!isLead(c) && c.type !== ';' && c.type !== 'function_body') { unit = true; prevDirective = false; }
        } else if (n.type === 'class_body' || n.type === 'extension_body' || n.type === 'enum_body') {
          unit = c.type === 'declaration' || SIGNATURES.has(c.type) || c.type === 'enum_constant';
        } else if (n.type === 'block') {
          unit = c.type === 'expression_statement' && (TEST_CALLS.test(c.text) || (tests && LABELLED.test(c.text) && HOLDS_TESTS.test(c.text)));
        }
        if (unit) {
          // A member written right under the previous one, with no blank line, doc comment or
          // annotation between them, stays in the same unit (a run of fields, say).
          const start = unitStart(c);
          const lead = start !== c.startPosition.row + 1;
          if (lead || c.startPosition.row > prevEnd + 1 || n.type === 'program' && isDirective(c)) out.add(start);
        }
        if (container && !isLead(c) && c.type !== '{' && c.type !== '}') prevEnd = c.endPosition.row;
        if (c.childCount && c.type !== 'string_literal') visit(c);
      }
    };
    visit(tree.rootNode);
    return out;
  }
  // Where a change block splits. Pure additions split where a new-side unit starts, pure
  // deletions where an old-side unit starts. A mixed block keeps its removed lines with the
  // added lines they were diffed against, and only splits the added lines after them. Blank lines
  // are never a change of their own: blank lines before the first unit go with it.
  function splitPoints(b, newStarts, oldStarts) {
    const cuts = [];
    if (!b.dels && newStarts) b.rows.forEach((r, i) => { if (i && newStarts.has(r.n)) cuts.push(i); });
    else if (!b.adds && oldStarts) b.rows.forEach((r, i) => { if (i && oldStarts.has(r.o)) cuts.push(i); });
    else if (newStarts) {
      let last = -1;
      b.rows.forEach((r, i) => { if (r.type === '-' || (r.toks && r.toks.some((tk) => tk.peer))) last = i; });
      b.rows.forEach((r, i) => { if (i > last && r.type === '+' && newStarts.has(r.n)) cuts.push(i); });
    }
    const blank = (from, to) => b.rows.slice(from, to).every((r) => !r.text.trim());
    const out = [];
    let start = 0;
    for (const cut of cuts) {
      if (blank(start, cut)) continue;
      out.push(cut);
      start = cut;
    }
    if (out.length && blank(out[out.length - 1], b.rows.length)) out.pop();
    return out;
  }
  function nameOf(sig) {
    const byField = sig.childForFieldName && sig.childForFieldName('name');
    if (byField) return byField.text;
    for (let i = 0; i < sig.namedChildCount; i++) {
      const c = sig.namedChild(i);
      if (c.type === 'identifier') return c.text;
      if (SIGNATURES.has(c.type)) return nameOf(c);
    }
    const m = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(?:<[^>]*>)?\s*\(/.exec(sig.text);
    return m ? m[1] : sig.text.split('\n')[0].slice(0, 40);
  }
  function memberAt(tree, line, text) {
    if (!tree) return null;
    if (structures.has(tree)) return resolvedMemberAt(structures.get(tree), line, Math.max(0, text.search(/\S/)));
    const col = Math.max(0, text.search(/\S/));
    let n = tree.rootNode.descendantForPosition(pos(line, col));
    let member = null, owner = null, test = null, group = null, testKey = null;
    for (let a = n; a; a = a.parent) {
      if (!member && a.type === 'function_body') {
        const s = a.previousNamedSibling;
        if (s && SIGNATURES.has(s.type)) member = nameOf(s);
      }
      if (!member && SIGNATURES.has(a.type)) member = nameOf(a);
      if (!member && (a.type === 'declaration' || a.type === 'static_final_declaration' || a.type === 'initialized_identifier') && a.parent && (BODIES.has(a.parent.type) || a.parent.type === 'program' || a.parent.type === 'static_final_declaration_list' || a.parent.type === 'initialized_identifier_list')) {
        // The declared name, not the first identifier of its type annotation.
        const ii = a.descendantsOfType('initialized_identifier')[0] || a.descendantsOfType('identifier_list')[0];
        const id = ii && ii.child(0) && ii.child(0).type === 'identifier' ? ii.child(0) : a.descendantsOfType('identifier')[0];
        if (id) member = id.text;
      }
      if (a.type === 'expression_statement' && (!test || !group)) {
        const call = testCall(a);
        if (call && call.kind !== 'group' && !test) {
          test = call.title;
          testKey = call.key;
        }
        if (call && call.kind === 'group' && !group) group = call.title;
      }
      if (!owner && TYPES.has(a.type)) { const nm = a.childForFieldName('name') || a.namedChildren.find((x) => x.type === 'identifier'); owner = nm ? nm.text : null; }
    }
    return { member: member ? (owner && !member.includes('.') ? owner + '.' + member : member) : owner || null, test, group, testKey };
  }
  // Role of a replaced token: a declaration name (the language server resolves it to
  // itself), a named-argument label, a type, or a reference.
  function roleOf(f, d) {
    const t = defsRaw[`${f.p}:${d.row.n}:${d.tk.c}`];
    if (t && t[0] === HEAD + f.p && t[1] === d.row.n - 1 && t[2] === d.tk.c) return 'declaration';
    const node = spanNode(f.newTree, pos(d.row.n, d.tk.c), pos(d.row.n, d.tk.c + d.tk.t.length));
    if (node.parent && node.parent.type === 'label') return 'named argument';
    if (d.tk.k === 'ty') return 'type';
    if (d.tk.k === 'kw') return 'keyword';
    return 'reference';
  }
  function declKind(tree, line, col) {
    if (!tree) return 'member';
    const declared = structures.has(tree) && declarationAt(structures.get(tree), line, col);
    if (declared) {
      if (TYPE_KINDS.has(declared.kind)) return 'type';
      if (declared.kind === 'PARAMETER') return 'param';
      if (declared.kind === 'LOCAL_VARIABLE') return 'local';
      return 'member';
    }
    let n = tree.rootNode.descendantForPosition(pos(line, col));
    const types = [];
    for (let a = n; a; a = a.parent) types.push(a.type);
    if (types.some((t) => t === 'import_or_export' || t === 'library_import' || t === 'import_specification' || t === 'library_export')) return 'import';
    for (const t of types) {
      if (t === 'formal_parameter' || t === 'formal_parameter_list' || t === 'optional_formal_parameters') return 'param';
      if (t === 'local_variable_declaration' || t === 'for_loop_parts' || t === 'pattern_variable_declaration' || t === 'catch_clause') return 'local';
      if (t === 'function_body' || BODIES.has(t) || t === 'program') break;
    }
    if (types.some((t) => TYPES.has(t)) && !types.some((t) => BODIES.has(t))) return 'type';
    return 'member';
  }

  try {
  for (const [name, cmp] of Object.entries(diff.compares)) {
    const meta = { left: cmp.left, right: cmp.right, label: cmp.label };
    // Adapters on for this head, and what .review.yaml adds.
    const repoPaths = execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '--name-only', meta.right], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 << 20 }).split('\n').filter(Boolean);
    let review = {};
    try { review = YAML.parse(gitShow(meta.right, '.review.yaml') || '') || {}; } catch (e) { log('.review.yaml is not valid YAML: ' + e.message); }
    const adapterOn = Object.fromEntries(Object.entries(ADAPTERS).map(([k, a]) => [k, review.adapters && k in review.adapters ? !!review.adapters[k] : repoPaths.some((p) => a.detect.test(p))]));
    const mappings = Object.entries(ADAPTERS).filter(([k]) => adapterOn[k]).map(([k, a]) => compileMapping(k, a.model))
      .concat((review.models || []).map((m, i) => compileMapping('.review.yaml models[' + i + ']', m)));
    const genRules = Object.entries(ADAPTERS).filter(([k]) => adapterOn[k]).flatMap(([k, a]) => a.generated.map((g) => [C.globToRegExp(g), k + ' adapter']))
      .concat((review.generated || []).map((g) => [C.globToRegExp(g), '.review.yaml']));
    const mappingFor = (rel) => mappings.find((mp) => mp.generated.some((rx) => rx.test(rel)));
    // The repository's own packages, by name, for package: imports. Several pubspecs can share
    // a name (a template's copy, say): an import resolves to the one that has the imported file.
    const packageDirs = new Map();
    repoPaths.filter((p) => /(^|\/)pubspec\.yaml$/.test(p)).forEach((p) => {
      try { const nm = /^name:\s*['"]?([\w]+)/m.exec(fs.readFileSync(HEAD + p, 'utf8')); if (nm) packageDirs.set(nm[1], [...(packageDirs.get(nm[1]) || []), path.dirname(p)]); } catch {}
    });
    const repoPathSet = new Set(repoPaths);
    const packageFile = (pkg, rest) => (packageDirs.get(pkg) || []).map((d) => path.normalize(path.join(d, 'lib', rest))).find((x) => repoPathSet.has(x));
    const files = [], generated = [];
    for (const f0 of cmp.files) {
      const f = JSON.parse(JSON.stringify(f0));
      const byAttr = f.ga === 'true';
      const rule = genRules.find(([rx]) => rx.test(f.p));
      if (byAttr || rule) {
        f.gen = byAttr ? '.gitattributes' : rule[1];
        if ((f.a + f.d) <= PEEK_MAX_LINES) {
          const text = execFileSync('git', ['-C', REPO, 'diff', '--no-renames', '-U3', meta.left, meta.right, '--', f.p], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
          f.hunks = [];
          let cur = null;
          for (const line of text.split('\n')) {
            const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
            if (m) { cur = { o: +m[1], n: +m[2], h: m[3].trim(), l: [] }; f.hunks.push(cur); } else if (cur && /^[ +-]/.test(line)) cur.l.push(line);
          }
        }
        generated.push(f);
        continue;
      }
      f.oldSrc = f.s !== 'A' ? gitShow(meta.left, f.p) : null;
      f.newSrc = f.s !== 'D' ? gitShow(meta.right, f.p) : null;
      if (C.langOf(f.p) === 'dart') {
        f.oldTree = parse(f.oldSrc);
        f.newTree = parse(f.newSrc);
        f.structure = structure?.[f.p];
        f.oldStructure = OLD[name]?.structure?.[f.p];
        if (f.structure && f.newTree) structures.set(f.newTree, f.structure);
        if (f.oldStructure && f.oldTree) structures.set(f.oldTree, f.oldStructure);
      }
      const tests = TEST_FILE.test(f.p);
      const newStarts = f.newTree ? unitStarts(f.newTree, tests) : null, oldStarts = f.oldTree ? unitStarts(f.oldTree, tests) : null;
      C.analyzeFile(f, { split: (b) => splitPoints(b, newStarts, oldStarts) });
      files.push(f);
    }

    // ---------- moved declarations
    // A removed declaration unit and an added one with the same full name and kind, or the same
    // short name with at least half their tokens alike, are one moved declaration. Its review is the diff between the two
    // bodies, carried by the added copy; the removed copy points at it.
    const MOVE_SIMILARITY = 0.5;
    const codeLine = (r) => { const t = r.text.trim(); return t && !/^(\/\/|\/\*|\*|@)/.test(t); };
    function unitOf(f, b, side) {
      const tree = side === 'n' ? f.newTree : f.oldTree;
      const r = tree && b.rows.find(codeLine);
      if (!r) return null;
      const line = side === 'n' ? r.n : r.o;
      for (let n = tree.rootNode.descendantForPosition(pos(line, r.text.search(/\S/))); n && n.type !== 'program'; n = n.parent) {
        if (n.startPosition.row !== line - 1) continue;
        if (TYPES.has(n.type)) { const nm = n.childForFieldName('name'); return nm ? { name: nm.text, short: nm.text, kind: 'type' } : null; }
        if (SIGNATURES.has(n.type) || (n.type === 'declaration' && n.parent && BODIES.has(n.parent.type))) {
          const at = memberAt(tree, line, r.text);
          return at && at.member ? { name: at.member, short: at.member.split('.').pop(), kind: 'member' } : null;
        }
        if (n.type === 'expression_statement' && TEST_CALLS.test(n.text)) {
          const m = /^\w+\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(n.text);
          return m ? { name: 'test:' + m[2], short: 'test:' + m[2], kind: 'test' } : null;
        }
      }
      return null;
    }
    const tokCache = new Map();
    const blockToks = (b) => {
      if (!tokCache.has(b)) tokCache.set(b, b.rows.flatMap((r) => r.toks.filter((tk) => tk.k !== 'ws').map((tk) => (tk.k === 'com' || tk.k === 'str' ? tk.k + ':' + tk.t : tk.t))));
      return tokCache.get(b);
    };
    const removedUnits = [], addedUnits = [];
    files.forEach((f) => f.blocks.forEach((b) => {
      if (!b.atoms.length) return;
      if (!b.adds && b.dels) { const u = unitOf(f, b, 'o'); if (u) removedUnits.push({ f, b, u }); }
      else if (!b.dels && b.adds) { const u = unitOf(f, b, 'n'); if (u) addedUnits.push({ f, b, u }); }
    }));
    const movePairs = [];
    removedUnits.forEach((R) => addedUnits.forEach((A) => {
      if (R.u.kind !== A.u.kind || R.u.short !== A.u.short) return;
      const x = blockToks(R.b), y = blockToks(A.b);
      const ops = C.lcsOps(x, y);
      if (!ops) return;
      const sim = (2 * ops.filter((o) => o === 'e').length) / (x.length + y.length);
      // The same full name and kind is the same declaration, whatever happened to its body.
      if (R.u.name === A.u.name || sim >= MOVE_SIMILARITY) movePairs.push({ R, A, rank: sim + (R.u.name === A.u.name ? 1 : 0) });
    }));
    movePairs.sort((p, q) => q.rank - p.rank || (p.A.b.id < q.A.b.id ? -1 : p.A.b.id > q.A.b.id ? 1 : 0));
    const movedR = new Set(), movedA = new Set();
    for (const { R, A } of movePairs) {
      if (movedR.has(R.b) || movedA.has(A.b)) continue;
      movedR.add(R.b); movedA.add(A.b);
      const a = A.b, r = R.b;
      const oldLines = r.rows.map((x) => x.text), newLines = a.rows.map((x) => x.text);
      const ops = C.lcsOps(oldLines.map((t) => t.trim()), newLines.map((t) => t.trim())) || [...oldLines.map(() => 'd'), ...newLines.map(() => 'i')];
      const l = [];
      let x = 0, y = 0;
      ops.forEach((op) => { if (op === 'e') { l.push(' ' + newLines[y]); x++; y++; } else if (op === 'd') l.push('-' + oldLines[x++]); else l.push('+' + newLines[y++]); });
      const syn = C.analyzeFile({ p: A.f.p, hunks: [{ o: r.rows[0].o, n: a.rows[0].n, l }] });
      const rows = syn.hunks[0].rows;
      // Only the tokens the body diff changed count as changed on the real rows.
      [a, r].forEach((blk) => blk.rows.forEach((row) => row.toks.forEach((tk) => { delete tk.atom; delete tk.peer; })));
      const byN = new Map(a.rows.map((row) => [row.n, row])), byO = new Map(r.rows.map((row) => [row.o, row]));
      a.changedNew = new Set(); r.changedOld = new Set();
      rows.forEach((sr) => {
        if (!sr.toks) return;
        const real = sr.type === '-' ? byO.get(sr.o) : byN.get(sr.n);
        if (!real) return;
        (sr.type === '-' ? r.changedOld : a.changedNew).add(sr.type === '-' ? sr.o : sr.n);
        sr.toks.forEach((tk) => { if (tk.atom) { const rt = real.toks.find((t) => t.c === tk.c); if (rt) rt.atom = tk.atom; } });
      });
      a.atoms = syn.blocks.flatMap((sb) => sb.atoms);
      a.atoms.forEach((at) => { at.block = a; });
      a.adds = rows.filter((x2) => x2.type === '+').length;
      a.dels = rows.filter((x2) => x2.type === '-').length;
      a.oldFile = R.f;
      a.move = { from: r, file: R.f, rows };
      r.atoms = []; r.adds = 0; r.dels = 0;
      r.movedTo = { block: a, file: A.f };
    }

    // ---------- edits and their tree-sitter identity
    // Each run of changed tokens is named by tree-sitter. Runs whose syntax regions overlap are
    // one edit, and a run of punctuation only (a bracket, a comma, a quote, an empty `///`) joins
    // an edit of its statement without changing what that edit is.
    const overlaps = (p, q) => p && q && cmpPos(p.start, q.end) < 0 && cmpPos(q.start, p.end) < 0;
    const wordy = (d) => CODE_KINDS.has(d.tk.k) || ((d.tk.k === 'str' || d.tk.k === 'com') && /\w/.test(d.tk.t));
    const sameStatement = (x, y) => (x.stmt.n && x.stmt.n === y.stmt.n) || (x.stmt.o && x.stmt.o === y.stmt.o);
    const spanUnion = (list) => { const xs = list.filter(Boolean); return xs.length ? [Math.min(...xs.map((x) => x[0])), Math.max(...xs.map((x) => x[1]))] : null; };
    const regionUnion = (f, of, list, side) => {
      const rs = list.map((r) => r[side + 'R']).filter(Boolean);
      if (!rs.length) return null;
      let a = rs[0].start, z = rs[0].end;
      rs.forEach((r) => { if (cmpPos(r.start, a) < 0) a = r.start; if (cmpPos(r.end, z) > 0) z = r.end; });
      return side === 'new' ? completeRegion(f.newTree, f.newSrc, a, z) : completeRegion(of.oldTree, of.oldSrc, a, z);
    };
    // The text of a token run as written: per row, from its first to its last token, optionally
    // widened to whole words (up to whitespace) for languages without a grammar.
    const runText = (list, words) => {
      const byRow = new Map();
      list.forEach((d) => { if (!byRow.has(d.row)) byRow.set(d.row, []); byRow.get(d.row).push(d.tk); });
      return [...byRow].map(([row, tks]) => {
        let a = tks[0].c, z = tks[tks.length - 1].c + tks[tks.length - 1].t.length;
        if (words) { while (a > 0 && !/\s/.test(row.text[a - 1])) a--; while (z < row.text.length && !/\s/.test(row.text[z])) z++; }
        return row.text.slice(a, z);
      }).join(' ');
    };
    const edits = [];
    const editOfAtom = new Map();
    for (const f of files) {
      for (const b of f.blocks) {
        const of = b.oldFile || f;
        const runs = [];
        for (const a of b.atoms) {
          const e = { atom: a, commentOnly: a.commentOnly };
          const del = a.del, ins = a.ins;
          const first = (list, side) => pos(side === 'n' ? list[0].row.n : list[0].row.o, list[0].tk.c);
          const last = (list, side) => { const x = list[list.length - 1]; return pos(side === 'n' ? x.row.n : x.row.o, x.tk.c + x.tk.t.length); };
          let oldR = null, newR = null;
          if (f.lang === 'dart') {
            if (ins.length && f.newTree) newR = completeRegion(f.newTree, f.newSrc, first(ins, 'n'), last(ins, 'n'));
            if (del.length && of.oldTree) oldR = completeRegion(of.oldTree, of.oldSrc, first(del, 'o'), last(del, 'o'));
          }
          const oneToken = del.length === 1 && ins.length === 1 && CODE_KINDS.has(del[0].tk.k) && CODE_KINDS.has(ins[0].tk.k);
          if (f.lang === 'dart' && oneToken && newR) {
            e.op = 'token';
            e.where = roleOf(f, ins[0]);
            e.key = `dart|token|${e.where}|${del[0].tk.t}→${ins[0].tk.t}`;
            e.from = del[0].tk.t; e.to = ins[0].tk.t;
          } else if (f.lang === 'dart' && (newR || oldR)) {
            e.op = !del.length ? 'insert' : !ins.length ? 'delete' : 'replace';
            e.where = (newR || oldR).type;
            e.from = oldR ? norm(oldR.text) : ''; e.to = newR ? norm(newR.text) : '';
            e.key = `dart|${e.op}|${e.where}|${e.from}→${e.to}`;
          } else {
            e.op = !del.length ? 'insert' : !ins.length ? 'delete' : 'replace';
            e.where = 'tokens';
            e.from = runText(del, true); e.to = runText(ins, true);
            e.key = `${f.lang}|tokens|${e.from}→${e.to}`;
          }
          // Lines the edit covers, extended to the whole syntax nodes when known.
          const lines = (list, side) => list.map((d) => (side === 'n' ? d.row.n : d.row.o));
          const nl = lines(ins, 'n'), ol = lines(del, 'o');
          e.newSpan = newR ? [newR.start.row + 1, newR.end.row + 1] : nl.length ? [Math.min(...nl), Math.max(...nl)] : null;
          e.oldSpan = oldR ? [oldR.start.row + 1, oldR.end.row + 1] : ol.length ? [Math.min(...ol), Math.max(...ol)] : null;
          e.newR = newR; e.oldR = oldR;
          e.punct = !del.concat(ins).some(wordy);
          e.stmt = { n: statementOf(f.newTree, newR), o: statementOf(of.oldTree, oldR) };
          runs.push(e);
        }
        const up = runs.map((_, i) => i);
        const top = (i) => (up[i] === i ? i : (up[i] = top(up[i])));
        for (let i = 0; i < runs.length; i++) {
          for (let j = i + 1; j < runs.length; j++) {
            const x = runs[i], y = runs[j];
            if (overlaps(x.newR, y.newR) || overlaps(x.oldR, y.oldR) || ((x.punct || y.punct) && sameStatement(x, y))) up[top(i)] = top(j);
          }
        }
        const clusters = new Map();
        runs.forEach((r, i) => { const k = top(i); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(r); });
        b.edits = [];
        clusters.forEach((list) => {
          const named = list.filter((r) => !r.punct);
          const main = named.length ? named : list;
          let e;
          if (main.length === 1) e = { ...main[0] };
          else {
            const keys = [...new Set(main.map((r) => r.key))];
            const nr = regionUnion(f, of, main, 'new'), or = regionUnion(f, of, main, 'old');
            e = { atom: main[0].atom, key: keys.join(' ⊕ '), where: (nr || or).type, from: or ? norm(or.text) : '', to: nr ? norm(nr.text) : '' };
            e.op = main.every((r) => r.op === 'insert') ? 'insert' : main.every((r) => r.op === 'delete') ? 'delete' : 'replace';
          }
          e.id = edits.length; e.block = b;
          e.atoms = list.map((r) => r.atom);
          e.runs = list;
          e.punct = !named.length;
          e.commentOnly = list.every((r) => r.commentOnly);
          e.newSpan = spanUnion(list.map((r) => r.newSpan));
          e.oldSpan = spanUnion(list.map((r) => r.oldSpan));
          e.atoms.forEach((a) => editOfAtom.set(a, e));
          b.edits.push(e);
          edits.push(e);
        });
      }
    }

    // ---------- same change: same key, at least two edits; edits that always occur in the
    // same blocks merge into one group. Punctuation alone is never a same change.
    const byKey = new Map();
    edits.forEach((e) => { if (e.punct) return; if (!byKey.has(e.key)) byKey.set(e.key, []); byKey.get(e.key).push(e); });
    const bySig = new Map();
    byKey.forEach((list, key) => {
      if (list.length < 2) return;
      const sig = list.map((e) => e.block.id).sort().join('|');
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push({ key, edits: list });
    });
    const groups = [];
    bySig.forEach((parts) => {
      parts.sort((x, y) => (x.edits[0].id - y.edits[0].id));
      groups.push({ parts, edits: parts.flatMap((p) => p.edits), count: parts[0].edits.length });
    });
    groups.sort((x, y) => y.count - x.count || (x.parts[0].key < y.parts[0].key ? -1 : 1));
    groups.forEach((g, i) => { g.id = i; g.edits.forEach((e) => { e.group = i; }); g.files = new Set(g.edits.map((e) => e.block.file.p)).size; });

    // ---------- members (enclosing declarations) for every block
    // A block belongs to the member that holds most of its code lines (comments don't count).
    const codeRow = (r) => r.toks && r.toks.some((tk) => tk.k !== 'ws' && tk.k !== 'com');
    for (const f of files) {
      for (const b of f.blocks) {
        let rows = b.rows.filter((r) => r.type === '+' && codeRow(r));
        let tree = f.newTree, line = (r) => r.n;
        if (!rows.length) { rows = b.rows.filter((r) => r.type === '-' && codeRow(r)); tree = f.oldTree; line = (r) => r.o; }
        if (!rows.length) rows = b.rows.filter((r) => r.type === '+').length ? b.rows.filter((r) => r.type === '+') : b.rows;
        const tally = new Map();
        let firstTest = null, firstGroup = null, firstTestKey = null;
        rows.forEach((r) => {
          const at = memberAt(tree, line(r), r.text);
          const k = at && at.member ? at.member : null;
          tally.set(k, (tally.get(k) || 0) + 1);
          if (!firstTest && at && at.test) {
            firstTest = at.test;
            firstTestKey = at.testKey;
          }
          if (!firstGroup && at && at.group) firstGroup = at.group;
        });
        let best = null, bestN = -1;
        tally.forEach((n, k) => { if (n > bestN) { best = k; bestN = n; } });
        b.member = best;
        b.test = firstTest;
        b.group = firstGroup;
        // A comment-only change documents the declaration below it, unless the block holds
        // that declaration itself (a class whose doc comment changed).
        const commentOnly = b.atoms.length && b.atoms.every((a) => a.commentOnly) && !b.rows.some((r) => r.type !== ' ' && codeRow(r) && !/^\s*@/.test(r.text));
        if (commentOnly && tree) {
          const src = tree === f.newTree ? f.newSrc : f.oldSrc;
          const lines = src.split('\n');
          const after = Math.max(...b.rows.filter((r) => (tree === f.newTree ? r.type === '+' : r.type === '-')).map((r) => line(r)).concat([0]));
          for (let l = after + 1; l <= Math.min(lines.length, after + 20); l++) {
            const t = lines[l - 1].trim();
            if (!t || t.startsWith('//') || t.startsWith('@')) continue;
            const at = memberAt(tree, l, lines[l - 1]);
            if (at && at.member) { b.member = at.member; b.documents = true; }
            break;
          }
        }
        const isTest = TEST_FILE.test(f.p) && (!b.member || b.member === 'main');
        b.memberKey = f.p + '::' + (isTest && firstTestKey ? firstTestKey : b.member || '(top)');
      }
    }

    const units = readingUnits(files, mappings.filter((mapping) => mapping.kind === 'yaml').flatMap((mapping) => mapping.source));
    const decls = new Map();
    const usesOf = new Map();
    // ---------- model fields changed in this comparison: Class.field -> blocks of the model file
    mappings.filter((mp) => mp.kind === 'yaml').forEach((mp) => files.filter((f) => mp.source.some((rx) => rx.test(f.p))).forEach((f) => {
      const modelFields = mp.fields;
      const cls = (src) => { const m = src && /^(?:class|exception):\s*(\w+)/m.exec(src); return m ? m[1] : null; };
      const name = cls(f.newSrc) || cls(f.oldSrc);
      if (!name) return;
      const fieldOf = (text) => { const m = /^  ([A-Za-z_]\w*):/.exec(text); return m && m[1] !== 'fields' && m[1] !== 'indexes' ? m[1] : null; };
      f.blocks.forEach((b) => {
        const touched = new Map();
        b.rows.forEach((r) => { const fld = fieldOf(r.text); if (fld) touched.set(fld, (touched.get(fld) || new Set()).add(r.type)); });
        if (!touched.size) {
          // A doc-comment change belongs to the field below it.
          const src = (f.newSrc || f.oldSrc).split('\n');
          const last = Math.max(...b.rows.map((r) => (r.type === '-' ? 0 : r.n)).concat([0]));
          for (let l = last + 1; l < Math.min(src.length, last + 6); l++) { const fld = fieldOf(src[l - 1]); if (fld) { touched.set(fld, new Set(['~'])); break; } if (src[l - 1].trim() && !src[l - 1].trim().startsWith('#')) break; }
        }
        touched.forEach((types, fld) => {
          const k = name + '.' + fld;
          if (!modelFields.has(k)) modelFields.set(k, { blocks: [], types: new Set(), file: f.p, cls: name, field: fld });
          modelFields.get(k).blocks.push(b);
          types.forEach((t) => modelFields.get(k).types.add(t));
        });
      });
    }));
    // Protobuf: messages (nested ones joined with _) and their fields, by line, on each side.
    const protoFields = (src) => {
      const out = new Map(), stack = [];
      (src || '').split('\n').forEach((raw, i) => {
        const t = raw.replace(/\/\/.*$/, '');
        const msg = stack.filter(Boolean).join('_');
        const m = /^\s*message\s+(\w+)\s*\{/.exec(t);
        const fm = !m && /^\s*(?:repeated\s+|optional\s+|required\s+)?[\w.]+(?:<[^>]*>)?\s+(\w+)\s*=\s*\d+/.exec(t);
        if (fm && msg) out.set(i + 1, { msg, field: fm[1] });
        let first = true;
        for (const ch of t) { if (ch === '{') { stack.push(m && first ? m[1] : null); first = false; } else if (ch === '}') stack.pop(); }
      });
      return out;
    };
    const camel = (snake) => snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    mappings.filter((mp) => mp.kind === 'proto').forEach((mp) => files.filter((f) => mp.source.some((rx) => rx.test(f.p))).forEach((f) => {
      const nf = protoFields(f.newSrc), of = protoFields(f.oldSrc);
      f.blocks.forEach((b) => b.rows.forEach((r) => {
        const hit = r.type === '+' ? nf.get(r.n) : r.type === '-' ? of.get(r.o) : null;
        if (!hit) return;
        const k = hit.msg + '.' + camel(hit.field);
        if (!mp.fields.has(k)) mp.fields.set(k, { blocks: [], types: new Set(), file: f.p, cls: hit.msg, field: hit.field });
        const mf = mp.fields.get(k);
        if (!mf.blocks.includes(b)) mf.blocks.push(b);
        mf.types.add(r.type);
      }));
    }));
    // A usage whose definition is generated from a changed model field links to that field's change.
    const linkModel = (u, mf, removedSide) => {
      const dk = `model:${mf.file}:${mf.cls}.${mf.field}`;
      if (!decls.has(dk)) {
        const onlyRemoved = mf.types.has('-') && !mf.types.has('+');
        decls.set(dk, { key: dk, name: mf.field, kind: 'member', block: mf.blocks[0], users: new Set(), member: mf.cls + '.' + mf.field, line: 0, file: mf.file, removed: onlyRemoved, model: true });
      }
      if (decls.get(dk).block === u.b) return;
      decls.get(dk).users.add(u.b);
      if (!usesOf.has(u.b)) usesOf.set(u.b, new Map());
      usesOf.get(u.b).set(dk, true);
    };

    // ---------- usage links from the language server
    const old = OLD[name];
    const plusRow = new Map();
    // A moved declaration's unchanged lines are not changed lines.
    files.forEach((f) => f.blocks.forEach((b) => b.rows.forEach((r) => { if (r.type === '+' && (!b.changedNew || b.changedNew.has(r.n))) plusRow.set(f.p + ':' + r.n, { f, b, r }); })));
    const changedCol = (r, col) => r.toks.some((tk) => tk.atom && (tk.c === col || tk.c + 1 === col));
    const fileByPath = new Map(files.map((f) => [f.p, f]));
    const diskTrees = new Map();
    const diskTree = (abs) => {
      if (!diskTrees.has(abs)) { let src = null; try { src = fs.readFileSync(abs, 'utf8'); } catch {} diskTrees.set(abs, src && { tree: parse(src), lines: src.split('\n') }); }
      return diskTrees.get(abs);
    };
    // Where a usage that resolves into generated code leads: a model field (YAML or protobuf),
    // or the declaration it was generated for (generated parts). Undefined when the target
    // isn't generated code a mapping covers.
    const cleanGenerated = (n) => n.replace(/^_?\$+/, '').replace(/^_/, '').replace(/(CopyWithImpl|CopyWith|Impl|FromJson|ToJson)$/, '');
    const genLink = (abs, root, line, col) => {
      const rel = abs.slice(root.length);
      const mp = mappingFor(rel);
      if (!mp) return undefined;
      const g = diskTree(abs);
      if (!g) return null;
      const id = /^[A-Za-z_$][\w$]*/.exec((g.lines[line - 1] || '').slice(col));
      const at = memberAt(g.tree, line, ' '.repeat(col) + 'x');
      if (!id || !at || !at.member) return null;
      const name = id[0], dot = at.member.indexOf('.');
      const owner = dot > 0 ? at.member.slice(0, dot) : null;
      if (mp.kind === 'yaml') {
        const cls = (owner || at.member).replace(mp.classSuffixes || /$^/, '');
        const mf = mp.fields.get(cls + '.' + name) || (name.endsWith('Id') ? mp.fields.get(cls + '.' + name.slice(0, -2)) : null);
        return mf ? { field: mf } : null;
      }
      if (mp.kind === 'proto') {
        const field = name.replace(/^(has|clear|ensure)(?=[A-Z])/, '');
        const mf = owner && mp.fields.get(owner + '.' + field.charAt(0).toLowerCase() + field.slice(1));
        return mf ? { field: mf } : null;
      }
      // A generated part: find what it was generated for in the library that owns the part.
      const partOf = /^\s*part\s+of\s+['"]([^'"]+)['"]/m.exec(g.lines.join('\n'));
      if (!partOf) return null;
      const libAbs = path.resolve(path.dirname(abs), partOf[1]), lib = diskTree(libAbs);
      if (!lib || !libAbs.startsWith(root)) return null;
      const base = cleanGenerated(owner || at.member), member = owner ? name : null;
      let hit = null;
      for (let i = 0; i < lib.tree.rootNode.namedChildCount && !hit; i++) {
        const n = lib.tree.rootNode.namedChild(i);
        const nm = TYPES.has(n.type) && (n.childForFieldName('name') || n.namedChildren.find((x) => x.type === 'identifier'));
        if (!nm || nm.text !== base) continue;
        hit = nm;
        // A member, or a parameter of a constructor (freezed's fields are factory parameters).
        if (member) for (const x of n.descendantsOfType('identifier')) { if (x.text === member && x.startIndex !== nm.startIndex && x.parent && x.parent.type !== 'type_identifier') { const p = x.parent.type; if (/formal_parameter|signature|initialized_identifier|declaration/.test(p) || SIGNATURES.has(p)) { hit = x; break; } } }
      }
      return hit ? { decl: { rel: libAbs.slice(root.length), line: hit.startPosition.row + 1, col: hit.startPosition.column } } : null;
    };
    // What a definition target is, independent of line shifts: file, name, enclosing member.
    const targetSig = (abs, root, line0, col) => {
      const t = diskTree(abs);
      if (!t) return null;
      const id = /^@?[A-Za-z_$][\w$]*/.exec((t.lines[line0] || '').slice(col));
      const at = memberAt(t.tree, line0 + 1, ' '.repeat(col) + 'x');
      return abs.slice(root.length) + '|' + (id ? id[0] : '?') + '|' + ((at && at.member) || '');
    };
    // A token whose text didn't change can still point somewhere else now: the same argument
    // label bound to another function's parameter. Such a token counts as changed.
    const rebound = (u, col) => {
      if (!old || u.b.move) return false;
      const tk = u.r.toks.find((t) => t.c === col || t.c + 1 === col);
      if (!tk || !tk.peer) return false;
      const ot = old.raw[`${u.f.p}:${tk.peer.row.o}:${tk.peer.tk.c + (col - tk.c)}`], nt = defsRaw[`${u.f.p}:${u.r.n}:${col}`];
      if (!ot || !nt || !ot[0].startsWith(old.dir) || !nt[0].startsWith(HEAD)) return false;
      return targetSig(ot[0], old.dir, ot[1], ot[2]) !== targetSig(nt[0], HEAD, nt[1], nt[2]);
    };
    const addUse = (u, dk, make) => {
      if (!decls.has(dk)) decls.set(dk, make());
      const d = decls.get(dk);
      if (d.block === u.b) return;
      d.users.add(u.b);
      if (!usesOf.has(u.b)) usesOf.set(u.b, new Map());
      usesOf.get(u.b).set(dk, true);
    };
    const declAt = (rel, f, b, line, col, extra) => () => {
      const row = b.rows.find((r) => r.n === line);
      const tok = row && (row.toks.find((t) => t.c === col) || row.toks.find((t) => t.c + 1 === col));
      const word = !tok && /^[A-Za-z_$][\w$]*/.exec(((f.newSrc || '').split('\n')[line - 1] || '').slice(col));
      const at = memberAt(f.newTree, line, ' '.repeat(col) + 'x');
      return { key: `${rel}:${line}:${col}`, name: tok ? tok.t.replace(/^@/, '') : word ? word[0] : '?', kind: declKind(f.newTree, line, col), block: b, users: new Set(), member: at && at.member, test: at && at.test, line, file: rel, ...extra };
    };
    // The changed lines inside a function, method or constructor (its signature and body).
    const blockNewSpan = (f, b) => {
      const ns = b.rows.filter((r) => r.n != null).map((r) => r.n);
      if (ns.length) return [Math.min(...ns), Math.max(...ns)];
      const h = f.hunks[b.hunk], next = h.rows[b.first + b.len], prev = h.rows[b.first - 1];
      const at = next && next.n != null ? next.n : prev && prev.n != null ? prev.n + 1 : null;
      return at == null ? null : [at, at];
    };
    const memberNode = (f, line, col) => {
      for (let n = f.newTree.rootNode.descendantForPosition(pos(line, col)); n; n = n.parent) {
        if (SIGNATURES.has(n.type)) return n;
        if (TYPES.has(n.type) || BODIES.has(n.type) || n.type === 'function_body') return null;
      }
      return null;
    };
    const isMemberName = (f, line, col) => {
      if (f.structure) return CALLABLE_KINDS.has(declarationAt(f.structure, line, col)?.kind);
      const n = f.newTree.rootNode.descendantForPosition(pos(line, col));
      if (!n || n.type !== 'identifier') return false;
      for (let a = n.parent; a; a = a.parent) {
        if (SIGNATURES.has(a.type)) { const nm = a.childForFieldName('name') || a.namedChildren.find((x) => x.type === 'identifier'); return !!nm && nm.startIndex === n.startIndex; }
        if (a.type === 'formal_parameter_list' || a.type === 'function_body' || BODIES.has(a.type)) return false;
      }
      return false;
    };
    const changedInside = (rel, line, col, signatureOnly) => {
      const f = fileByPath.get(rel);
      if (!f || !f.newTree) return null;
      const declaration = f.structure && declarationAt(f.structure, line, col);
      const sig = declaration ? null : memberNode(f, line, col);
      if (!declaration && !sig) return null;
      if (declaration && !CALLABLE_KINDS.has(declaration.kind)) return null;
      let end = declaration ? (signatureOnly ? declaration.signatureEndLine : declaration.endLine) : sig.endPosition.row + 1;
      // A method's body follows its outer signature (method_signature > function_signature).
      let outer = sig;
      while (outer?.parent && SIGNATURES.has(outer.parent.type)) outer = outer.parent;
      if (!signatureOnly && outer?.nextSibling && outer.nextSibling.type === 'function_body') end = outer.nextSibling.endPosition.row + 1;
      const start = declaration ? declaration.startLine : sig.startPosition.row + 1;
      const hits = f.blocks.filter((x) => x.atoms.length && (() => { const sp = blockNewSpan(f, x); return sp && sp[0] <= end && sp[1] >= start && (!signatureOnly || x.rows.some((r) => r.n != null && r.n >= start && r.n <= end && plusRow.has(rel + ':' + r.n))); })());
      // The first change with code in it, so a comment edit doesn't stand for the function.
      const b = hits.find((x) => x.atoms.some((a) => !a.commentOnly)) || hits[0];
      return b ? { f, b } : null;
    };
    const changedParams = (f, line, col) => {
      if (f.structure) {
        const declaration = declarationAt(f.structure, line, col);
        return f.structure.declarations.filter((parameter) => parameter.kind === 'PARAMETER' && parameter.elementOwner === declaration?.id).flatMap((parameter) => {
          const [line, col] = parameter.position.split(':').map(Number);
          const hit = plusRow.get(`${f.p}:${line}`);
          return hit ? [{ line, col, b: hit.b }] : [];
        });
      }
      const sig = memberNode(f, line, col);
      if (!sig) return [];
      return sig.descendantsOfType('formal_parameter').map((fp) => {
        const ids = fp.descendantsOfType('identifier');
        const id = ids[ids.length - 1];
        const hit = id && plusRow.get(f.p + ':' + (id.startPosition.row + 1));
        return hit ? { line: id.startPosition.row + 1, col: id.startPosition.column, b: hit.b } : null;
      }).filter(Boolean);
    };
    const isTestFile = (p) => TEST_FILE.test(p);
    const reached = new Map();
    const reachChanged = (rel, line0, col) => {
      const start = `${rel}:${line0}:${col}`;
      if (reached.has(start)) return reached.get(start);
      const hits = [], seen = new Set([start]);
      let level = [start];
      for (let depth = 0; level.length && depth <= (CALLS ? CALLS.depth : 0); depth++) {
        const next = [];
        level.forEach((k) => {
          const i1 = k.lastIndexOf(':'), i0 = k.lastIndexOf(':', i1 - 1);
          const r = k.slice(0, i0), l = +k.slice(i0 + 1, i1) + 1, c = +k.slice(i1 + 1);
          const fr = fileByPath.get(r);
          const inside = fr && fr.newTree && isMemberName(fr, l, c) && changedInside(r, l, c, false);
          if (inside) { hits.push({ key: `${r}:${l}:${c}`, rel: r, line: l, col: c, f: inside.f, b: inside.b }); return; }
          ((CALLS && CALLS.graph[k]) || []).forEach((x) => { if (!seen.has(x)) { seen.add(x); next.push(x); } });
        });
        level = next;
      }
      reached.set(start, hits);
      return hits;
    };
    for (const [key, [tpath, tl, tc]] of Object.entries(defsRaw)) {
      const i1 = key.lastIndexOf(':'), i0 = key.lastIndexOf(':', i1 - 1);
      const p = key.slice(0, i0), line = +key.slice(i0 + 1, i1), col = +key.slice(i1 + 1);
      const u = plusRow.get(p + ':' + line);
      if (!u || !u.b.atoms.length || !tpath.startsWith(HEAD)) continue;
      // Updating an expectation still validates the call beside it, even if the call's
      // spelling stayed the same. Production ripples still require a changed reference.
      if (!(isTestFile(p) || changedCol(u.r, col) || rebound(u, col))) continue;
      const rel = tpath.slice(HEAD.length);
      const gl = genLink(tpath, HEAD, tl + 1, tc);
      if (gl !== undefined) {
        if (gl && gl.field) linkModel(u, gl.field, false);
        else if (gl && gl.decl) { const d2 = plusRow.get(gl.decl.rel + ':' + gl.decl.line); if (d2 && d2.b !== u.b) addUse(u, `${gl.decl.rel}:${gl.decl.line}:${gl.decl.col}`, declAt(gl.decl.rel, d2.f, d2.b, gl.decl.line, gl.decl.col)); }
        continue;
      }
      const d = plusRow.get(rel + ':' + (tl + 1));
      if (d?.b.atoms.length) {
        if (d.b !== u.b) addUse(u, `${rel}:${tl + 1}:${tc}`, declAt(rel, d.f, d.b, tl + 1, tc));
        else {
          // A parameter used only inside its own change: no use, but it can still name the
          // ripple it passes on (the top parameter, where the change enters).
          const dk = `${rel}:${tl + 1}:${tc}`;
          if (!decls.has(dk)) { const made = declAt(rel, d.f, d.b, tl + 1, tc)(); if (made.kind === 'param') decls.set(dk, made); }
        }
        continue;
      }
      // A test links to the changed code it reaches: the first changed function on each path
      // of calls from what it calls, up to the call graph's depth.
      if (isTestFile(u.f.p)) reachChanged(rel, tl, tc).forEach((h) => { if (h.b !== u.b) addUse(u, h.key, declAt(h.rel, h.f, h.b, h.line, h.col, { kind: 'member' })); });
    }
    // A call whose argument list changed uses the called function's signature. A changed
    // positional argument joins the ripple of the parameter in the same position when that
    // parameter changed (a named argument already resolves to its parameter through its label).
    // A changed signature without a changed parameter links the call to the function itself.
    const calleeOf = (args) => {
      const p = args.parent;
      if (p && p.type === 'argument_part' && p.parent && p.parent.type === 'selector') {
        const prev = p.parent.previousNamedSibling;
        if (!prev) return null;
        if (prev.type === 'identifier') return prev;
        const ids = prev.descendantsOfType('identifier');
        return ids.length ? ids[ids.length - 1] : null;
      }
      if (p && (p.type === 'new_expression' || p.type === 'const_object_expression')) {
        const ids = p.children.filter((c) => c.type === 'identifier' || c.type === 'type_identifier');
        return ids.length ? ids[ids.length - 1] : null;
      }
      return null;
    };
    const positionalParams = (sig) => {
      const list = sig.descendantsOfType('formal_parameter_list')[0];
      const out = [];
      if (list) list.namedChildren.forEach((c) => {
        if (c.type === 'formal_parameter') out.push(c);
        else if (c.type === 'optional_formal_parameters' && c.text.trim().startsWith('[')) c.namedChildren.forEach((x) => { if (x.type === 'formal_parameter') out.push(x); });
      });
      return out;
    };
    const paramDecl = (f, fp) => {
      const ids = fp.descendantsOfType('identifier');
      const id = ids[ids.length - 1];
      const hit = id && plusRow.get(f.p + ':' + (id.startPosition.row + 1));
      return hit ? { line: id.startPosition.row + 1, col: id.startPosition.column, b: hit.b } : null;
    };
    files.forEach((f) => {
      if (f.structure) {
        for (const argument of f.structure.arguments) {
          if (argument.named || !argument.callable?.[0].startsWith(HEAD)) continue;
          const [callee, line, col] = argument.callable;
          const rel = callee.slice(HEAD.length);
          const signature = changedInside(rel, line + 1, col, true);
          if (!signature) continue;
          const [target, parameterLine, parameterCol] = argument.target;
          const parameter = target === callee && plusRow.get(`${rel}:${parameterLine + 1}`);
          for (let n = argument.startLine; n <= argument.endLine; n++) {
            const usage = plusRow.get(`${f.p}:${n}`);
            if (!usage || !usage.r.toks.some((token) => token.atom && (n > argument.startLine || token.c + token.t.length > argument.startColumn) && (n < argument.endLine || token.c < argument.endColumn))) continue;
            if (parameter) {
              if (parameter.b !== usage.b) addUse(usage, `${rel}:${parameterLine + 1}:${parameterCol}`, declAt(rel, signature.f, parameter.b, parameterLine + 1, parameterCol));
            } else if (!changedParams(signature.f, line + 1, col).length && signature.b !== usage.b) {
              addUse(usage, `${rel}:${line + 1}:${col}`, declAt(rel, signature.f, signature.b, line + 1, col, { kind: 'member' }));
            }
          }
        }
        return;
      }
      if (!f.newTree) return;
      f.blocks.forEach((b) => {
        if (!b.atoms.length) return;
        const seen = new Set();
        b.rows.forEach((r) => {
          if (r.type !== '+' || !plusRow.has(f.p + ':' + r.n)) return;
          r.toks.forEach((tk) => {
            if (!tk.atom) return;
            let n = f.newTree.rootNode.descendantForPosition(pos(r.n, tk.c)), arg = null;
            while (n && n.type !== 'arguments') { if (n.parent && n.parent.type === 'arguments') arg = n; n = STATEMENTS.has(n.type) ? null : n.parent; }
            const callee = n && calleeOf(n);
            if (!callee || !arg || arg.type === 'named_argument') return;
            const k = n.namedChildren.filter((c) => c.type === 'argument').findIndex((c) => c.startIndex === arg.startIndex);
            if (k < 0 || seen.has(callee.startIndex + ':' + k)) return;
            seen.add(callee.startIndex + ':' + k);
            const t = defsRaw[`${f.p}:${callee.startPosition.row + 1}:${callee.startPosition.column}`];
            if (!t || !t[0].startsWith(HEAD)) return;
            const rel = t[0].slice(HEAD.length);
            const sig = changedInside(rel, t[1] + 1, t[2], true);
            if (!sig) return;
            const sigNode = memberNode(sig.f, t[1] + 1, t[2]);
            const params = positionalParams(sigNode);
            const q = params[k] && paramDecl(sig.f, params[k]);
            if (q) { if (q.b !== b) addUse({ f, b, r }, `${rel}:${q.line}:${q.col}`, declAt(rel, sig.f, q.b, q.line, q.col)); }
            else if (!changedParams(sig.f, t[1] + 1, t[2]).length && sig.b !== b) addUse({ f, b, r }, `${rel}:${t[1] + 1}:${t[2]}`, declAt(rel, sig.f, sig.b, t[1] + 1, t[2], { kind: 'member' }));
          });
        });
      });
    });

    // Overrides: a changed method that overrides a changed method links to it, and changed
    // overrides of the same method elsewhere (a framework's, say) join one chain. Members of
    // Object (toString, ==, hashCode) are left out: every class overrides them.
    if (SUPERS) {
      const byBase = new Map();
      for (const [key, [tpath, tl, tc]] of Object.entries(SUPERS)) {
        const i1 = key.lastIndexOf(':'), i0 = key.lastIndexOf(':', i1 - 1);
        const p = key.slice(0, i0), line = +key.slice(i0 + 1, i1), col = +key.slice(i1 + 1);
        const u = plusRow.get(p + ':' + line), f = fileByPath.get(p);
        if (!u || !f || !f.newTree || !isMemberName(f, line, col) || /\/(?:dart-sdk|pkg\/sky_engine)\/lib\/core\/object\.dart$/.test(tpath)) continue;
        if (tpath.startsWith(HEAD)) {
          const rel = tpath.slice(HEAD.length), d = plusRow.get(rel + ':' + (tl + 1));
          if (d) { if (d.b !== u.b) addUse(u, `${rel}:${tl + 1}:${tc}`, declAt(rel, d.f, d.b, tl + 1, tc, { kind: 'member' })); continue; }
        }
        const k = JSON.stringify([tpath, tl, tc]);
        if (!byBase.has(k)) byBase.set(k, []);
        byBase.get(k).push(u.b);
      }
      byBase.forEach((list, k) => {
        const blocks = [...new Set(list)];
        if (blocks.length < 2) return;
        const [tpath, tl, tc] = JSON.parse(k);
        const t = diskTree(tpath);
        const word = t && /^[A-Za-z_$][\w$]*/.exec((t.lines[tl] || '').slice(tc));
        const at = t && memberAt(t.tree, tl + 1, ' '.repeat(tc) + 'x');
        const dk = 'super:' + k;
        decls.set(dk, { key: dk, name: word ? word[0] : '?', kind: 'member', block: blocks[0], users: new Set(blocks.slice(1)), member: (at && at.member) || (word && word[0]), line: tl + 1, file: tpath, overrides: true });
        blocks.slice(1).forEach((b) => { if (!usesOf.has(b)) usesOf.set(b, new Map()); usesOf.get(b).set(dk, true); });
      });
    }

    // Names in strings: a tool, route or class named in a string is invisible to the language
    // server. A name-like string literal on a changed line (or a backticked name in a changed
    // Markdown line) links to a changed declaration of that name, or else to the other changes
    // that introduce the same string, when the code itself (not only tests or docs) introduces
    // it. Name-like: no spaces, and a capital after the first
    // letter, an underscore, a dot, a hyphen or a digit (tail_runner_logs, FullModelInclude,
    // runner.log), so plain words like 'name' don't count. A string in more than 15 changes is
    // too common to mean anything.
    const nameLike = (x) => x.length >= 4 && x.length <= 80 && /^[A-Za-z_][\w$]*([.-][\w$]+)*$/.test(x) && (/[A-Z_.-]/.test(x.slice(1)) || /\d/.test(x));
    const declsByName = new Map();
    for (const [key, [tpath, tl, tc]] of Object.entries(defsRaw)) {
      const i1 = key.lastIndexOf(':'), i0 = key.lastIndexOf(':', i1 - 1);
      const p = key.slice(0, i0), line = +key.slice(i0 + 1, i1), col = +key.slice(i1 + 1);
      const u = plusRow.get(p + ':' + line);
      if (!u || tpath !== HEAD + p || tl !== line - 1 || tc !== col) continue;
      const kind = declKind(u.f.newTree, line, col);
      const tok = u.r.toks.find((t) => t.c === col);
      if (!tok || (kind !== 'member' && kind !== 'type')) continue;
      if (!declsByName.has(tok.t)) declsByName.set(tok.t, []);
      declsByName.get(tok.t).push({ rel: p, line, col, f: u.f, b: u.b });
    }
    const strings = new Map();
    const addString = (x, b) => { if (!nameLike(x)) return; if (!strings.has(x)) strings.set(x, new Set()); strings.get(x).add(b); };
    const QUOTED = /^r?('''|"""|'|")([\s\S]*)\1$/;
    files.forEach((f) => f.blocks.forEach((b) => {
      if (!b.atoms.length) return;
      if (b.lang === 'md') {
        b.rows.forEach((r) => { if (r.type === '+' && plusRow.has(f.p + ':' + r.n)) for (const m of r.text.matchAll(/`([^`\s]+?)(?:\(\))?`/g)) addString(m[1], b); });
        return;
      }
      if (!f.newTree) return;
      const seen = new Set();
      b.rows.forEach((r) => {
        if (r.type !== '+' || !plusRow.has(f.p + ':' + r.n)) return;
        r.toks.forEach((tk) => {
          if (!tk.atom || tk.k !== 'str') return;
          let n = f.newTree.rootNode.descendantForPosition(pos(r.n, tk.c));
          while (n && n.type !== 'string_literal') n = n.parent;
          if (!n || seen.has(n.startIndex)) return;
          seen.add(n.startIndex);
          for (let a = n.parent; a; a = a.parent) if (/directive|import/.test(a.type)) return;
          const m = QUOTED.exec(n.text);
          if (m && !m[2].includes('$')) addString(m[2], b);
        });
      });
    }));
    const place = (b) => (b.lang === 'md' ? 2 : isTestFile(b.file.p) ? 1 : 0);
    strings.forEach((blocks, x) => {
      if (blocks.size > 15) return;
      const named = (declsByName.get(x) || []).slice(0, 3);
      if (named.length) {
        named.forEach((d) => blocks.forEach((b) => { if (b !== d.b) addUse({ f: b.file, b, r: null }, `${d.rel}:${d.line}:${d.col}`, declAt(d.rel, d.f, d.b, d.line, d.col)); }));
        return;
      }
      if (blocks.size < 2 || ![...blocks].some((b) => place(b) === 0)) return;
      const list = [...blocks].sort((p, q) => place(p) - place(q) || (p.id < q.id ? -1 : 1));
      const dk = 'str:' + x;
      decls.set(dk, { key: dk, name: x, kind: 'member', block: list[0], users: new Set(list.slice(1)), member: null, line: 0, file: list[0].file.p, str: true });
      list.slice(1).forEach((b) => { if (!usesOf.has(b)) usesOf.set(b, new Map()); usesOf.get(b).set(dk, true); });
    });

    // Removed lines link the same way, through the old side's language server.
    const minusRow = new Map();
    files.forEach((f) => f.blocks.forEach((b) => b.rows.forEach((r) => { if (r.type === '-' && (!b.changedOld || b.changedOld.has(r.o))) minusRow.set(f.p + ':' + r.o, { f, b, r }); })));
    if (old) {
      for (const [key, [tpath, tl, tc]] of Object.entries(old.raw)) {
        const i1 = key.lastIndexOf(':'), i0 = key.lastIndexOf(':', i1 - 1);
        const p = key.slice(0, i0), line = +key.slice(i0 + 1, i1), col = +key.slice(i1 + 1);
        const u = minusRow.get(p + ':' + line);
        if (!u || !tpath.startsWith(old.dir) || !changedCol(u.r, col)) continue;
        const rel = tpath.slice(old.dir.length);
        const gl = genLink(tpath, old.dir, tl + 1, tc);
        if (gl !== undefined) { if (gl && gl.field) linkModel(u, gl.field, true); continue; }
        const d = minusRow.get(rel + ':' + (tl + 1));
        if (!d || d.b === u.b) continue;
        const dk = `old:${rel}:${tl + 1}:${tc}`;
        if (!decls.has(dk)) {
          const tok = d.r.toks.find((t) => t.c === tc) || d.r.toks.find((t) => t.c + 1 === tc);
          const at = memberAt(d.f.oldTree, tl + 1, ' '.repeat(tc) + 'x');
          // A moved declaration isn't removed: its old usages belong to the moved copy.
          const mv = d.b.movedTo && d.b.movedTo.block;
          decls.set(dk, { key: dk, name: tok ? tok.t.replace(/^@/, '') : '?', kind: declKind(d.f.oldTree, tl + 1, tc), block: mv || d.b, users: new Set(), member: mv ? mv.member : at && at.member, test: at && at.test, line: tl + 1, file: rel, removed: !mv });
        }
        if (decls.get(dk).block === u.b) continue;
        decls.get(dk).users.add(u.b);
        if (!usesOf.has(u.b)) usesOf.set(u.b, new Map());
        usesOf.get(u.b).set(dk, true);
      }
      // A declaration whose name token was replaced is one declaration: its old usages
      // join the new name.
      edits.flatMap((e) => e.runs.map((r) => ({ ...r, block: e.block }))).forEach((e) => {
        if (e.op !== 'token' || e.where !== 'declaration') return;
        const od = e.atom.del[0], nd = e.atom.ins[0];
        const ot = old.raw[`${e.block.file.p}:${od.row.o}:${od.tk.c}`];
        if (!ot || ot[0] !== old.dir + e.block.file.p || ot[1] !== od.row.o - 1 || ot[2] !== od.tk.c) return;
        const ok = `old:${e.block.file.p}:${od.row.o}:${od.tk.c}`, nk = `${e.block.file.p}:${nd.row.n}:${nd.tk.c}`;
        const oldD = decls.get(ok);
        if (!oldD) return;
        let newD = decls.get(nk);
        if (!newD) {
          const at = memberAt(e.block.file.newTree, nd.row.n, ' '.repeat(nd.tk.c) + 'x');
          newD = { key: nk, name: nd.tk.t, kind: declKind(e.block.file.newTree, nd.row.n, nd.tk.c), block: e.block, users: new Set(), member: at && at.member, test: at && at.test, line: nd.row.n, file: e.block.file.p, renamedFrom: oldD.name };
          decls.set(nk, newD);
        }
        oldD.users.forEach((u) => { newD.users.add(u); const m = usesOf.get(u); m.delete(ok); m.set(nk, true); });
        newD.renamedFrom = oldD.name;
        decls.delete(ok);
      });
    }

    // ---------- chains
    const allBlocks = files.flatMap((f) => f.blocks).filter((b) => b.atoms.length);
    const parent = new Map(allBlocks.map((b) => [b, b]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (x, y) => { x = find(x); y = find(y); if (x !== y) parent.set(x, y); };
    // A ripple is a parameter or variable whose change spreads: a local only within its own
    // member (a test's fixture variable doesn't tie the tests together), and a parameter only
    // when its function already existed (calls to a new function link to the function).
    const newFunction = (d) => {
      const f = fileByPath.get(d.file);
      const sig = f && f.newTree && memberNode(f, d.line, Math.max(0, ((f.newSrc || '').split('\n')[d.line - 1] || '').indexOf(d.name)));
      const nm = sig && (sig.childForFieldName && sig.childForFieldName('name') || sig.descendantsOfType('identifier')[0]);
      const hit = nm && plusRow.get(d.file + ':' + (nm.startPosition.row + 1));
      return !!(hit && !hit.b.dels);
    };
    decls.forEach((d) => {
      if (d.block.unit) return;
      const users = [...d.users].filter((u) => !u.unit);
      if (d.removed) { if (d.kind === 'param' || d.kind === 'local') users.forEach((u) => union(d.block, u)); return; }
      if (d.kind === 'local') users.forEach((u) => { if (u.memberKey === d.block.memberKey) union(d.block, u); });
      else if (d.kind === 'param' && !newFunction(d)) users.forEach((u) => union(d.block, u));
    });
    const comps = new Map();
    allBlocks.forEach((b) => { const r = find(b); if (!comps.has(r)) comps.set(r, new Set()); comps.get(r).add(b); });
    let chains = [...comps.values()].filter((s) => s.size > 1).map((blocks) => ({ blocks, kind: 'ripple' }));
    const chainOf = new Map();
    chains.forEach((c) => c.blocks.forEach((b) => chainOf.set(b, c)));
    decls.forEach((d) => {
      if (d.block.unit || (d.kind !== 'member' && d.kind !== 'type') || !d.users.size || !d.block.atoms.length) return;
      const blocks = new Set([d.block, ...[...d.users].filter((b) => !b.unit)]);
      const owners = new Set([...blocks].map((b) => chainOf.get(b)));
      if (owners.size === 1 && [...owners][0]) return; // already inside one ripple chain
      chains.push({ blocks, kind: 'member', root: d });
    });
    const identToken = (d) => d.tk.k === 'id' || d.tk.k === 'ty' || d.tk.k === 'ann';
    groups.forEach((g) => {
      const named = g.edits.some((e) => !e.commentOnly && e.atoms.some((a) => a.del.concat(a.ins).some(identToken)));
      if (!named) return;
      const blocks = new Set(g.edits.map((e) => e.block).filter((b) => !b.unit));
      if (blocks.size < 2) return;
      const shared = chains.filter((c) => [...blocks].every((b) => c.blocks.has(b)));
      if (shared.length) return;
      chains.push({ blocks, kind: 'group', group: g });
    });
    const memberCount = (c) => new Set([...c.blocks].map((b) => b.memberKey)).size;
    // A chain is named after its best declaration: what remains before what was removed,
    // functions, methods, fields and types before parameters and locals, public before private,
    // then the most used.
    const isPublic = (d) => ![d.name, ...String(d.member || '').split('.')].some((x) => String(x).startsWith('_'));
    const rootRank = (d) => (d.removed ? 100 : 0) + (d.kind === 'member' || d.kind === 'type' ? 0 : d.kind === 'param' ? 20 : 40) + (isPublic(d) ? 0 : 10);
    chains = chains.filter((c) => (c.kind === 'group' ? c.blocks.size > 1 : memberCount(c) > 1));
    // Member cohesion: a change that no rule links joins the chains of its member (a test counts
    // as a member in test files; top-level code doesn't). Changes that already belong to a chain
    // stay out of other chains.
    const byMember = new Map();
    allBlocks.forEach((b) => { if (!b.unit && !b.memberKey.endsWith('::(top)')) { if (!byMember.has(b.memberKey)) byMember.set(b.memberKey, []); byMember.get(b.memberKey).push(b); } });
    const linkedBlocks = new Set(chains.flatMap((c) => [...c.blocks]));
    chains.forEach((c) => { [...c.blocks].forEach((b) => (byMember.get(b.memberKey) || []).forEach((x) => { if (!linkedBlocks.has(x)) c.blocks.add(x); })); });
    chains.forEach((c) => {
      const counted = [...decls.values()].filter((d) => c.blocks.has(d.block) && d.kind !== 'import').map((d) => ({ d, n: [...d.users].filter((u) => c.blocks.has(u)).length }));
      // A parameter whose own change passes it on to another member's parameter counts too:
      // the top of a ripple can have no other change using it, when its uses sit in its own.
      const passesOn = (d) => d.kind === 'param' && counted.some((x) => x.d.kind === 'param' && x.d.member !== d.member && x.d.users.has(d.block));
      const inside = counted.filter((x) => x.n > 0 || passesOn(x.d));
      // In a ripple, the top parameter comes first: its callers don't pass it on from a
      // parameter of their own (the one where the change enters).
      const params = inside.filter((x) => x.d.kind === 'param').map((x) => x.d);
      const withParam = new Set(params.map((d) => d.member));
      const below = new Set(params.filter((d) => [...d.users].some((u) => c.blocks.has(u) && u.member !== d.member && withParam.has(u.member))));
      const rank = (d) => rootRank(d) + (below.has(d) ? 50 : 0);
      inside.sort((x, y) => rank(x.d) - rank(y.d) || y.n - x.n || (x.d.key < y.d.key ? -1 : 1));
      if (!c.root) c.root = inside.length ? inside[0].d : null;
      c.also = inside.filter((x) => x.d !== c.root && x.n >= 2 && x.d.kind !== 'local').slice(0, 3).map((x) => x.d);
    });
    const label = (d) => {
      if (!d) return '(changes)';
      if (d.overrides) return 'overrides ' + d.member;
      if (d.str) return `“${d.name}”`;
      if (d.removed) return '− ' + label({ ...d, removed: false });
      if (d.model) return d.member;
      let m = d.member;
      const ctor = m && /^([\w$]+)\.\1$/.exec(m);
      if (ctor) m = ctor[1];
      if (d.kind === 'param') return `${m || '?'}(${d.name})`;
      if (ctor && d.name === ctor[1]) return `${ctor[1]}()`;
      if (d.kind === 'local') return `${!m || m === 'main' ? path.basename(d.file) : m} · ${d.name}`;
      return m && m.endsWith(d.name) ? m : m ? `${m.split('.')[0]}.${d.name}` : d.name;
    };
    const editLabel = (e) => {
      const t = (x) => (x.length > 48 ? x.slice(0, 47) + '…' : x);
      return e.op === 'insert' ? '+ ' + t(e.to) : e.op === 'delete' ? '− ' + t(e.from) : t(e.from) + ' → ' + t(e.to);
    };
    // Chains rooted at the same declaration are one chain (a ripple and its root's star).
    // A member's own chain and the ripple of one of its parameters are one chain too.
    // A field and the constructor parameter that sets it (`this.field`) are one declaration: the
    // field's chain is the constructor's chain. Fields set by the unnamed constructor go to it.
    const fieldCtor = new Map();
    files.forEach((f) => {
      if (f.structure) {
        for (const parameter of f.structure.declarations) {
          if (!parameter.field) continue;
          const field = declarationAt(f.structure, parameter.field[1] + 1, parameter.field[2]);
          const constructor = indexOf(f.structure).ids.get(parameter.owner);
          if (!field || !constructor) continue;
          const member = memberName(f.structure, constructor);
          const unnamed = constructor.name.endsWith('.new');
          const label = unnamed ? constructor.name.slice(0, -4) + '()' : member;
          const key = f.p + '::' + memberName(f.structure, field);
          if (!fieldCtor.has(key) || unnamed) fieldCtor.set(key, label);
          fieldCtor.set(f.p + '::' + member, label);
        }
        return;
      }
      if (!f.newTree) return;
      f.newTree.rootNode.descendantsOfType('constructor_param').forEach((cp) => {
        const ids = cp.descendantsOfType('identifier');
        let sig = cp.parent;
        while (sig && !SIGNATURES.has(sig.type)) sig = sig.parent;
        let owner = sig && sig.parent;
        while (owner && !TYPES.has(owner.type)) owner = owner.parent;
        const nm = owner && (owner.childForFieldName('name') || owner.namedChildren.find((x) => x.type === 'identifier'));
        if (!ids.length || !sig || !nm) return;
        const ctorName = nameOf(sig), cls = nm.text, key = f.p + '::' + cls + '.' + ids[ids.length - 1].text;
        const ctorLabel = ctorName === cls ? cls + '()' : ctorName.includes('.') ? ctorName : cls + '.' + ctorName;
        if (!fieldCtor.has(key) || ctorName === cls) fieldCtor.set(key, ctorLabel);
        fieldCtor.set(f.p + '::' + (ctorName.includes('.') ? ctorName : cls + '.' + ctorName), ctorLabel);
      });
    });
    const byName = new Map();
    const fieldKey = (d) => d && d.file + '::' + d.member;
    const declarationOwner = (d) => {
      if (d.str || d.overrides || d.model) return d.key;
      const file = fileByPath.get(d.file);
      const tree = d.removed ? file?.oldTree : file?.newTree;
      const col = Number(d.key.slice(d.key.lastIndexOf(':') + 1));
      if (!tree || !d.line || !Number.isFinite(col)) return d.key;

      const resolved = structures.get(tree);
      if (resolved) {
        let declaration = declarationAt(resolved, d.line, col);
        // Anonymous callbacks have semantic identities even though they are not named
        // reading units. Their parameters must not merge under the enclosing function.
        if (declaration && ['PARAMETER', 'LOCAL_VARIABLE'].includes(declaration.kind) && declaration.elementOwner) {
          return `${d.removed ? 'old:' : ''}${declaration.elementOwner}`;
        }
        while (declaration) {
          if (CALLABLE_KINDS.has(declaration.kind)) return `${d.removed ? 'old:' : ''}${declaration.id}`;
          declaration = indexOf(resolved).ids.get(declaration.owner);
        }
        return d.key;
      }
      let node = tree.rootNode.descendantForPosition(pos(d.line, col));
      while (node) {
        if (SIGNATURES.has(node.type) || node.type === 'function_expression') {
          while (SIGNATURES.has(node.parent?.type)) node = node.parent;
          return `${d.removed ? 'old:' : ''}${d.file}:${node.startPosition.row + 1}:${node.startPosition.column}`;
        }
        node = node.parent;
      }
      return d.key;
    };
    const mergeKey = (c, nm) => (c.root && c.root.kind === 'member' && fieldCtor.has(fieldKey(c.root)) ? fieldCtor.get(fieldKey(c.root))
      : c.root && c.root.kind === 'param' && c.root.member ? label({ ...c.root, kind: 'member', name: c.root.member.split('.').pop() }) : nm);
    chains.forEach((c) => {
      const nm = c.kind === 'group' && !c.root ? editLabel(c.group.edits[0]) : label(c.root);
      const memberName = mergeKey(c, nm);
      const ctor = c.root && fieldCtor.get(fieldKey(c.root));
      const key = ctor ? c.root.file + '::constructor:' + ctor : c.root ? declarationOwner(c.root) : 'edit:' + c.group.parts.map((p) => p.key).join('|');
      c.name = c.root && c.root.kind === 'member' && fieldCtor.has(fieldKey(c.root)) ? memberName : nm;
      if (!byName.has(key)) { byName.set(key, c); return; }
      const keep = byName.get(key);
      if (keep.root && keep.root.kind === 'param' && c.root && c.root.kind !== 'param') { keep.name = c.name; }
      if (memberName === c.name || memberName === fieldCtor.get(fieldKey(keep.root))) keep.name = memberName;
      c.blocks.forEach((b) => keep.blocks.add(b));
      [c.root, ...c.also].forEach((d) => { if (d && !keep.also.includes(d) && d !== keep.root) keep.also.push(d); });
    });
    chains = [...byName.values()];
    // Removed types retain their own identity; equal type names in other libraries do not
    // establish a relationship. New declarations get reading units below instead.
    const removedTypes = new Map();
    files.forEach((f) => {
      if (!f.oldTree) return;
      for (const node of f.oldTree.rootNode.namedChildren) {
        if (!TYPES.has(node.type)) continue;
        const name = node.childForFieldName('name') || node.namedChildren.find((n) => n.type === 'identifier');
        const hit = name && minusRow.get(f.p + ':' + (name.startPosition.row + 1));
        if (hit && !hit.b.adds) removedTypes.set(f.p + '::' + name.text, hit.b);
      }
    });
    const removedChains = new Map();
    chains = chains.filter((c) => {
      if (!c.root || !c.root.removed) return true;
      const type = c.root.kind === 'type' ? c.root.name : String(c.root.member || '').split('.')[0];
      const key = c.root.file + '::' + type;
      if (!removedTypes.has(key)) return true;
      c.blocks.add(removedTypes.get(key));
      c.name = '− ' + type;
      const keep = removedChains.get(key);
      if (!keep) {
        removedChains.set(key, c);
        return true;
      }
      c.blocks.forEach((block) => keep.blocks.add(block));
      return false;
    });

    // Scoped setup is a test dependency, not an implementation owner. Add it after the
    // existing-code ripple pass so group registration cannot combine unrelated behaviors.
    const addSetup = (block, context) => {
      for (const setup of context || []) {
        const key = 'setup:' + setup.id;
        addUse({ b: block }, key, () => ({
          key, name: setup.name, kind: 'setup', member: setup.name,
          block: [...setup.blocks][0], users: new Set(), file: setup.file, line: setup.start,
        }));
      }
    };
    for (const unit of units) addSetup([...unit.blocks][0], unit.context);
    for (const block of allBlocks) addSetup(block, block.context);

    // These are candidate nodes, not sidebar entries. Complete declarations and scenarios
    // enter chains only through dependencies; sharing a file does not establish a chain.
    for (const unit of units) {
      const blocks = new Set(unit.blocks);
      const root = [...decls.values()].find((d) => d.block.unit === unit &&
        (unit.kind === 'type' ? d.kind === 'type' && d.name === unit.name : d.member === unit.name && d.kind === 'member')) || {
        key: 'unit:' + unit.id, name: unit.name, member: unit.name,
        file: unit.file, line: unit.start, kind: unit.kind === 'type' ? 'type' : 'member',
        block: [...blocks].find((b) => b.atoms.length), users: new Set(),
      };
      const chain = {
        kind: 'declaration', root, blocks, also: [], unit,
        name: unit.name,
        support: isTestFile(unit.file),
      };
      chains.push(chain);
    }

    // Existing members can anchor introduced dependencies or new test scenarios, even when
    // no existing-code rule produced a chain for that member alone.
    const owned = new Set(chains.flatMap((chain) => [...chain.blocks]));
    byMember.forEach((blocks) => {
      const remaining = blocks.filter((block) => !owned.has(block));
      const callsNew = remaining.some((block) => [...(usesOf.get(block) || new Map()).keys()].some((key) => {
        const declaration = decls.get(key);
        return declaration.kind !== 'setup' && declaration.block.unit;
      }));
      const calledByNew = [...decls.values()].some((declaration) => remaining.includes(declaration.block) && [...declaration.users].some((block) => block.unit));
      if (!callsNew && !calledByNew) return;
      const first = remaining[0];
      const root = {
        key: 'caller:' + first.memberKey, name: first.test || first.member,
        member: first.member, kind: 'member', file: first.file.p,
        line: first.rows.find((row) => row.n != null)?.n || 0, block: first, users: new Set(),
      };
      chains.push({ kind: 'member', root, blocks: new Set(remaining), name: root.name, also: [], support: isTestFile(first.file.p) });
    });

    chains.forEach((chain) => {
      chain.support = chain.root ? isTestFile(chain.root.file) : [...chain.blocks].every((block) => isTestFile(block.file.p));
    });
    chains = assembleIntroducedChains(chains, usesOf, decls, isTestFile, files.flatMap((file) => file.blocks));

    const namesOf = (c) => {
      const out = new Set();
      c.blocks.forEach((b) => { if (b.member && b.member !== 'main') out.add(b.member.split('.').pop()); });
      decls.forEach((d) => { if (c.blocks.has(d.block) && (d.kind === 'member' || d.kind === 'type')) out.add(d.name); });
      return out;
    };
    const chainNames = chains.map((c) => [c, namesOf(c)]);
    allBlocks.filter((b) => b.lang === 'md' && !b.unit).forEach((b) => {
      const mentioned = new Set();
      b.rows.forEach((r) => { if (r.type === '+' || r.type === '-') for (const m of r.text.matchAll(/`([A-Za-z_$][\w$.]*)(?:\(\))?`/g)) mentioned.add(m[1].split('.').pop()); });
      chainNames.forEach(([c, names]) => { if (c.kind !== 'declaration' && [...mentioned].some((x) => names.has(x))) c.blocks.add(b); });
    });
    allBlocks.filter((b) => b.lang === 'dart' && !b.unit).forEach((b) => {
      const imported = [];
      b.rows.forEach((r) => {
        const m = r.type === '+' && /^\s*import\s+['"]([^'"]+)['"]/.exec(r.text);
        const pkg = m && /^package:([^/]+)\/(.+)$/.exec(m[1]);
        if (pkg && packageFile(pkg[1], pkg[2])) imported.push(packageFile(pkg[1], pkg[2]));
        else if (m && !m[1].startsWith('package:') && !m[1].startsWith('dart:')) imported.push(path.normalize(path.join(path.dirname(b.file.p), m[1])));
      });
      if (!imported.length) return;
      chains.forEach((c) => {
        const uses = [...c.blocks].some((x) => x.file === b.file && [...(usesOf.get(x) || new Map()).keys()].some((dk) => imported.includes(decls.get(dk).file)));
        if (uses && c.kind !== 'declaration') c.blocks.add(b);
      });
    });
    // An import prefix (`as p`) starts no chain: its import joins the chains that use it.
    decls.forEach((d) => { if (d.kind === 'import' && !d.block.unit) chains.forEach((c) => { if (c.kind !== 'declaration' && [...d.users].some((u) => c.blocks.has(u))) c.blocks.add(d.block); }); });
    // `part 'x.dart'` makes x.dart part of this library: chains with changes in x.dart take it.
    allBlocks.filter((b) => b.lang === 'dart' && !b.unit).forEach((b) => {
      const parts = [];
      b.rows.forEach((r) => { const m = r.type !== ' ' && /^\s*part\s+['"]([^'"]+)['"]/.exec(r.text); if (m) parts.push(path.normalize(path.join(path.dirname(b.file.p), m[1]))); });
      if (parts.length) chains.forEach((c) => { if (c.kind !== 'declaration' && [...c.blocks].some((x) => parts.includes(x.file.p))) c.blocks.add(b); });
    });
    // Chains with exactly the same changes are one chain, named after the better root.
    const bySet = new Map();
    chains = chains.filter((c) => {
      const k = [...c.blocks].map((b) => b.id).sort().join('|');
      const keep = bySet.get(k);
      if (!keep) { bySet.set(k, c); return true; }
      if (c.root && (!keep.root || rootRank(c.root) < rootRank(keep.root))) { [keep.root, c.root] = [c.root, keep.root]; [keep.name, c.name] = [c.name, keep.name]; }
      [c.root, ...c.also].forEach((d) => { if (d && d !== keep.root && !keep.also.includes(d)) keep.also.push(d); });
      return false;
    });

    // ---------- chains by commit
    // Each commit and its follow-ups make one chain (commits.js), however large: the commit is
    // the unit its author declared. Renames keep their own chains, and a block that is nothing
    // but renames stays out of the commit's chain.
    let history = null;
    if (PROVENANCE && PROVENANCE.commits.some((c) => !c.merge)) {
      history = commitFamilies({ provenance: PROVENANCE, files, blocks: allBlocks });
      // A rename: every edit of the group swaps one name for another (not one literal for another).
      const oneName = (list) => { const words = list.filter((d) => d.tk.k !== 'ws'); return words.length === 1 && identToken(words[0]) && !/^(true|false|null)$/.test(words[0].tk.t); };
      // The same names swapped in different places of the syntax are one rename.
      const swaps = new Map();
      groups.filter((g) => g.edits.every((e) => e.atoms.length === 1 && oneName(e.atoms[0].del) && oneName(e.atoms[0].ins))).forEach((g) => {
        const name = editLabel(g.edits[0]);
        if (!swaps.has(name)) swaps.set(name, { kind: 'group', group: g, groups: new Set(), root: null, blocks: new Set(), name, also: [] });
        const c = swaps.get(name);
        c.groups.add(g.id);
        g.edits.forEach((e) => c.blocks.add(e.block));
      });
      const renames = [...swaps.values()].filter((c) => c.blocks.size > 1);
      const renamed = new Set(renames.flatMap((c) => [...c.groups]));
      const mechanical = (b) => b.edits.some((e) => renamed.has(e.group)) && b.edits.every((e) => e.punct || renamed.has(e.group));
      // A commit's root is what it changes before what tests it.
      const bestRoot = (blocks) => {
        const inside = [...decls.values()].filter((d) => blocks.has(d.block) && d.kind !== 'import' && d.kind !== 'setup')
          .map((d) => ({ d, n: [...d.users].filter((u) => blocks.has(u)).length }));
        inside.sort((x, y) => isTestFile(x.d.file) - isTestFile(y.d.file) || rootRank(x.d) - rootRank(y.d) || y.n - x.n || (x.d.key < y.d.key ? -1 : 1));
        return inside.length ? inside[0].d : null;
      };
      const byCommit = [];
      history.families.forEach((fam, fi) => {
        const own = new Set([...fam.blocks].filter((b) => !mechanical(b)));
        if (own.size) byCommit.push({ kind: 'commit', root: bestRoot(own), blocks: own, name: subjectParts(PROVENANCE.commits[fam.root].subject).text, also: [], support: [...own].every((b) => isTestFile(b.file.p)), familyIndex: fi });
      });
      renames.forEach((c) => { c.familyIndex = history.families.length; });
      chains = byCommit.concat(renames);
    }

    chains.sort((x, y) => y.blocks.size - x.blocks.size || (x.name < y.name ? -1 : 1));
    chains.forEach((c, i) => { c.id = i; c.files = new Set([...c.blocks].map((b) => b.file.p)).size; });

    // Shared validation appears in several chains. Index its changed references once;
    // rescanning every token for every dependency in every chain repeats the same work.
    const referenceLines = new Map();
    const changedReferences = (block) => {
      if (referenceLines.has(block)) return referenceLines.get(block);
      const targets = new Map();
      for (const row of block.rows) {
        if (row.type !== '+') continue;
        for (const token of row.toks) {
          if (!token.atom) continue;
          const target = defsRaw[`${block.file.p}:${row.n}:${token.c}`];
          if (!target?.[0].startsWith(HEAD)) continue;
          const key = `${target[0].slice(HEAD.length)}:${target[1] + 1}`;
          if (!targets.has(key)) targets.set(key, new Set());
          targets.get(key).add(row.n);
        }
      }
      referenceLines.set(block, targets);
      return targets;
    };

    // Graph per chain: nodes are members; blocks whose edits are all one same-change group
    // that appears 3+ times in the chain collapse into one node, and the tests of one test file
    // are one node (by commit, its new tests and their setup too).
    for (const c of chains) {
      const groupCount = new Map();
      c.blocks.forEach((b) => { const gs = new Set(b.edits.map((e) => e.group)); if (gs.size === 1 && [...gs][0] !== undefined) groupCount.set([...gs][0], (groupCount.get([...gs][0]) || 0) + 1); });
      const nodeOf = new Map();
      const nodes = new Map();
      [...c.blocks].sort((x, y) => (x.id < y.id ? -1 : 1)).forEach((b) => {
        const gs = new Set(b.edits.map((e) => e.group));
        const g = gs.size === 1 ? [...gs][0] : undefined;
        const testCase = isTestFile(b.file.p) && /::(test:.*|main|\(top\))$/.test(b.memberKey);
        const newTest = history && isTestFile(b.file.p) && ['test', 'setup'].includes(b.unit?.kind);
        const collapsed = g !== undefined && groupCount.get(g) >= 3;
        // A same change's own chain shows its places as one, even in a test group's setup.
        const own = c.groups ? c.groups.has(g) : c.group && c.group.id === g;
        const key = collapsed && own ? 'group:' + g : newTest ? 'tests:' + b.file.p : b.unit ? 'unit:' + b.unit.id : collapsed ? 'group:' + g : testCase ? 'tests:' + b.file.p : 'member:' + b.memberKey;
        const tests = key.startsWith('tests:');
        if (!nodes.has(key)) nodes.set(key, { key, blocks: [], files: new Set(), group: key.startsWith('group:') ? g : null, member: tests ? null : b.unit ? b.unit.name : testCase ? null : b.member, file: b.file.p, test: b.test, unit: tests ? undefined : b.unit?.id, tests: tests ? new Set() : null });
        const n = nodes.get(key);
        n.blocks.push(b); n.files.add(b.file.p);
        if (n.tests && b.test) n.tests.add(b.test);
        nodeOf.set(b, key);
      });
      const edges = new Map();
      c.blocks.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => {
          const d = decls.get(dk);
          if (!c.blocks.has(d.block)) return;
          const from = nodeOf.get(b), to = nodeOf.get(d.block);
          if (from === to) return;
          const k = from + '>' + to;
          if (!edges.has(k)) edges.set(k, { from, to, labels: new Set() });
          edges.get(k).labels.add(d.name);
        });
      });
      // By commit: the declarations other chains change that this one uses (a function a commit
      // calls, changed by another commit), linked without moving their changes here.
      const ext = new Map();
      if (history) c.blocks.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => {
          const d = decls.get(dk);
          if (d.removed || (d.kind !== 'member' && d.kind !== 'type') || c.blocks.has(d.block)) return;
          if (!ext.has(dk)) ext.set(dk, { d, from: new Set() });
          ext.get(dk).from.add(nodeOf.get(b));
        });
      });
      c.ext = [...ext.values()];
      c.focus = {};
      decls.forEach((d) => {
        if (!c.blocks.has(d.block) || d.removed) return;
        const inChainUsers = [...d.users].filter((u) => c.blocks.has(u));
        if (!inChainUsers.length && d !== c.root) return;
        (c.focus[d.block.id] = c.focus[d.block.id] || new Set()).add(d.line);
      });
      c.blocks.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => {
          const d = decls.get(dk);
          if (!c.blocks.has(d.block)) return;
          for (const line of changedReferences(b).get(`${d.file}:${d.line}`) || []) {
            (c.focus[b.id] = c.focus[b.id] || new Set()).add(line);
          }
        });
      });
      const rootKey = c.root ? nodeOf.get(c.root.block) : [...nodes.keys()][0];
      // Layers: distance from the root over links in either direction.
      const adj = new Map([...nodes.keys()].map((k) => [k, new Set()]));
      edges.forEach((e) => { adj.get(e.from).add(e.to); adj.get(e.to).add(e.from); });
      const layer = new Map([[rootKey, 0]]);
      const q = [rootKey];
      while (q.length) { const x = q.shift(); [...adj.get(x)].sort().forEach((y) => { if (!layer.has(y)) { layer.set(y, layer.get(x) + 1); q.push(y); } }); }
      const maxLayer = Math.max(0, ...layer.values());
      nodes.forEach((n, k) => { if (!layer.has(k)) layer.set(k, maxLayer + 1); });
      c.graph = {
        root: rootKey,
        nodes: [...nodes.values()].map((n) => ({ key: n.key, layer: layer.get(n.key), group: n.group, member: n.member, file: n.file, files: n.files.size, test: n.test, unit: n.unit, tests: n.tests ? n.tests.size : undefined, blocks: n.blocks.map((b) => b.id) }))
          .sort((x, y) => x.layer - y.layer || (x.file < y.file ? -1 : x.file > y.file ? 1 : (x.key < y.key ? -1 : 1))),
        edges: [...edges.values()].map((e) => ({ from: e.from, to: e.to, labels: [...e.labels].sort() })),
      };
    }
    // A collapsed same-change group is still available in the group view. A self-contained
    // new implementation is still available by file. Neither is a one-node chain, and
    // file-local new code does not need a separate chain navigation entry.
    // By commit, every chain stays: a commit's changes are its chain, however few.
    chains = chains.filter((c) => {
      const changes = new Set([...c.blocks].filter((block) => block.edits.length).map((block) => block.unit || block));
      if (history) return changes.size > 0;
      return changes.size > 1 && c.graph.nodes.length > 1 && (c.kind !== 'declaration' || c.files > 1);
    });
    chains.forEach((c, i) => { c.id = i; });

    // Linked chains: a block of one chain uses a member that roots another, or they share blocks.
    const rootChain = new Map(chains.filter((c) => c.root).map((c) => [c.root.key, c]));
    chains.forEach((c) => {
      const links = new Set();
      c.blocks.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => { const o = rootChain.get(dk); if (o && o !== c) links.add(o.id); });
        chains.forEach((o) => { if (o !== c && o.blocks.has(b)) links.add(o.id); });
      });
      c.links = [...links].sort((x, y) => x - y);
      c.shares = new Set();
      chains.forEach((o) => { if (o !== c && [...c.blocks].some((b) => !isTestFile(b.file.p) && o.blocks.has(b))) c.shares.add(o.id); });
    });
    // A chain's core is the changes of its root's member (all its changes when it has no root).
    // Chain A uses chain B when A's core uses a function, method, field or type of B's core.
    chains.forEach((c) => {
      const mk = c.root ? c.root.block.memberKey : null;
      c.core = new Set([...c.blocks].filter((b) => (c.support || !isTestFile(b.file.p)) && (b.unit || !mk || b.memberKey === mk)));
    });
    chains.forEach((c) => {
      c.uses = new Set();
      c.core.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => {
          const d = decls.get(dk);
          if (d.kind !== 'member' && d.kind !== 'type' && !chains.some((o) => o.root === d)) return;
          chains.forEach((o) => { if (o !== c && o.core.has(d.block) && !c.core.has(d.block)) c.uses.add(o.id); });
        });
      });
    });
    // Depth: longest path from a chain nobody uses, ignoring back edges of cycles. By commit,
    // chains have no levels: they follow the commits.
    const levelUses = (c) => (history ? [] : [...c.uses]);
    const depth = new Map();
    const usedBy = new Map(chains.map((c) => [c.id, []]));
    chains.forEach((c) => levelUses(c).forEach((o) => usedBy.get(o).push(c.id)));
    const state = new Map();
    const order = [];
    const visit = (id) => { state.set(id, 1); levelUses(chains[id]).sort((a, b) => a - b).forEach((o) => { if (!state.has(o)) visit(o); }); state.set(id, 2); order.push(id); };
    chains.forEach((c) => { if (!state.has(c.id)) visit(c.id); });
    order.reverse().forEach((id) => {
      const parents = usedBy.get(id).filter((p) => order.indexOf(p) < order.indexOf(id));
      depth.set(id, parents.length ? Math.max(...parents.map((p) => depth.get(p) + 1)) : 0);
    });
    // Families: chains connected by uses or shared changes; by commit, the commit's chains.
    const fam = new Map();
    let famId = 0;
    chains.forEach((c) => {
      if (history) { fam.set(c.id, c.familyIndex); return; }
      if (fam.has(c.id)) return;
      const stack = [c.id];
      fam.set(c.id, famId);
      while (stack.length) {
        const x = stack.pop(), ch = chains[x];
        // Shared test infrastructure does not combine otherwise independent production work.
        const neighbors = ch.support ? [] : [...ch.uses, ...usedBy.get(x), ...ch.shares].filter((y) => !chains[y].support);
        neighbors.forEach((y) => { if (!fam.has(y)) { fam.set(y, famId); stack.push(y); } });
      }
      famId++;
    });
    chains.forEach((c) => { c.depth = depth.get(c.id); c.family = fam.get(c.id); });

    // ---------- serialize
    const fileIndex = new Map(files.map((f, i) => [f, i]));
    // By commit: each commit's chain, what started it and what changed it later. The last
    // family holds the same changes.
    const familiesOut = (h) => {
      const commit = (i) => PROVENANCE.commits[i];
      const chainsOf = (fi) => chains.filter((c) => c.familyIndex === fi).map((c) => c.id);
      return h.families.map((f, fi) => {
        const sub = subjectParts(commit(f.root).subject);
        return {
          id: fi, sha: commit(f.root).sha, kind: sub.kind, subject: sub.text, body: commit(f.root).body,
          commits: f.commits.map((i) => ({ sha: commit(i).sha, subject: commit(i).subject, role: h.roles[i].role })),
          revisedBy: f.revisedBy.map(([i, lines]) => ({ sha: commit(i).sha, subject: commit(i).subject, lines })),
          buildsOn: f.buildsOn, revises: f.revises, chains: chainsOf(fi),
        };
      }).concat([{ id: h.families.length, same: true, chains: chainsOf(h.families.length) }]);
    };
    // By commit: each declaration a chain uses that other chains change, with the chain to read it
    // in (a commit's before a rename's) and the members here that use it.
    const extOut = (c) => c.ext.map(({ d, from }) => {
      const owners = chains.filter((o) => o.blocks.has(d.block)).sort((x, y) => (x.kind === 'commit' ? 0 : 1) - (y.kind === 'commit' ? 0 : 1) || x.id - y.id);
      return owners.length ? { name: label(d), file: d.file, line: d.line, block: d.block.id, chain: owners[0].id, from: [...from].sort() } : null;
    }).filter(Boolean).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    // What a same-change token resolves to on the new side: [key, label]. The group view lists
    // its places under each declaration.
    const symOf = (e) => {
      const d = e.atom.ins[0];
      const t = d && defsRaw[`${e.block.file.p}:${d.row.n}:${d.tk.c}`];
      if (!t) return undefined;
      const inRepo = t[0].startsWith(HEAD);
      const dt = diskTree(t[0]);
      const word = dt && /^@?[A-Za-z_$][\w$]*/.exec((dt.lines[t[1]] || '').slice(t[2]));
      const at = dt && memberAt(dt.tree, t[1] + 1, ' '.repeat(t[2]) + 'x');
      const name = word ? word[0].replace(/^@/, '') : '?';
      const lbl = dt ? label({ name, kind: declKind(dt.tree, t[1] + 1, t[2]), member: at && at.member, file: inRepo ? t[0].slice(HEAD.length) : t[0] }) : name;
      return [(inRepo ? t[0].slice(HEAD.length) : path.basename(t[0])) + ':' + (t[1] + 1) + ':' + t[2], lbl];
    };
    // A moved declaration's body diff: [type, text, old line, new line, changed ranges].
    const rowOut = (r) => {
      const ranges = [];
      (r.toks || []).forEach((tk) => { if (tk.atom) ranges.push([tk.c, tk.c + tk.t.length, editOfAtom.get(tk.atom).id]); });
      return ranges.length ? [r.type, r.text, r.o, r.n, ranges] : [r.type, r.text, r.o, r.n];
    };
    // Where a hunk starts inside a string or a comment over several lines, on either side: what
    // opens it (so, sn). The page highlights a hunk's lines alone, as if after it.
    const openings = (dir, p) => { try { return dartOpenings(fs.readFileSync(dir + p, 'utf8')); } catch { return null; } };
    const startsIn = (f) => {
      const dart = /\.dart$/.test(f.p);
      const was = dart && OLD[name] ? openings(OLD[name].dir, f.p) : null, is = dart ? openings(HEAD, f.p) : null;
      return (h) => { const so = was && h.o > 0 && was[h.o - 1], sn = is && h.n > 0 && is[h.n - 1]; return { ...(so ? { so } : {}), ...(sn ? { sn } : {}) }; };
    };
    const ser = {
      label: meta.label, left: meta.left.slice(0, 7), right: meta.right.slice(0, 7),
      files: files.map((f) => { const at = startsIn(f); return {
        p: f.p, s: f.s, a: f.a, d: f.d, lang: f.lang,
        hunks: f.hunks.map((h) => ({ o: h.o, n: h.n, h: h.h, ...at(h), rows: h.rows.map((r) => {
          const row = [r.type, r.text];
          if (r.toks) {
            const ranges = [];
            r.toks.forEach((tk) => { if (tk.atom) ranges.push([tk.c, tk.c + tk.t.length, editOfAtom.get(tk.atom).id]); });
            if (ranges.length) row.push(ranges);
          }
          return row;
        }) })),
        blocks: f.blocks.map((b) => ({ id: b.id, hunk: b.hunk, first: b.first, len: b.rows.length, adds: b.adds, dels: b.dels, member: b.member, test: b.test, grp: b.group || undefined, mk: b.memberKey, unit: b.unit?.id, documents: b.documents || undefined, edits: b.edits.map((e) => e.id),
          move: b.move ? { f: fileIndex.get(b.move.file), b: b.move.from.id, rows: b.move.rows.map(rowOut) } : undefined,
          movedTo: b.movedTo ? { f: fileIndex.get(b.movedTo.file), b: b.movedTo.block.id, n: (b.movedTo.block.rows.find((r) => r.text.trim()) || b.movedTo.block.rows[0]).n, changes: b.movedTo.block.edits.length } : undefined })),
        // A test file's tests as sentences: its group and test calls, matched and compared.
        outline: f.lang === 'dart' && TEST_FILE.test(f.p) ? testOutline(f) || undefined : undefined,
      }; }),
      units: units.map((u) => ({ id: u.id, kind: u.kind, name: u.name, file: u.file, start: u.start, end: u.end, blocks: [...u.blocks].map((b) => b.id) })),
      edits: edits.map((e) => ({ id: e.id, f: fileIndex.get(e.block.file), b: e.block.id, op: e.op, where: e.where, from: e.from.slice(0, 400), to: e.to.slice(0, 400), group: e.group, comment: e.commentOnly || undefined, os: e.oldSpan, ns: e.newSpan, sym: e.group != null && e.op === 'token' ? symOf(e) : undefined })),
      groups: groups.map((g) => ({ id: g.id, count: g.count, files: g.files, parts: g.parts.map((p) => p.edits[0].id), edits: g.edits.map((e) => e.id) })),
      chainsBy: history ? 'history' : 'structure',
      families: history ? familiesOut(history) : undefined,
      chains: chains.map((c) => ({ id: c.id, name: c.name, kind: c.kind, rootKind: c.root ? c.root.kind : null, also: c.also.map(label).filter((x, i, a) => x !== c.name && a.indexOf(x) === i), blocks: [...c.blocks].map((b) => b.id).sort(), files: c.files, graph: c.graph, ext: history ? extOut(c) : undefined, links: c.links, uses: [...c.uses].sort((a, b) => a - b), shares: [...c.shares].sort((a, b) => a - b), depth: c.depth, family: c.family, adds: [...c.blocks].reduce((x, b) => x + b.adds, 0), dels: [...c.blocks].reduce((x, b) => x + b.dels, 0), focus: Object.fromEntries(Object.entries(c.focus).map(([k, v]) => [k, [...v].sort((x, y) => x - y)])) })),
      generated: generated.map((f) => { const at = startsIn(f); return { p: f.p, s: f.s, a: f.a, d: f.d, gen: f.gen, hunks: f.hunks ? f.hunks.map((h) => ({ o: h.o, n: h.n, h: h.h, ...at(h), rows: h.l.map((l) => [l[0], l.slice(1)]) })) : null }; }),
    };
    out.compares[name] = ser;
    const inChain = new Set(chains.flatMap((c) => [...c.blocks]));
    if (history) log(`${name}: by commit, ${history.families.length} commit chains from ${PROVENANCE.commits.filter((c) => !c.merge).length} commits`);
    log(`${name}: ${files.length} files, ${allBlocks.length} change blocks, ${edits.length} edits, ${groups.length} same-change groups (${groups.reduce((s, g) => s + g.edits.length, 0)} edits), ${chains.length} chains covering ${inChain.size} blocks, ${allBlocks.length - inChain.size} not in a chain, generated ${generated.length} (${generated.filter((g) => g.hunks).length} peekable)`);
    chains.slice(0, 14).forEach((c) => log(`   chain ${String(c.blocks.size).padStart(3)} blocks · ${String(c.files).padStart(2)} files · ${c.graph.nodes.length} nodes · ${c.name}${c.also.length ? '  also: ' + c.also.map(label).join(', ') : ''}  links: ${c.links.length}`));
    const names = chains.map((c) => c.name); log('   duplicate chain names:', names.filter((n, i) => names.indexOf(n) !== i).length);
    groups.slice(0, 8).forEach((g) => { const e = edits[g.parts[0].edits[0].id]; log(`   group ×${g.count} ${e.op} in ${e.where}: ${e.from.slice(0, 40)} → ${e.to.slice(0, 40)}`); });
  }
  return out;
  } finally {
    for (const tree of trees) tree.delete();
    parser.delete();
  }
}
