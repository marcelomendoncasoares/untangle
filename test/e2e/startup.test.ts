import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { buildSteps } from '../../dist/build.js';
import { fonts, progressPage } from '../../dist/page.js';
import { browserSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { read } from './page.ts';

const skip = browserSkip();
const plan = ['branch', ...buildSteps('history'), 'history'];
const title = '#168 Offline sync: merge changes by their hybrid logical clocks';
const where = 'serverpod/serverpod_offline_sync · main 8f32150 → c754fb4';
const head = 'head ~/.cache/untangle/worktrees/github.com/serverpod/serverpod_offline_sync/c754fb4b15d1';
const base = 'base ~/.cache/untangle/worktrees/github.com/serverpod/serverpod_offline_sync/e0598c1577db';

interface Step { label: string; state: 'running' | 'done' | 'failed'; ms?: number; detail?: string; count?: [number, number]; notes: string[] }
interface Status { phase: 'building' | 'ready' | 'failed'; title: string; where: string; plan: string[]; steps: Step[]; notes: string[]; error?: string; moved?: string; rev: number }

const done = (label: string, ms: number, notes: string[] = []): Step => ({ label, state: 'done', ms, notes });
const before4 = [done('branch', 640), done('checkouts', 880, [head, base]), done('packages', 1790), done('diff', 380, ['87 files changed, 21 of them generated'])];
const reading = (n: number): Step => ({ label: 'Dart analyzer', state: 'running', ms: 4000, detail: `Dart files ${n} of 116: packages/serverpod_offline_sync/lib/src/sync/engine.dart`, count: [n, 116], notes: [] });

/**
 * Stands in for untangle while it builds: the startup page, a status the test moves on (answered
 * the way untangle answers, at the next change), and the review once the status says it's ready.
 */
async function building(first: Omit<Status, 'rev'>): Promise<{ url: string; set(next: Omit<Status, 'rev'>): void; close(): Promise<void> }> {
  let status: Status = { ...first, rev: 1 };
  let waiting: Array<() => void> = [];
  const page = progressPage();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(status)); };
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(status.phase === 'ready' ? '<!doctype html><title>review</title><div id="viewer">The review</div>' : page);
    } else if (url.pathname === '/assets/fonts.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end(fonts() ?? '');
    } else if (url.pathname === '/api/status') {
      const rev = url.searchParams.get('rev');
      if (rev === null || Number(rev) !== status.rev) json();
      else waiting.push(json);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    set(next) {
      status = { ...next, rev: status.rev + 1 };
      const answers = waiting;
      waiting = [];
      answers.forEach((answer) => answer());
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// Each row: its step, its state, and its time (a running step's clock is left out: it ticks).
const rows = `[...document.querySelectorAll('.st')].map((li) => {
  const state = ['pending', 'running', 'done', 'failed', 'skipped'].find((name) => li.classList.contains(name));
  const time = state === 'running' ? '' : li.querySelector('.tm').textContent;
  return [li.querySelector('.lb').firstChild.textContent, state, time].filter(Boolean).join(' | ');
}).join('\\n')`;
const row = (label: string) => `[...document.querySelectorAll('.st')].find((li) => li.querySelector('.lb').firstChild.textContent === ${JSON.stringify(label)})`;

describe('Given the startup page of a review being built, ', { skip, timeout: 120_000 }, () => {
  let page: Browser | undefined;
  let build: Awaited<ReturnType<typeof building>> | undefined;

  before(async () => {
    build = await building({ phase: 'building', title, where, plan, steps: [...before4, reading(40)], notes: [] });
    page = await launchBrowser(1400, 900);
    await page.reducedMotion(false);
    await page.goto(build.url);
    await page.until(`document.querySelectorAll('.st').length === ${plan.length}`);
  });

  after(async () => {
    await page?.close();
    await build?.close();
  });

  describe('when it opens, ', () => {
    let shown = '';

    before(async () => {
      shown = await read(page!, `[document.getElementById('title').textContent, document.getElementById('where').textContent, ${rows}, ${row('Dart analyzer')}.querySelector('.dt').textContent].join('\\n')`);
    });

    it('then it names the review, and lists every step with its state and time: what is done, the analyzer reading its files, and what comes after it.', () => {
      assert.equal(shown, [
        title,
        where,
        'branch | done | 640 ms',
        'checkouts | done | 880 ms',
        'packages | done | 1.8 s',
        'diff | done | 380 ms',
        'Dart analyzer | running',
        'commits | pending',
        'analysis | pending',
        'history | pending',
        'Dart files 40 of 116: packages/serverpod_offline_sync/lib/src/sync/engine.dart',
      ].join('\n'));
    });

    it('then each checkout\'s path takes one line.', async () => {
      const lines = await read(page!, `[...${row('checkouts')}.querySelectorAll('.nt')].map((note) => note.textContent.slice(0, 4) + ' ' + Math.round(note.getBoundingClientRect().height / parseFloat(getComputedStyle(note).lineHeight)) + ' line').join(', ')`);
      assert.equal(lines, 'head 1 line, base 1 line');
    });

    it('then the analyzer\'s mark turns, and the running step\'s ground is under it.', async () => {
      const turning = await read(page!, `(() => {
        const li = ${row('Dart analyzer')}, hl = document.getElementById('hl');
        const spin = li.querySelector('.arc').getAnimations().map((a) => a.animationName).join(',');
        return spin + ' | ' + (hl.style.transform === 'translateY(' + li.offsetTop + 'px)' && hl.style.opacity === '1' ? 'under it' : hl.style.transform);
      })()`);
      assert.equal(turning, 'turn | under it');
    });
  });

  describe('when the analyzer reads more files, a second later, ', () => {
    let moved = '';

    before(async () => {
      const bar = Number(await page!.eval(`parseFloat(document.getElementById('fill').style.width)`));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      build!.set({ phase: 'building', title, where, plan, steps: [...before4, reading(80)], notes: [] });
      await page!.until(`${row('Dart analyzer')}.querySelector('.dt').textContent.startsWith('Dart files 80 ')`);
      moved = await read(page!, `(() => {
        const li = ${row('Dart analyzer')};
        const now = parseFloat(document.getElementById('fill').style.width);
        return [now > ${bar} && now < 100 ? 'the bar moved on' : 'the bar at ' + now, li.querySelector('.cbar i').style.transform, li.querySelector('.eta').textContent].join(' | ');
      })()`);
    });

    it('then the bar moves on, the analyzer\'s own bar fills to its count, and it says about how long is left.', () => {
      assert.equal(moved, 'the bar moved on | scaleX(0.6897) | a few seconds left');
    });
  });

  describe('when the analyzer finishes and the commits are replayed, ', () => {
    let seen = '';
    let after = '';

    before(async () => {
      await page!.eval(`(() => {
        const li = ${row('Dart analyzer')};
        new MutationObserver(() => {
          if (!li.classList.contains('done') || window.seen) return;
          window.seen = [
            'check: ' + li.querySelector('.ck').getAnimations().map((a) => a.transitionProperty).join(','),
            'mark: ' + li.querySelector('.ic').getAnimations().length,
            'ground: ' + document.getElementById('hl').getAnimations().map((a) => a.transitionProperty).filter((p) => p === 'transform').join(','),
          ].join(' | ');
        }).observe(li, { attributes: true, attributeFilter: ['class'] });
      })()`);
      build!.set({ phase: 'building', title, where, plan, steps: [...before4, done('Dart analyzer', 9000), { label: 'commits', state: 'running', ms: 0, notes: [] }], notes: [] });
      seen = String(await page!.until('window.seen'));
      await page!.until(`${row('Dart analyzer')}.querySelector('.now').hidden`);
      after = await read(page!, rows);
    });

    it('then its mark draws a check as it settles, and the running step\'s ground glides to the commits.', () => {
      assert.equal(seen, 'check: stroke-dashoffset | mark: 1 | ground: transform');
    });

    it('then the analyzer keeps its time, and its files fold away.', () => {
      assert.equal(after, [
        'branch | done | 640 ms',
        'checkouts | done | 880 ms',
        'packages | done | 1.8 s',
        'diff | done | 380 ms',
        'Dart analyzer | done | 9.0 s',
        'commits | running',
        'analysis | pending',
        'history | pending',
      ].join('\n'));
    });
  });

  describe('when the review is ready, ', () => {
    let opened = '';

    before(async () => {
      await page!.eval(`new MutationObserver(() => sessionStorage.setItem('phase', document.getElementById('phase').textContent)).observe(document.getElementById('phase'), { childList: true })`);
      build!.set({ phase: 'ready', title, where, plan, steps: [...before4, done('Dart analyzer', 9000), done('commits', 470), done('analysis', 3200), done('history', 60)], notes: [] });
      await page!.until(`document.getElementById('viewer')`);
      opened = await read(page!, `sessionStorage.getItem('phase') + ' | ' + document.getElementById('viewer').textContent`);
    });

    it('then the page says it is opening the review, and the review replaces it.', () => {
      assert.equal(opened, 'Opening the review | The review');
    });
  });
});

describe('Given the startup page of a review whose analysis is cached, ', { skip, timeout: 120_000 }, () => {
  let page: Browser | undefined;
  let build: Awaited<ReturnType<typeof building>> | undefined;
  const cached = 'using the analysis cached in ~/.cache/untangle/reviews/github.com/serverpod/serverpod_offline_sync/e0598c1577db-c754fb4b15d1';

  before(async () => {
    build = await building({ phase: 'building', title, where, plan, steps: [done('branch', 840), { label: 'history', state: 'running', ms: 0, notes: [] }], notes: [cached] });
    page = await launchBrowser(1400, 900);
    await page.goto(build.url);
    await page.until(`document.querySelectorAll('.st').length === ${plan.length}`);
  });

  after(async () => {
    await page?.close();
    await build?.close();
  });

  describe('when it opens, ', () => {
    let shown = '';

    before(async () => {
      shown = await read(page!, `[${rows}, document.getElementById('notes').textContent, document.getElementById('hint').hidden ? 'no hint' : 'the hint'].join('\\n')`);
    });

    it('then the steps the cache spares say cached, under the note that says where it is, and the first time\'s hint is gone.', () => {
      assert.equal(shown, [
        'branch | done | 840 ms',
        'checkouts | skipped | cached',
        'packages | skipped | cached',
        'diff | skipped | cached',
        'Dart analyzer | skipped | cached',
        'commits | skipped | cached',
        'analysis | skipped | cached',
        'history | running',
        cached,
        'no hint',
      ].join('\n'));
    });
  });

  describe('when the last step finishes with reduced motion, ', () => {
    let seen = '';

    before(async () => {
      await page!.reducedMotion(true);
      await page!.eval(`(() => {
        const li = ${row('history')};
        new MutationObserver(() => {
          if (li.classList.contains('done')) window.seen = 'check: ' + li.querySelector('.ck').getAnimations().length + ' | mark: ' + li.querySelector('.ic').getAnimations().length;
        }).observe(li, { attributes: true, attributeFilter: ['class'] });
      })()`);
      build!.set({ phase: 'building', title, where, plan, steps: [done('branch', 840), done('history', 60)], notes: [cached] });
      seen = String(await page!.until('window.seen'));
    });

    it('then its check is there at once.', () => {
      assert.equal(seen, 'check: 0 | mark: 0');
    });
  });
});

describe('Given the startup page of a review that cannot be built, ', { skip, timeout: 120_000 }, () => {
  let page: Browser | undefined;
  let build: Awaited<ReturnType<typeof building>> | undefined;

  before(async () => {
    build = await building({ phase: 'failed', title, where, plan, steps: [...before4, { label: 'Dart analyzer', state: 'failed', ms: 1000, notes: [] }], notes: [], error: 'untangle needs the Dart SDK on PATH' });
    page = await launchBrowser(1400, 900);
    await page.goto(build.url);
    await page.until(`document.querySelectorAll('.st').length === ${plan.length}`);
  });

  after(async () => {
    await page?.close();
    await build?.close();
  });

  describe('when it opens, ', () => {
    let shown = '';

    before(async () => {
      shown = await read(page!, `[document.getElementById('phase').textContent, ${rows}, document.getElementById('err').textContent, document.getElementById('meter').classList.contains('bad') ? 'a red bar' : 'the bar', document.getElementById('hl').style.opacity === '0' ? 'no step running' : 'a step running'].join('\\n')`);
    });

    it('then it says so, with the step that failed, what is left undone, and why.', () => {
      assert.equal(shown, [
        'The review could not be built',
        'branch | done | 640 ms',
        'checkouts | done | 880 ms',
        'packages | done | 1.8 s',
        'diff | done | 380 ms',
        'Dart analyzer | failed | 1.0 s',
        'commits | pending',
        'analysis | pending',
        'history | pending',
        'untangle needs the Dart SDK on PATH',
        'a red bar',
        'no step running',
      ].join('\n'));
    });
  });
});

describe('Given the startup page of a review another untangle turns out to serve, ', { skip, timeout: 120_000 }, () => {
  let page: Browser | undefined;
  let build: Awaited<ReturnType<typeof building>> | undefined;
  let other: http.Server | undefined;
  let there = '';

  before(async () => {
    other = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>review</title><div id="viewer">The review, served by the other untangle</div>');
    });
    await new Promise<void>((resolve) => other!.listen(0, '127.0.0.1', resolve));
    there = `http://127.0.0.1:${(other.address() as AddressInfo).port}/?token=other`;
    build = await building({ phase: 'building', title, where, plan, steps: [done('branch', 640)], notes: [] });
    page = await launchBrowser(1400, 900);
    await page.goto(build.url);
    await page.until(`document.querySelectorAll('.st').length === ${plan.length}`);
  });

  after(async () => {
    await page?.close();
    await build?.close();
    other?.closeAllConnections();
    other?.close();
  });

  describe('when the untangle that builds it hears so, ', () => {
    let shown = '';

    before(async () => {
      build!.set({ phase: 'building', title, where, plan, steps: [done('branch', 640)], notes: [], moved: there });
      await page!.until(`document.getElementById('viewer')`);
      shown = await read(page!, `location.href + ' | ' + document.getElementById('viewer').textContent`);
    });

    it('then the page goes to that review’s page.', () => {
      assert.equal(shown, `${there} | The review, served by the other untangle`);
    });
  });
});
