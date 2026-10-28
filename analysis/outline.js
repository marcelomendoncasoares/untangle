// The test outline of a test file: its group and test calls on both sides, as trees, with what
// changed in each. A test's sentence is the titles from its outermost group down to it, joined as
// written ("Given …, when …, then …."), so the viewer can show a file's tests as the sentences
// they assert, nested the way the calls nest.
//
// Calls are matched by position, as the analyzer has them: a call whose line stayed is the same
// call, and a new title on it is a rewording. Tests are then compared as whole sentences: renaming
// a Given rewords every test under it, and a test that reads the same in a new group is regrouped,
// not new. Each call carries the change blocks in its range, in its own lines (a group's setup,
// without its calls) and in its title, so the viewer can scope all of it to a chain. A test counts
// its expect calls, and a group says whether it sets anything up: setUp, setUpAll, or a variable
// with a value in its own body, which the calls under it share.

const CLAUSE = /^\s*(given|when|then)\b/i;
const TESTS = new Set(['test', 'testWidgets']);
const SETUP = /^setUp(All)?\s*\(/;
const EXPECT = new Set(['expect', 'expectLater']);

// The expect calls in a test: expect and expectLater called by name (not a method of something).
const expectsIn = (node) => node.descendantsOfType('identifier').filter((id) => {
  if (!EXPECT.has(id.text)) return false;
  const next = id.nextNamedSibling;
  return !!next && next.type === 'selector' && next.namedChild(0)?.type === 'argument_part';
}).length;

// A call statement with a title: test, testWidgets and group, or a wrapper whose first argument is
// a string (Serverpod's withServerpod, say), which counts as a group when it holds calls.
function callOf(node) {
  if (node.type !== 'expression_statement') return null;
  const m = /^([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/.exec(node.text.slice(0, 160));
  if (!m) return null;
  const args = node.namedChildren.find((c) => c.type === 'selector')?.descendantsOfType('arguments')[0];
  const arg = args?.namedChildren.find((c) => c.type === 'argument');
  if (!arg) return null;
  const literal = /^r?['"]/.test(arg.text);
  const kind = TESTS.has(m[1]) ? 't' : m[1] === 'group' ? 'g' : literal ? 'w' : null;
  if (!kind) return null;
  const strings = literal ? [...arg.text.matchAll(/r?(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g)] : [];
  // A title split into adjacent strings reads with a space where they meet, which the first so
  // often forgets ('… 4 times,' 'then …').
  const title = strings.length ? strings.map((x) => x[2].replace(/\\(['"\\])/g, '$1')).reduce((a, b) => (/\S$/.test(a) && /^\S/.test(b) ? a + ' ' + b : a + b)) : arg.text;
  // A group that declares a variable with a value in its own body (not in a setUp's or a test's)
  // shares it with the calls under it, which sets their scenario up as setUp would.
  const block = kind !== 't' && args.namedChildren.map((a) => a.namedChild(0)).find((x) => x?.type === 'function_expression')
    ?.namedChildren.find((x) => x.type === 'function_expression_body')?.namedChildren.find((x) => x.type === 'block');
  const su = !!block && block.namedChildren.some((x) => x.type === 'local_variable_declaration' && x.descendantsOfType('=').length > 0);
  return { kind, title, s: node.startPosition.row + 1, e: node.endPosition.row + 1, te: arg.endPosition.row + 1, su };
}

// The calls of a tree, nested, a test with its expect calls and a group with whether it sets up.
// A wrapper that holds no calls is an ordinary call, not a group.
function callsOf(tree) {
  if (!tree) return [];
  const roots = [];
  const walk = (node, parent) => {
    let here = parent;
    const c = callOf(node);
    if (c) {
      here = { ...c, kids: [], parent };
      if (c.kind === 't') here.x = expectsIn(node);
      (parent ? parent.kids : roots).push(here);
    } else if (parent && node.type === 'expression_statement' && SETUP.test(node.text.slice(0, 12))) parent.su = true;
    if (!c || c.kind !== 't') for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i), here);
  };
  walk(tree.rootNode, null);
  const keep = (list, parent) => list.flatMap((c) => {
    c.kids = keep(c.kids, c);
    if (c.kind === 'w' && !c.kids.length) return [];
    c.parent = parent;
    return [c];
  });
  return keep(roots, null);
}
const flat = (roots) => { const out = []; const visit = (c) => { out.push(c); c.kids.forEach(visit); }; roots.forEach(visit); return out; };
const isLabel = (c) => c.kind === 'w' && !CLAUSE.test(c.title);
const pathOf = (c) => { const out = []; for (let x = c; x; x = x.parent) out.unshift(x); return out; };
const clausesOf = (c) => pathOf(c).filter((x) => !isLabel(x)).map((x) => x.title.trim());
const sentenceOf = (c) => clausesOf(c).join(' ');
const loose = (s) => s.replace(/[,\s]+/g, ' ').trim();

// The diff of a file, line by line: which lines each side added or removed, their text and block,
// and the old line of each new line that stayed.
function linesOf(f) {
  const added = new Map(), removed = new Map(), kept = new Map(), deltas = [];
  for (const h of f.hunks || []) {
    let o = h.o, n = h.n;
    for (const r of h.rows) {
      if (r.type === '+') { added.set(n, { text: r.text, block: -1 }); n++; } else if (r.type === '-') { removed.set(o, { text: r.text, block: -1 }); o++; } else { kept.set(n, o); o++; n++; }
    }
    deltas.push([n, o - n]);
  }
  (f.blocks || []).forEach((b, k) => b.rows.forEach((r) => {
    if (r.type === '+' && added.has(r.n)) added.get(r.n).block = k;
    if (r.type === '-' && removed.has(r.o)) removed.get(r.o).block = k;
  }));
  const toOld = (n) => {
    if (added.has(n)) return null;
    if (kept.has(n)) return kept.get(n);
    let delta = 0;
    for (const [after, d] of deltas) { if (n >= after) delta = d; else break; }
    return n + delta;
  };
  return { added, removed, toOld };
}

/** The outline of a test file, or null when neither side holds a test or a group. */
export function testOutline(f) {
  const now = callsOf(f.newTree), was = callsOf(f.oldTree);
  if (!now.length && !was.length) return null;
  const nowAll = flat(now), wasAll = flat(was);
  const { added, removed, toOld } = linesOf(f);
  const match = new Map(), back = new Map();
  const pair = (n, o) => { match.set(n, o); back.set(o, n); };
  // 1. The same call: its line stayed.
  for (const n of nowAll) {
    const line = toOld(n.s);
    const o = line == null ? null : wasAll.find((x) => x.s === line && x.kind === n.kind && !back.has(x));
    if (o) pair(n, o);
  }
  // 2. The same title, moved: under the same group when it can be.
  for (const n of nowAll) {
    if (match.has(n)) continue;
    const same = wasAll.filter((x) => !back.has(x) && x.kind === n.kind && x.title === n.title);
    if (!same.length) continue;
    const under = n.parent ? match.get(n.parent) : null;
    pair(n, same.find((x) => x.parent === (under || null)) || same[0]);
  }
  // 3. A new title on a rewritten call line, in order among its siblings.
  for (const n of nowAll) {
    if (match.has(n) || !added.has(n.s)) continue;
    const under = n.parent ? match.get(n.parent) : null;
    if (n.parent && !under) continue;
    const o = (under ? under.kids : was).find((x) => !back.has(x) && x.kind === n.kind && removed.has(x.s));
    if (o) pair(n, o);
  }
  // 4. A test that reads as it did, in new groups.
  for (const n of nowAll) {
    if (match.has(n) || n.kind !== 't') continue;
    const o = wasAll.find((x) => !back.has(x) && x.kind === 't' && loose(sentenceOf(x)) === loose(sentenceOf(n)));
    if (o) pair(n, o);
  }

  const index = new Map(nowAll.map((n, i) => [n, i]));
  const blocksIn = (map, a, b, skip = []) => {
    const rows = [];
    if (a == null) return rows;
    for (let line = a; line <= b; line++) {
      const r = map.get(line);
      if (r && !skip.some(([s, e]) => line >= s && line <= e)) rows.push(r);
    }
    return rows;
  };
  const ids = (rows) => [...new Set(rows.map((r) => r.block).filter((k) => k >= 0))].sort((x, y) => x - y);
  // Changed lines that say something (not blank, not only closing brackets, which the diff pairs
  // with whichever brace it likes), per block: [block, added, removed].
  const counts = (adds, dels) => {
    const by = new Map();
    for (const [rows, at] of [[adds, 1], [dels, 2]]) for (const r of rows) {
      if (r.block < 0 || /^[\s})\];,]*$/.test(r.text)) continue;
      if (!by.has(r.block)) by.set(r.block, [r.block, 0, 0]);
      by.get(r.block)[at]++;
    }
    return [...by.values()].sort((x, y) => x[0] - y[0]);
  };

  const nodes = nowAll.map((n) => {
    const o = match.get(n) || null;
    const out = { k: n.kind, t: n.title, s: n.s, e: n.e };
    if (n.parent) out.p = index.get(n.parent);
    if (isLabel(n)) out.l = 1;
    if (o) { out.os = o.s; out.oe = o.e; if (o.title !== n.title) out.ot = o.title; }
    // Where the calls under it were, so its own old lines can be told from theirs.
    if (o && o.kids.length) out.ok = o.kids.map((c) => [c.s, c.e]);
    if (n.kind === 't') out.x = n.x;
    else if (n.su) out.su = 1;
    if (n.kind === 't') {
      if (!o) out.st = 'new';
      else {
        const before = sentenceOf(o), after = sentenceOf(n);
        const sameWords = before === after && clausesOf(o).join('\n') === clausesOf(n).join('\n');
        out.st = sameWords ? 'same' : loose(before) === loose(after) ? 'regrouped' : 'reworded';
        if (!sameWords) out.was = before;
      }
    } else out.st = !o ? 'new' : o.title !== n.title ? 'renamed' : 'same';
    // Its blocks: in its range, in its own lines (without its title and its calls), in its title.
    const kids = (n.kind === 't' ? [] : n.kids.map((c) => [c.s, c.e])).concat([[n.s, n.te]]);
    const oldKids = (o && n.kind !== 't' ? o.kids.map((c) => [c.s, c.e]) : []).concat(o ? [[o.s, o.te]] : []);
    const all = blocksIn(added, n.s, n.e).concat(o ? blocksIn(removed, o.s, o.e) : []);
    const ownAdds = blocksIn(added, n.s, n.e, kids), ownDels = o ? blocksIn(removed, o.s, o.e, oldKids) : [];
    const head = blocksIn(added, n.s, n.te).concat(o ? blocksIn(removed, o.s, o.te) : []);
    if (all.length) out.b = ids(all);
    const own = counts(ownAdds, ownDels);
    if (own.length) out.own = own;
    if (head.length) out.head = ids(head);
    return out;
  });

  // Calls that are gone, at their highest removed level, with the sentences they held.
  const gone = wasAll.filter((o) => !back.has(o) && (!o.parent || back.has(o.parent)));
  const removedOut = gone.map((o) => {
    const leaves = flat([o]).filter((x) => x.kind === 't').map(sentenceOf);
    const out = { k: o.kind, t: o.title, os: o.s, oe: o.e, leaves };
    if (o.parent) out.p = index.get(back.get(o.parent));
    if (isLabel(o)) out.l = 1;
    const b = ids(blocksIn(removed, o.s, o.e));
    if (b.length) out.b = b;
    return out;
  });

  // Blocks with changes outside every call: imports, helpers. Closing brackets alone don't count
  // when the rest of their block is a call's: a block runs to where the next one starts, so the
  // last test's holds the brace that closes main.
  const inside = (line, roots) => roots.some((c) => line >= c.s && line <= c.e);
  const outside = new Set(), within = new Set(), brackets = new Set();
  for (const [lines, roots] of [[added, now], [removed, was]]) {
    for (const [line, r] of lines) {
      if (r.block < 0 || !r.text.trim()) continue;
      if (inside(line, roots)) within.add(r.block);
      else (/^[\s})\];,]*$/.test(r.text) ? brackets : outside).add(r.block);
    }
  }
  brackets.forEach((k) => { if (!within.has(k)) outside.add(k); });

  const out = { nodes };
  if (removedOut.length) out.removed = removedOut;
  if (outside.size) out.out = [...outside].sort((x, y) => x - y);
  return out;
}
