// GitHub's two protocols end at local bare repositories, including pushes made from the worktree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stubGh } from '../helpers/gh.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

export function workingFixture(o: { fork?: boolean; protocol?: 'ssh' | 'https'; state?: string; missing?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-working-'));
  const cache = path.join(root, 'cache');
  const mirror = path.join(root, 'github');
  const author = TempRepo.create();
  author.write('.gitignore', 'ignored\n');
  author.write('greeting.txt', 'hello\n');
  const base = author.commit({ subject: 'Start', author: ada, committer: ada });
  author.branch('feature');
  author.write('greeting.txt', 'hello world\n');
  const head = author.commit({ subject: 'Greet the world', author: ada, committer: ada });
  const bare = path.join(mirror, 'acme/sample.git');
  const fork = path.join(mirror, 'ada/sample.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  fs.mkdirSync(path.dirname(fork), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.file://${mirror}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/',
    GIT_CONFIG_KEY_1: `url.file://${mirror}/.insteadOf`, GIT_CONFIG_VALUE_1: 'git@github.com:',
    GIT_AUTHOR_NAME: ada.name, GIT_AUTHOR_EMAIL: ada.email, GIT_COMMITTER_NAME: ada.name, GIT_COMMITTER_EMAIL: ada.email,
  };
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'clone', '--bare', author.dir, bare);
  git(root, 'clone', '--bare', author.dir, fork);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(bare, 'update-ref', 'refs/pull/7/head', head);
  git(bare, 'update-ref', 'refs/pull/8/head', head);
  if (o.fork) git(bare, 'update-ref', '-d', 'refs/heads/feature');
  const remote = o.fork ? fork : bare;
  author.remoteAdd('origin', remote);
  const url = 'https://github.com/acme/sample/pull/7';
  const pr = {
    number: 7, title: 'Greet the world', url, state: o.state ?? 'OPEN', baseRefName: 'main', baseRefOid: base,
    headRefName: 'feature', headRefOid: head, headRepository: o.missing ? null : { name: 'sample' },
    headRepositoryOwner: o.missing ? null : { login: o.fork ? 'ada' : 'acme' }, isCrossRepository: o.fork ?? false,
  };
  const gh = stubGh();
  const answer = () => gh.setReplies([
    { match: ['config', 'get', 'git_protocol'], stdout: o.protocol ?? 'https' },
    { match: ['pr', 'view'], stdout: pr },
  ]);
  answer();
  const commit = (dir: string, file = 'added.txt', text = 'a change\n') => {
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, 'add', file);
    git(dir, 'commit', '-m', 'Change the greeting');
    return git(dir, 'rev-parse', 'HEAD');
  };
  return {
    root, cache, bare, remote, author, base, head, url, env, gh, pr, git, commit, answer,
    push: () => {
      git(author.dir, 'push', 'origin', 'feature');
      // The pull ref lives in the base repository even when the head lives in a fork.
      git(bare, 'fetch', remote, '+refs/heads/feature:refs/pull/7/head');
      pr.headRefOid = git(remote, 'rev-parse', 'feature');
      answer();
    },
    use() {
      const saved = { ...process.env };
      Object.assign(process.env, env, gh.env, { UNTANGLE_CACHE: cache });
      return () => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      };
    },
    remove() {
      gh.remove();
      author.remove();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function until<T>(what: string, read: () => Promise<T> | T): Promise<NonNullable<T>> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
