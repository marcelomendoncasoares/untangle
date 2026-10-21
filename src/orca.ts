// Orca's command line, as untangle's manager uses it: to bring a review's tab or its chat's
// terminal to the front. Orca exports its command to the terminals it runs (ORCA_CLI_COMMAND);
// elsewhere on Linux it's orca-ide, since a bare orca there is often the screen reader.
import { spawn } from 'node:child_process';
import { has } from './exec.js';

/** Orca's command, when there is one to run. */
export function orcaCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const cli = env.ORCA_CLI_COMMAND || (process.platform === 'linux' ? 'orca-ide' : 'orca');
  return has(cli) ? cli : null;
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
