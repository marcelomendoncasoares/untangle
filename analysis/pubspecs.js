// The pubspec.yaml files a review changes, for the page's Dependencies view. Each is read on both
// sides, key by key: the package's name and version, its environment, and each dependency in each
// section, as a constraint or where it comes from, with its line. The changes come grouped by
// dependency across the review, and the packages' versions by change. Where the repository commits
// a pubspec.lock (set aside as generated), each changed dependency gets what it resolved to on each
// side, and the lock's other changes come apart. No warnings: pub get and pub publish say them.
import YAML from 'yaml';
import { isTestModel } from './models.js';

export const PUBSPEC = /(^|\/)pubspec\.yaml$/;
export const LOCK = /(^|\/)pubspec\.lock$/;
// The sections a change is in, in the order the page shows them.
export const SECTIONS = ['dependencies', 'dev_dependencies', 'dependency_overrides', 'environment'];
const SHA = /^[0-9a-f]{40}$/;

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Every scalar as written: version: 1.0 stays 1.0, and an empty value is ''.
const parseDoc = (text) => YAML.parseDocument(text, { schema: 'failsafe' });

/** A dependency as one line: its constraint, or where it comes from. */
export function depSpec(v) {
  if (v == null || v === '') return 'any';
  if (typeof v !== 'object' || Array.isArray(v)) return String(v);
  if ('path' in v) return 'path ' + v.path;
  if ('git' in v) {
    const g = v.git && typeof v.git === 'object' ? v.git : { url: v.git };
    let s = 'git ' + String(g.url || '').replace(/^https?:\/\//, '').replace(/\.git$/, '');
    if (g.ref) s += ' @ ' + (SHA.test(String(g.ref)) ? String(g.ref).slice(0, 7) : String(g.ref));
    if (g.path) s += ' · ' + g.path;
    return s;
  }
  if ('sdk' in v) return 'sdk ' + v.sdk;
  if ('hosted' in v) {
    const h = v.hosted && typeof v.hosted === 'object' ? v.hosted.url : v.hosted;
    return `${v.version != null && v.version !== '' ? v.version : 'any'} from ${String(h || '').replace(/^https?:\/\//, '')}`;
  }
  if ('version' in v) return String(v.version);
  return JSON.stringify(v);
}

/** Line numbers by character offset: line n starts at [n - 1]. */
function lineOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/**
 * A pubspec, read: its name, version, workspace and resolution, the line of each top-level key,
 * and each section's entries with their specs and lines. Null when it isn't a YAML map.
 */
export function parsePubspec(text) {
  if (text == null) return null;
  let doc;
  try { doc = parseDoc(text); } catch { return null; }
  if (!YAML.isMap(doc.contents)) return null;
  const js = doc.toJS() || {};
  const line = lineOf(text);
  const keyLine = (pair) => (pair.key && pair.key.range ? line(pair.key.range[0]) : null);
  const top = new Map();
  doc.contents.items.forEach((pair) => { const k = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key); top.set(k, keyLine(pair)); });
  const entries = {};
  for (const sec of SECTIONS) {
    entries[sec] = new Map();
    const node = doc.get(sec, true), vals = js[sec];
    if (!YAML.isMap(node) || !vals || typeof vals !== 'object') continue;
    node.items.forEach((pair) => {
      const k = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      entries[sec].set(k, { spec: sec === 'environment' ? String(vals[k] ?? '') || 'any' : depSpec(vals[k]), line: keyLine(pair) });
    });
  }
  const str = (v) => (v == null || typeof v === 'object' ? null : String(v));
  return {
    name: str(js.name), version: str(js.version), publishTo: str(js.publish_to), resolution: str(js.resolution),
    workspace: Array.isArray(js.workspace) ? js.workspace.map(String) : null, top, entries,
  };
}

/** A pubspec.lock's packages and the version each resolved to. Null when it can't be read. */
export function lockVersions(text) {
  if (!text) return null;
  try {
    const js = YAML.parse(text, { schema: 'failsafe' });
    const pk = js && js.packages;
    if (!pk || typeof pk !== 'object' || Array.isArray(pk)) return null;
    return new Map(Object.entries(pk).map(([k, v]) => [k, v && typeof v === 'object' && v.version != null ? String(v.version) : null]));
  } catch {
    return null;
  }
}

/** What changed between two sides of a pubspec: each entry of each section, with its line. */
export function comparePubspecs(o, n) {
  const changes = [];
  for (const sec of SECTIONS) {
    const a = o ? o.entries[sec] : new Map(), b = n ? n.entries[sec] : new Map();
    const names = [...new Set([...a.keys(), ...b.keys()])].sort();
    for (const dep of names) {
      const was = a.get(dep), is = b.get(dep);
      if (was && is && was.spec === is.spec) continue;
      changes.push({ sec, dep, old: was ? was.spec : null, new: is ? is.spec : null, side: is ? 'RIGHT' : 'LEFT', line: is ? is.line : was.line });
    }
  }
  return changes;
}

/** A folded pubspec's line, in short: its version, its dependencies' changes, overrides, environment. */
export function pubspecSummary(version, changes, status) {
  const parts = [];
  if (version) parts.push(`${version[0] ?? 'no version'} → ${version[1] ?? 'no version'}`);
  const of = (sec) => changes.filter((c) => c.sec === sec);
  const deps = of('dependencies'), dev = of('dev_dependencies'), ov = of('dependency_overrides'), env = of('environment');
  const both = deps.concat(dev);
  if (both.length) {
    const counted = [deps.length ? plural(deps.length, 'dependency', 'dependencies') : '', dev.length ? plural(dev.length, 'dev dependency', 'dev dependencies') : ''].filter(Boolean).join(' and ');
    const news = new Set(both.map((c) => c.new));
    const how = both.every((c) => c.old == null) ? ' added' : both.every((c) => c.new == null) ? ' removed' : both.every((c) => c.old != null) && news.size === 1 ? ` to ${[...news][0]}` : ' changed';
    parts.push(counted + how);
  }
  if (ov.length) parts.push(plural(ov.length, 'override', 'overrides'));
  if (env.length) parts.push(env.map((c) => `${c.dep} ${c.new ?? 'removed'}`).join(', '));
  return parts.join(' · ') || (status === 'A' ? 'new' : status === 'D' ? 'removed' : 'other keys');
}

/**
 * The review's pubspecs, for the page: each changed pubspec.yaml as a card (the root's first, then
 * by path; test packages', by the Models page's rule, last), the changes grouped by dependency, the
 * packages' versions by change, and the committed locks' other changes. Null when no pubspec changed.
 */
export function readPubspecs({ files, generated, show, review, index }) {
  const changed = files.filter((f) => PUBSPEC.test(f.p));
  if (!changed.length) return null;
  const extra = Array.isArray(review && review.tests) ? review.tests.filter((g) => typeof g === 'string') : [];
  // The workspace at the head: its root's members, which resolve together, with the root's lock.
  const root = parsePubspec(show('right', 'pubspec.yaml'));
  const members = new Set((root && root.workspace ? root.workspace : []).map((d) => d.replace(/^\.\//, '').replace(/\/+$/, '')));
  const locks = new Map();
  const lockAt = (side, p) => {
    const k = side + ':' + p;
    if (!locks.has(k)) locks.set(k, lockVersions(show(side, p)));
    return locks.get(k);
  };
  const cards = changed.map((f) => {
    const o = parsePubspec(f.oldSrc), n = parsePubspec(f.newSrc), m = n || o;
    const dir = dirOf(f.p);
    const changes = comparePubspecs(o, n);
    const card = { f: index(f), name: (m && m.name) || dir || f.p, dir, st: f.s, sum: '', changes };
    const ov = o && o.version, nv = n && n.version;
    if (ov !== nv && (ov != null || nv != null)) { card.version = [ov, nv]; if (n && nv != null) card.vline = n.top.get('version'); }
    if (m && m.workspace) card.root = true;
    const member = members.has(dir) || (m && m.resolution === 'workspace');
    if (member) card.member = true;
    if (members.size && !card.root && !member) card.outside = true;
    if (isTestModel(f.p, dir, extra)) card.test = true;
    // What each changed dependency resolved to, by the lock that resolves this pubspec.
    const lock = member ? 'pubspec.lock' : (dir ? dir + '/' : '') + 'pubspec.lock';
    const was = lockAt('left', lock), is = lockAt('right', lock);
    if (was || is) {
      card.lock = lock;
      changes.forEach((c) => {
        if (c.sec === 'environment') return;
        const a = was ? was.get(c.dep) ?? null : null, b = is ? is.get(c.dep) ?? null : null;
        if (a != null || b != null) c.res = [a, b];
      });
    }
    card.sum = pubspecSummary(card.version, changes, f.s);
    return card;
  }).sort((a, b) => Number(!!a.test) - Number(!!b.test) || Number(!a.root) - Number(!b.root) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

  // Each change once, with the pubspecs that make it: the most made first, then by section and name.
  const groups = new Map();
  cards.forEach((c) => c.changes.forEach((x) => {
    const k = [x.sec, x.dep, x.old, x.new].join('\u0000');
    if (!groups.has(k)) groups.set(k, { sec: x.sec, dep: x.dep, old: x.old, new: x.new, f: [] });
    groups.get(k).f.push(c.f);
  }));
  const grouped = [...groups.values()].sort((a, b) => b.f.length - a.f.length || SECTIONS.indexOf(a.sec) - SECTIONS.indexOf(b.sec) || (a.dep < b.dep ? -1 : a.dep > b.dep ? 1 : 0));
  // The packages' own versions, by change.
  const versions = new Map();
  cards.filter((c) => c.version).forEach((c) => {
    const k = c.version.join('\u0000');
    if (!versions.has(k)) versions.set(k, { old: c.version[0], new: c.version[1], f: [] });
    versions.get(k).f.push(c.f);
  });
  // A committed lock's other changes: what resolved differently that no row above says.
  const lockList = generated.filter((g) => LOCK.test(g.p)).map((g) => {
    const said = new Set(cards.filter((c) => c.lock === g.p).flatMap((c) => c.changes.filter((x) => x.res).map((x) => x.dep)));
    const was = lockAt('left', g.p) || new Map(), is = lockAt('right', g.p) || new Map();
    const others = [...new Set([...was.keys(), ...is.keys()])].sort()
      .filter((dep) => !said.has(dep) && (was.get(dep) ?? null) !== (is.get(dep) ?? null))
      .map((dep) => ({ dep, old: was.get(dep) ?? null, new: is.get(dep) ?? null }));
    return { p: g.p, others };
  }).filter((l) => l.others.length);
  return { cards, groups: grouped, versions: [...versions.values()], locks: lockList.length ? lockList : undefined };
}
