export interface Adapter {
  detect: RegExp;
  generated: string[];
  model: { kind: 'yaml' | 'part' | 'proto'; generated: string[]; source?: string | string[]; classSuffixes?: string };
}
export declare const ADAPTERS: Record<string, Adapter>;
/** [glob, what writes it] for files set aside as generated whatever adapters are on. */
export declare const SET_ASIDE: Array<[string, string]>;
/** [glob, where it comes from] for each generated-file pattern that applies. */
export declare function generatedGlobs(paths: string[], review: unknown): Array<[string, string]>;
