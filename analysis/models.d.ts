export declare const MODEL_FILE: RegExp;

export interface ParsedModel {
  kind: 'class' | 'exception' | 'enum';
  name: string | null;
  line: number;
  doc: string[];
  keys: Map<string, { v: string; line: number }>;
  fields: Map<string, { def: string; line: number; doc: string[] }>;
  indexes: Map<string, { props: Record<string, string>; line: number }>;
  values: Array<{ name: string; line: number; doc: string[] }>;
}

/** What changed in a model, for the summaries: added, removed or changed, and its definition. */
export interface ModelRow {
  s: 'add' | 'del' | 'chg' | 'doc';
  f: string;
  t?: string;
  o?: string;
  doc?: boolean;
}

/** A warning: its template's key, the names it's filled in with, and the line it's about, if one. */
export interface ModelWarning {
  k: 'required' | 'field-removed' | 'removed' | 'retyped' | 'enum-order' | 'no-migration' | 'not-regenerated' | 'serverpod';
  side?: 'LEFT' | 'RIGHT';
  line?: number;
  cls?: string;
  fields?: string[];
  field?: string;
  from?: string;
  to?: string;
  value?: string;
  table?: string;
  text?: string;
}

/** A model the review changes, as the page gets it. */
export interface ModelItem {
  f: number;
  name: string;
  type: 'class' | 'exception' | 'enum';
  st: string;
  pkg: string;
  rel: string;
  test: boolean;
  sum: string;
  rows: ModelRow[];
  warns: ModelWarning[];
  table?: string;
  en?: 'byIndex' | 'byName';
  ext?: string;
  gen?: Array<{ p: string; gone?: boolean; only?: boolean }>;
  mig?: { v: string; p: string; start?: number; end?: number; hits?: number[]; more?: string[] };
  used?: Array<{ p: string; l: number | null; m?: string | null; test?: boolean }>;
}

export declare function splitTop(def: string): string[];
export declare function parseModel(text: string | null | undefined): ParsedModel | null;
/** What each line of a model file starts inside, as the line at the margin above it that opens it (fields:, say); '' is a line at the margin. Line n is at [n - 1]. */
export declare function modelOpenings(text: string): string[];
export declare function compareModels(o: ParsedModel | null, n: ParsedModel | null, opts?: { test?: boolean }): { rows: ModelRow[]; warns: ModelWarning[] };
export declare function summary(rows: ModelRow[], status: string): string;
export declare function migrationAction(sql: string, table: string, added?: string[]): { start: number; end: number; hits: number[] } | null;
export declare function isTestModel(file: string, pkg: string, extra?: string[]): boolean;
export declare function readModels(input: {
  files: Array<{ p: string; s: string; oldSrc: string | null; newSrc: string | null }>;
  generated: Array<{ p: string; s: string; hunks?: Array<{ l: string[] }> | null }>;
  show(side: 'left' | 'right', path: string): string | null;
  grep(side: 'left' | 'right', pattern: string, pathspecs: string[]): Array<{ p: string; text: string }>;
  repoPaths: string[];
  review: unknown;
  usersOf(path: string): NonNullable<ModelItem['used']>;
  index(file: unknown): number;
}): ModelItem[];
