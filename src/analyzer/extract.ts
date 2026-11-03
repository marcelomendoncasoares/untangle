import fs from 'node:fs';
import path from 'node:path';
import type { CallGraph, Diff, RawDefinitions } from '../../analysis/analyze.js';
import { definitionCollector, type Definitions } from '../pipeline/definitions.js';
import { CALL_DEPTH } from '../pipeline/links.js';
import { Analyzer, type FileFacts, type Location, type Structure } from './client.js';

export interface Extracted {
  defs: Definitions;
  defsOld: Definitions;
  calls: CallGraph;
  supers: RawDefinitions;
  structure: Record<string, Structure>;
  structureOld: Record<string, Structure>;
}

const TEST_FILE = /(^|\/)(test|test_[a-z0-9_]+|integration_test)\/|_test\.dart$/;

/** Resolve each changed file once, sharing its facts between chains and definition peeks. */
export async function extract(diff: Diff, head: string, base: string, progress: { detail(line: string, count?: [number, number]): void; note(line: string): void; verbose(line: string): void }): Promise<Extracted> {
  const files = diff.compares.base.files.filter((file) => file.hunks && file.p.endsWith('.dart'));
  const defs = definitionCollector(head);
  const defsOld = definitionCollector(base);
  const structure: Record<string, Structure> = {};
  const structureOld: Record<string, Structure> = {};
  const supers: RawDefinitions = {};
  const graph: Record<string, string[]> = {};
  const calls: CallGraph = { depth: CALL_DEPTH, seeds: [], graph };
  // A moved file is read at its old path in the base: facts on the base side go by base paths.
  const paths = files.flatMap((file) => [path.join(head, file.p), path.join(base, file.from ?? file.p)]).filter((file) => fs.existsSync(file));
  const output = { defs: defs.data, defsOld: defsOld.data, structure, structureOld, supers, calls };
  if (!paths.length) return output;

  const analyzer = await Analyzer.start(paths, progress.verbose);
  const added = new Set<string>();
  const seeds = new Map<string, Location>();
  const callsByFile = new Map<string, FileFacts['calls']>();
  const refused = new Set<string>();
  const nodeKey = ([file, line, col]: Location) => file.startsWith(head + path.sep) && !file.includes('/generated/')
    ? `${file.slice(head.length + 1)}:${line}:${col}` : null;

  // All added lines must be known before test seeds are collected, regardless of file order.
  for (const file of files) for (const hunk of file.hunks!) {
    let line = hunk.n;
    for (const text of hunk.l) {
      if (text[0] === '+') added.add(`${file.p}:${line}`);
      if (text[0] !== '-') line++;
    }
  }

  try {
    let done = 0;
    for (const file of files) {
      const headLines = new Set<number>();
      const baseLines = new Set<number>();
      for (const hunk of file.hunks!) {
        let n = hunk.n;
        let o = hunk.o;
        for (const text of hunk.l) {
          if (text[0] !== '-') headLines.add(n++);
          if (text[0] === '-') baseLines.add(o);
          if (text[0] !== '+') o++;
        }
      }

      for (const side of ['head', 'base'] as const) {
        const current = side === 'head';
        const rel = current ? file.p : file.from ?? file.p;
        const abs = path.join(current ? head : base, rel);
        if (!fs.existsSync(abs)) continue;
        progress.detail(`Dart files ${++done} of ${paths.length}: ${rel}`, [done, paths.length]);
        const facts = await analyzer.file(abs);
        if (!facts) {
          refused.add(rel);
          continue;
        }
        // A moved file's diff is made again from its declarations, by the analysis: every line of it.
        const lines = file.from ? { has: () => true } : current ? headLines : baseLines;
        const collector = current ? defs : defsOld;
        (current ? structure : structureOld)[rel] = {
          declarations: facts.declarations,
          directives: facts.directives,
          scenarios: facts.scenarios,
          arguments: current ? facts.arguments : [],
        };

        for (const [position, length] of Object.entries(facts.unresolved)) {
          const [line, col] = position.split(':').map(Number);
          if (lines.has(line) && !facts.references[position]) collector.add(rel, line, col, length, null);
        }

        for (const [position, reference] of Object.entries(facts.references)) {
          const [line, col] = position.split(':').map(Number);
          if (!lines.has(line)) continue;
          const [target, targetLine, targetCol] = reference.target;
          // An import's URI names a file and uses nothing in it: the page can go there, but it ties
          // no change to another, nor calls anything from a test.
          const uri = reference.kind === 'uri';
          collector.add(rel, line, col, reference.length, { path: target, line: targetLine, col: targetCol }, !uri);

          if (current && TEST_FILE.test(file.p) && added.has(`${file.p}:${line}`) && !uri) {
            const key = nodeKey(reference.target);
            if (key && !added.has(`${target.slice(head.length + 1)}:${targetLine + 1}`)) seeds.set(key, reference.target);
          }
        }

        if (current) {
          callsByFile.set(abs, facts.calls);
          for (const [position, target] of Object.entries(facts.supers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
            const line = Number(position.split(':')[0]);
            if (added.has(`${file.p}:${line}`)) supers[`${file.p}:${position}`] = target;
          }
        }
        const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === 'ERROR');
        if (errors.length) progress.verbose(`${rel}: ${errors.length} analyzer diagnostics; unresolved references are omitted`);
      }
    }
    if (refused.size) {
      const [first] = refused;
      progress.note(refused.size === 1
        ? `the Dart analyzer can't resolve ${first}: no chains or go to definition in it`
        : `the Dart analyzer can't resolve ${refused.size} files, such as ${first}: no chains or go to definition in them`);
    }

    const outgoing = async (target: Location): Promise<Location[] | undefined> => {
      let fileCalls = callsByFile.get(target[0]);
      if (!fileCalls) {
        fileCalls = await analyzer.calls(target[0]);
        callsByFile.set(target[0], fileCalls);
      }
      return fileCalls[target.join(':')];
    };

    progress.detail('calls reachable from changed tests');
    let level: Array<[string, Location]> = [];
    for (const [key, target] of [...seeds].sort(([a], [b]) => a.localeCompare(b))) {
      if (await outgoing(target)) level.push([key, target]);
    }
    calls.seeds = level.map(([key]) => key).sort();
    const seen = new Set<string>();

    for (let depth = 0; level.length && depth < CALL_DEPTH; depth++) {
      const next: Array<[string, Location]> = [];
      for (const [key, target] of level) {
        if (seen.has(key)) continue;
        seen.add(key);
        const targets = new Map<string, Location>();
        for (const to of await outgoing(target) ?? []) {
          const child = nodeKey(to);
          if (child) targets.set(child, to);
        }
        graph[key] = [...targets.keys()].sort();
        next.push(...targets);
      }
      level = next;
    }
    return output;
  } finally {
    callsByFile.clear();
    await analyzer.stop();
  }
}
