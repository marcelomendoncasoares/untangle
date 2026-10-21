// Process metrics for the page's status bar: untangle's memory, CPU and active resources, and the
// language server's memory and CPU.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const linux = process.platform === 'linux';

/** Resident memory of a process, in bytes. */
export function rss(pid: number): number | null {
  try {
    if (linux) {
      const kb = /^VmRSS:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return kb ? Number(kb[1]) * 1024 : null;
    }
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024 || null;
  } catch {
    return null;
  }
}

/** A process's children: a review's language server, for one that can't say its memory itself. */
export function childPids(pid: number): number[] {
  try {
    const text = linux ? fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8') : execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    return text.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** CPU time a process has used, in milliseconds (Linux: user and system ticks of 10 ms). */
function cpuMs(pid: number): number | null {
  if (!linux) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[11]) + Number(fields[12])) * 10;
  } catch {
    return null;
  }
}

export interface LspState {
  state: 'off' | 'starting' | 'ready' | 'failed';
  pid: number | null;
  error?: string;
}

export class Metrics {
  private last = { at: process.hrtime.bigint(), cpu: process.cpuUsage(), lsp: null as { pid: number; ms: number } | null };

  /** Usage since the previous sample: CPU as a percentage of one core. */
  sample(lsp: LspState) {
    const at = process.hrtime.bigint(), cpu = process.cpuUsage();
    const wallMs = Math.max(1, Number(at - this.last.at) / 1e6);
    const ownMs = (cpu.user - this.last.cpu.user + cpu.system - this.last.cpu.system) / 1000;
    const lspMs = lsp.pid ? cpuMs(lsp.pid) : null;
    const lspCpu = lspMs != null && this.last.lsp && this.last.lsp.pid === lsp.pid ? (100 * (lspMs - this.last.lsp.ms)) / wallMs : null;
    this.last = { at, cpu, lsp: lsp.pid && lspMs != null ? { pid: lsp.pid, ms: lspMs } : null };
    return {
      rss: process.memoryUsage().rss,
      cpu: (100 * ownMs) / wallMs,
      resources: process.getActiveResourcesInfo().length,
      lsp: { ...lsp, rss: lsp.pid ? rss(lsp.pid) : null, cpu: lspCpu },
    };
  }
}
