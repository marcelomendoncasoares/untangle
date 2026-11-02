// A headless Chromium through the DevTools protocol. No Puppeteer or Playwright.
// Snap Chromium cannot read the host's /tmp, so pages are opened over http only
// and its profile lives under the home directory.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export function findChrome(): string | null {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const name of ['chromium', 'google-chrome', 'chromium-browser']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (found) return found;
    } catch {
      // The next name.
    }
  }
  return null;
}

/** Why a browser test cannot run, or false when Chromium is available. */
export function browserSkip(): string | false {
  return findChrome() ? false : 'Chromium is not on PATH (CHROME_PATH, chromium, google-chrome, or chromium-browser)';
}

/** Why an end-to-end test cannot run, or false when Chromium and dart are available. */
export function e2eSkip(): string | false {
  const chrome = browserSkip();
  if (chrome) return chrome;
  try {
    execFileSync('which', ['dart'], { stdio: 'ignore' });
  } catch {
    return 'dart is not on PATH';
  }
  return false;
}

const KEYS: Record<string, { code: string; vk: number; text?: string; shift?: boolean }> = {
  Escape: { code: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Enter: { code: 'Enter', vk: 13 },
  Tab: { code: 'Tab', vk: 9 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  '?': { code: 'Slash', vk: 191, text: '?', shift: true },
};

export interface Browser {
  goto(url: string): Promise<void>;
  /** Polls a JS expression until it is truthy. Throws the expression if it never is. */
  until(expression: string, ms?: number): Promise<unknown>;
  eval(expression: string): Promise<unknown>;
  click(selector: string, opts?: { scroll?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }): Promise<void>;
  /** Clicks the element whose own text is `name` and whose line contains `line`. */
  clickIn(selector: string, name: string, line: string, opts?: { ctrl?: boolean }): Promise<void>;
  shiftClick(selector: string): Promise<void>;
  doubleClick(selector: string): Promise<void>;
  /** Presses at the element's center, moves by `dx`/`dy`, and releases. */
  drag(selector: string, dx: number, dy: number): Promise<void>;
  /** Presses on `from` and releases on `onto`. */
  dragOnto(from: string, onto: string): Promise<void>;
  /** Clicks at a fraction of the element's box, 0 to 1 from the top left. */
  clickRatio(selector: string, xRatio: number, yRatio: number, opts?: { scroll?: boolean }): Promise<void>;
  /** Moves the pointer to the element's center, or to `x` and `y`, fractions of its box from the top left. */
  hover(selector: string, opts?: { scroll?: boolean; x?: number; y?: number }): Promise<void>;
  /** Moves the pointer to the element's center and, two frames later, turns the wheel `dy` pixels there. */
  wheel(selector: string, dy: number): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string, opts?: { shift?: boolean; ctrl?: boolean }): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  /** A phone's screen, its width and height in CSS pixels, with its pixel ratio and touch. */
  phone(width: number, height: number): Promise<void>;
  /** A finger put down on the element's middle, moved down by dy pixels, and lifted. */
  swipe(selector: string, dy: number): Promise<void>;
  reducedMotion(on: boolean): Promise<void>;
  /** Installs a fake clock before the next document's scripts run. */
  installClock(): Promise<void>;
  /** Moves the fake clock and runs the timers that came due. */
  advance(ms: number): Promise<void>;
  close(): Promise<void>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: unknown;
  params?: {
    loaderId?: string;
    frame?: { loaderId?: string; parentId?: string };
    response?: { url?: string; status?: number };
  };
}

export async function launchBrowser(width = 1400, height = 900): Promise<Browser> {
  const bin = findChrome();
  if (!bin) throw new Error(String(browserSkip()));
  const profile = fs.mkdtempSync(path.join(os.homedir(), 'untangle-e2e-'));
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const browserUrl = await devtoolsUrl(child);
  const ws = new WebSocket(browserUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('the DevTools socket failed')));
  });
  let next = 0;
  let sessionId = '';
  const pending = new Map<number, (message: CdpMessage) => void>();
  const events = new Map<string, Array<(message: CdpMessage) => void>>();
  const onEvent = (method: string, handler: (message: CdpMessage) => void) => {
    const list = events.get(method) ?? [];
    list.push(handler);
    events.set(method, list);
    return () => {
      const current = events.get(method) ?? [];
      events.set(method, current.filter((item) => item !== handler));
    };
  };
  const send = (method: string, params: Record<string, unknown> = {}, session?: string) => new Promise<CdpMessage>((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params, sessionId: session }));
  });
  ws.addEventListener('message', (ev: MessageEvent) => {
    const message = JSON.parse(String(ev.data)) as CdpMessage;
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
    if (message.method && (!message.sessionId || message.sessionId === sessionId)) {
      for (const handler of events.get(message.method) ?? []) handler(message);
    }
    if (message.method === 'Page.javascriptDialogOpening' && sessionId) {
      void send('Page.handleJavaScriptDialog', { accept: true }, sessionId);
    }
  });
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = (created.result as { targetId: string }).targetId;
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = (attached.result as { sessionId: string }).sessionId;
  const session = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
  await session('Page.enable');
  await session('Runtime.enable');
  // With UNTANGLE_VIEWER_COV, the page's code coverage (npm run test:coverage): taken before each
  // navigation, when the page reloads itself, and at close.
  const covDir = process.env.UNTANGLE_VIEWER_COV;
  const takeCoverage = async () => {
    if (!covDir) return;
    try {
      const taken = await session('Profiler.takePreciseCoverage');
      const scripts = ((taken.result as { result?: Array<{ url: string }> } | undefined)?.result ?? []).filter((x) => x.url.startsWith('http'));
      if (scripts.length) fs.writeFileSync(path.join(covDir, `page-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(scripts));
    } catch {
      // The page is gone.
    }
  };
  if (covDir) {
    await session('Profiler.enable');
    await session('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    onEvent('Page.frameStartedLoading', () => { void takeCoverage(); });
  }
  await session('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression: string): Promise<unknown> => {
    const message = await session('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const result = message.result as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined;
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || expression);
    }
    return result?.result?.value;
  };

  type Box = { left: number; top: number; width: number; height: number };
  const same = (a: Box, b: Box) => Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
  /**
   * The box of the element `find` evaluates to, once it holds still and is what sits at its centre.
   * The page keeps a line in place for a few frames after it redraws, so each look first lets
   * those frames pass: a click measured before them would land where the line no longer is. An
   * element that stays covered (a scrim over it, on purpose) is used as it is after a few tries.
   */
  const settledBox = async (find: string, scroll: boolean, what: string): Promise<Box> => {
    let last: Box | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const box = await evaluate(`(async () => {
        await Promise.race([
          new Promise((done) => { let frames = 0; const tick = () => (++frames >= 4 ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }),
          new Promise((done) => setTimeout(done, 250)),
        ]);
        const el = ${find};
        if (!el) return null;
        if (${scroll ? 'true' : 'false'}) el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { left: r.left, top: r.top, width: r.width, height: r.height, hit: !!top && (top === el || el.contains(top)) };
      })()`) as (Box & { hit: boolean }) | null;
      if (!box) throw new Error(`no element matches ${what}`);
      if (box.hit && last && same(last, box)) return box;
      last = box;
    }
    return last!;
  };
  const boxOf = (selector: string, scroll: boolean) => settledBox(`document.querySelector(${JSON.stringify(selector)})`, scroll, selector);
  const at = async (x: number, y: number, type: string, modifiers: number, clickCount: number, buttons = 0) => {
    await session('Input.dispatchMouseEvent', { x, y, type, button: 'left', buttons, modifiers, clickCount, pointerType: 'mouse' });
  };
  const clickAt = async (x: number, y: number, modifiers: number, clickCount: number) => {
    await at(x, y, 'mouseMoved', modifiers, 0);
    await at(x, y, 'mousePressed', modifiers, clickCount);
    await at(x, y, 'mouseReleased', modifiers, clickCount);
  };
  const press = async (key: string, opts: { shift?: boolean; ctrl?: boolean }) => {
    const known = KEYS[key] ?? {
      code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key,
      vk: 0,
      text: key.length === 1 ? key : undefined,
    };
    const modifiers = ((opts.shift || known.shift) ? 8 : 0) + (opts.ctrl ? 2 : 0);
    const commands = opts.ctrl && key.toLowerCase() === 'a' ? ['selectAll'] : undefined;
    const base = { key, code: known.code, windowsVirtualKeyCode: known.vk, modifiers };
    await session('Input.dispatchKeyEvent', { ...base, type: 'keyDown', commands });
    if (known.text && !opts.ctrl) await session('Input.dispatchKeyEvent', { ...base, type: 'char', text: known.text });
    await session('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    await takeCoverage();
    closed = true;
    try { ws.close(); } catch { /* already closed */ }
    if (child.pid != null && child.exitCode == null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode != null || child.signalCode != null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (child.pid != null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
        }
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(profile, { recursive: true, force: true });
  };

  return {
    async goto(url: string) {
      await takeCoverage();
      // The document already up is complete, so readyState alone can succeed
      // before this navigation commits. Mark it, and accept the page only once
      // the loader Page.navigate returns has committed and loaded. A token URL
      // redirects, and that loader id is kept across the redirect. The load
      // event itself carries no loader id.
      const token = `leaving-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      let marked = false;
      try {
        await evaluate(`window.__leaving = ${JSON.stringify(token)}`);
        marked = true;
      } catch {
        // about:blank, or a document that is already going away.
      }
      const frames: Array<{ loaderId: string; parentId?: string; n: number }> = [];
      const loads: number[] = [];
      let n = 0;
      const stopFrame = onEvent('Page.frameNavigated', (message) => {
        const frame = message.params?.frame;
        if (!frame?.loaderId) return;
        frames.push({ loaderId: frame.loaderId, parentId: frame.parentId, n: ++n });
      });
      const stopLoad = onEvent('Page.loadEventFired', () => {
        loads.push(++n);
      });
      try {
        const navigated = await session('Page.navigate', { url });
        const result = navigated.result as { loaderId?: string; errorText?: string } | undefined;
        if (result?.errorText) throw new Error(result.errorText);
        const loaderId = result?.loaderId;
        if (!loaderId) throw new Error(`the new page did not load: ${url}`);
        const arrived = marked
          ? `window.__leaving !== ${JSON.stringify(token)} && document.readyState === "complete"`
          : 'document.readyState === "complete"';
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const frame = frames.find((item) => item.loaderId === loaderId && !item.parentId);
          const loaded = frame != null && loads.some((at) => at > frame.n);
          if (loaded) {
            const tree = await session('Page.getFrameTree');
            const current = (tree.result as { frameTree?: { frame?: { loaderId?: string } } } | undefined)?.frameTree?.frame?.loaderId;
            if (current === loaderId) {
              try {
                if (await evaluate(arrived)) return;
              } catch {
                // The new document is not scriptable yet.
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`the new page did not load: ${url}`);
      } finally {
        stopFrame();
        stopLoad();
      }
    },
    until(expression: string, ms = 60_000) {
      return poll(evaluate, expression, ms);
    },
    eval: evaluate,
    async click(selector: string, opts: { scroll?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) {
      const box = await boxOf(selector, opts.scroll !== false);
      await clickAt(box.left + box.width / 2, box.top + box.height / 2, (opts.ctrl ? 2 : 0) | (opts.meta ? 4 : 0) | (opts.shift ? 8 : 0), 1);
    },
    async clickIn(selector: string, name: string, line: string, opts: { ctrl?: boolean } = {}) {
      const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => (node.textContent || '') === ${JSON.stringify(name)} && (node.closest('.ln, .sl, .pk-ln')?.textContent || '').includes(${JSON.stringify(line)}))`;
      const box = await settledBox(find, true, `${selector} named ${name} on a line with ${line}`);
      await clickAt(box.left + box.width / 2, box.top + box.height / 2, opts.ctrl ? 2 : 0, 1);
    },
    async shiftClick(selector: string) {
      const box = await boxOf(selector, true);
      await clickAt(box.left + box.width / 2, box.top + box.height / 2, 8, 1);
    },
    async doubleClick(selector: string) {
      const box = await boxOf(selector, true);
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      await clickAt(x, y, 0, 1);
      await clickAt(x, y, 0, 2);
    },
    async drag(selector: string, dx: number, dy: number) {
      const box = await boxOf(selector, true);
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      await at(x, y, 'mousePressed', 0, 1, 1);
      await at(x + dx, y + dy, 'mouseMoved', 0, 0, 1);
      await at(x + dx, y + dy, 'mouseReleased', 0, 1, 0);
    },
    async dragOnto(from: string, onto: string) {
      const points = await evaluate(`(() => {
        const start = document.querySelector(${JSON.stringify(from)});
        const end = document.querySelector(${JSON.stringify(onto)});
        if (!start || !end) return null;
        start.scrollIntoView({ block: 'center', inline: 'nearest' });
        const a = start.getBoundingClientRect();
        const b = end.getBoundingClientRect();
        return { x: a.left + a.width / 2, y: a.top + a.height / 2, x2: b.left + b.width / 2, y2: b.top + b.height / 2 };
      })()`) as { x: number; y: number; x2: number; y2: number } | null;
      if (!points) throw new Error(`cannot drag ${from} onto ${onto}`);
      await at(points.x, points.y, 'mousePressed', 0, 1, 1);
      await at(points.x2, points.y2, 'mouseMoved', 0, 0, 1);
      await at(points.x2, points.y2, 'mouseReleased', 0, 1, 0);
    },
    async clickRatio(selector: string, xRatio: number, yRatio: number, opts: { scroll?: boolean } = {}) {
      const box = await boxOf(selector, opts.scroll !== false);
      await clickAt(box.left + box.width * xRatio, box.top + box.height * yRatio, 0, 1);
    },
    async hover(selector: string, opts: { scroll?: boolean; x?: number; y?: number } = {}) {
      const box = await boxOf(selector, opts.scroll !== false);
      await at(box.left + box.width * (opts.x ?? 0.5), box.top + box.height * (opts.y ?? 0.5), 'mouseMoved', 0, 0);
    },
    async swipe(selector: string, dy: number) {
      const box = await boxOf(selector, false);
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      const touch = (type: string, ty: number) => session('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: ty }] });
      await touch('touchStart', y);
      for (let i = 1; i <= 10; i++) await touch('touchMove', y + (dy * i) / 10);
      await touch('touchEnd', y + dy);
    },
    async wheel(selector: string, dy: number) {
      // Measured once, not settled: the wheel turns while the page may still be moving.
      const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`) as { x: number; y: number } | null;
      if (!point) throw new Error(`no element matches ${selector}`);
      await at(point.x, point.y, 'mouseMoved', 0, 0);
      // A wheel listener the page adds as the pointer arrives reaches the compositor with a frame.
      await evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
      await session('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: dy, pointerType: 'mouse' });
    },
    async type(text: string) {
      await session('Input.insertText', { text });
    },
    key(key: string, opts: { shift?: boolean; ctrl?: boolean } = {}) {
      return press(key, opts);
    },
    async setViewport(nextWidth: number, nextHeight: number) {
      await session('Emulation.setDeviceMetricsOverride', { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false });
    },
    async phone(nextWidth: number, nextHeight: number) {
      await session('Emulation.setDeviceMetricsOverride', { width: nextWidth, height: nextHeight, deviceScaleFactor: 2, mobile: true });
      await session('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    },
    async reducedMotion(on: boolean) {
      await session('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
    },
    async installClock() {
      await session('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
    },
    async advance(ms: number) {
      await evaluate(`window.__advance(${ms})`);
    },
    close,
  };
}

// A clock the page's own timers see. Date.now moves only when the test advances it, and the
// timers scheduled with setTimeout and setInterval fire then.
const CLOCK = `(() => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const timers = [];
  let next = 1;
  Date.now = () => realNow() + offset;
  const drop = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  window.setTimeout = (fn, ms, ...args) => { const id = next++; timers.push({ id, fn, args, at: Date.now() + (ms || 0), interval: false }); return id; };
  window.setInterval = (fn, ms, ...args) => { const id = next++; timers.push({ id, fn, args, at: Date.now() + (ms || 0), interval: true, every: ms || 0 }); return id; };
  window.clearTimeout = drop;
  window.clearInterval = drop;
  window.__advance = (ms) => {
    offset += ms;
    const due = timers.filter((t) => t.at <= Date.now()).sort((a, b) => a.at - b.at);
    for (const t of due) {
      if (t.interval) t.at = Date.now() + t.every;
      else drop(t.id);
      t.fn(...t.args);
    }
  };
})();`;

async function poll(evaluate: (expression: string) => Promise<unknown>, expression: string, ms: number): Promise<unknown> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch {
      // The page is between loads.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${expression}`);
}

function devtoolsUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url!);
    };
    const take = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (match) finish(null, match[1]);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => finish(new Error(`Chromium did not open a DevTools port\n${text}`)), 60_000);
    child.once('exit', (code) => finish(new Error(`Chromium exited ${code} before opening a DevTools port\n${text}`)));
  });
}

/** Serves a directory over http, for an exported page. Snap Chromium cannot open file://. */
export function staticServer(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(dir);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.resolve(root, name === '/' ? 'review.html' : `.${name}`);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
