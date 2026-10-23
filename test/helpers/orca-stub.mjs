#!/usr/bin/env node
// A stand-in for Orca's CLI: it notes each call (a JSON line in ORCA_STUB_LOG) and answers as Orca
// would, from a small state file next to the log: a project added, its worktree, the tabs opened
// (where, and showing what) and terminals.
import fs from 'node:fs';

const args = process.argv.slice(2).filter((a) => a !== '--json');
const log = process.env.ORCA_STUB_LOG;
fs.appendFileSync(log, JSON.stringify(args) + '\n');
const stateFile = log + '.state';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { repos: [], tabs: 0, terminals: 0, open: [] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const ok = (result) => process.stdout.write(JSON.stringify({ ok: true, result }));
const fail = (code) => process.stdout.write(JSON.stringify({ ok: false, error: { code } }));
const flag = (name) => args[args.indexOf(name) + 1];
const [a, b] = args;

if (a === 'repo' && b === 'add') {
  const id = `repo-${state.repos.length + 1}`;
  state.repos.push({ id, path: flag('--path') });
  save();
  ok({ repo: { id, path: flag('--path') } });
} else if (a === 'worktree' && b === 'list') {
  const repo = state.repos.find((r) => `id:${r.id}` === flag('--repo'));
  ok({ worktrees: repo ? [{ id: `${repo.id}::${repo.path}`, path: repo.path }] : [] });
} else if (a === 'worktree' && b === 'show') {
  const known = state.repos.some((r) => `id:${r.id}::${r.path}` === flag('--worktree'));
  known ? ok({ worktree: { id: flag('--worktree').slice(3) } }) : fail('worktree_not_found');
} else if (a === 'tab' && b === 'create' && flag('--worktree') === 'id:global-floating-terminal') {
  // Orca's CLI can't name its floating workspace: a tab there comes from a page of its own.
  fail('selector_not_found');
} else if (a === 'tab' && b === 'create') {
  state.tabs++;
  const worktree = args.includes('--worktree') ? flag('--worktree').replace(/^id:/, '') : 'wt-active';
  (state.open ??= []).push({ browserPageId: `pg_${state.tabs}`, url: flag('--url'), worktreeId: worktree, active: true });
  save();
  ok({ browserPageId: `pg_${state.tabs}` });
} else if (a === 'tab' && b === 'list') {
  ok({ tabs: state.open ?? [] });
} else if (a === 'terminal' && b === 'create') {
  state.terminals++;
  save();
  ok({ handle: `term_${state.terminals}` });
} else ok({});
