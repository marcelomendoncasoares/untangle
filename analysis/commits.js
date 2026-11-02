// Chains by commit: the history layer of the review.
//
// Every changed line has an origin, the commit that started it (src/provenance.ts). A commit
// that changed more lines of one chain than it started of its own is a follow-up and joins that
// chain. Any other commit starts a chain with the lines it started, linked to the chains whose
// lines it changed: it builds on one, or revises several. A block goes to the chain that started
// most of its lines (on a tie, most of its words), and a whole new declaration goes with it; a
// change no commit made goes with the change beside it. Merges from the base's branch start
// nothing.

const CONV = /^(\w+)(\(([^)]*)\))?!?:\s*(.*)$/;

/** A subject as a chain's name: a conventional prefix ("fix(cli):") apart, as its kind. */
export function subjectParts(subject) {
  const s = subject.trim();
  const m = CONV.exec(s);
  if (!m || !m[4]) return { text: s, kind: '' };
  return { text: m[4][0].toUpperCase() + m[4].slice(1), kind: m[1] + (m[3] ? `(${m[3]})` : '') };
}

const lineCount = (text) => (!text ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
const wordy = (row) => /\w/.test(row.text);
const words = (row) => (row.text.match(/\w+/g) || []).length;

/**
 * Families of blocks by commit. `blocks`: the review's changes, each with its reading unit.
 * Returns the families (oldest first), each block's family index, and each commit's role.
 */
export function commitFamilies({ provenance, files, blocks }) {
  const commits = provenance.commits;
  // A file whose replay does not end at the head's lines has no usable provenance.
  const usable = new Map(files.map((f) => {
    const pf = provenance.files[f.p];
    return [f, pf && (f.newSrc == null || pf.lines === lineCount(f.newSrc)) ? pf : null];
  }));
  // Who started a row, and who it is credited to: a moved line, to the commit that moved it.
  const startOf = (f, r) => {
    const pf = usable.get(f);
    if (!pf) return -1;
    if (r.type === '+') return pf.plus[r.n]?.[0] ?? -1;
    if (r.type === '-') return pf.minus[r.o] ?? -1;
    return -1;
  };
  const creditOf = (f, r) => {
    const pf = usable.get(f);
    if (!pf || r.type !== '+') return startOf(f, r);
    const x = pf.plus[r.n];
    return !x ? -1 : x[0] >= 0 ? x[0] : x[1];
  };
  const counted = (b) => { const code = b.rows.filter((r) => r.type !== ' ' && wordy(r)); return code.length ? code : b.rows.filter((r) => r.type !== ' '); };

  // What each commit started that is still in the review.
  const survivors = new Map();
  for (const b of blocks) for (const r of counted(b)) {
    const c = startOf(b.file, r);
    if (c >= 0) survivors.set(c, (survivors.get(c) || 0) + 1);
  }

  // Follow-ups join the family whose lines they changed; the others start their own.
  const root = commits.map((_, i) => i);
  const find = (i) => { while (root[i] !== i) i = root[i]; return i; };
  const roles = commits.map(() => ({ role: 'start', revises: [] }));
  commits.forEach((c, i) => {
    if (c.merge) { roles[i].role = 'merge'; return; }
    const byFamily = new Map();
    for (const [origin, n] of Object.entries(provenance.revised[i] || {})) {
      const f = find(Number(origin));
      if (f !== i) byFamily.set(f, (byFamily.get(f) || 0) + n);
    }
    const revised = [...byFamily.values()].reduce((a, b) => a + b, 0);
    roles[i].revises = [...byFamily.keys()].sort((a, b) => a - b);
    if (byFamily.size === 1 && (survivors.get(i) || 0) <= revised) {
      root[i] = roles[i].revises[0];
      roles[i].role = 'follow-up';
    } else if (byFamily.size === 1) roles[i].role = 'builds-on';
    else if (byFamily.size > 1) roles[i].role = 'revises';
  });

  // A block, or a whole new declaration, goes to the family that started most of its lines; on a
  // tie, the one that started more of its words (a call's `group(` that kept the origin of one
  // it replaced doesn't outweigh the title written with it), then the older one. A test group's
  // setup is no declaration: each of its blocks votes.
  const whole = (b) => (b.unit && b.unit.kind !== 'setup' ? b.unit : null);
  const vote = (list) => {
    const tally = new Map();
    for (const b of list) for (const r of counted(b)) {
      const c = creditOf(b.file, r);
      if (c < 0) continue;
      const f = find(c), t = tally.get(f) || { lines: 0, words: 0 };
      t.lines++;
      t.words += words(r);
      tally.set(f, t);
    }
    let best = -1, most = { lines: 0, words: 0 };
    tally.forEach((t, f) => {
      if (t.lines > most.lines || (t.lines === most.lines && (t.words > most.words || (t.words === most.words && f < best)))) { best = f; most = t; }
    });
    return best;
  };
  const rootOf = new Map();
  const unitBlocks = new Map();
  for (const b of blocks) if (whole(b)) { if (!unitBlocks.has(b.unit)) unitBlocks.set(b.unit, []); unitBlocks.get(b.unit).push(b); }
  unitBlocks.forEach((list) => {
    const f = vote(list);
    if (f >= 0) list.forEach((b) => rootOf.set(b, f));
  });
  for (const b of blocks) {
    if (rootOf.has(b) || whole(b)) continue;
    const f = vote([b]);
    if (f >= 0) rootOf.set(b, f);
  }
  // A change no commit made (git's diff of the whole review can pair lines the commits never
  // touched: a brace pushed down shows as removed here and added further on) goes with the
  // nearest change of its file, the one after it on a tie: the addition that replaces it.
  const after = (x, b) => x.hunk > b.hunk || (x.hunk === b.hunk && x.first > b.first);
  const rowsBetween = (x, b) => (x.hunk !== b.hunk ? 0 : after(x, b) ? x.first - b.first - b.rows.length : b.first - x.first - x.rows.length);
  const distance = (x, b) => Math.abs(x.hunk - b.hunk) * 1e7 + rowsBetween(x, b) * 2 + (after(x, b) ? 0 : 1);
  const nearest = (b) => blocks.filter((x) => x.file === b.file && rootOf.has(x)).sort((x, y) => distance(x, b) - distance(y, b))[0];
  const unplaced = new Map();
  for (const b of blocks) if (!rootOf.has(b)) { const k = whole(b) || b; if (!unplaced.has(k)) unplaced.set(k, []); unplaced.get(k).push(b); }
  unplaced.forEach((list) => {
    const near = list.map(nearest).find(Boolean);
    if (near) list.forEach((b) => rootOf.set(b, rootOf.get(near)));
  });

  const byRoot = new Map();
  for (const b of blocks) {
    if (!rootOf.has(b)) continue;
    const f = rootOf.get(b);
    if (!byRoot.has(f)) byRoot.set(f, new Set());
    byRoot.get(f).add(b);
  }
  const families = [...byRoot.keys()].sort((a, b) => a - b).map((r) => ({
    root: r,
    commits: commits.map((_, i) => i).filter((i) => !commits[i].merge && find(i) === r),
    blocks: byRoot.get(r),
    buildsOn: roles[r].role === 'builds-on' ? roles[r].revises[0] : null,
    revises: roles[r].role === 'revises' ? roles[r].revises : [],
    revisedBy: [],
  }));
  const familyOfRoot = new Map(families.map((f, i) => [f.root, i]));
  // The commits of other families that changed this family's lines, and how many.
  commits.forEach((c, j) => {
    if (c.merge) return;
    const byFamily = new Map();
    for (const [origin, n] of Object.entries(provenance.revised[j] || {})) {
      const r = find(Number(origin));
      if (r !== find(j) && familyOfRoot.has(r)) byFamily.set(r, (byFamily.get(r) || 0) + n);
    }
    byFamily.forEach((n, r) => families[familyOfRoot.get(r)].revisedBy.push([j, n]));
  });
  families.forEach((f) => {
    f.buildsOn = f.buildsOn != null && familyOfRoot.has(find(f.buildsOn)) ? familyOfRoot.get(find(f.buildsOn)) : null;
    f.revises = [...new Set(f.revises.map(find))].filter((r) => familyOfRoot.has(r)).map((r) => familyOfRoot.get(r));
  });
  const familyOf = new Map();
  for (const [b, r] of rootOf) familyOf.set(b, familyOfRoot.get(r));
  return { families, familyOf, roles };
}
