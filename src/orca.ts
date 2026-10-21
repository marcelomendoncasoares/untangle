// Orca's command line, as untangle's manager uses it: to bring a review's tab or its chat's
// terminal to the front, and to start chats in the Reviews workspace. Orca exports its command to
// the terminals it runs (ORCA_CLI_COMMAND); elsewhere on Linux it's orca-ide, since a bare orca
// there is often the screen reader.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { has } from './exec.js';

/**
 * Orca's command, when there is one to run: the one Orca's terminals export, or Orca's own on
 * PATH. UNTANGLE_NO_ORCA keeps untangle off the one on PATH (its tests set it), so only a
 * terminal Orca runs leads it to Orca.
 */
export function orcaCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const cli = env.ORCA_CLI_COMMAND || (env.UNTANGLE_NO_ORCA ? null : process.platform === 'linux' ? 'orca-ide' : 'orca');
  return cli && has(cli) ? cli : null;
}

/** What Orca answered: its result, or its error's code. */
export interface OrcaAnswer { ok: boolean; code: string | null; result: Record<string, unknown> | null }

/** Runs an Orca command with --json, and reads its answer. */
export function orca(args: string[], cli: string | null = orcaCli()): Promise<OrcaAnswer> {
  if (!cli) return Promise.resolve({ ok: false, code: 'no Orca here', result: null });
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cli, [...args, '--json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: 'Orca didn’t start', result: null }); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { ok?: boolean; error?: { code?: string; message?: string }; result?: Record<string, unknown> };
        resolve({ ok: j.ok === true, code: j.ok ? null : j.error?.code || j.error?.message || 'failed', result: j.result ?? null });
      } catch {
        resolve({ ok: false, code: 'Orca didn’t answer', result: null });
      }
    });
  });
}

/** Brings a browser tab to the front: false when it's gone. */
export async function showTab(page: string, cli = orcaCli()): Promise<boolean> {
  return (await orca(['tab', 'switch', '--page', page, '--focus'], cli)).ok;
}

/**
 * Brings a terminal to the front. Orca gives a terminal a new handle when it restarts: its pane
 * (tab:leaf) finds it again. The handle it has now, or null when it's gone.
 */
export async function showTerminal(t: { handle: string; pane: string | null }, cli = orcaCli()): Promise<string | null> {
  const r = await orca(['terminal', 'switch', '--terminal', t.handle], cli);
  if (r.ok) return t.handle;
  if (r.code !== 'terminal_handle_stale' || !t.pane) return null;
  const list = await orca(['terminal', 'list'], cli);
  const terms = ((list.result as { terminals?: Array<{ handle: string; tabId?: string; leafId?: string }> } | null)?.terminals) || [];
  const found = terms.find((x) => `${x.tabId}:${x.leafId}` === t.pane);
  return found && (await orca(['terminal', 'switch', '--terminal', found.handle], cli)).ok ? found.handle : null;
}

/** Where untangle keeps the Reviews workspace's folder, and what Orca calls it once it's added. */
const workspaceDir = (root: string) => path.join(root, 'chats', 'Reviews');
const workspaceFile = (root: string) => path.join(root, 'chats', 'orca.json');

/**
 * The Reviews workspace: one Orca project for every review, where their chats run and their
 * pages open as tabs. It's a folder of untangle's cache, made a git repository so Orca takes it as
 * a project, and added to Orca the first time. Its worktree's id, or null without Orca.
 */
export async function reviewsWorkspace(root: string, cli = orcaCli()): Promise<{ worktree: string; folder: string } | null> {
  if (!cli) return null;
  const folder = workspaceDir(root);
  if (!fs.existsSync(path.join(folder, '.git'))) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'README.md'), 'The chats of your untangle reviews run here: untangle reviews starts them.\n');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'untangle', GIT_AUTHOR_EMAIL: 'untangle@localhost', GIT_COMMITTER_NAME: 'untangle', GIT_COMMITTER_EMAIL: 'untangle@localhost' };
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['commit', '-q', '--no-gpg-sign', '-m', 'The Reviews workspace']]) {
      if (spawnSync('git', ['-C', folder, ...args], { env, stdio: 'ignore' }).status !== 0) return null;
    }
  }
  // Added before: the worktree Orca gave it, when Orca still has it.
  try {
    const known = JSON.parse(fs.readFileSync(workspaceFile(root), 'utf8')) as { worktree?: string };
    if (known.worktree && (await orca(['worktree', 'show', '--worktree', `id:${known.worktree}`], cli)).ok) return { worktree: known.worktree, folder };
  } catch {
    // Not added yet.
  }
  const added = await orca(['repo', 'add', '--path', folder], cli);
  const repo = (added.result as { repo?: { id?: string } } | null)?.repo?.id;
  if (!added.ok || !repo) return null;
  const list = await orca(['worktree', 'list', '--repo', `id:${repo}`], cli);
  const worktree = ((list.result as { worktrees?: Array<{ id?: string }> } | null)?.worktrees ?? []).map((w) => w.id).find(Boolean);
  if (!worktree) return null;
  await orca(['worktree', 'set', '--worktree', `id:${worktree}`, '--display-name', 'Reviews'], cli);
  fs.writeFileSync(workspaceFile(root), JSON.stringify({ worktree, repo }));
  return { worktree, folder };
}

/** Starts a command in a new terminal of a workspace, titled: its handle, or null when Orca didn't. */
export async function newTerminal(worktree: string, title: string, command: string, cli = orcaCli()): Promise<string | null> {
  const r = await orca(['terminal', 'create', '--worktree', `id:${worktree}`, '--title', title, '--command', command], cli);
  const res = r.result as { handle?: string; terminal?: { handle?: string } } | null;
  return r.ok ? res?.handle ?? res?.terminal?.handle ?? null : null;
}
