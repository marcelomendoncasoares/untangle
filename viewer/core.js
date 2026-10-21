// Review core: deterministic, no heuristics beyond a tokenizer and an LCS.
// The same functions run in node (to measure) and in the prototype page.
(function (root) {
  const DART_KW = new Set(('abstract as assert async await base break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync this throw true try type typedef var void when while with yield').split(' '));
  const YAML_KW = new Set(['true', 'false', 'null']);

  function langOf(path) {
    if (/\.dart$/.test(path)) return 'dart';
    if (/\.(ya?ml|spy)$/.test(path)) return 'yaml';
    if (/\.(md|markdown|mdown)$/i.test(path)) return 'md';
    if (/\.sql$/.test(path)) return 'sql';
    if (/\.json$/.test(path)) return 'json';
    return 'text';
  }

  // Words inside comments and strings become separate tokens of that kind, so an edit
  // inside a comment or a string is as small as the words that changed.
  const WORDS = /\s+|[A-Za-z_$][\w$]*|\d+|[^\sA-Za-z_$\d]/g;
  function words(text, kind, col, out) {
    let m;
    WORDS.lastIndex = 0;
    while ((m = WORDS.exec(text))) out.push({ t: m[0], k: /^\s/.test(m[0]) ? 'ws' : kind, c: col + m.index });
  }

  const OPS = ['>>>=', '...', '??=', '>>=', '<<=', '=>', '??', '?.', '..', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '<<', '::'];

  // Where braces opening at k close (the index after the "}"), past strings inside them.
  function braceEnd(line, k) {
    let depth = 0;
    for (let j = k; j < line.length; j++) {
      if (line[j] === '{') depth++;
      else if (line[j] === '}' && --depth === 0) return j + 1;
      else if (line[j] === "'" || line[j] === '"') j = stringEnd(line, j) - 1;
    }
    return line.length;
  }
  // Where a string opening at j ends (the index after its quote), past interpolations in it.
  function stringEnd(line, j) {
    for (let x = j + 1; x < line.length; x++) {
      if (line[x] === '\\') x++;
      else if (line[x] === '$' && line[x + 1] === '{') x = braceEnd(line, x + 1) - 1;
      else if (line[x] === line[j]) return x + 1;
    }
    return line.length;
  }
  // A Dart string's text between from and to, its interpolations as code: "$name", whose name is
  // a token of its own, and "${expression}", whose expression is tokenized as code.
  function interpolated(line, from, to, out, opts) {
    let text = from;
    for (let j = from; j < to; j++) {
      if (line[j] === '\\') { j++; continue; }
      if (line[j] !== '$') continue;
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(j + 1, to));
      if (!name && line[j + 1] !== '{') continue;
      words(line.slice(text, j), 'str', text, out);
      if (name) {
        const w = name[0];
        out.push({ t: '$', k: 'op', c: j }, { t: w, k: DART_KW.has(w) ? 'kw' : /^_?[A-Z]/.test(w) ? 'ty' : 'id', c: j + 1 });
        text = j + 1 + w.length;
      } else {
        const end = Math.min(braceEnd(line, j + 1), to);
        const closed = line[end - 1] === '}' && end - 1 >= j + 2;
        out.push({ t: '${', k: 'op', c: j });
        tokenize(line.slice(j + 2, closed ? end - 1 : end), 'dart', opts).forEach((tk) => out.push({ ...tk, c: tk.c + j + 2 }));
        if (closed) out.push({ t: '}', k: 'op', c: end - 1 });
        text = end;
      }
      j = text - 1;
    }
    words(line.slice(text, to), 'str', text, out);
  }

  // A line as tokens. opts.interpolations: a Dart string's interpolations are code (the page
  // shows them so); left out, a string is words, as changes are matched.
  function tokenize(line, lang, opts) {
    const out = [];
    let i = 0;
    const n = line.length;
    const interp = lang === 'dart' && !!(opts && opts.interpolations);
    const lineComment = lang === 'dart' || lang === 'json' ? '//' : lang === 'sql' ? '--' : null;
    while (i < n) {
      const ch = line[i];
      const rest = line.slice(i);
      let m;
      if ((m = /^\s+/.exec(rest))) { out.push({ t: m[0], k: 'ws', c: i }); i += m[0].length; continue; }
      if (lang === 'md') { words(rest, 'md', i, out); break; }
      if (lineComment && rest.startsWith(lineComment)) {
        const lead = /^\/\/\/?|^--/.exec(rest)[0];
        out.push({ t: lead, k: 'com', c: i });
        words(rest.slice(lead.length), 'com', i + lead.length, out);
        break;
      }
      if (lang === 'yaml' && ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        const lead = /^#+/.exec(rest)[0];
        out.push({ t: lead, k: 'com', c: i });
        words(rest.slice(lead.length), 'com', i + lead.length, out);
        break;
      }
      if (lang === 'dart' && rest.startsWith('/*')) {
        const end = rest.indexOf('*/', 2);
        const len = end < 0 ? rest.length : end + 2;
        words(rest.slice(0, len), 'com', i, out);
        i += len;
        continue;
      }
      if (ch === "'" || ch === '"' || (ch === 'r' && (line[i + 1] === "'" || line[i + 1] === '"'))) {
        const start = i;
        const code = interp && ch !== 'r';
        let j = ch === 'r' ? i + 1 : i;
        const q = line[j];
        j++;
        while (j < n && line[j] !== q) j = code && line[j] === '$' && line[j + 1] === '{' ? braceEnd(line, j + 1) : j + (line[j] === '\\' && ch !== 'r' ? 2 : 1);
        j = Math.min(n, j + 1);
        out.push({ t: line[start] === 'r' ? 'r' + q : q, k: 'str', c: start });
        const bodyStart = start + (ch === 'r' ? 2 : 1);
        const closed = j <= n && line[j - 1] === q && j - 1 >= bodyStart;
        const bodyEnd = closed ? j - 1 : j;
        if (code) interpolated(line, bodyStart, bodyEnd, out, opts);
        else words(line.slice(bodyStart, bodyEnd), 'str', bodyStart, out);
        if (closed) out.push({ t: q, k: 'str', c: j - 1 });
        i = j;
        continue;
      }
      if ((m = /^(0x[0-9a-fA-F]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(rest))) { out.push({ t: m[0], k: 'num', c: i }); i += m[0].length; continue; }
      if (ch === '@' && (m = /^@[A-Za-z_]\w*/.exec(rest))) { out.push({ t: m[0], k: 'ann', c: i }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
        const w = m[0];
        let k = 'id';
        if (lang === 'dart' && DART_KW.has(w)) k = 'kw';
        else if (lang === 'yaml' && YAML_KW.has(w)) k = 'kw';
        else if (lang === 'dart' && /^_?[A-Z]/.test(w)) k = 'ty';
        else if (lang === 'yaml' && line.slice(i + w.length).startsWith(':')) k = 'key';
        out.push({ t: w, k, c: i });
        i += w.length;
        continue;
      }
      const op = OPS.find((o) => rest.startsWith(o));
      out.push({ t: op || ch, k: 'op', c: i });
      i += (op || ch).length;
    }
    return out;
  }

  // Longest common subsequence over token texts; ties prefer deleting first, so the
  // output is the same on every run.
  const MAX_CELLS = 4e6;
  function lcsOps(a, b) {
    const n = a.length, m = b.length;
    if (n === 0) return b.map(() => 'i');
    if (m === 0) return a.map(() => 'd');
    if (n * m > MAX_CELLS) return null;
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        dp[x * w + y] = a[x] === b[y] ? dp[(x + 1) * w + y + 1] + 1 : Math.max(dp[(x + 1) * w + y], dp[x * w + y + 1]);
      }
    }
    const ops = [];
    let x = 0, y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { ops.push('e'); x++; y++; }
      else if (dp[(x + 1) * w + y] >= dp[x * w + y + 1]) { ops.push('d'); x++; }
      else { ops.push('i'); y++; }
    }
    while (x < n) { ops.push('d'); x++; }
    while (y < m) { ops.push('i'); y++; }
    return ops;
  }

  // What two tokens must share to match: the text, the kind for comment and string
  // words, and the nesting depth for brackets, so a ")" only matches a ")" that closes
  // the same level.
  function matchKeys(list) {
    let depth = 0;
    return list.map(({ tk }) => {
      if (tk.k === 'com' || tk.k === 'str') return tk.k + ':' + tk.t;
      if (tk.k === 'op' && '([{'.includes(tk.t)) return tk.t + (depth++);
      if (tk.k === 'op' && ')]}'.includes(tk.t)) return tk.t + (--depth);
      return tk.t;
    });
  }

  // A file's hunks become change blocks (runs of -/+ lines between context lines).
  // Each block is tokenized; whitespace is dropped for matching; an LCS over the
  // remaining tokens yields atoms: maximal runs of removed/added tokens.
  // opts.split(block) may return row indexes (inside the block) where a new block starts;
  // the pieces are diffed again on their own.
  function analyzeFile(file, opts) {
    const lang = langOf(file.p);
    let blocks = [];
    (file.hunks || []).forEach((h, hi) => {
      let o = h.o, nn = h.n;
      const rows = h.l.map((raw) => {
        const type = raw[0];
        const text = raw.slice(1);
        const row = { type, text, o: type !== '+' ? o : null, n: type !== '-' ? nn : null };
        if (type !== '+') o++;
        if (type !== '-') nn++;
        return row;
      });
      let cur = null;
      rows.forEach((row, ri) => {
        if (row.type === ' ') { cur = null; return; }
        if (!cur) { cur = { hunk: hi, rows: [], first: ri }; blocks.push(cur); }
        cur.rows.push(row);
      });
      h.rows = rows;
    });
    blocks.forEach((b) => diffBlock(b, lang));
    if (opts && opts.split) {
      const out = [];
      blocks.forEach((b) => {
        const cuts = (opts.split(b) || []).filter((c) => c > 0 && c < b.rows.length).sort((x, y) => x - y);
        if (!cuts.length) { out.push(b); return; }
        let start = 0;
        [...new Set(cuts), b.rows.length].forEach((end) => {
          const piece = { hunk: b.hunk, rows: b.rows.slice(start, end), first: b.first + start };
          diffBlock(piece, lang);
          out.push(piece);
          start = end;
        });
      });
      blocks = out;
    }
    blocks.forEach((b, bi) => {
      b.id = file.p + '#' + bi;
      b.file = file;
      b.atoms.forEach((a, ai) => { a.id = b.id + '.' + ai; });
    });
    file.blocks = blocks;
    file.lang = lang;
    return file;
  }

  // Tokens of one block, its LCS, and its atoms. Matched tokens keep a pointer to their
  // counterpart (tk.peer) so a later pass can compare what each side refers to.
  function diffBlock(b, lang) {
    b.lang = lang;
    const del = [], ins = [];
    b.rows.forEach((row) => {
      const toks = tokenize(row.text, lang);
      row.toks = toks;
      toks.forEach((tk) => { if (tk.k !== 'ws') (row.type === '-' ? del : ins).push({ tk, row }); });
    });
    b.dels = b.rows.filter((r) => r.type === '-').length;
    b.adds = b.rows.filter((r) => r.type === '+').length;
    const ops = lcsOps(matchKeys(del), matchKeys(ins));
    b.atoms = [];
    if (ops === null) {
      b.atoms.push({ del, ins, prev: '', next: '' });
    } else {
      let x = 0, y = 0, cur = null, lastEq = '';
      ops.forEach((op) => {
        if (op === 'e') {
          if (cur) { cur.next = del[x].tk.t; b.atoms.push(cur); cur = null; }
          lastEq = del[x].tk.t;
          ins[y].tk.peer = del[x];
          x++; y++;
          return;
        }
        if (!cur) cur = { del: [], ins: [], prev: lastEq, next: '' };
        if (op === 'd') cur.del.push(del[x++]); else cur.ins.push(ins[y++]);
      });
      if (cur) b.atoms.push(cur);
    }
    // A bracket can "change" only because its depth did; same text on both sides
    // is not an edit.
    b.atoms = b.atoms.filter((a) => a.del.map((d) => d.tk.t).join(' ') !== a.ins.map((d) => d.tk.t).join(' '));
    b.atoms.forEach((a) => {
      a.block = b;
      a.text = { del: a.del.map((d) => d.tk.t), ins: a.ins.map((d) => d.tk.t) };
      a.keyText = { del: a.del.map(keyOf), ins: a.ins.map(keyOf) };
      a.commentOnly = a.del.concat(a.ins).every((d) => d.tk.k === 'com');
      a.punctOnly = a.del.concat(a.ins).every((d) => d.tk.k === 'op');
      a.del.concat(a.ins).forEach((d) => { d.tk.atom = a; });
    });
    b.layoutOnly = b.atoms.length === 0;
    return b;
  }

  function keyOf(d) { return d.tk.k === 'com' || d.tk.k === 'str' ? d.tk.k + ':' + d.tk.t : d.tk.t; }

  function atomKey(a, mode) {
    const core = a.block.lang + ' ' + a.keyText.del.join(' ') + ' → ' + a.keyText.ins.join(' ');
    if (mode === 'context') return a.prev + ' ⟨' + core + '⟩ ' + a.next;
    if (mode === 'next') return '⟨' + core + '⟩ ' + a.next;
    return core;
  }

  // Identical edits: atoms with the same key. A group needs at least two atoms.
  function groupAtoms(files, mode) {
    const map = new Map();
    files.forEach((f) => (f.blocks || []).forEach((b) => b.atoms.forEach((a) => {
      const k = atomKey(a, mode || 'tokens');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(a);
    })));
    const bySig = new Map();
    map.forEach((atoms, key) => {
      if (atoms.length < 2) return;
      const sig = atoms.map((a) => a.block.id).sort().join('|');
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push({ key, atoms });
    });
    const groups = [];
    bySig.forEach((parts) => {
      parts.sort((x, y) => x.atoms[0].id < y.atoms[0].id ? -1 : 1);
      const atoms = parts.flatMap((p) => p.atoms);
      const blocks = new Set(atoms.map((a) => a.block));
      groups.push({ key: parts.map((p) => p.key).join(' \u2026 '), parts, atoms, count: parts[0].atoms.length, blocks: blocks.size });
    });
    groups.sort((x, y) => y.count - x.count || (x.key < y.key ? -1 : 1));
    return groups;
  }

  function globToRegExp(pattern) {
    let rx = '';
    for (let i = 0; i < pattern.length;) {
      if (pattern.startsWith('**/', i)) { rx += '(?:.*/)?'; i += 3; }
      else if (pattern.startsWith('**', i)) { rx += '.*'; i += 2; }
      else if (pattern[i] === '*') { rx += '[^/]*'; i++; }
      else { rx += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&'); i++; }
    }
    return new RegExp('^' + rx + '$');
  }

  // Note numbers as words: N4, N2 and N4, N1–N3, N1, N3 and N5.
  function nList(ns) {
    const runs = [];
    [...ns].sort((a, b) => a - b).forEach((n) => { const r = runs[runs.length - 1]; if (r && n === r[1] + 1) r[1] = n; else runs.push([n, n]); });
    const parts = runs.flatMap(([a, b]) => (b - a >= 2 ? [`N${a}–N${b}`] : a === b ? [`N${a}`] : [`N${a}`, `N${b}`]));
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || '';
  }

  // Where an agent's chat is, as the page and untangle reviews say it.
  function agentLabel(a) {
    if (a.state === 'listening') return `${a.name} is listening`;
    if (a.state === 'working') return `${a.name} is working${a.on.length ? ' on ' + nList(a.on) : ''}`;
    if (a.state === 'queued') return a.on.length ? `${nList(a.on)} ${a.on.length === 1 ? 'waits' : 'wait'} for ${a.name}’s turn` : `untangle’s line waits for ${a.name}’s turn`;
    if (a.state === 'deaf') return `${a.name} isn’t listening`;
    return `${a.name} left`;
  }

  root.ReviewCore = { tokenize, langOf, lcsOps, analyzeFile, diffBlock, groupAtoms, atomKey, globToRegExp, nList, agentLabel };
})(typeof window !== 'undefined' ? window : globalThis);
