// The manager's page: every review on this machine, live. It asks untangle for them every two
// seconds while it's shown, and for the last lines of the open row's chat. A row opens like a peek;
// from there you go to the review or to its chat.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Titles keep their code: `serverpod doctor`.
  const md = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
  const fmt = (n) => n.toLocaleString('en-US');
  const bytes = (n) => (!n ? '0 KB' : n < 1 << 20 ? Math.max(1, Math.round(n / 1024)) + ' KB' : n < 1000 * (1 << 20) ? Math.round(n / (1 << 20)) + ' MB' : (n / (1 << 30)).toFixed(1) + ' GB');
  // A while, as people say it: 4 min, 3 h 50 m, 2 d.
  const span = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return 'a moment';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 && h < 10 ? `${h} h ${m % 60} m` : `${h} h`;
    return `${Math.floor(h / 24)} d`;
  };
  const ago = (iso) => (iso ? `${span(Date.now() - Date.parse(iso))} ago` : '');
  const svg = (d) => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
  const LN = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  const ICON = {
    list: svg(`<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" ${LN}/>`),
    spark: svg('<path d="M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z" fill="currentColor"/>'),
    pause: svg('<path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
    repo: svg(`<path d="M3.5 13V3.5a1 1 0 0 1 1-1h8v9h-8a1 1 0 0 0-1 1.5M5.5 13.5h7" ${LN}/>`),
    term: svg(`<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" ${LN}/><path d="M4.5 6.2 6.6 8 4.5 9.8M8.4 10.2h3" ${LN}/>`),
    open: svg(`<path d="M6.5 3.5h6v6M12.5 3.5 4 12" ${LN}/>`),
    done: svg(`<path d="M3.5 8.5l3 3 6-7" ${LN}/>`),
    plus: svg('<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
    play: svg('<path d="M5 3.3v9.4L12.6 8z" fill="currentColor"/>'),
    back: svg(`<path d="M10 3.5 5.5 8l4.5 4.5" ${LN}/>`),
    chev: svg(`<path d="M6 3.5 10.5 8 6 12.5" ${LN}/>`),
    more: svg('<circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/>'),
    stop: svg(`<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" ${LN}/>`),
    free: svg(`<path d="M8 2.5v7M5 6.5l3 3 3-3M3 12.5h10" ${LN}/>`),
    trash: svg(`<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" ${LN}/>`),
    old: svg(`<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" ${LN}/>`),
    disk: svg(`<rect x="2" y="3" width="12" height="10" rx="2" ${LN}/><path d="M5 10h.01M8 10h3" ${LN}/>`),
  };
  // Each agent prints its chat its own way.
  const GLYPH = { claude: { tool: '●', out: '└', say: '●', you: '>' }, codex: { tool: '•', out: '└', say: '•', you: '›' } };

  // Closed reviews picked to free or forget, and whether Forget is asking first.
  const S = { data: null, tab: 'open', filter: 'all', sel: null, menu: null, tail: null, tailFor: null, toast: null, starting: new Set(), picked: new Set(), confirm: false };
  // The palette: New review. What you typed, the row lit, and GitHub's pull requests once they come;
  // then the review picked, and how its agent starts (the form), or the review an agent joins.
  const P = { open: false, q: '', hl: 0, pulls: null, loading: false, stage: 'pick', item: null, form: null, agents: null, addFor: null };
  const TEMPLATE = (pr) => `Do an initial review of this ${pr ? 'pull request' : 'branch'}. Read the whole change, then post your findings to untangle as notes on the lines they’re about, one note per point: bugs and edge cases first, then missing tests, then design and naming. Say what you’d change and why, and leave out style nits. Then tell me how many notes you posted, and keep watching the review for mine.`;
  const AGENT = { claude: 'Claude', codex: 'Codex' };
  // Quoted for a shell, as untangle types it into the terminal.
  const sh = (t) => (/^[\w./:@%+=,-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`);
  let toastTimer = 0, toastN = 0;

  // The page is drawn again every two seconds. What didn't change keeps its elements, so an open
  // row doesn't open again, a spinner doesn't start over, and the row under the pointer stays lit.
  // Elements with a data-id are matched by it (and their data-act), the rest by place and tag.
  const tpl = document.createElement('template');
  const keyOf = (n) => (n.nodeType === 1 && n.dataset.id != null ? `${n.dataset.act || ''}|${n.dataset.id}` : null);
  function patch(el, html) {
    tpl.innerHTML = html;
    children(el, tpl.content);
  }
  function morph(a, b) {
    if (a.nodeType !== 1) {
      if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
      return;
    }
    for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
    for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
    children(a, b);
  }
  function children(a, b) {
    let at = a.firstChild;
    for (let n = b.firstChild; n; ) {
      const next = n.nextSibling, key = keyOf(n);
      let m = null;
      if (key != null) {
        for (let x = at; x; x = x.nextSibling) if (keyOf(x) === key) { m = x; break; }
      } else if (at && keyOf(at) == null && at.nodeName === n.nodeName) m = at;
      if (!m) a.insertBefore(n, at);
      else {
        if (m === at) at = at.nextSibling;
        else a.insertBefore(m, at);
        morph(m, n);
      }
      n = next;
    }
    while (at) {
      const next = at.nextSibling;
      a.removeChild(at);
      at = next;
    }
  }

  function api(path, init) {
    return fetch('api/' + path, init).then((r) => r.json().catch(() => ({ error: r.statusText })).then((j) => {
      if (!r.ok) throw new Error(j.error || String(r.status));
      return j;
    }));
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const rows = () => (S.data ? S.data.reviews : []);
  const open = () => rows().filter((r) => r.status !== 'closed');
  const closedRows = () => rows().filter((r) => r.status === 'closed');
  const needs = (r) => r.status === 'running' && !!r.need;
  const working = (r) => r.agents.some((a) => a.state === 'working');
  const idleFor = (r) => (r.status === 'running' && r.active && !r.build ? Date.now() - r.active : 0);
  const memOf = (r) => (r.memory ? r.memory.untangle + (r.memory.lsp || 0) : 0);
  const shown = () => {
    if (S.tab === 'closed') return closedRows().filter((r) => S.filter === 'all' || (S.filter === 'freed' && r.freed) || (S.filter.startsWith('repo:') && r.repo === S.filter.slice(5)));
    return open().filter((r) => S.filter === 'all' || (S.filter === 'need' && needs(r)) || (S.filter === 'work' && working(r)) || (S.filter === 'paused' && r.status === 'paused') || (S.filter.startsWith('repo:') && r.repo === S.filter.slice(5)));
  };

  function toast(text, bad) {
    S.toast = { text, bad: !!bad, n: ++toastN };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = null; layer(); }, 3200);
    layer();
  }

  // ---- The top bar and the side

  function top() {
    const run = open().filter((r) => r.status === 'running');
    const paused = open().length - run.length;
    $('#counts').textContent = S.data ? `${run.length} running · ${paused} paused` : '';
    const total = run.reduce((a, r) => a + memOf(r), 0) + (S.data ? S.data.memory.manager : 0);
    const mem = $('#mem');
    mem.classList.toggle('none', !run.length);
    mem.setAttribute('aria-expanded', String(S.menu === 'mem'));
    $('#mem-total').textContent = S.data ? `${bytes(total)} · ${run.length} running` : '—';
    const waiting = run.filter(needs).length;
    document.title = `${waiting ? `(${waiting}) ` : ''}Reviews · untangle`;
  }

  function side() {
    const list = open();
    const left = list.reduce((a, r) => a + (r.progress.total - r.progress.done), 0);
    const total = list.reduce((a, r) => a + r.progress.total, 0), done = list.reduce((a, r) => a + r.progress.done, 0);
    const nr = (key, icon, name, n, hot) => `<button type="button" class="nr" data-act="filter" data-key="${esc(key)}" aria-current="${S.filter === key}"><span class="ic">${icon}</span><span class="nm${key.startsWith('repo:') ? ' mono' : ''}">${esc(name)}</span><span class="n${hot ? ' hot' : ''}">${n}</span></button>`;
    const repos = new Map();
    (S.tab === 'open' ? list : rows().filter((r) => r.status === 'closed')).forEach((r) => repos.set(r.repo, (repos.get(r.repo) || 0) + 1));
    let nav;
    if (S.tab === 'open') {
      const need = list.filter(needs).length;
      nav = nr('all', ICON.list, 'All open', list.length) + nr('need', '<i></i>', 'Need you', need, need > 0) + nr('work', ICON.spark, 'Agents at work', list.filter(working).length) + nr('paused', ICON.pause, 'Paused', list.filter((r) => r.status === 'paused').length);
    } else nav = nr('all', ICON.list, 'All closed', closedRows().length) + nr('freed', ICON.free, 'Space freed', closedRows().filter((r) => r.freed).length);
    const d = S.data ? S.data.disk : null;
    const sum = d ? d.open + d.closed + d.old + d.shared : 0;
    const seg = (v, c) => (v > 0 ? `<i style="flex:${v} 1 0;background:${c}"></i>` : '');
    patch($('#side'), `<div class="big"><b>${fmt(left)}</b><span>change${left === 1 ? '' : 's'} left to review</span><span class="bar"><i style="width:${total ? ((100 * done) / total).toFixed(1) : 0}%"></i></span><small>${fmt(done)} of ${fmt(total)} reviewed, in ${list.length} open review${list.length === 1 ? '' : 's'}</small></div>
      <div class="tabs" role="tablist"><button type="button" role="tab" data-act="tab" data-key="open" aria-selected="${S.tab === 'open'}">Open<i>${list.length}</i></button><button type="button" role="tab" data-act="tab" data-key="closed" aria-selected="${S.tab === 'closed'}">Closed<i>${rows().length - list.length}</i></button></div>
      <div class="nav">${nav}</div>
      ${repos.size ? `<div class="grp">Repositories</div><div class="nav">${[...repos].sort((a, b) => b[1] - a[1]).map(([name, n]) => nr('repo:' + name, ICON.repo, name, n)).join('')}</div>` : ''}
      <div class="disk"><div class="disk-h"><b>${d ? bytes(sum) : '—'}</b><span>in untangle’s cache${d && d.measuring ? ', measuring…' : ''}</span></div>
        <div class="disk-bar">${d ? seg(d.open, 'var(--d-open)') + seg(d.closed, 'var(--d-closed)') + seg(d.old, 'var(--d-old)') + seg(d.shared, 'var(--d-shared)') : ''}</div>
        <div class="legend"><span><i style="background:var(--d-open)"></i>Open reviews<b>${d ? bytes(d.open) : '—'}</b></span><span><i style="background:var(--d-closed)"></i>Closed, can be freed<b>${d ? bytes(d.closed) : '—'}</b></span><span><i style="background:var(--d-old)"></i>Old checkouts<b>${d ? bytes(d.old) : '—'}</b></span><span><i style="background:var(--d-shared)"></i>Clones and shared<b>${d ? bytes(d.shared) : '—'}</b></span></div>
        ${S.tab === 'open' && d && d.closed + d.old > 0 ? '<button type="button" class="link" data-act="tab" data-key="closed">Clean up</button>' : ''}
      </div>`);
  }

  // ---- The list

  const whyText = { paused: 'Paused', tab: 'Its tab closed', stop: 'Stopped', signal: 'Stopped', ended: 'Ended' };

  function events(r) {
    const ev = [];
    if (r.build && r.build.error) ev.push(`<span class="ev bad"><i></i>${esc(r.build.error)}</span>`);
    if (needs(r)) ev.push(`<span class="ev local"><i></i>${esc(r.need)}</span>`);
    const idle = idleFor(r);
    if (idle > 3600000) ev.push(`<span class="ev">Idle ${span(idle)}: no page in front</span>`);
    return ev.join('');
  }

  function agentCell(r) {
    if (r.older) return '<span class="agent"><span class="lab" data-st="none"><i></i><span>Agent not known</span></span><small>an older untangle doesn’t say</small></span>';
    const a = r.agents[0];
    const c = r.chat;
    const id = c ? `${c.kind === 'codex' ? 'Thread' : 'Session'} ${c.id.slice(0, 8)}` : '';
    if (r.status === 'running' && a && r.pausing) return `<span class="agent"><span class="lab" data-st="pausing"><i></i><span>Pausing after ${esc(a.name)}’s turn</span></span><small>${esc(id)}${c && c.orca ? ' · in Orca' : ''}</small></span>`;
    if (r.status === 'running' && a) return `<span class="agent"><span class="lab" data-st="${esc(a.state)}"><i></i><span>${esc(a.label)}</span></span><small>${esc(id)}${c && c.orca ? ' · in Orca' : ''}</small></span>`;
    if ((r.status !== 'running' || r.build) && c) return `<span class="agent"><span class="lab" data-st="kept"><i></i><span>${esc(c.agent)}’s chat, kept</span></span><small>${esc(id)}</small></span>`;
    return `<span class="agent"><span class="lab" data-st="none"><i></i><span>No agent</span></span><small>${r.status === 'running' ? 'a chat’s untangle watch holds it' : 'no chat held it'}</small></span>`;
  }

  // The build's share done, from the steps it expects and the one it's on.
  function built(b) {
    const plan = b.plan || [];
    const at = b.step ? plan.indexOf(b.step.label) : -1;
    if (at < 0 || !plan.length) return 0.05;
    const part = b.step.count && b.step.count[1] ? b.step.count[0] / b.step.count[1] : 0.5;
    return Math.min(0.98, (at + part) / plan.length);
  }

  function progCell(r) {
    if (r.older) return '<span class="prog"><span class="step">Progress not known</span></span>';
    if (r.build) {
      const pct = Math.round(built(r.build) * 100);
      return `<span class="prog"><span class="step"><b>${pct}%</b> ${esc(r.build.step ? r.build.step.label : 'starting')}</span><span class="track build"><i style="width:${pct}%"></i></span></span>`;
    }
    const p = r.progress;
    return `<span class="prog"><span><b>${fmt(p.done)}</b> <span class="of">of ${fmt(p.total)}</span></span><span class="track"><i style="width:${p.total ? ((100 * p.done) / p.total).toFixed(1) : 100}%"></i></span></span>`;
  }

  function memCell(r) {
    const up = Date.now() - Date.parse(r.opened);
    if (r.status === 'running') return `<span class="memc"><b>${r.memory ? bytes(memOf(r)) : '—'}</b><small>${up < 60000 ? 'just now' : span(up)}</small></span>`;
    const again = `<button type="button" class="btn sm" data-act="${r.status === 'closed' ? 'start' : 'resume'}" data-id="${esc(r.id)}">${ICON.play}${r.status === 'closed' ? 'Reopen' : 'Resume'}</button>`;
    return `<span class="memc">${S.starting.has(r.id) ? '<small>starting…</small>' : again}<small>${r.disk != null ? bytes(r.disk) + ' on disk' : ''}</small></span>`;
  }

  function row(r) {
    const sel = S.sel === r.id;
    const st = r.status !== 'running' ? r.status : r.build ? 'build' : needs(r) ? 'need' : '';
    const l2 = r.older ? `${esc(r.repo)} · started by an untangle from before this page`
      : r.status === 'running'
      ? `${esc(r.repo)}${r.author ? ' · ' + esc(r.author) : ''} · <span class="a">+${fmt(r.size.add)}</span> <span class="d">−${fmt(r.size.del)}</span> in ${fmt(r.size.files)} file${r.size.files === 1 ? '' : 's'}`
      : `${r.github ? (r.github.state === 'merged' ? 'Merged' : 'Closed on GitHub') : r.status === 'closed' ? 'Closed' : whyText[r.stopped ? r.stopped.why : 'stop']} ${ago(r.status === 'closed' ? r.closed : r.stopped && r.stopped.at)} · ${esc(r.repo)}${r.author ? ' · ' + esc(r.author) : ''}`;
    const ev = r.status === 'running' ? events(r) : '';
    return `<div class="rw${sel ? ' sel' : ''}" data-id="${esc(r.id)}">
      <div class="row ${r.status}" data-act="sel" data-id="${esc(r.id)}">
        <span class="st ${st}"></span>
        <span class="main">
          <span class="l1"><span class="num">${esc(r.name.replace(/^[^#]*#/, '#'))}</span>${r.kind ? `<span class="kind">${esc(r.kind)}</span>` : ''}<span class="ttl">${md(r.title)}</span></span>
          <span class="l2">${l2}</span>
          ${ev ? `<span class="l3">${ev}</span>` : ''}
        </span>
        ${agentCell(r)}${progCell(r)}${memCell(r)}
      </div>
      ${sel ? peek(r) : ''}
    </div>`;
  }

  function tail(r) {
    const c = r.chat;
    if (!c) return '';
    const lines = S.tailFor === r.id ? S.tail : null;
    if (!lines || !lines.length) return `<p class="pk-text">${lines ? 'Nothing in its chat yet.' : 'Its last lines show here once untangle finds the chat’s transcript.'}</p>`;
    const g = GLYPH[c.kind] || GLYPH.claude;
    return `<div class="tail">${lines.map((l) => `<div class="tl ${l.kind}"><i>${g[l.kind]}</i><span>${esc(l.text)}</span></div>`).join('')}</div>`;
  }

  function peek(r) {
    const c = r.chat, a = r.agents[0];
    const chat = r.older
      ? '<div class="pk-h"><b>An older untangle</b></div><p class="pk-text">This review runs an untangle from before this page, so it can’t say how far it is, which agent holds it, or what waits for you. Its own page works as always. Close it and start it again with New review, and it’s listed in full.</p>'
      : c
      ? `<div class="pk-h"><b>${esc(c.agent)}</b><span>${esc(a ? a.label : `${c.agent}’s chat, kept`)}</span><span class="sp"></span>${c.orca ? `<button type="button" class="btn sm" data-act="chat" data-id="${esc(r.id)}">${ICON.term}Chat<kbd>C</kbd></button>` : ''}</div>${tail(r)}`
      : `<div class="pk-h"><b>No agent</b></div><p class="pk-text">No chat holds this review. Add Claude or Codex, and its chat starts with the untangle skill${S.data && S.data.orca ? ', in Orca' : ''}.</p>${r.status === 'running' && !r.build ? `<div class="pk-act"><button type="button" class="btn sm" data-act="add-agent" data-id="${esc(r.id)}">${ICON.plus}Add an agent</button></div>` : ''}`;
    const w = r.waiting;
    const notes = r.older ? '<div class="pk-h"><b>Notes</b></div><p class="pk-text">On its page.</p>' : `<div class="pk-h"><b>${w.length ? 'Waiting for you' : 'Nothing waits for you'}</b></div>${w.map((x) => `<div class="wn"><span class="nb">N${x.n}</span><code>${esc(x.path.split('/').pop())}${x.line ? ':' + x.line : ''}</code><span>${esc(x.by)} ${x.wrote ? 'wrote' : 'answered'}</span></div>`).join('')}<div class="pk-more">${r.notes.open ? `${r.notes.open} open note${r.notes.open === 1 ? '' : 's'}` : 'No open notes'}</div>`;
    const running = r.status === 'running';
    const res = `<div class="pk-h"><b>This review</b><span class="sp"></span>${r.url ? `<a class="ib" href="${esc(r.url)}" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open on GitHub">${ICON.open}</a>` : ''}${r.status !== 'closed' ? `<button type="button" class="ib" data-act="more" data-id="${esc(r.id)}" aria-label="More" aria-expanded="${S.menu === 'more:' + r.id}">${ICON.more}</button>` : ''}</div>
      ${S.menu === 'more:' + r.id ? `<div class="pop" style="right:8px;top:40px;width:236px">${running && working(r) && !r.pausing ? `<button type="button" class="mi" data-act="pause-now" data-id="${esc(r.id)}">${ICON.pause}Pause now, mid-turn</button>` : ''}${r.status === 'paused' && r.chat ? `<button type="button" class="mi" data-act="resume-bare" data-id="${esc(r.id)}">${ICON.play}Resume without the agent</button>` : ''}<button type="button" class="mi" data-act="close" data-id="${esc(r.id)}">${ICON.stop}Close review</button></div>` : ''}
      ${running ? `<div class="kv"><span>untangle</span><b>${r.memory ? bytes(r.memory.untangle) : '—'}</b><span></span></div>
      <div class="kv"><span>Language server</span><b>${r.memory && r.memory.lsp ? bytes(r.memory.lsp) : 'not running'}</b>${r.memory && r.memory.lsp && !r.id.startsWith('run:') ? `<button type="button" class="btn" data-act="lsp" data-id="${esc(r.id)}" title="Start the language server over: it lets go of what it loaded">Free</button>` : '<span></span>'}</div>` : ''}
      <div class="kv"><span>On disk</span><b>${r.disk != null ? bytes(r.disk) : r.id.startsWith('run:') ? '—' : 'measuring…'}</b><span></span></div>
      <div class="kv"><span>Head</span><b>${esc(r.head.slice(0, 7))}</b><span></span></div>
      ${running ? `<div class="pk-act"><button type="button" class="btn sm primary" data-act="open" data-id="${esc(r.id)}">Open review<kbd>⏎</kbd></button>${r.build || r.older ? '' : `<button type="button" class="btn sm" data-act="pause" data-id="${esc(r.id)}"${r.pausing ? ' disabled' : ''}>${ICON.pause}${r.pausing ? 'Pausing' : 'Pause'}<kbd>P</kbd></button>`}</div>` : ''}
      ${r.status === 'paused' ? `<div class="pk-act"><button type="button" class="btn sm primary" data-act="resume" data-id="${esc(r.id)}">${ICON.play}Resume<kbd>R</kbd></button></div>` : ''}`;
    return `<div class="peek"><div class="pk">${chat}</div><div class="pk">${notes}</div><div class="pk res">${res}</div></div>`;
  }

  function pill() {
    if (S.tab !== 'open' || !S.data) return '';
    const need = open().filter(needs), run = open().filter((r) => r.status === 'running').length;
    if (!need.length) return run ? `<div class="pill quiet"><span>Nothing waits for you</span><span class="sep"></span><span><b>${run}</b> running</span></div>` : '';
    const r = need[0];
    return `<div class="pill"><span><b>${need.length}</b> ${need.length > 1 ? 'need' : 'needs'} you</span><span class="sep"></span><button type="button" class="act" data-act="next" data-id="${esc(r.id)}">Go to ${esc(r.name.replace(/^[^#]*#/, '#'))} · ${esc(r.need)}<kbd>Space</kbd></button></div>`;
  }

  function sheet() {
    if (S.tab === 'closed') return closedSheet(shown());
    const list = shown();
    const title = { all: 'Open reviews', need: 'Need you', work: 'Agents at work', paused: 'Paused' }[S.filter] || S.filter.slice(5);
    let body;
    if (!S.data) body = '<p class="empty">Loading your reviews…</p>';
    else if (!rows().length) body = '<p class="empty">No reviews yet. <code>untangle &lt;pr-url&gt;</code> starts one, or <code>untangle</code> in a branch, and asking an agent to review in untangle does too. They show here as they run, and stay once they stop.</p>';
    else if (!list.length) body = '<p class="empty">Nothing here now.</p>';
    else {
      const run = list.filter((r) => r.status === 'running'), paused = list.filter((r) => r.status === 'paused');
      body = (run.length ? `<div class="gh"><b>Running</b>${run.length}</div>${run.map(row).join('')}` : '') + (paused.length ? `<div class="gh"><b>Paused</b>${paused.length}</div>${paused.map(row).join('')}` : '');
    }
    const idle = S.tab === 'open' && S.filter === 'all' ? open().find((r) => idleFor(r) > 3600000 && !r.pausing && r.memory) : null;
    const hint = idle ? `<span class="hint">${esc(idle.name.replace(/^[^#]*#/, '#'))} sat idle ${span(idleFor(idle))} · pausing frees <b>${bytes(memOf(idle))}</b><button type="button" class="btn" data-act="pause" data-id="${esc(idle.id)}">Pause</button></span>` : '';
    patch($('#sheet'), `<div class="head"><h1>${esc(title)}</h1><span class="sub">${S.data ? `${list.length} · newest first` : ''}</span><span class="sp"></span>${hint}</div><div class="list">${body}</div>${pill()}`);
  }

  // ---- Closed reviews: what each holds on disk, and freeing it

  const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const num = (r) => r.name.replace(/^[^#]*#/, '#');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // The ones the head's button frees: those merged or closed on GitHub, or else every closed one.
  const merged = () => { const left = closedRows().filter((r) => !r.freed); const m = left.filter((r) => r.github); return m.length ? m : left; };
  // What freeing these gives back: what only they hold, and what they share once all its holders go.
  function freeable(ids) {
    const own = closedRows().filter((r) => ids.has(r.id) && !r.freed).reduce((a, r) => a + (r.disk || 0), 0);
    return own + (S.data.disk ? S.data.disk.shares.filter((x) => x.by.every((id) => ids.has(id))).reduce((a, x) => a + (x.bytes || 0), 0) : 0);
  }

  function crow(r) {
    const on = S.picked.has(r.id), p = r.parts;
    // What its size counts: what only it holds. What it shares is listed under Shared.
    const parts = r.freed ? 'notes and marks' : p && p.checkouts + p.analyses ? [p.checkouts ? plural(p.checkouts, 'checkout', 'checkouts') : '', p.analyses ? plural(p.analyses, 'analysis', 'analyses') : ''].filter(Boolean).join(' · ') : p && p.shared ? 'all of it shared' : 'nothing on disk';
    const when = r.github ? `${r.github.state === 'merged' ? 'merged' : 'closed on GitHub'} ${day(r.github.at)}` : `closed ${day(r.closed)}`;
    return `<div class="crow${on ? ' picked' : ''}${r.freed ? ' freed' : ''}" data-act="pick" data-id="${esc(r.id)}">
      <button type="button" class="cb${on ? ' on' : ''}" data-act="pick" data-id="${esc(r.id)}" aria-pressed="${on}" aria-label="Pick ${esc(r.name)}"></button>
      <span class="main"><span class="l1"><span class="num">${esc(num(r))}</span>${r.kind ? `<span class="kind">${esc(r.kind)}</span>` : ''}<span class="ttl">${md(r.title)}</span></span><span class="l2">${esc(r.repo)}${r.author ? ' · ' + esc(r.author) : ''} · ${when}${r.freed ? ` · space freed ${day(r.freed)}` : ''}</span></span>
      ${progCell(r)}
      <span class="cnotes">${r.notes.open ? `<b>${r.notes.open}</b> open note${r.notes.open === 1 ? '' : 's'}` : 'no open notes'}</span>
      <span class="sz"><b>${r.disk != null ? bytes(r.disk) : '…'}</b><small>${parts}</small></span>
      <span class="cact">${S.starting.has(r.id) ? '<small>starting…</small>' : `<button type="button" class="btn sm" data-act="start" data-id="${esc(r.id)}">Reopen</button>`}</span>
    </div>`;
  }

  // What no one review holds: clones, checkouts closed reviews share, and the old checkouts.
  function sharedRows() {
    const d = S.data.disk;
    if (!d) return '';
    const fixed = (icon, title, l2, b, small, act) => `<div class="crow fixed"><span class="ic">${icon}</span><span class="main"><span class="l1"><span class="ttl">${title}</span></span><span class="l2">${l2}</span></span><span></span><span></span><span class="sz"><b>${b != null ? bytes(b) : '…'}</b><small>${small}</small></span><span class="cact">${act || ''}</span></div>`;
    const out = [];
    if (d.clones.length) out.push(fixed(ICON.repo, `${d.clones.length === 1 ? 'Clone' : 'Clones'} of ${esc(and(d.clones.map((c) => c.repo)))}`, 'A clone goes once no review of its repository is left.', d.clones.some((c) => c.bytes == null) ? null : d.clones.reduce((a, c) => a + c.bytes, 0), d.clones.length > 1 ? and(d.clones.map((c) => (c.bytes != null ? bytes(c.bytes) : '…'))) : ''));
    for (const x of d.shares) out.push(fixed(ICON.disk, `${{ base: 'Base checkout', analysis: 'Analysis', checkout: 'Checkout' }[x.what]} of ${esc(and(x.names.map((n) => n.replace(/^[^#]*#/, '#'))))}`, `It goes with the ${x.by.length === 2 ? 'second' : 'last'} of them to be freed.`, x.bytes, `used by ${x.by.length} reviews`));
    const o = d.oldCheckouts;
    const past = `${plural(o.moved, 'head', 'heads')} that ${esc(and(o.past.map((n) => n.replace(/^[^#]*#/, '#'))))} moved past`, none = (n) => `${plural(n, 'checkout', 'checkouts')} no review names`;
    if (o.count) out.push(fixed(ICON.old, 'Old checkouts', `${o.moved === o.count ? past : !o.moved ? none(o.count) : `${past}, and ${none(o.count - o.moved)}`}. No review shows them.`, o.bytes, plural(o.count, 'checkout', 'checkouts'), '<button type="button" class="btn sm" data-act="free-old">Remove</button>'));
    return out.length ? `<div class="gh"><b>Shared</b>no one review holds these</div>${out.join('')}` : '';
  }

  function closedSheet(list) {
    const picked = closedRows().filter((r) => S.picked.has(r.id));
    const total = closedRows().reduce((a, r) => a + (r.disk || 0), 0);
    let act;
    if (picked.length) {
      const b = freeable(new Set(picked.map((r) => r.id)));
      act = `<button type="button" class="btn sm" data-act="free-picked"${picked.every((r) => r.freed) ? ' disabled' : ''}>${ICON.free}Free the space of ${picked.length} · ${bytes(b)}</button><button type="button" class="btn sm ghost" data-act="forget-ask">${ICON.trash}Forget ${picked.length}…</button>`;
    } else {
      const m = merged();
      act = m.length ? `<button type="button" class="btn sm primary" data-act="free-merged">${ICON.free}Free the space of ${m.every((r) => r.github && r.github.state === 'merged') ? 'merged reviews' : plural(m.length, 'closed review', 'closed reviews')} · ${bytes(freeable(new Set(m.map((r) => r.id))))}</button>` : closedRows().length ? '<span class="sub">Only notes and marks are left</span>' : '';
    }
    const confirm = S.confirm && picked.length ? `<div class="confirm"><span>Forget ${plural(picked.length, 'review', 'reviews')}? Their notes, marks and records go too, and that can’t be undone.</span><span class="sp"></span><button type="button" class="btn sm" data-act="forget-cancel">Cancel</button><button type="button" class="btn sm warn" data-act="forget">Forget ${picked.length}</button></div>` : '';
    const body = !S.data ? '<p class="empty">Loading your reviews…</p>'
      : !closedRows().length ? '<p class="empty">No closed reviews. A review you close, or whose pull request merges while it’s paused, is listed here with what it holds on disk.</p>'
      : `${confirm}<div class="cols"><span></span><span>Review</span><span>Reviewed</span><span>Notes</span><span>Space</span><span></span></div>${list.map(crow).join('') || '<p class="empty">Nothing here now.</p>'}${S.filter === 'all' ? sharedRows() : ''}`;
    patch($('#sheet'), `<div class="head"><h1>${S.filter === 'freed' ? 'Space freed' : S.filter.startsWith('repo:') ? esc(S.filter.slice(5)) : 'Closed reviews'}</h1><span class="sub">${S.data ? `${closedRows().length} · ${bytes(total)}` : ''}</span><span class="sp"></span>${act}</div><div class="list closed">${body}</div>`);
  }

  // ---- Over the page: the memory menu, and toasts

  function layer() {
    let h = '';
    if (S.menu === 'mem' && S.data) {
      const run = open().filter((r) => r.status === 'running');
      const total = run.reduce((a, r) => a + memOf(r), 0) + S.data.memory.manager;
      const m = $('#mem').getBoundingClientRect();
      h += `<div class="pop" style="right:${Math.round(innerWidth - m.right)}px;top:${Math.round(m.bottom + 6)}px;width:400px" role="dialog" aria-label="Memory">
        <div class="pop-h">Memory<span>${bytes(total)}</span></div>
        ${run.map((r) => `<div class="pop-r"><small><span class="who">${esc(r.name)}</span>untangle ${r.memory ? bytes(r.memory.untangle) : '—'} · language server ${r.memory && r.memory.lsp ? bytes(r.memory.lsp) : 'off'}</small><b>${r.memory ? bytes(memOf(r)) : '—'}</b></div>`).join('')}
        ${run.filter((r) => idleFor(r) > 3600000 && !r.pausing).map((r) => `<div class="pop-r"><button type="button" class="btn sm" data-act="pause" data-id="${esc(r.id)}">${ICON.pause}Pause ${esc(r.name)}, idle ${span(idleFor(r))} · frees ${bytes(memOf(r))}</button><span></span></div>`).join('')}
        <div class="pop-r"><small>This page’s own process</small><b>${bytes(S.data.memory.manager)}</b></div>
      </div>`;
    }
    if (S.toast) h += `<div class="toast${S.toast.bad ? ' bad' : ''}" role="status" data-id="toast:${S.toast.n}">${esc(S.toast.text)}</div>`;
    patch($('#layer'), h);
  }

  // ---- The palette: New review

  const PR_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)(?:[/?#].*)?$/;
  // A review of this pull request, open or paused: the palette resumes or brings it, rather than starting it again.
  const reviewOf = (url) => rows().find((r) => r.url && r.url === url && r.status !== 'closed');

  // What the palette offers, in its groups: a link you pasted, what's asked of you, what you paused, your own.
  function choices() {
    const q = P.q.trim().toLowerCase();
    const hit = (...texts) => !q || texts.some((t) => String(t).toLowerCase().includes(q));
    const out = [];
    const link = PR_URL.exec(P.q.trim());
    if (link) out.push({ group: 'Link', num: '#' + link[3], title: `Start the review of ${link[1]}/${link[2]}#${link[3]}`, hint: '', target: `https://github.com/${link[1]}/${link[2]}/pull/${link[3]}` });
    const pull = (group) => (p) => {
      const open = reviewOf(p.url);
      return { group, num: '#' + p.number, title: p.title, hint: open ? (open.status === 'paused' ? 'paused · Resume' : 'running · Open') : `${p.author} · ${p.repo.split('/').pop()}${p.draft ? ' · draft' : ''}`, target: open ? null : p.url, id: open ? open.id : null, again: open && open.status === 'paused' };
    };
    if (P.pulls) out.push(...P.pulls.asked.filter((p) => hit(p.number, p.title, p.repo, p.author)).map(pull('Asked to review you')));
    out.push(...open().filter((r) => r.status === 'paused' && hit(r.name, r.title, r.repo)).map((r) => ({ group: 'Paused', num: r.name.replace(/^[^#]*#/, '#'), title: r.title, hint: r.chat ? `Resume · ${r.chat.agent}’s chat kept` : 'Resume', id: r.id, again: true })));
    if (P.pulls) out.push(...P.pulls.yours.filter((p) => hit(p.number, p.title, p.repo)).map(pull('Yours')));
    return out;
  }

  // The command that starts the chat, as untangle will type it.
  function command() {
    const f = P.form, it = P.item;
    const msg = f.msg.trim();
    const first = `${f.agent === 'claude' ? '/untangle' : '$untangle'} ${it.target}${msg ? ' ' + msg : ''}`;
    const flags = (f.flags[f.agent] || '').trim();
    const resume = f.chat === 'resume' && f.resume;
    const how = f.agent === 'claude' ? (resume ? `--resume ${sh(f.resume)}` : `--session-id ${f.session} -n ${sh('Review ' + it.name)}`) : resume ? `resume ${sh(f.resume)}` : '--no-daemon';
    return [f.agent, how, flags, sh(first)].filter(Boolean).join(' ');
  }

  function formHtml() {
    const f = P.form, it = P.item, ag = P.agents;
    const kind = f.agent;
    const seg = ['claude', 'codex', 'none'].map((k) => `<button type="button" data-act="f-agent" data-key="${k}" aria-pressed="${kind === k}"${k !== 'none' && ag && !ag[k].installed ? ' disabled title="Not installed here"' : ''}>${k === 'none' ? 'No agent' : AGENT[k]}</button>`).join('');
    const chats = ag ? ag.chats.filter((c) => c.kind === kind) : [];
    const opt = (key, label, small, off) => `<button type="button" class="opt" data-act="f-chat" data-key="${key}" aria-pressed="${f.chat === key}"${off ? ' disabled' : ''}><i class="radio"></i>${label}<small>${small}</small></button>`;
    const agentRows = kind === 'none' ? '<div class="field"><span>Chat</span><span class="where">None. Add an agent from its row, any time.</span></div>' : `
      <div class="field"><span>Chat</span><span class="opts">${opt('new', 'New chat', `named Review ${esc(it.name)}`)}${opt('resume', 'Resume a chat', chats.length ? 'one that held a review before' : 'none held a review before', !chats.length)}</span></div>
      ${f.chat === 'resume' && chats.length ? `<div class="field"><span></span><span class="chats">${chats.map((c) => `<button type="button" class="copt" data-act="f-resume" data-key="${esc(c.id)}" aria-pressed="${f.resume === c.id}"><i class="radio"></i><span>${esc(c.agent)} · Review ${esc(c.from)}</span><small>closed ${esc(ago(c.when))}</small></button>`).join('')}</span></div>` : ''}
      <div class="field"><span></span><button type="button" class="chk" data-act="f-own" aria-pressed="${f.own}"><i></i>Request an initial review from ${AGENT[kind]}</button></div>
      <div class="field"><label for="f-msg">First message<small>optional</small></label><span class="msg"><textarea id="f-msg" rows="5" placeholder="Anything for ${AGENT[kind]} to start with. It reads it after ${kind === 'claude' ? '/untangle' : '$untangle'} and the link.">${esc(f.msg)}</textarea><small id="f-msg-note">${f.own ? 'The review template: change it as you like.' : 'Request an initial review fills it with a template.'}</small></span></div>`;
    const where = ag && ag.orca ? '<b>Reviews</b> workspace: a tab for the page' + (kind === 'none' ? '' : ', a terminal for the chat') : 'Orca isn’t here: ' + (kind === 'none' ? 'the page opens in your browser' : 'the chat’s command is copied, to paste in a terminal');
    const adv = kind === 'none' ? '' : `<div class="field"><span></span><button type="button" class="adv" data-act="f-adv" aria-expanded="${f.adv}">${ICON.chev}Advanced<span>how ${AGENT[kind]} starts, and its command</span></button></div>
      ${f.adv ? `<div class="field"><label for="f-flags">Starts with</label><span class="flags"><input id="f-flags" type="text" spellcheck="false" autocomplete="off" value="${esc(f.flags[kind] || '')}" placeholder="${kind === 'claude' ? '--model opus --permission-mode auto' : '-m gpt-6.1-sol'}"></span></div><pre class="cmd" id="f-cmd">${esc(command())}</pre>` : ''}`;
    return `<div class="sh">${P.addFor ? '<span></span>' : `<button type="button" class="ib" data-act="pal-back" aria-label="Back">${ICON.back}</button>`}<span class="main"><span class="l1"><span class="num">${esc(it.num)}</span>${it.kind ? `<span class="kind">${esc(it.kind)}</span>` : ''}<span class="ttl">${md(it.title)}</span></span><span class="l2">${esc(it.sub)}</span></span></div>
      <div class="pal-body">
        ${P.addFor ? '' : `<div class="field"><span>Agent</span><span class="seg">${seg}</span></div>`}
        ${agentRows}
        <div class="field"><span>In Orca</span><span class="where">${where}</span></div>
        ${adv}
      </div>
      <div class="pal-foot"><span class="note">${P.addFor ? `${AGENT[kind]} starts with the skill, and holds the review.` : kind === 'none' ? 'The review starts, and its page opens.' : `The review starts first, then ${AGENT[kind]} holds it with the skill.`}</span><span class="sp"></span><button type="button" class="btn sm" data-act="close-pal">Cancel<kbd>Esc</kbd></button><button type="button" class="btn sm primary" data-act="f-start">${P.addFor ? `Start ${AGENT[kind]}` : 'Start review'}<kbd>⏎</kbd></button></div>`;
  }

  function palette() {
    const box = $('#palette');
    if (!P.open) { if (box) box.remove(); return; }
    if (P.stage === 'start') {
      const html = `<div class="scrim" data-act="close-pal"></div><div class="pal" role="dialog" aria-label="${P.addFor ? 'Add an agent' : 'Start a review'}">${formHtml()}</div>`;
      const div = box || document.createElement('div');
      div.id = 'palette';
      const was = document.activeElement && document.activeElement.id;
      const at = document.activeElement && document.activeElement.selectionStart;
      div.innerHTML = html;
      if (!box) document.body.appendChild(div);
      const again = was && document.getElementById(was);
      if (again) { again.focus(); if (at != null && again.setSelectionRange) again.setSelectionRange(at, at); }
      return;
    }
    const list = choices();
    P.hl = Math.max(0, Math.min(P.hl, list.length - 1));
    let h = '', group = '';
    list.forEach((c, i) => {
      if (c.group !== group) {
        group = c.group;
        h += `<div class="pal-g">${esc(group)}${group === 'Asked to review you' && P.pulls ? `<span>${P.pulls.asked.length}</span>` : ''}</div>`;
      }
      h += `<button type="button" class="pal-r${i === P.hl ? ' on' : ''}" data-act="choose" data-i="${i}"><span class="num">${esc(c.num)}</span><span class="t">${md(c.title)}</span><span class="h${c.again ? ' res' : ''}">${esc(c.hint)}</span></button>`;
    });
    const note = P.loading ? 'Asking GitHub for the pull requests that wait for you…' : P.pulls && P.pulls.error ? P.pulls.error : !list.length ? (P.q ? 'Nothing matches. Paste a pull request’s link to start its review.' : 'Nothing waits for you on GitHub.') : '';
    const body = `<div class="scrim" data-act="close-pal"></div><div class="pal" role="dialog" aria-label="Start a review">
      <div class="pal-in">${ICON.plus}<input id="pal-in" type="text" autocomplete="off" spellcheck="false" placeholder="Paste a pull request’s link, or search" value="${esc(P.q)}"><kbd>Esc</kbd></div>
      <div class="pal-list">${h}${note ? `<p class="pal-note">${esc(note)}</p>` : ''}</div>
      <div class="pal-f"><span><kbd>↑</kbd><kbd>↓</kbd>move</span><span><kbd>⏎</kbd>choose</span><span>A link to any pull request works too</span></div>
    </div>`;
    if (box) {
      // Typing stays where it is: only the list is drawn again.
      box.querySelector('.pal-list').innerHTML = `${h}${note ? `<p class="pal-note">${esc(note)}</p>` : ''}`;
      return;
    }
    const div = document.createElement('div');
    div.id = 'palette';
    div.innerHTML = body;
    document.body.appendChild(div);
    $('#pal-in').focus();
  }

  function openPalette(addFor) {
    P.open = true;
    P.q = '';
    P.hl = 0;
    P.stage = 'pick';
    P.addFor = null;
    S.menu = null;
    if (!P.agents) api('agents').then((d) => { P.agents = d; if (P.stage === 'start') palette(); }, () => {});
    if (addFor) {
      const r = byId(addFor);
      if (r) return startForm({ target: r.target, num: r.name.replace(/^[^#]*#/, '#'), name: r.name, title: r.title, kind: r.kind, sub: `${r.repo}${r.author ? ' · ' + r.author : ''} · running` }, addFor);
    }
    palette();
    if (!P.pulls && !P.loading) {
      P.loading = true;
      api('pulls').then((d) => { P.pulls = d; }, (e) => { P.pulls = { asked: [], yours: [], error: e.message }; }).finally(() => { P.loading = false; palette(); });
    }
  }

  function closePalette() {
    P.open = false;
    P.stage = 'pick';
    P.addFor = null;
    palette();
  }

  // The form, for a review picked or a running one an agent joins: the agent you last started.
  function startForm(item, addFor) {
    const agents = P.agents || { claude: { installed: true, flags: '' }, codex: { installed: true, flags: '' }, chats: [] };
    const first = agents.claude.installed ? 'claude' : agents.codex.installed ? 'codex' : 'none';
    P.stage = 'start';
    P.item = item;
    P.addFor = addFor || null;
    P.form = { agent: addFor && first === 'none' ? 'claude' : first, chat: 'new', resume: null, own: false, msg: '', adv: false, session: crypto.randomUUID(), flags: { claude: agents.claude.flags, codex: agents.codex.flags } };
    palette();
  }

  function sendForm() {
    const f = P.form, it = P.item;
    const agent = f.agent === 'none' ? null : { kind: f.agent, resume: f.chat === 'resume' ? f.resume : null, session: f.session, flags: f.flags[f.agent] || '', message: f.msg };
    const addFor = P.addFor;
    closePalette();
    const said = (d) => {
      if (d.command) {
        // No Orca to start it in: its command, for a terminal.
        const copy = navigator.clipboard ? navigator.clipboard.writeText(d.command) : Promise.reject(new Error('no clipboard'));
        copy.then(() => toast(`Copied ${AGENT[agent.kind]}’s command: paste it in a terminal to start the chat`), () => toast(`Run this in a terminal: ${d.command}`));
      } else if (agent) toast(addFor ? `${AGENT[agent.kind]} is starting, in Orca` : `The review of ${it.num} is starting, and ${AGENT[agent.kind]} with it, in Orca`);
      else toast(d.already ? `${it.num} is running already` : `The review of ${it.num} is starting`);
      poll();
    };
    if (addFor) return post('agent', { id: addFor, agent }).then(said, (e) => toast(e.message, true));
    S.starting.add(it.target);
    post('start', { target: it.target, agent }).then(said, (e) => toast(e.message, true)).finally(() => { S.starting.delete(it.target); render(); });
    render();
  }

  function choose(c) {
    if (!c) return;
    if (c.target && !c.id) {
      const m = PR_URL.exec(c.target);
      const pull = P.pulls ? [...P.pulls.asked, ...P.pulls.yours].find((p) => p.url === c.target) : null;
      const kt = /^([a-z]+)(?:\([^)]*\))?!?: (.+)$/.exec(pull ? pull.title : '');
      return startForm({ target: c.target, num: c.num, name: m ? `${m[2]}#${m[3]}` : c.num, title: pull ? (kt ? kt[2] : pull.title) : `${m[1]}/${m[2]}#${m[3]}`, kind: kt ? kt[1] : null, sub: pull ? `${pull.repo} · ${pull.author}${pull.draft ? ' · draft' : ''} · updated ${ago(pull.updated)}` : 'a link you pasted' });
    }
    closePalette();
    if (c.id && !c.again) return act('open', c.id);
    if (c.id) return act('resume', c.id);
    const body = { target: c.target };
    const key = c.id || c.target;
    S.starting.add(key);
    toast(c.again ? `Resuming ${c.num}…` : `Starting the review of ${c.num}…`);
    post('start', body).then((d) => { toast(d.already ? `${c.num} is running already` : c.again ? `${c.num} is starting again` : `The review of ${c.num} is starting`); poll(); }, (e) => toast(e.message, true)).finally(() => { S.starting.delete(key); render(); });
    render();
  }

  function render() {
    top();
    side();
    sheet();
    layer();
  }

  // ---- Talking to untangle

  let timer = 0;
  function poll() {
    clearTimeout(timer);
    if (document.visibilityState === 'hidden') return;
    api('reviews').then((d) => {
      S.data = d;
      if (S.sel && !rows().some((r) => r.id === S.sel)) S.sel = null;
      render();
    }, () => {}).finally(() => { timer = setTimeout(poll, 2000); });
    loadTail();
  }

  function loadTail() {
    const id = S.sel;
    if (!id) return;
    api('tail?id=' + encodeURIComponent(id)).then((d) => {
      if (S.sel !== id) return;
      S.tail = d.lines;
      S.tailFor = id;
      const box = document.querySelector(`.rw[data-id="${CSS.escape(id)}"] .peek`);
      if (box) sheet();
    }, () => {});
  }

  const byId = (id) => rows().find((r) => r.id === id);
  const short = (r) => r.name;

  function act(name, id) {
    const r = byId(id);
    if (!r) return;
    if (name === 'open') post('open', { id }).then((d) => toast(d.where === 'orca' ? `${short(r)} is in front, in Orca` : `Opened ${short(r)} in the browser`), (e) => toast(e.message, true));
    if (name === 'chat') post('chat', { id }).then(() => toast(`${r.chat.agent}’s chat is in front, in Orca`), (e) => toast(e.message, true));
    if (name === 'lsp') post('lsp', { id }).then(() => { toast(`${short(r)}’s language server starts over`); poll(); }, (e) => toast(e.message, true));
    if (name === 'close') {
      S.menu = null;
      post('close', { id }).then(() => { toast(r.older ? `Closed ${short(r)}` : id.startsWith('run:') ? `Stopped ${short(r)} before it was built` : `Closed ${short(r)}: it’s under Closed now`); if (S.sel === id) S.sel = null; poll(); }, (e) => toast(e.message, true));
    }
    if (name === 'pause' || name === 'pause-now') {
      S.menu = null;
      post('pause', { id, now: name === 'pause-now' }).then((d) => {
        const a = r.agents[0];
        toast(d.waiting ? `${short(r)} pauses when ${a ? a.name : 'its agent'}’s turn ends` : `Paused ${short(r)}: ${r.memory ? bytes(memOf(r)) + ' back' : 'its memory is back'}${r.chat ? `. ${r.chat.agent}’s chat is kept` : ''}`);
        poll();
      }, (e) => toast(e.message, true));
    }
    if (name === 'resume' || name === 'resume-bare') {
      S.menu = null;
      S.starting.add(id);
      render();
      post('resume', { id, agent: name === 'resume' }).then((d) => {
        if (d.command && navigator.clipboard) navigator.clipboard.writeText(d.command).then(() => toast(`${short(r)} is starting again. Copied ${r.chat.agent}’s command: paste it in a terminal`), () => toast(`Run this in a terminal: ${d.command}`));
        else toast(`${short(r)} is starting again${name === 'resume' && r.chat ? `, with ${r.chat.agent}’s chat` : ''}`);
        poll();
      }, (e) => toast(e.message, true)).finally(() => { S.starting.delete(id); render(); });
    }
    if (name === 'start') {
      S.starting.add(id);
      render();
      post('start', { id }).then(() => { toast(`${short(r)} is starting again`); poll(); }, (e) => toast(e.message, true)).finally(() => { S.starting.delete(id); render(); });
    }
  }

  // ---- Clicks and keys

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    const was = S.menu;
    if (S.menu && !(b && (b.dataset.act === 'mem' || b.dataset.act === 'more')) && !e.target.closest('.pop')) S.menu = null;
    if (!b) {
      if (was) { top(); layer(); }
      return;
    }
    const key = b.dataset.key, id = b.dataset.id;
    switch (b.dataset.act) {
      case 'sel':
        S.sel = S.sel === id ? null : id;
        S.tail = null;
        S.tailFor = null;
        render();
        loadTail();
        break;
      case 'tab':
        S.tab = key;
        S.filter = 'all';
        S.sel = null;
        S.picked.clear();
        S.confirm = false;
        render();
        $('#sheet .list').scrollTop = 0;
        break;
      case 'pick':
        if (S.picked.has(id)) S.picked.delete(id);
        else S.picked.add(id);
        S.confirm = false;
        sheet();
        break;
      case 'free-picked':
      case 'free-merged': {
        const ids = b.dataset.act === 'free-picked' ? [...S.picked] : merged().map((r) => r.id);
        const back = freeable(new Set(ids));
        post('free', { ids }).then((d) => { toast(`Freed the space of ${plural(d.freed, 'review', 'reviews')}: ${bytes(back)} back. Their notes and marks stay`); S.picked.clear(); poll(); }, (e) => toast(e.message, true));
        break;
      }
      case 'forget-ask':
        S.confirm = true;
        sheet();
        break;
      case 'forget-cancel':
        S.confirm = false;
        sheet();
        break;
      case 'forget':
        post('forget', { ids: [...S.picked] }).then((d) => { toast(`Forgot ${plural(d.forgot, 'review', 'reviews')}`); S.picked.clear(); S.confirm = false; poll(); }, (e) => toast(e.message, true));
        break;
      case 'free-old': {
        const back = S.data.disk ? S.data.disk.oldCheckouts.bytes : null;
        post('free-old', {}).then((d) => { toast(`Removed ${plural(d.removed, 'old checkout', 'old checkouts')}${back ? `: ${bytes(back)} back` : ''}`); poll(); }, (e) => toast(e.message, true));
        break;
      }
      case 'filter':
        S.filter = key;
        render();
        $('#sheet .list').scrollTop = 0;
        break;
      case 'mem':
        S.menu = S.menu === 'mem' ? null : 'mem';
        top();
        layer();
        break;
      case 'next':
      case 'open':
      case 'chat':
      case 'lsp':
      case 'close':
      case 'start':
      case 'pause':
      case 'pause-now':
      case 'resume':
      case 'resume-bare':
        act(b.dataset.act === 'next' ? 'open' : b.dataset.act, id);
        break;
      case 'more':
        S.menu = S.menu === 'more:' + id ? null : 'more:' + id;
        sheet();
        break;
      case 'new':
        openPalette();
        break;
      case 'close-pal':
        closePalette();
        break;
      case 'choose':
        choose(choices()[Number(b.dataset.i)]);
        break;
      case 'pal-back':
        P.stage = 'pick';
        $('#palette').remove();
        palette();
        break;
      case 'f-agent':
        P.form.agent = key;
        P.form.chat = 'new';
        P.form.resume = null;
        if (P.form.own) P.form.msg = TEMPLATE(PR_URL.test(P.item.target));
        palette();
        break;
      case 'f-chat':
        P.form.chat = key;
        if (key === 'resume' && !P.form.resume) { const c = P.agents && P.agents.chats.find((x) => x.kind === P.form.agent); P.form.resume = c ? c.id : null; }
        palette();
        break;
      case 'f-resume':
        P.form.resume = key;
        palette();
        break;
      case 'f-own': {
        const f = P.form, t = TEMPLATE(PR_URL.test(P.item.target));
        f.own = !f.own;
        if (f.own && !f.msg.trim()) f.msg = t;
        else if (!f.own && f.msg === t) f.msg = '';
        palette();
        break;
      }
      case 'f-adv':
        P.form.adv = !P.form.adv;
        palette();
        break;
      case 'f-start':
        sendForm();
        break;
      case 'add-agent':
        openPalette(id);
        break;
      default:
        break;
    }
  });

  document.addEventListener('input', (e) => {
    if ((e.target.id === 'f-msg' || e.target.id === 'f-flags') && P.form) {
      if (e.target.id === 'f-msg') P.form.msg = e.target.value;
      else P.form.flags[P.form.agent] = e.target.value;
      const cmd = $('#f-cmd');
      if (cmd) cmd.textContent = command();
      return;
    }
    if (e.target.id !== 'pal-in') return;
    P.q = e.target.value;
    P.hl = 0;
    palette();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return P.open ? closePalette() : openPalette(); }
    if (P.open && P.stage === 'start') {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      else if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); sendForm(); }
      return;
    }
    if (P.open) {
      const list = choices();
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); P.hl = Math.min(list.length - 1, P.hl + 1); palette(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); P.hl = Math.max(0, P.hl - 1); palette(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(list[P.hl]); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    // Closed reviews are picked with clicks: Escape lets go of them.
    if (S.tab === 'closed' && e.key === 'Escape') { S.confirm = false; S.picked.clear(); sheet(); return; }
    if (S.tab === 'closed' && e.key !== ' ') return;
    const list = shown();
    const at = list.findIndex((r) => r.id === S.sel);
    const go = (i) => {
      const r = list[Math.max(0, Math.min(list.length - 1, i))];
      if (!r) return;
      S.sel = r.id;
      S.tail = null;
      S.tailFor = null;
      render();
      loadTail();
      const el = document.querySelector(`.rw[data-id="${CSS.escape(r.id)}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(at + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(at < 0 ? 0 : at - 1); }
    else if (e.key === 'Enter' && S.sel) { e.preventDefault(); act('open', S.sel); }
    else if (e.key === 'c' && S.sel && byId(S.sel) && byId(S.sel).chat && byId(S.sel).chat.orca) act('chat', S.sel);
    else if (e.key === 'p' && S.sel && byId(S.sel) && byId(S.sel).status === 'running' && !byId(S.sel).build && !byId(S.sel).older) act('pause', S.sel);
    else if (e.key === 'r' && S.sel && byId(S.sel) && byId(S.sel).status === 'paused') act('resume', S.sel);
    else if (e.key === ' ') {
      const r = open().find(needs);
      if (r) { e.preventDefault(); act('open', r.id); }
    } else if (e.key === 'Escape') {
      if (S.menu) S.menu = null;
      else S.sel = null;
      render();
    }
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  addEventListener('resize', () => { if (S.menu) layer(); });
  poll();
  // From a review's Start a review: the palette opens with the page.
  if (location.hash === '#new') { history.replaceState(null, '', location.pathname); openPalette(); }
})();
