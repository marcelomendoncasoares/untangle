import type { Structure } from '../src/analyzer/client.js';
import type { Provenance } from '../src/provenance.js';
/** "path:line:col" (1-based line) -> [absolute target file, 0-based line, column]. */
export type RawDefinitions = Record<string, [string, number, number]>;

export interface DiffFile {
  p: string;
  s: string;
  /** Where a file git found moved came from: the path it had at the left commit. */
  from?: string;
  a: number;
  d: number;
  ga: string;
  hunks?: Array<{ o: number; n: number; h: string; l: string[] }>;
}

export interface Diff {
  compares: Record<string, { left: string; right: string; label: string; files: DiffFile[] }>;
}

export interface CallGraph {
  depth: number;
  seeds: string[];
  graph: Record<string, string[]>;
}

export interface Model {
  compares: Record<string, any>;
}

export declare function analyze(input: {
  repo: string;
  headDir: string;
  diff: Diff;
  defsRaw: RawDefinitions;
  structure?: Record<string, Structure>;
  old?: Record<string, { dir: string; raw: RawDefinitions; structure?: Record<string, Structure> }>;
  calls?: CallGraph | null;
  supers?: RawDefinitions | null;
  /** Which commit started each changed line: chains then follow the commits. */
  provenance?: Provenance | null;
  log?: (line: string) => void;
}): Promise<Model>;
