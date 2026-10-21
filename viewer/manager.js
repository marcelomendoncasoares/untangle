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
  };
  // Each agent prints its chat its own way.
  const GLYPH = { claude: { tool: '●', out: '└', say: '●', you: '>' }, codex: { tool: '•', out: '└', say: '•', you: '›' } };

  const S = { data: null, tab: 'open', filter: 'all', sel: null, menu: null, tail: null, tailFor: null, toast: null };
  let toastTimer = 0;

  function api(path, init) {
    return fetch('api/' + path, init).then((r) => r.json().catch(() => ({ error: r.statusText })).then((j) => {
      if (!r.ok) throw new Error(j.error || String(r.status));
      return j;
    }));
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const rows = () => (S.data ? S.data.reviews : []);
  const open = () => rows().filter((r) => r.status !== 'closed');
  const needs = (r) => r.status === 'running' && !!r.need;
  const working = (r) => r.agents.some((a) => a.state === 'working');
  const idleFor = (r) => (r.status === 'running' && r.active && !r.build ? Date.now() - r.active : 0);
  const memOf = (r) => (r.memory ? r.memory.untangle + (r.memory.lsp || 0) : 0);
  const shown = () => {
    if (S.tab === 'closed') return rows().filter((r) => r.status === 'closed' && (!S.filter.startsWith('repo:') || r.repo === S.filter.slice(5)));
    return open().filter((r) => S.filter === 'all' || (S.filter === 'need' && needs(r)) || (S.filter === 'work' && working(r)) || (S.filter === 'paused' && r.status === 'paused') || (S.filter.startsWith('repo:') && r.repo === S.filter.slice(5)));
  };

  function toast(text, bad) {
    S.toast = { text, bad: !!bad };
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
    } else nav = nr('all', ICON.list, 'All closed', rows().filter((r) => r.status === 'closed').length);
    const d = S.data ? S.data.disk : null;
    const sum = d ? d.open + d.closed + d.clones : 0;
    const seg = (v, c) => (v > 0 ? `<i style="flex:${v} 1 0;background:${c}"></i>` : '');
    $('#side').innerHTML = `<div class="big"><b>${fmt(left)}</b><span>change${left === 1 ? '' : 's'} left to review</span><span class="bar"><i style="width:${total ? ((100 * done) / total).toFixed(1) : 0}%"></i></span><small>${fmt(done)} of ${fmt(total)} reviewed, in ${list.length} open review${list.length === 1 ? '' : 's'}</small></div>
      <div class="tabs" role="tablist"><button type="button" role="tab" data-act="tab" data-key="open" aria-selected="${S.tab === 'open'}">Open<i>${list.length}</i></button><button type="button" role="tab" data-act="tab" data-key="closed" aria-selected="${S.tab === 'closed'}">Closed<i>${rows().length - list.length}</i></button></div>
      <div class="nav">${nav}</div>
      ${repos.size ? `<div class="grp">Repositories</div><div class="nav">${[...repos].sort((a, b) => b[1] - a[1]).map(([name, n]) => nr('repo:' + name, ICON.repo, name, n)).join('')}</div>` : ''}
      <div class="disk"><div class="disk-h"><b>${d ? bytes(sum) : '—'}</b><span>in untangle’s cache${d && d.measuring ? ', measuring…' : ''}</span></div>
        <div class="disk-bar">${d ? seg(d.open, 'var(--d-open)') + seg(d.closed, 'var(--d-closed)') + seg(d.clones, 'var(--d-shared)') : ''}</div>
        <div class="legend"><span><i style="background:var(--d-open)"></i>Open reviews<b>${d ? bytes(d.open) : '—'}</b></span><span><i style="background:var(--d-closed)"></i>Closed reviews<b>${d ? bytes(d.closed) : '—'}</b></span><span><i style="background:var(--d-shared)"></i>Clones<b>${d ? bytes(d.clones) : '—'}</b></span></div>
      </div>`;
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
    const a = r.agents[0];
    const c = r.chat;
    const id = c ? `${c.kind === 'codex' ? 'Thread' : 'Session'} ${c.id.slice(0, 8)}` : '';
    if (r.status === 'running' && a) return `<span class="agent"><span class="lab" data-st="${esc(a.state)}"><i></i><span>${esc(a.label)}</span></span><small>${esc(id)}${c && c.orca ? ' · in Orca' : ''}</small></span>`;
    if (r.status !== 'running' && c) return `<span class="agent"><span class="lab" data-st="kept"><i></i><span>${esc(c.agent)}’s chat, kept</span></span><small>${esc(id)}</small></span>`;
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
    return `<span class="memc"><b>${r.disk != null ? bytes(r.disk) : '—'}</b><small>on disk</small></span>`;
  }

  function row(r) {
    const sel = S.sel === r.id;
    const st = r.status !== 'running' ? r.status : r.build ? 'build' : needs(r) ? 'need' : '';
    const l2 = r.status === 'running'
      ? `${esc(r.repo)}${r.author ? ' · ' + esc(r.author) : ''} · <span class="a">+${fmt(r.size.add)}</span> <span class="d">−${fmt(r.size.del)}</span> in ${fmt(r.size.files)} file${r.size.files === 1 ? '' : 's'}`
      : `${r.status === 'closed' ? 'Closed' : whyText[r.stopped ? r.stopped.why : 'stop']} ${ago(r.status === 'closed' ? r.closed : r.stopped && r.stopped.at)} · ${esc(r.repo)}${r.author ? ' · ' + esc(r.author) : ''}`;
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
    const chat = c
      ? `<div class="pk-h"><b>${esc(c.agent)}</b><span>${esc(a ? a.label : `${c.agent}’s chat, kept`)}</span><span class="sp"></span>${c.orca ? `<button type="button" class="btn sm" data-act="chat" data-id="${esc(r.id)}">${ICON.term}Chat<kbd>C</kbd></button>` : ''}</div>${tail(r)}`
      : `<div class="pk-h"><b>No agent</b></div><p class="pk-text">No chat holds this review. In Claude or Codex, “review this in untangle” holds it, with the untangle skill.</p>`;
    const w = r.waiting;
    const notes = `<div class="pk-h"><b>${w.length ? 'Waiting for you' : 'Nothing waits for you'}</b></div>${w.map((x) => `<div class="wn"><span class="nb">N${x.n}</span><code>${esc(x.path.split('/').pop())}${x.line ? ':' + x.line : ''}</code><span>${esc(x.by)} ${x.wrote ? 'wrote' : 'answered'}</span></div>`).join('')}<div class="pk-more">${r.notes.open ? `${r.notes.open} open note${r.notes.open === 1 ? '' : 's'}` : 'No open notes'}</div>`;
    const running = r.status === 'running';
    const res = `<div class="pk-h"><b>This review</b><span class="sp"></span>${r.url ? `<a class="ib" href="${esc(r.url)}" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open on GitHub">${ICON.open}</a>` : ''}</div>
      ${running ? `<div class="kv"><span>untangle</span><b>${r.memory ? bytes(r.memory.untangle) : '—'}</b><span></span></div>
      <div class="kv"><span>Language server</span><b>${r.memory && r.memory.lsp ? bytes(r.memory.lsp) : 'not running'}</b>${r.memory && r.memory.lsp ? `<button type="button" class="btn" data-act="lsp" data-id="${esc(r.id)}" title="Start the language server over: it lets go of what it loaded">Free</button>` : '<span></span>'}</div>` : ''}
      <div class="kv"><span>On disk</span><b>${r.disk != null ? bytes(r.disk) : 'measuring…'}</b><span></span></div>
      <div class="kv"><span>Head</span><b>${esc(r.head.slice(0, 7))}</b><span></span></div>
      ${running ? `<div class="pk-act"><button type="button" class="btn sm primary" data-act="open" data-id="${esc(r.id)}">Open review<kbd>⏎</kbd></button></div>` : ''}`;
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
    const list = shown();
    const title = S.tab === 'closed' ? 'Closed reviews' : { all: 'Open reviews', need: 'Need you', work: 'Agents at work', paused: 'Paused' }[S.filter] || S.filter.slice(5);
    let body;
    if (!S.data) body = '<p class="empty">Loading your reviews…</p>';
    else if (!rows().length) body = '<p class="empty">No reviews yet. <code>untangle &lt;pr-url&gt;</code> starts one, or <code>untangle</code> in a branch, and asking an agent to review in untangle does too. They show here as they run, and stay once they stop.</p>';
    else if (!list.length) body = '<p class="empty">Nothing here now.</p>';
    else if (S.tab === 'closed') body = list.map(row).join('');
    else {
      const run = list.filter((r) => r.status === 'running'), paused = list.filter((r) => r.status === 'paused');
      body = (run.length ? `<div class="gh"><b>Running</b>${run.length}</div>${run.map(row).join('')}` : '') + (paused.length ? `<div class="gh"><b>Paused</b>${paused.length}</div>${paused.map(row).join('')}` : '');
    }
    const list0 = $('#sheet .list');
    const scroll = list0 ? list0.scrollTop : 0;
    $('#sheet').innerHTML = `<div class="head"><h1>${esc(title)}</h1><span class="sub">${S.data ? `${list.length} · newest first` : ''}</span></div><div class="list">${body}</div>${pill()}`;
    $('#sheet .list').scrollTop = scroll;
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
        <div class="pop-r"><small>This page’s own process</small><b>${bytes(S.data.memory.manager)}</b></div>
      </div>`;
    }
    if (S.toast) h += `<div class="toast${S.toast.bad ? ' bad' : ''}" role="status">${esc(S.toast.text)}</div>`;
    $('#layer').innerHTML = h;
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
  }

  // ---- Clicks and keys

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    const was = S.menu;
    if (S.menu && !(b && b.dataset.act === 'mem') && !e.target.closest('.pop')) S.menu = null;
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
        render();
        break;
      case 'filter':
        S.filter = key;
        render();
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
        act(b.dataset.act === 'next' ? 'open' : b.dataset.act, id);
        break;
      default:
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
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
})();
