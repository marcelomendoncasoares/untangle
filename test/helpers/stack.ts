// main <- a <- b <- c, with a fix on b merged into c, and d built on c. All fetches
// and pushes go to the temporary bare repository, including URLs that look like GitHub's.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conversationOf, pullRequest } from './conversation.ts';
import { stubGh, type GhReply } from './gh.ts';
import { TempRepo, type Person } from './repo.ts';
import { pubspec } from './review.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const file = 'lib/stack.dart';

export function stackFixture() {
  const work = TempRepo.create();
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-stack-'));
  const bare = path.join(mirror, 'acme', 'sample.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' } }).trim();
  git(mirror, 'init', '--bare', '-b', 'main', bare);
  work.config('user.name', ada.name);
  work.config('user.email', ada.email);
  const commit = (subject: string) => work.commit({ subject, author: ada, committer: ada });
  const text = (ref = 'HEAD') => git(work.dir, 'show', `${ref}:${file}`) + '\n';
  work.write('pubspec.yaml', pubspec);
  const context = 'void context() {\n  print("old");\n}\n';
  work.write('lib/context.dart', context);
  work.write(file, "void review() {\n  print('root');\n  print('obsolete');\n  print('keep1');\n  print('keep2');\n  print('keep3');\n  print('keep4');\n  print('keep5');\n  print('keep6');\n}\n");
  const base = commit('Start');
  work.branch('a');
  work.write(file, text().replace("  print('root');", "  print('root');\n  print('a');"));
  const a = commit('Add a');
  work.branch('b');
  work.write('lib/context.dart', context.replace('}\n', '  print("b only");\n}\n'));
  work.write(file, text().replace("  print('a');", "  print('a');\n  print('b');").replace("  print('keep6');", "  print('keep6');\n  print('temporary b');"));
  const b = commit('Add b');
  work.branch('c');
  work.write('lib/context.dart', context);
  work.write(file, '// c\n' + text().replace("print('temporary b')", "print('c')"));
  const c = commit('Add c');
  work.checkout('b');
  work.write(file, text().replace("  print('obsolete');\n", ''));
  const fix = commit('Fix b');
  work.checkout('c');
  const merge = work.merge({ ref: 'b', subject: 'Bring b into c', author: ada, committer: ada });
  work.branch('d');
  work.write('lib/d.dart', 'void d() {}\n');
  const d = commit('Add d');
  work.checkout('c');
  work.remoteAdd('origin', 'https://github.com/acme/sample.git');
  const branches = { a: 'a', b: 'b', c: 'c', d: 'd' };
  const heads = { a, b: fix, c: merge, d };
  const urls = { a: 'https://github.com/acme/sample/pull/1', b: 'https://github.com/acme/sample/pull/2', c: 'https://github.com/acme/sample/pull/3', d: 'https://github.com/acme/sample/pull/4' };
  const prs = Object.entries(branches).map(([name, branch], i) => ({
    number: i + 1, title: `Add ${name}`, url: urls[name as keyof typeof urls], state: 'OPEN',
    baseRefName: i ? Object.values(branches)[i - 1] : 'main', baseRefOid: i ? Object.values(heads)[i - 1] : base,
    headRefName: branch, headRefOid: heads[name as keyof typeof heads], isDraft: false, author: { login: 'ada' },
    headRepository: { name: 'sample' }, headRepositoryOwner: { login: 'acme' }, isCrossRepository: false,
  }));
  const conversations = prs.map((p) => ({ ...pullRequest({ number: p.number, title: p.title, url: p.url, head: p.headRefOid }), id: `PR_${p.number}` }));
  const line = (ref: string, content: string) => {
    const n = text(ref).trimEnd().split('\n').findIndex((s) => s.includes(content));
    if (n < 0) throw new Error(`no ${content} in ${ref}`);
    return n + 1;
  };
  const lowerThreads = pullRequest({ number: 2, title: 'Add b', url: urls.b, head: fix, threads: [
    { id: 'B_LINE', path: file, line: line('b', "'b'"), body: 'Keep this in b.' },
    { id: 'B_OLD', path: file, line: line('b', "'temporary b'"), body: 'This later changes.' },
    { id: 'B_REMOVED', path: file, line: line('a', "'obsolete'"), body: 'Was this removed?' },
    { id: 'B_CONTEXT', path: 'lib/context.dart', line: 2, body: 'Context in a file the overall review no longer shows.' },
  ] }).reviewThreads;
  lowerThreads.nodes[2].diffSide = 'LEFT';
  conversations[1].reviewThreads = lowerThreads;
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${mirror}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };
  const gh = stubGh();
  const merged: Array<{ number: number; headRefOid: string; mergeCommit: { oid: string }; mergedAt: string }> = [];
  const replies = (opened = 3, extra: GhReply[] = []): GhReply[] => [
    ...extra,
    { match: ['config', 'get', 'git_protocol'], stdout: 'https' },
    { match: ['pr', 'list', '--repo', 'acme/sample', '--state', 'open'], stdout: prs.filter((p) => p.state === 'OPEN') },
    { match: ['pr', 'list', '--repo', 'acme/sample', '--state', 'merged'], stdout: merged },
    ...prs.map((p) => ({ match: ['pr', 'view', String(p.number)], stdout: p })),
    { match: ['pr', 'view'], stdout: prs[opened - 1] },
    ...prs.map((p) => ({ match: ['api', 'graphql'], stdinIncludes: `"number":${p.number}`, stdout: { ...conversationOf({ number: p.number, title: p.title, url: p.url, head: p.headRefOid }), data: { viewer: { login: 'ada', avatarUrl: '', url: 'https://github.com/ada' }, repository: { pullRequest: conversations[p.number - 1] } } } })),
  ];
  const update = (opened = 3, extra: GhReply[] = []) => gh.setReplies(replies(opened, extra));
  const publish = (number: number) => {
    const p = prs[number - 1];
    p.headRefOid = work.rev(p.headRefName);
    p.baseRefOid = work.rev(p.baseRefName);
    conversations[number - 1].headRefOid = p.headRefOid;
    git(work.dir, 'push', '--force', bare, `refs/heads/${p.headRefName}:refs/heads/${p.headRefName}`, `refs/heads/${p.headRefName}:refs/pull/${number}/head`);
    update();
  };
  git(work.dir, 'push', bare, 'main');
  for (const p of prs) publish(p.number);
  update();
  return {
    work, mirror, bare, env, gh, file, base, branches, heads, urls, prs, merged, conversations, commits: { a, b, c, fix, merge, d },
    git, text, line, commit, publish, replies, update,
    remove() { gh.remove(); work.remove(); fs.rmSync(mirror, { recursive: true, force: true }); },
  };
}

export type StackFixture = ReturnType<typeof stackFixture>;
