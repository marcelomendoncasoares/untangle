// The raw git diff of a comparison as JSON, with no analysis.
//
// For every changed file: path, status, +/- counts and whether the right side's .gitattributes
// marks it linguist-generated. Generated files (that, or a pattern of the adapters and
// .review.yaml) get stats only; every other file gets its unified-diff hunks (-U3), exactly as
// git produced them. A file git finds moved (renamed, at least half of it the same) is one file
// changed, at its new path, with the path it came from: its diff is only what changed in it.
import YAML from 'yaml';
import { generatedGlobs } from '../../analysis/adapters.js';
import type { Diff, DiffFile } from '../../analysis/analyze.js';
import '../../viewer/core.js';
import { git, gitMaybe, run } from '../exec.js';

const C = globalThis.ReviewCore;

type Hunk = NonNullable<DiffFile['hunks']>[number];

/** The generated-file patterns that apply to a commit: the adapters' and .review.yaml's. */
export function generatedPatterns(repo: string, rev: string): string[] {
  const paths = git(repo, 'ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean);
  let review: unknown = {};
  try {
    review = YAML.parse(gitMaybe(repo, 'show', `${rev}:.review.yaml`) || '') || {};
  } catch {
    // The analysis reports an invalid .review.yaml.
  }
  return generatedGlobs(paths, review).map(([glob]) => glob);
}

export function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (m) {
      cur = { o: +m[1], n: +m[3], h: m[5].trim(), l: [] };
      hunks.push(cur);
    } else if (cur && (line[0] === ' ' || line[0] === '-' || line[0] === '+')) {
      cur.l.push(line);
    }
    // "\ No newline at end of file" is dropped.
  }
  return hunks;
}

/** One file's hunks between two commits: of the path it had at the left one, when it moved. */
export const fileHunks = (repo: string, left: string, right: string, p: string, from?: string | null) =>
  parseHunks(from ? git(repo, 'diff', '-M', '-U3', left, right, '--', from, p) : git(repo, 'diff', '--no-renames', '-U3', left, right, '--', p));

/**
 * What changed between two commits, by path, moves found: each file's status (a moved file is
 * changed, M, with the path it came from) and its lines added and removed.
 */
export function changedFiles(repo: string, left: string, right: string): Map<string, { s: string; from?: string; a: number; d: number }> {
  const files = new Map<string, { s: string; from?: string; a: number; d: number }>();
  // NUL-separated: status, then a path, or a moved file's two.
  const status = git(repo, 'diff', '-M', '--name-status', '-z', left, right).split('\0');
  for (let i = 0; i + 1 < status.length; ) {
    const s = status[i++];
    if (!s) continue;
    if (s[0] === 'R') {
      const from = status[i++], to = status[i++];
      files.set(to, { s: 'M', from, a: 0, d: 0 });
    } else files.set(status[i++], { s, a: 0, d: 0 });
  }
  // "added, removed, path", or "added, removed," then a moved file's two paths.
  const numstat = git(repo, 'diff', '-M', '--numstat', '-z', left, right).split('\0');
  for (let i = 0; i < numstat.length; ) {
    const row = numstat[i++];
    if (!row) continue;
    const [a, d, ...rest] = row.split('\t');
    const f = files.get(rest.join('\t') || (i++, numstat[i++]));
    if (f) Object.assign(f, { a: a === '-' ? 0 : +a, d: d === '-' ? 0 : +d });
  }
  return files;
}

export function exportDiff(repo: string, compares: Record<string, { left: string; right: string; label: string }>, generated: string[]): Diff {
  const patterns = generated.map((g) => C.globToRegExp(g));
  const result: Diff = { compares: {} };
  for (const [name, { left, right, label }] of Object.entries(compares)) {
    const changed = changedFiles(repo, left, right);
    const paths = [...changed.keys()].sort();
    const attrs = new Map<string, string>();
    const attrOut = paths.length ? run('git', ['-C', repo, 'check-attr', '--source', right, '--stdin', 'linguist-generated'], { input: paths.join('\n') }) : '';
    for (const row of attrOut.split('\n').filter(Boolean)) {
      const v = row.lastIndexOf(': '), k = row.lastIndexOf(': ', v - 1);
      attrs.set(row.slice(0, k), row.slice(v + 2));
    }
    const files: DiffFile[] = paths.map((p) => {
      const { s, from, a, d } = changed.get(p)!;
      const f: DiffFile = { p, s, ...(from && { from }), a, d, ga: attrs.get(p) || 'unspecified' };
      if (attrs.get(p) !== 'true' && !patterns.some((rx) => rx.test(p))) f.hunks = fileHunks(repo, left, right, p, from);
      return f;
    });
    result.compares[name] = { left, right, label, files };
  }
  return result;
}
