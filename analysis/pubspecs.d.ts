export declare const PUBSPEC: RegExp;
export declare const LOCK: RegExp;
export declare const SECTIONS: Array<'dependencies' | 'dev_dependencies' | 'dependency_overrides' | 'environment'>;

export type PubSection = (typeof SECTIONS)[number];

export interface ParsedPubspec {
  name: string | null;
  version: string | null;
  publishTo: string | null;
  resolution: string | null;
  workspace: string[] | null;
  top: Map<string, number | null>;
  entries: Record<PubSection, Map<string, { spec: string; line: number | null }>>;
}

/** One entry of a section that changed: what it was and what it is (null: absent), and its line. */
export interface PubChange {
  sec: PubSection;
  dep: string;
  old: string | null;
  new: string | null;
  side: 'LEFT' | 'RIGHT';
  line: number | null;
  /** What the lock resolved it to, before and after. */
  res?: [string | null, string | null];
}

/** A pubspec the review changes, as the page gets it. */
export interface PubspecCard {
  f: number;
  name: string;
  dir: string;
  st: string;
  sum: string;
  changes: PubChange[];
  version?: [string | null, string | null];
  vline?: number | null;
  root?: true;
  member?: true;
  outside?: true;
  test?: true;
  lock?: string;
}

export interface PubspecsData {
  cards: PubspecCard[];
  groups: Array<{ sec: PubSection; dep: string; old: string | null; new: string | null; f: number[] }>;
  versions: Array<{ old: string | null; new: string | null; f: number[] }>;
  locks?: Array<{ p: string; others: Array<{ dep: string; old: string | null; new: string | null }> }>;
}

export declare function depSpec(v: unknown): string;
export declare function parsePubspec(text: string | null | undefined): ParsedPubspec | null;
export declare function lockVersions(text: string | null | undefined): Map<string, string | null> | null;
export declare function comparePubspecs(o: ParsedPubspec | null, n: ParsedPubspec | null): PubChange[];
export declare function pubspecSummary(version: PubspecCard['version'], changes: PubChange[], status: string): string;
export declare function readPubspecs(input: {
  files: Array<{ p: string; s: string; oldSrc: string | null; newSrc: string | null }>;
  generated: Array<{ p: string; s: string }>;
  show(side: 'left' | 'right', path: string): string | null;
  review: unknown;
  index(file: unknown): number;
}): PubspecsData | null;
