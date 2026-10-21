// The review page: the viewer with the review's data inlined, as one HTML document.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReviewData } from './build.js';
import { ROOT } from './version.js';

export interface PageConfig {
  /** Served by untangle: marks, live definitions, whole files and search go through its API. */
  served: boolean;
  /** This review, for keys in browser storage. */
  key: string;
  /** The saved marks and layout. */
  state: unknown;
  /** The pull request's page, and where the comparison runs (repo · base → head). */
  url: string | null;
  where: string;
  /** Absolute paths of the head and base checkouts, for links to the editor (null until they exist). */
  roots?: { head: string; base: string } | null;
  /** How "Open in editor" works: a link built from a template, or a command untangle runs. */
  editor?: { mode: 'uri'; template: string } | { mode: 'command' | 'orca' };
  /** The ref that holds the marks. */
  snapshot?: { ref: string; commit: string | null; note: string | null };
  /** Lines in each modified file at the head: how far its diff can grow below the last hunk. */
  lines?: Record<string, number>;
  /** The pull request's conversation on GitHub (through gh), or why it's off. */
  github?: { number: number; url: string } | { off: string } | null;
  head?: string;
  base?: string;
  /** The review's notes, kept on this machine: what the page shows of them at first. */
  notes?: unknown;
}

const read = (f: string) => fs.readFileSync(path.join(ROOT, 'viewer', f), 'utf8');
// JSON inside <script>: no "<" at all, so nothing in it can close or open a tag.
const inline = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const built = (name: string) => {
  try {
    return fs.readFileSync(path.join(ROOT, 'dist', name));
  } catch {
    return null;
  }
};
/** The highlighter bundle (dist/highlight.js), built by `npm run build`. */
export const highlighter = () => built('highlight.js');
/** The page's fonts, with their files inlined (dist/fonts.css), built by `npm run build`. */
export const fonts = () => built('fonts.css');
const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
// Served, a page tells untangle when it opens and closes, so the last one to close can stop it.
const presence = () => {
  const src = read('presence.js');
  if (/<\/script/i.test(src)) throw new Error('presence.js contains </script');
  return `<script>\n${src}</script>`;
};
// Served, an asset's URL carries its content's hash: a browser never keeps an old one.
const fontsLink = (css: Buffer | null) => (css ? `<link rel="stylesheet" href="assets/fonts.css?v=${hash(css)}">` : '');

// Generated diffs kept in an exported page, smallest files first: the rest are listed without.
const EXPORT_GENERATED_BUDGET = 1_000_000;

/**
 * Renders the page for a review: everything but the config is inlined once, up front. Served,
 * the page loads the highlighter from untangle and asks for generated diffs when they open;
 * exported, it carries both, within a budget for the generated diffs.
 */
export function reviewPage(data: ReviewData, title: string, mode: 'served' | 'export'): (config: PageConfig) => string {
  const template = read('index.html'), core = read('core.js'), viewer = read('viewer.js');
  const shiki = highlighter(), faces = fonts();
  for (const [name, src] of [['core.js', core], ['viewer.js', viewer], ['highlight.js', shiki ? shiki.toString('utf8') : '']]) if (/<\/script/i.test(src)) throw new Error(`${name} contains </script`);
  if (faces && /<\/style/i.test(faces.toString('utf8'))) throw new Error('fonts.css contains </style');
  type Generated = { p: string; hunks: unknown };
  // Exported, the smallest generated diffs stay within the budget; served, none: the page asks.
  const generated = (list: Generated[]): Generated[] => {
    if (mode === 'served') return list.map((g) => ({ ...g, hunks: null }));
    const size = (g: Generated) => (g.hunks ? JSON.stringify(g.hunks).length : 0);
    let used = 0;
    const kept = new Set<Generated>();
    [...list].sort((a, b) => size(a) - size(b)).forEach((g) => { if (g.hunks && used + size(g) <= EXPORT_GENERATED_BUDGET) { used += size(g); kept.add(g); } });
    return list.map((g) => ({ ...g, hunks: kept.has(g) ? g.hunks : null }));
  };
  const model = { compares: Object.fromEntries(Object.entries(data.model.compares).map(([k, c]) => [k, { ...c, generated: generated(c.generated) }])) };
  const highlight = !shiki ? '' : mode === 'served' ? `<script src="assets/highlight.js?v=${hash(shiki)}"></script>` : `<script>${shiki.toString('utf8')}</script>`;
  const parts: Array<[string, string]> = [
    ['/*TITLE*/', escapeHtml(title + ' · untangle')],
    ['<!--FONTS-->', !faces ? '' : mode === 'served' ? fontsLink(faces) : `<style>${faces.toString('utf8')}</style>`],
    ['<!--PRESENCE-->', mode === 'served' ? presence() : ''],
    ['<!--HIGHLIGHT-->', highlight],
    ['/*CORE*/', core],
    ['/*CONFIG*/', '\0'],
    ['/*MODEL*/', inline(model)],
    ['/*DEFS*/', inline(data.defs)],
    ['/*REFS*/', inline(data.refs)],
    ['/*DEFSOLD*/', inline(data.defsOld)],
    ['/*HISTORY*/', inline(data.history ?? null)],
    ['/*VIEWER*/', viewer],
  ];
  // One pass over the template, so text in the data that looks like a placeholder stays as it is.
  const found = parts.map(([key, value]) => {
    const at = template.indexOf(key);
    if (at < 0 || template.indexOf(key, at + 1) >= 0) throw new Error(`index.html needs exactly one ${key}`);
    return { at, key, value };
  }).sort((a, b) => a.at - b.at);
  const pieces: string[] = [];
  let page = '', last = 0;
  for (const { at, key, value } of found) {
    page += template.slice(last, at);
    if (key === '/*CONFIG*/') { pieces.push(page); page = ''; } else page += value;
    last = at + key.length;
  }
  pieces.push(page + template.slice(last));
  return (config) => pieces[0] + inline(config) + pieces[1];
}

/** The manager's page, untangle reviews': the reviews on this machine, live. */
export function managerPage(config: { version: string }): string {
  const script = read('manager.js');
  if (/<\/script/i.test(script)) throw new Error('manager.js contains </script');
  return read('manager.html')
    .replace('<!--FONTS-->', fontsLink(fonts()))
    .replace('<!--PRESENCE-->', presence())
    .replace('/*CONFIG*/', () => inline(config))
    .replace('/*MANAGER*/', () => script);
}

/** The page shown while the review is being built: it follows the steps and reloads when done. */
export function progressPage(): string {
  return read('progress.html').replace('<!--FONTS-->', fontsLink(fonts())).replace('<!--PRESENCE-->', presence());
}
