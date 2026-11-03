// Compile once at installation/build time; review startup never runs pub or a compiler.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// tsc has built it: dart as untangle starts it, Flutter's dart.bat on Windows included.
import { dartSpawn } from '../dist/exec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'analyzer');
const output = path.join(root, 'dist', process.platform === 'win32' ? 'dart-analyzer.exe' : 'dart-analyzer');
const stamp = output + '.sha256';
let version;

try {
  version = execFileSync(...dartSpawn(['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('Dart is unavailable; skipping the analyzer build. Dart reviews require Dart 3.12+ and npm run build.');
  process.exit(0);
}

const hash = crypto.createHash('sha256').update(version).update(process.platform).update(process.arch);
for (const file of ['bin/extract.dart', 'pubspec.yaml', 'pubspec.lock']) hash.update(fs.readFileSync(path.join(source, file)));
const fingerprint = hash.digest('hex');

if (fs.existsSync(output) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fingerprint) process.exit(0);

fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = output + '.' + process.pid;

try {
  execFileSync(...dartSpawn(['pub', 'get', '--enforce-lockfile'], { cwd: source, stdio: 'inherit' }));
  execFileSync(...dartSpawn(['compile', 'exe', 'bin/extract.dart', '-o', temporary], { cwd: source, stdio: 'inherit' }));
  fs.renameSync(temporary, output);
  fs.writeFileSync(stamp, fingerprint);
} finally {
  fs.rmSync(temporary, { force: true });
}
