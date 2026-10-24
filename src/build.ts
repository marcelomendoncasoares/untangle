// Builds the review of a target: checkouts, the diff, the analyzer's facts and the
// analysis, cached per pair of commits.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { analyze, type Model } from '../analysis/analyze.js';
import { reviewDir, tilde } from './cache.js';
import { checkoutAt, packageDirs, pubGet, rehomeCheckouts, resolved, worktree } from './checkouts.js';
import { has } from './exec.js';
import { extract, type Extracted } from './analyzer/extract.js';
import { slim, type SlimDefinitions } from './pipeline/definitions.js';
import { exportDiff, generatedPatterns } from './pipeline/diff.js';
import { changedUsages } from './pipeline/links.js';
import { generatedBy, readProvenance, type Provenance } from './provenance.js';
import type { History } from './history.js';
import type { Target } from './target.js';
import { ROOT, VERSION } from './version.js';

/** What the page shows: the model and the definition answers it embeds. */
export interface ReviewData {
  model: Model;
  defs: SlimDefinitions;
  refs: ReturnType<typeof changedUsages>;
  defsOld: Record<string, SlimDefinitions>;
  /** The commits, and which wrote each changed line (not cached with the rest: see history.ts). */
  history?: History | null;
}

export interface Progress {
  /** Starts a step; the next step (or done) ends it. */
  step(label: string): void;
  /** What the current step is doing now, and how far it is through what it counts. */
  detail(text: string, count?: [number, number]): void;
  /** A line worth keeping in the narration. */
  note(text: string): void;
  verbose(text: string): void;
}

// What each cached stage depends on: when any of these files changes, the stage runs again.
function fingerprint(files: string[]): string {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(path.join(ROOT, f)));
  return h.digest('hex').slice(0, 16);
}
const EXTRACTION_STAGE = ['dist/analyzer/client.js', 'dist/analyzer/extract.js', 'analyzer/bin/extract.dart', 'analyzer/pubspec.lock', 'dist/pipeline/diff.js', 'dist/pipeline/definitions.js', 'dist/pipeline/links.js', 'dist/model-definitions.js', 'analysis/adapters.js'];
const MODEL_STAGE = ['analysis/analyze.js', 'analysis/dart.js', 'analysis/models.js', 'analysis/units.js', 'analysis/structure.js', 'analysis/chains.js', 'analysis/commits.js', 'analysis/outline.js', 'dist/provenance.js'];

/** What chains follow: the commits that started each change, or the code's structure alone. */
export type ChainsBy = 'history' | 'structure';

/** The steps a build runs, in order, when nothing is cached: the page lists those to come. */
export function buildSteps(chains: ChainsBy): string[] {
  return ['checkouts', 'packages', 'diff', 'analyzer', ...(chains === 'history' ? ['commits'] : []), 'analysis'];
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};
const writeJson = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data));
// A turn of the event loop: the page hears that a step started before the step holds the thread.
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Answers extends Extracted {
  version: string;
  diff: Parameters<typeof analyze>[0]['diff'];
  headDir: string;
  baseDir: string;
}

/** Checkouts of both sides, reusable by live navigation after extraction exits. */
export interface Checkouts {
  headDir: string;
  baseDir: string;
}

/**
 * The review and its checkouts. Bulk extraction exits before grouping; live navigation
 * starts its own language server after the review is ready.
 */
export async function buildReview(target: Target, opts: { noCache: boolean; label: string; title: string; chains: ChainsBy }, progress: Progress): Promise<{ data: ReviewData; checkouts: Checkouts | null }> {
  const dir = reviewDir(target.repoKey, target.baseSha, target.headSha);
  fs.mkdirSync(dir, { recursive: true });
  // The checkouts older untangles made as worktrees of your repository: it stops listing them.
  await rehomeCheckouts(target.repoKey);
  const byCommit = opts.chains === 'history';
  const extractorVersion = fingerprint(EXTRACTION_STAGE), modelVersion = extractorVersion + '.' + fingerprint(MODEL_STAGE);
  // Each way of chaining keeps its own analysis, so switching between them reuses both.
  const suffix = byCommit ? '-history' : '';

  const cached = !opts.noCache && readJson<{ version: string }>(path.join(dir, `meta${suffix}.json`));
  if (cached && cached.version === modelVersion) {
    const data = readJson<ReviewData>(path.join(dir, `review${suffix}.json`));
    if (data) {
      // The names are this run's: the same commits can come by a URL or a directory, and a title can change.
      Object.assign(data.model.compares.base, { title: opts.title, label: opts.label });
      progress.note(`using the analysis cached in ${tilde(dir)}`);
      return { data, checkouts: null };
    }
  }

  let answers = !opts.noCache ? readJson<Answers>(path.join(dir, 'answers.json')) : null;
  // The analysis reads the checkouts too: they must still hold the same commits.
  if (answers && (answers.version !== extractorVersion || !checkoutAt(answers.headDir, target.headSha) || !checkoutAt(answers.baseDir, target.baseSha))) answers = null;
  if (answers) progress.note('reusing the analyzer’s facts; running the analysis again');
  else answers = await askAnalyzer(target, dir, opts.label, extractorVersion, progress);

  let provenance: Provenance | null = null;
  if (byCommit) {
    progress.step('commits');
    try {
      const t1 = Date.now();
      const marked = new Set(answers.diff.compares.base.files.filter((f) => f.ga === 'true').map((f) => f.p));
      provenance = await readProvenance(target.repo, target.baseSha, target.headSha, generatedBy(generatedPatterns(target.repo, target.headSha), marked), opts.noCache ? null : dir);
      progress.verbose(`${provenance.commits.length} commits replayed in ${Date.now() - t1} ms`);
    } catch (e) {
      progress.note(`chains follow the code alone: the commits could not be replayed (${(e as Error).message})`);
    }
  }

  progress.step('analysis');
  await turn();
  const t0 = Date.now();
  const model = await analyze({
    repo: target.repo,
    headDir: answers.headDir,
    diff: answers.diff,
    defsRaw: answers.defs.raw,
    old: { base: { dir: answers.baseDir, raw: answers.defsOld.raw, structure: answers.structureOld } },
    structure: answers.structure,
    calls: answers.calls,
    supers: answers.supers,
    provenance,
    log: progress.verbose,
  });
  const c = model.compares.base;
  c.title = opts.title;
  type Change = { id: string; unit?: string; edits: number[] };
  const changes: Change[] = c.files.flatMap((f: { blocks: Change[] }) => f.blocks).filter((b: Change) => b.edits.length);
  const inChain = new Set(c.chains.flatMap((ch: { blocks: string[] }) => ch.blocks));
  const count = (blocks: Change[]) => new Set(blocks.map((block) => block.unit || block.id)).size;
  const commitChains = c.families ? `, following ${c.families.filter((f: { same?: boolean; chains: number[] }) => !f.same && f.chains.length).length} commits` : '';
  progress.note(`${c.chains.length} chains${commitChains} hold ${count(changes.filter((block) => inChain.has(block.id)))} of ${count(changes)} changes; ${c.groups.length} same-change groups (${Date.now() - t0} ms)`);

  const data: ReviewData = { model, defs: slim(answers.defs), refs: changedUsages(answers.diff, answers.headDir, answers.defs.raw), defsOld: { base: slim(answers.defsOld) } };
  writeJson(path.join(dir, `review${suffix}.json`), data);
  writeJson(path.join(dir, `meta${suffix}.json`), { version: modelVersion, untangle: VERSION, base: target.baseSha, head: target.headSha, builtAt: new Date().toISOString() });
  return { data, checkouts: { headDir: answers.headDir, baseDir: answers.baseDir } };
}

/**
 * Checkouts of both sides with their packages resolved. The directory itself serves as the head
 * when it holds the head commit and its packages are resolved; untangle never runs pub get in it.
 */
export async function prepareCheckouts(target: Target, progress: Progress): Promise<{ headDir: string; baseDir: string }> {
  progress.step('checkouts');
  const needs = (checkout: string) => packageDirs(target.repo, target.baseSha, target.headSha, checkout);
  let headDir = target.headDir && checkoutAt(target.headDir, target.headSha) && needs(target.headDir).every(resolved) ? fs.realpathSync(target.headDir) : null;
  if (target.headDir && !headDir) progress.note('your checkout’s packages aren’t resolved; using a checkout in the cache for the head');
  progress.detail('base ' + target.baseSha.slice(0, 7));
  const baseDir = await worktree(target.repo, target.repoKey, target.baseSha);
  if (!headDir) {
    progress.detail('head ' + target.headSha.slice(0, 7));
    headDir = await worktree(target.repo, target.repoKey, target.headSha);
  }
  progress.note(`head ${tilde(headDir)}`);
  progress.note(`base ${tilde(baseDir)}`);

  progress.step('packages');
  for (const [side, checkout] of [['head', headDir], ['base', baseDir]] as const) {
    if (checkout === target.headDir) continue;
    const dirs = needs(checkout).filter((d) => !resolved(d));
    if (!dirs.length) continue;
    progress.detail(`${side}: pub get in ${dirs.length} folder${dirs.length > 1 ? 's' : ''}`);
    const failed = await pubGet(dirs, progress.verbose);
    failed.forEach((d) => progress.note(`pub get failed in ${tilde(d)}; its code resolves partly`));
  }
  return { headDir, baseDir };
}

async function askAnalyzer(target: Target, dir: string, label: string, version: string, progress: Progress): Promise<Answers> {
  const { headDir, baseDir } = await prepareCheckouts(target, progress);

  progress.step('diff');
  await turn();
  const diff = exportDiff(target.repo, { base: { left: target.baseSha, right: target.headSha, label } }, generatedPatterns(target.repo, target.headSha));
  const files = diff.compares.base.files;
  progress.note(`${files.length} files changed, ${files.filter((f) => !f.hunks).length} of them generated`);

  progress.step('analyzer');
  if (!has('dart')) throw new Error('untangle needs the Dart SDK on PATH');
  const facts = await extract(diff, headDir, baseDir, progress);
  const answers: Answers = { version, diff, ...facts, headDir, baseDir };
  writeJson(path.join(dir, 'answers.json'), answers);
  return answers;
}
