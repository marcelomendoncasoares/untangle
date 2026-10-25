import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package's root folder: dist/, analysis/ and viewer/ live in it. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * When the untangle on disk was built: the newest of its compiled code, its analysis and its page,
 * as they are now. A process keeps running the code it started with, so a newer build on disk is a
 * reason to restart it. UNTANGLE_BUILT_FROM names one more file to count, for tests.
 */
export function builtAt(): number {
  let newest = 0;
  const seen = (file: string) => {
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs);
    } catch {
      // Gone meanwhile.
    }
  };
  const walk = (dir: string, keep: RegExp, deep: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (deep) walk(p, keep, deep);
      } else if (keep.test(e.name)) seen(p);
    }
  };
  walk(path.join(ROOT, 'dist'), /\.js$/, true);
  walk(path.join(ROOT, 'analysis'), /\.js$/, false);
  walk(path.join(ROOT, 'viewer'), /\.(js|html|css)$/, false);
  if (process.env.UNTANGLE_BUILT_FROM) seen(process.env.UNTANGLE_BUILT_FROM);
  return newest;
}

/** What this process runs: the untangle on disk as it started. */
export const STARTED_BUILT = builtAt();
