// Types for core.js, which runs in the page and in the analysis alike.
export {};

export interface Token {
  /** Text. */
  t: string;
  /** Kind: ws, id, ty, kw, num, ann, key, str, com, op, md. */
  k: string;
  /** Column. */
  c: number;
}

declare global {
  var ReviewCore: {
    tokenize(line: string, lang: string, opts?: { interpolations?: boolean }): Token[];
    langOf(path: string): string;
    globToRegExp(pattern: string): RegExp;
    /** Note numbers as words: N4, N2 and N4, N1–N3. */
    nList(ns: number[]): string;
    /** Where an agent's chat is, in words: Claude is listening, Codex is working on N2. */
    agentLabel(a: { name: string; state: string; on: number[] }): string;
  };
}
