(() => {
  'use strict';

  const ORG = 'Team Tasks'; // change to your organisation's name
  const DAY = 864e5;

  const root = document.getElementById('app');
  const state = {
    loading: true,
    needsSetup: false,
    user: null,
    view: 'mine', // mine | all | recurring | people | teams | sheets
    tasks: [],
    users: [],
    teams: [],
    status: 'pending', // pending | in_progress | done (which list is showing)
    person: 'all',
    team: 'all',
    flag: 'all', // all | priority | blocked (admin All tasks filter)
    animate: true, // play entrance animations on the next render only
    flash: new Set(), // task ids that just changed (highlighted briefly)
    tz: '', // organisation time zone used for repeating tasks
    recurring: [], // repeating-task schedules (admins)
    resources: [], // saved sheets and materials
    resQuery: '',
    resCat: 'all',
  };
  let animating = false;
  const live = { ws: null, on: false, wanted: false, retry: 0, retryTimer: null, pingTimer: null, refreshTimer: null, dirty: false, catchUp: false, hiddenAt: 0 };

  const STATUSES = [
    ['pending', 'To do'],
    ['in_progress', 'In progress'],
    ['done', 'Done'],
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES);
  const PRIO_LABEL = { 1: '1st priority', 2: '2nd priority', 3: '3rd priority' };
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const REPEAT_SHORT = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' };

  /* ---------- tiny DOM helpers ---------- */

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let deferredValue;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') deferredValue = v;
      else if (k === 'checked' || k === 'disabled') el[k] = true;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    if (deferredValue !== undefined) el.value = deferredValue;
    return el;
  }

  // Static, hard-coded SVG paths only (never user data).
  const ICONS = {
    sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    tasks: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    link: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  };

  function icon(name, size = 18) {
    const el = document.createElement('span');
    el.className = 'ico';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return el;
  }

  const logoMark = () => h('div', { class: 'logo' }, icon('check', 20));
  const initials = (name) =>
    name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  // Shows the person's photo when they have one, otherwise their initials.
  function avatar(name, person) {
    const el = h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name));
    if (person && person.avatar_v) {
      const img = h('img', { src: `/api/avatar/${person.id}?v=${person.avatar_v}`, alt: '', decoding: 'async' });
      img.addEventListener('error', () => img.remove()); // falls back to the initials
      el.append(img);
    }
    return el;
  }

  const stagger = (els) => {
    els.forEach((el, i) => el.style.setProperty('--i', Math.min(i, 12)));
    return els;
  };

  function timeAgo(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    if (hr < 24) return `${hr} h ago`;
    const d = Math.round(hr / 24);
    return d < 7 ? `${d} d ago` : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  // Numbers count up when a page first appears.
  function countUp(el, target) {
    if (!animating || target === 0) { el.textContent = String(target); return; }
    const t0 = performance.now();
    el.textContent = '0';
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / 700);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Circular completion meter that draws itself in.
  function progressRing(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const C = 2 * Math.PI * 26;
    const wrap = h('div', { class: 'ring', role: 'img', 'aria-label': total ? `${pct}% of tasks done (${done} of ${total})` : 'No tasks yet' });
    wrap.innerHTML =
      '<svg viewBox="0 0 64 64" width="64" height="64"><defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="g1"/><stop offset="1" class="g2"/></linearGradient></defs>' +
      '<circle class="track" cx="32" cy="32" r="26"/><circle class="bar" cx="32" cy="32" r="26" transform="rotate(-90 32 32)"/></svg>' +
      `<span class="ring-n">${pct}%</span>`;
    const bar = wrap.querySelector('.bar');
    const target = C * (1 - pct / 100);
    bar.style.strokeDasharray = String(C);
    if (animating) {
      bar.style.strokeDashoffset = String(C);
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.strokeDashoffset = String(target); }));
    } else {
      bar.style.strokeDashoffset = String(target);
    }
    return wrap;
  }

  function emptyState(message) {
    const art = document.createElement('div');
    art.className = 'empty-art';
    art.setAttribute('aria-hidden', 'true');
    art.innerHTML =
      '<svg viewBox="0 0 120 90" width="120" height="90" fill="none"><rect class="e-card" x="22" y="16" width="76" height="58" rx="10"/>' +
      '<line class="e-line" x1="36" y1="34" x2="84" y2="34"/><line class="e-line" x1="36" y1="46" x2="70" y2="46"/>' +
      '<circle class="e-dot" cx="90" cy="64" r="14"/><polyline class="e-check" points="83 64 88 69 97 59"/></svg>';
    return h('div', { class: 'empty' }, art, h('p', null, message));
  }

  // Confetti burst when a task is finished.
  function celebrate(x, y) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#34c3a8', '#4ab0e0', '#f2b45c', '#ff8f85', '#a78bfa', '#6ea4ff'];
    const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    for (let i = 0; i < 26; i++) {
      const p = document.createElement('i');
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 110;
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(angle) * dist - 40 + 'px');
      p.style.setProperty('--rot', Math.round(Math.random() * 540 - 270) + 'deg');
      layer.append(p);
    }
    document.body.append(layer);
    setTimeout(() => layer.remove(), 1100);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && state.user) {
        state.user = null;
        stopLive();
        render();
      }
      throw new Error(data.error || 'Something went wrong. Try again.');
    }
    return data;
  }

  function toast(message) {
    const el = h('div', { class: 'toast', role: 'status' }, message);
    document.body.append(el);
    setTimeout(() => el.remove(), 3200);
  }

  /* ---------- dates ---------- */

  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fmtDate = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtShort = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // How a task's deadline is shown, and which urgency group it falls in.
  function dueInfo(task) {
    if (task.status === 'done') {
      return { group: 'done', tone: 'done', when: '', rel: task.completed_at ? `Done ${fmtShort(new Date(task.completed_at))}` : 'Done' };
    }
    if (!task.deadline) return { group: 'none', tone: 'none', when: 'No deadline', rel: '' };

    const due = new Date(task.deadline);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const days = Math.round((startDue - startToday) / DAY);
    const when = `${fmtDate(due)}, ${fmtTime(due)}`;

    if (due < now) return { group: 'overdue', tone: 'late', when, rel: days < 0 ? `${plural(-days, 'day')} overdue` : 'Overdue today' };
    if (days === 0) return { group: 'today', tone: 'today', when, rel: 'Due today' };
    if (days === 1) return { group: 'week', tone: 'soon', when, rel: 'Due tomorrow' };
    if (days <= 7) return { group: 'week', tone: 'soon', when, rel: `In ${days} days` };
    return { group: 'later', tone: 'none', when, rel: `In ${days} days` };
  }

  const GROUPS = [
    ['p1', '1st priority – do these first'],
    ['p2', '2nd priority'],
    ['p3', '3rd priority'],
    ['overdue', 'Overdue'],
    ['today', 'Today'],
    ['week', 'Next 7 days'],
    ['later', 'Later'],
    ['none', 'No deadline'],
  ];

  /* ---------- WhatsApp (click-to-send via the admin's own WhatsApp) ---------- */

  function waText(person, task, kind) {
    const first = person.name.trim().split(/\s+/)[0];
    const flag =
      task.priority === 1
        ? '🔴 *1st PRIORITY* – needs to be done ASAP.\n'
        : task.priority === 2
        ? '🟠 *2nd priority* – please do it after your 1st-priority tasks.\n'
        : task.priority === 3
        ? '🟡 *3rd priority*.\n'
        : '';
    let lead;
    if (kind === 'new') {
      lead = `Hi ${first}, you have a new task: *${task.title}*.`;
    } else if (kind === 'blocker') {
      const b = task.blockers && task.blockers[0] ? task.blockers[0].body.slice(0, 200) : '';
      lead = `Hi ${first}, I saw you are blocked on *${task.title}*: "${b}". Let's sort it out. What do you need?`;
    } else {
      lead = `Hi ${first}, a quick reminder about your task: *${task.title}*.`;
    }
    let due = '';
    if (task.deadline) {
      const d = new Date(task.deadline);
      due = ` Due: ${fmtDate(d)}, ${fmtTime(d)}.`;
    }
    const note = kind !== 'blocker' && task.description ? `\n${task.description.slice(0, 300)}` : '';
    return `${flag}${lead}${due}${note}\nOpen your tasks: ${location.origin}`;
  }

  function waButton(person, task, kind) {
    if (!person || !person.phone) {
      return h('span', { class: 'btn-wa off', title: 'Add a WhatsApp number under People → Edit' }, icon('chat', 15), 'No number');
    }
    return h(
      'a',
      {
        class: 'btn-wa',
        href: `https://wa.me/${person.phone}?text=${encodeURIComponent(waText(person, task, kind))}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': `Send ${person.name} a WhatsApp message about ${task.title}`,
      },
      icon('chat', 15),
      'WhatsApp'
    );
  }

  /* ---------- night mode ---------- */

  const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

  function paintThemeButton(btn) {
    const dark = currentTheme() === 'dark';
    btn.replaceChildren(icon(dark ? 'sun' : 'moon', 20));
    const label = dark ? 'Switch to day mode' : 'Switch to night mode';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  function themeButton(extra = '') {
    const btn = h('button', {
      class: 'icon-btn theme-toggle ' + extra,
      type: 'button',
      onclick: () => {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
        document.querySelectorAll('.theme-toggle').forEach(paintThemeButton);
      },
    });
    paintThemeButton(btn);
    return btn;
  }

  /* ---------- data loading ---------- */

  async function loadTasks() {
    const path = state.user.role === 'admin' && state.view === 'all' ? '/tasks' : '/tasks?mine=1';
    state.tasks = (await api(path)).tasks;
  }
  async function loadUsers() { state.users = (await api('/users')).users; }
  async function loadTeams() { state.teams = (await api('/teams')).teams; }
  async function loadRecurring() { state.recurring = (await api('/recurring')).recurring; }
  async function loadResources() { state.resources = (await api('/resources')).resources; }

  async function enter() {
    state.view = 'mine';
    state.status = 'pending';
    state.person = 'all';
    state.team = 'all';
    state.flag = 'all';
    state.animate = true;
    await loadTasks();
    if (state.user.role === 'admin') await Promise.all([loadUsers(), loadTeams()]);
    render();
    startLive();
  }

  async function go(view) {
    state.view = view;
    state.person = 'all';
    state.team = 'all';
    state.flag = 'all';
    state.animate = true;
    try {
      if (view === 'people' || view === 'teams') await Promise.all([loadUsers(), loadTeams()]);
      else if (view === 'recurring') await Promise.all([loadUsers(), loadRecurring()]);
      else if (view === 'sheets') await loadResources();
      else {
        await loadTasks();
        if (view === 'all') await Promise.all([loadUsers(), loadTeams()]);
      }
    } catch (e) {
      toast(e.message);
    }
    render();
    window.scrollTo({ top: 0 });
  }

  /* ---------- live updates ---------- */

  const taskSig = (t) => [t.status, t.priority, t.title, t.deadline, t.assignee_id, blockersOf(t).map((b) => b.id).join(',')].join('|');

  function paintLive(el) {
    el.classList.toggle('on', live.on);
    const label = live.on ? 'Live updates on' : 'Connecting…';
    el.title = label;
    el.setAttribute('aria-label', label);
    const text = el.querySelector('span');
    if (text) text.textContent = live.on ? 'Live' : 'Connecting…';
  }

  function liveBadge() {
    const el = h('span', { class: 'live', role: 'img' }, h('i'), h('span'));
    paintLive(el);
    return el;
  }

  function setLive(on) {
    live.on = on;
    document.querySelectorAll('.live').forEach(paintLive);
  }

  // Fetch fresh data after someone else changed something, then redraw without replaying animations.
  async function liveRefresh() {
    if (!state.user) return;
    live.dirty = false;
    const before = new Map(state.tasks.map((t) => [t.id, taskSig(t)]));
    try {
      await loadTasks();
      if (state.user.role === 'admin') await Promise.all([loadUsers(), loadTeams()]);
      if (state.view === 'recurring' && state.user.role === 'admin') await loadRecurring();
      if (state.view === 'sheets') await loadResources();
    } catch {
      return;
    }
    state.flash = new Set(state.tasks.filter((t) => before.get(t.id) !== taskSig(t)).map((t) => t.id));
    render();
    setTimeout(() => { state.flash = new Set(); }, 2200);
  }

  function scheduleRefresh() {
    clearTimeout(live.refreshTimer);
    live.refreshTimer = setTimeout(liveRefresh, 300); // bursts of changes become one refresh
  }

  function onLiveMessage(m) {
    if (!state.user) return;
    if (document.hidden) { live.dirty = true; return; }
    if (m.text && m.by !== state.user.id) toast(m.text);
    scheduleRefresh();
  }

  // Drop the current connection without waiting for the browser's close event.
  function dropSocket() {
    const ws = live.ws;
    live.ws = null;
    clearInterval(live.pingTimer);
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try { ws.close(); } catch { /* ignore */ }
    }
    setLive(false);
  }

  function connectLive() {
    if (!state.user || live.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/api/live`); } catch { scheduleReconnect(); return; }
    live.ws = ws;
    ws.onopen = () => {
      live.retry = 0;
      setLive(true);
      clearInterval(live.pingTimer);
      live.pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 40000);
      if (live.catchUp) { live.catchUp = false; liveRefresh(); } // pick up anything missed while offline
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'changed') onLiveMessage(m);
        // The server ended this connection on purpose (access changed): re-check the session now.
        if (m.type === 'bye' && live.wanted && state.user) {
          dropSocket();
          live.catchUp = true;
          scheduleReconnect();
        }
      } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      clearInterval(live.pingTimer);
      if (live.ws === ws) live.ws = null;
      setLive(false);
      if (live.wanted && state.user) { live.catchUp = true; scheduleReconnect(); }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  function scheduleReconnect() {
    if (!live.wanted || live.retryTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** live.retry);
    live.retry += 1;
    live.retryTimer = setTimeout(() => { live.retryTimer = null; reconnectLive(); }, delay);
  }

  // Before reconnecting, make sure the session is still valid (the person may have been
  // deactivated or had their access changed while the connection was down).
  async function reconnectLive() {
    if (!live.wanted || !state.user) return;
    try {
      const r = await api('/me');
      if (!r.user) {
        state.user = null;
        stopLive();
        render();
        toast('You have been signed out.');
        return;
      }
      const roleChanged = r.user.role !== state.user.role;
      state.user = r.user;
      if (roleChanged) { await enter(); return; }
    } catch {
      scheduleReconnect(); // offline: try again later
      return;
    }
    connectLive();
  }

  function startLive() {
    live.wanted = true;
    connectLive();
  }

  function stopLive() {
    live.wanted = false;
    clearTimeout(live.retryTimer);
    clearTimeout(live.refreshTimer);
    clearInterval(live.pingTimer);
    live.retryTimer = null;
    dropSocket();
  }

  /* ---------- sign-in screens ---------- */

  function field(label, name, type = 'text', attrs = {}, hint) {
    return h('label', { class: 'field' }, h('span', null, label), h('input', { name, type, ...attrs }), hint ? h('small', null, hint) : null);
  }

  function loginScreen() {
    const err = h('p', { class: 'form-error', role: 'alert' });
    const form = h(
      'form',
      {
        class: 'auth-card',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const fd = new FormData(form);
          try {
            const r = await api('/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
            state.user = r.user;
            state.tz = r.tz || '';
            await enter();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      logoMark(),
      h('h1', null, ORG),
      h('p', { class: 'sub' }, 'Sign in to see your tasks.'),
      field('Username', 'username', 'text', { autocomplete: 'username', required: true, autocapitalize: 'none' }),
      field('Password', 'password', 'password', { autocomplete: 'current-password', required: true }),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')
    );
    return h('main', { class: 'auth' }, themeButton('floating'), form);
  }

  function setupScreen() {
    const err = h('p', { class: 'form-error', role: 'alert' });
    const form = h(
      'form',
      {
        class: 'auth-card',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const fd = new FormData(form);
          try {
            await api('/setup', {
              method: 'POST',
              body: { key: fd.get('key'), name: fd.get('name'), username: fd.get('username'), password: fd.get('password') },
            });
            state.needsSetup = false;
            render();
            toast('Admin account created. Sign in to continue.');
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      logoMark(),
      h('h1', null, 'Create the first admin'),
      h('p', { class: 'sub' }, 'This only works once, while no accounts exist.'),
      field('Setup key', 'key', 'password', { required: true, autocomplete: 'off' }, 'The SETUP_KEY secret you set on Cloudflare.'),
      field('Your name', 'name', 'text', { required: true }),
      field('Username', 'username', 'text', { required: true, autocapitalize: 'none' }),
      field('Password', 'password', 'password', { required: true, minlength: 8, autocomplete: 'new-password' }, 'At least 8 characters.'),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Create admin account')
    );
    return h('main', { class: 'auth' }, themeButton('floating'), form);
  }

  /* ---------- shell: header, account menu, navigation ---------- */

  function closeMenus() {
    document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    document.querySelectorAll('.avatar-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

  // ----- profile photo: shrink to a small square JPEG in the browser, then upload -----
  function toSquareJpeg(file, size = 192) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('Please choose an image file.'));
      if (file.size > 20 * 1024 * 1024) return reject(new Error('That image is too large.'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That image type is not supported. Try a JPG or PNG.'));
        img.onload = () => {
          const side = Math.min(img.width, img.height);
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that image.'))), 'image/jpeg', 0.85);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  const photoInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    photoInput.value = '';
    if (!file) return;
    try {
      const blob = await toSquareJpeg(file);
      const res = await fetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save the photo.');
      state.user.avatar_v = data.v;
      if (state.user.role === 'admin') await loadUsers();
      render();
      toast('Photo updated.');
    } catch (e) {
      toast(e.message);
    }
  });

  async function removePhoto(person) {
    const own = person.id === state.user.id;
    try {
      await api(own ? '/avatar' : `/avatar/${person.id}`, { method: 'DELETE' });
      if (own) state.user.avatar_v = null;
      if (state.user.role === 'admin') await loadUsers();
      render();
      toast(own ? 'Photo removed.' : `${person.name}'s photo was removed.`);
    } catch (e) {
      toast(e.message);
    }
  }

  function accountMenu() {
    const u = state.user;
    const sub = u.role === 'admin' ? 'Admin' : u.team || 'Member';
    const menu = h(
      'div',
      { class: 'menu', hidden: true },
      h('div', { class: 'menu-who' }, avatar(u.name, u), h('div', null, h('strong', null, u.name), h('span', null, `@${u.username} · ${sub}`))),
      h('button', { class: 'menu-item', type: 'button', onclick: () => { closeMenus(); photoInput.click(); } }, u.avatar_v ? 'Change photo' : 'Add a photo'),
      u.avatar_v ? h('button', { class: 'menu-item', type: 'button', onclick: () => { closeMenus(); removePhoto(u); } }, 'Remove photo') : null,
      h('button', { class: 'menu-item', type: 'button', onclick: () => { closeMenus(); passwordDialog(); } }, 'Change password'),
      h('button', { class: 'menu-item', type: 'button', onclick: logout }, 'Sign out')
    );
    const btn = h(
      'button',
      {
        class: 'avatar-btn',
        type: 'button',
        'aria-label': 'Account menu',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        onclick: (e) => {
          e.stopPropagation();
          const opening = menu.hidden;
          closeMenus();
          if (opening) {
            menu.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
          }
        },
      },
      avatar(u.name, u)
    );
    return h('div', { class: 'account' }, btn, menu);
  }

  function shell() {
    const admin = state.user.role === 'admin';
    const tabs = [['mine', 'My tasks', 'Mine', 'tasks']];
    if (admin) tabs.push(['all', 'All tasks', 'All', 'layers'], ['recurring', 'Repeating', 'Repeat', 'repeat'], ['people', 'People', 'People', 'users'], ['teams', 'Teams', 'Teams', 'tag']);
    tabs.push(['sheets', 'Sheets', 'Sheets', 'grid']);

    const nav = h(
      'nav',
      { class: 'tabs', 'aria-label': 'Sections' },
      tabs.map(([key, label, short, ic]) =>
        h(
          'button',
          { class: 'tab' + (state.view === key ? ' on' : ''), type: 'button', 'aria-current': state.view === key ? 'page' : null, onclick: () => go(key) },
          icon(ic, 20),
          h('span', { class: 't-full' }, label),
          h('span', { class: 't-short', 'aria-hidden': 'true' }, short)
        )
      )
    );

    const header = h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, logoMark(), h('span', null, ORG)),
      nav,
      h('div', { class: 'top-right' }, liveBadge(), themeButton(), accountMenu())
    );

    const page =
      state.view === 'people' ? peopleView() : state.view === 'teams' ? teamsView() : state.view === 'recurring' ? recurringView() : state.view === 'sheets' ? sheetsView() : taskView(state.view === 'all');
    page.classList.add('has-nav');
    return h('div', null, header, page);
  }

  /* ---------- tasks ---------- */

  const blockersOf = (t) => t.blockers || [];
  const groupOf = (t) => (t.priority ? 'p' + t.priority : dueInfo(t).group);

  function statCard(key, label, count) {
    const n = h('span', { class: 'stat-n' }, count);
    countUp(n, count);
    return h(
      'button',
      {
        type: 'button',
        class: `stat s-${key}` + (state.status === key ? ' on' : ''),
        'aria-pressed': String(state.status === key),
        onclick: () => { state.status = key; render(); },
      },
      n,
      h('span', { class: 'stat-l' }, label)
    );
  }

  function taskView(all) {
    const isAdmin = state.user.role === 'admin';
    const manage = all || isAdmin;

    let tasks = state.tasks.slice();
    if (all) {
      if (state.person !== 'all') tasks = tasks.filter((t) => String(t.assignee_id) === state.person);
      if (state.team !== 'all') tasks = tasks.filter((t) => t.assignee_team === state.team);
    }
    const isOpen = (t) => t.status !== 'done';
    const blockedCount = tasks.filter((t) => isOpen(t) && blockersOf(t).length).length;
    const priorityCount = tasks.filter((t) => isOpen(t) && t.priority).length;
    if (all && state.flag === 'priority') tasks = tasks.filter((t) => t.priority);
    if (all && /^p[123]$/.test(state.flag)) tasks = tasks.filter((t) => t.priority === Number(state.flag[1]));
    if (all && state.flag === 'blocked') tasks = tasks.filter((t) => blockersOf(t).length);

    const todo = tasks.filter((t) => t.status === 'pending');
    const prog = tasks.filter((t) => t.status === 'in_progress');
    const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));
    const overdue = [...todo, ...prog].filter((t) => dueInfo(t).group === 'overdue').length;

    const extra = [];
    if (overdue) extra.push(h('span', { class: 'late' }, `${overdue} overdue`));
    if (priorityCount) extra.push(h('span', { class: 'prio-s' }, `${priorityCount} priority`));
    if (blockedCount) extra.push(h('span', { class: 'late' }, `${blockedCount} blocked`));

    const head = h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { class: 'head-main' },
        progressRing(done.length, tasks.length),
        h(
          'div',
          null,
          h('h1', null, all ? 'All tasks' : `Hi, ${state.user.name.trim().split(/\s+/)[0]}`),
          h('p', { class: 'summary' }, `${todo.length} to do · ${prog.length} in progress`, extra.map((x) => [' · ', x]))
        )
      ),
      all
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => taskDialog() }, icon('plus', 18), 'Assign task')
        : isAdmin
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => taskDialog() }, icon('plus', 18), 'Add my task')
        : null
    );

    const parts = [head];

    if (all && blockedCount && state.flag !== 'blocked') {
      parts.push(
        h(
          'button',
          { class: 'alert-strip', type: 'button', onclick: () => { state.flag = 'blocked'; render(); } },
          icon('alert', 18),
          h('span', null, `${plural(blockedCount, 'task')} blocked – people need your help`),
          h('span', { class: 'alert-cta' }, 'View')
        )
      );
    }

    parts.push(
      h(
        'div',
        { class: 'stats', role: 'group', 'aria-label': 'Filter by status' },
        statCard('pending', 'To do', todo.length),
        statCard('in_progress', 'In progress', prog.length),
        statCard('done', 'Done', done.length)
      )
    );

    if (all) {
      const people = state.users.filter((u) => u.role === 'member');
      parts.push(
        h(
          'div',
          { class: 'toolbar' },
          h(
            'select',
            { 'aria-label': 'Filter by team', value: state.team, onchange: (e) => { state.team = e.target.value; render(); } },
            h('option', { value: 'all' }, 'All teams'),
            state.teams.map((t) => h('option', { value: t.name }, t.name))
          ),
          h(
            'select',
            { 'aria-label': 'Filter by person', value: state.person, onchange: (e) => { state.person = e.target.value; render(); } },
            h('option', { value: 'all' }, 'Everyone'),
            people.map((p) => h('option', { value: String(p.id) }, p.name + (p.active ? '' : ' (inactive)')))
          ),
          h(
            'select',
            { 'aria-label': 'Filter by flag', value: state.flag, onchange: (e) => { state.flag = e.target.value; render(); } },
            h('option', { value: 'all' }, 'Any task'),
            h('option', { value: 'priority' }, 'Any priority'),
            h('option', { value: 'p1' }, '1st priority'),
            h('option', { value: 'p2' }, '2nd priority'),
            h('option', { value: 'p3' }, '3rd priority'),
            h('option', { value: 'blocked' }, 'Blocked only')
          )
        )
      );
    }

    const list = state.status === 'done' ? done : state.status === 'in_progress' ? prog : todo;
    let n = 0;
    if (!list.length) {
      const msg =
        all && state.flag !== 'all'
          ? 'Nothing matches this filter.'
          : {
              pending: all ? 'No to-do tasks match these filters.' : isAdmin ? 'Nothing on your list. Use "Add my task" to note something down.' : 'Nothing on your to-do list. New tasks will show up here.',
              in_progress: all ? 'Nobody has a task in progress right now.' : 'Nothing in progress. Move a task here when you start working on it.',
              done: 'No completed tasks yet.',
            }[state.status];
      parts.push(emptyState(msg));
    } else if (state.status === 'done') {
      parts.push(h('ul', { class: 'tasks' }, list.map((t) => taskCard(t, all, manage, n++))));
    } else {
      for (const [key, label] of GROUPS) {
        const items = list.filter((t) => groupOf(t) === key);
        if (!items.length) continue;
        parts.push(
          h(
            'section',
            { class: 'group g-' + key },
            h('h2', null, /^p[123]$/.test(key) ? icon('zap', 16) : null, label, h('span', { class: 'count' }, items.length)),
            h('ul', { class: 'tasks' }, items.map((t) => taskCard(t, all, manage, n++)))
          )
        );
      }
    }
    return h('main', { class: 'page' }, parts);
  }

  function statusControl(t) {
    return h(
      'div',
      { class: 'status-seg', role: 'group', 'aria-label': `Status of ${t.title}` },
      STATUSES.map(([key, label]) =>
        h('button', { type: 'button', class: `st st-${key}` + (t.status === key ? ' on' : ''), 'aria-pressed': String(t.status === key), onclick: (e) => setStatus(t, key, e) }, label)
      )
    );
  }

  function taskCard(t, all, manage, i = 0) {
    const d = dueInfo(t);
    const person = all ? state.users.find((u) => u.id === t.assignee_id) : null;
    const open = t.status !== 'done';
    const mine = t.assignee_id === state.user.id;
    const personal = mine && state.user.role === 'admin'; // an admin's own to-do
    const blockers = open ? blockersOf(t) : [];

    const dueChip =
      t.status === 'done'
        ? h('span', { class: 'chip done' }, icon('check', 14), d.rel)
        : h('span', { class: 'chip ' + d.tone }, icon('clock', 14), d.when, d.rel ? ` · ${d.rel}` : '');

    const chips = h(
      'div',
      { class: 'chips' },
      t.priority && open ? h('span', { class: `chip prio p${t.priority}` }, icon('zap', 13), PRIO_LABEL[t.priority]) : null,
      t.repeat ? h('span', { class: 'chip repeat' }, icon('repeat', 13), REPEAT_SHORT[t.repeat]) : null,
      dueChip,
      blockers.length ? h('span', { class: 'chip blocked' }, icon('alert', 13), 'Blocked') : null,
      all ? h('span', { class: 'chip person' }, avatar(t.assignee_name, person), t.assignee_name + (t.assignee_team ? ` · ${t.assignee_team}` : '')) : null
    );

    const blockerBox = blockers.length
      ? h(
          'div',
          { class: 'blockers' },
          blockers.map((b) =>
            h(
              'div',
              { class: 'blocker' },
              icon('alert', 16),
              h('div', { class: 'blocker-body' }, h('p', null, b.body), h('small', null, `${b.author_name} · ${timeAgo(b.created_at)}`)),
              h('button', { class: 'link', type: 'button', onclick: () => resolveBlocker(b) }, 'Resolved')
            )
          )
        )
      : null;

    const actions = [];
    if (all && open) actions.push(waButton(person, t, blockers.length ? 'blocker' : 'reminder'));
    if (mine && !personal && open) {
      actions.push(h('button', { class: 'link warn', type: 'button', onclick: () => blockerDialog(t) }, icon('alert', 14), 'Report a blocker'));
    }
    if (manage) {
      actions.push(h('button', { class: 'link', type: 'button', onclick: () => taskDialog(t) }, 'Edit'));
      actions.push(h('button', { class: 'link danger', type: 'button', onclick: () => removeTask(t) }, 'Delete'));
    }

    const li = h(
      'li',
      { class: `task is-${t.status} tone-${d.tone}` + (t.priority && open ? ` is-priority is-p${t.priority}` : '') + (blockers.length ? ' is-blocked' : '') + (state.flash.has(t.id) ? ' flash' : '') },
      h('div', { class: 'task-main' }, h('p', { class: 'title' }, t.title), t.description ? h('p', { class: 'desc' }, t.description) : null, chips, blockerBox),
      h('div', { class: 'task-side' }, statusControl(t), actions.length ? h('div', { class: 'actions' }, actions) : null)
    );
    li.style.setProperty('--i', Math.min(i, 12));
    return li;
  }

  async function setStatus(t, status, e) {
    if (t.status === status) return;
    // Capture where to burst confetti before the list re-renders.
    const rect = e && e.currentTarget ? e.currentTarget.getBoundingClientRect() : null;
    try {
      const r = await api('/tasks/' + t.id, { method: 'PATCH', body: { status } });
      t.status = r.task.status;
      t.completed_at = r.task.completed_at;
      render();
      toast(`Moved to ${STATUS_LABEL[status]}`);
      if (status === 'done' && rect) celebrate(rect.left + rect.width / 2, rect.top);
    } catch (err) {
      toast(err.message);
    }
  }

  async function resolveBlocker(b) {
    try {
      await api(`/blockers/${b.id}/resolve`, { method: 'POST' });
      await loadTasks();
      render();
      toast('Blocker marked as resolved.');
    } catch (e) {
      toast(e.message);
    }
  }

  function blockerDialog(t) {
    formDialog({
      title: 'Report a blocker',
      submit: 'Send to admin',
      fields: [
        h('p', { class: 'hint' }, `Task: ${t.title}`),
        h(
          'label',
          { class: 'field' },
          h('span', null, "What's holding this up?"),
          h('textarea', { name: 'body', required: true, maxlength: 500, placeholder: 'e.g. Waiting for the client logo files' }),
          h('small', null, 'Your admin will see this on the task. Mark it resolved once it is sorted.')
        ),
      ],
      onSubmit: async (fd) => {
        await api(`/tasks/${t.id}/blockers`, { method: 'POST', body: { body: fd.get('body') } });
        await loadTasks();
        render();
        toast('Your admin can now see this.');
      },
    });
  }

  async function removeTask(t) {
    if (!confirm(`Delete "${t.title}"? This cannot be undone.`)) return;
    try {
      await api('/tasks/' + t.id, { method: 'DELETE' });
      await loadTasks();
      render();
      toast('Task deleted.');
    } catch (e) {
      toast(e.message);
    }
  }

  /* ---------- dialogs ---------- */

  function priorityField(value = 0) {
    return h(
      'label',
      { class: 'field' },
      h('span', null, 'Priority'),
      h(
        'select',
        { name: 'priority', value: String(value) },
        h('option', { value: '0' }, 'No priority'),
        h('option', { value: '1' }, '1st priority – do first (ASAP)'),
        h('option', { value: '2' }, '2nd priority'),
        h('option', { value: '3' }, '3rd priority')
      ),
      h('small', null, 'Shown as a coloured tag, and priority tasks are pinned to the top of the list.')
    );
  }

  const fmtHm = (hhmm) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };
  const scheduleText = (r) =>
    (r.repeat === 'daily' ? 'Every day' : r.repeat === 'weekdays' ? 'Every weekday (Mon–Fri)' : `Every ${DAYS[r.weekday]}`) + (r.due_time ? ` · due by ${fmtHm(r.due_time)}` : '');

  // "Repeat" selector with the extra day / time fields it needs.
  function scheduleFields(initial = {}, onToggle = () => {}) {
    const repeatSel = h(
      'select',
      { name: 'repeat', value: initial.repeat || '' },
      h('option', { value: '' }, 'Does not repeat'),
      h('option', { value: 'daily' }, 'Every day'),
      h('option', { value: 'weekdays' }, 'Every weekday (Mon–Fri)'),
      h('option', { value: 'weekly' }, 'Every week')
    );
    const dayLabel = h(
      'label',
      { class: 'field', hidden: initial.repeat !== 'weekly' },
      h('span', null, 'On'),
      h('select', { name: 'weekday', value: String(initial.weekday ?? 1) }, DAYS.map((d, i) => h('option', { value: String(i) }, d)))
    );
    const timeLabel = h(
      'label',
      { class: 'field', hidden: !initial.repeat },
      h('span', null, 'Due by (optional)'),
      h('input', { type: 'time', name: 'due_time', value: initial.due_time || '' }),
      h('small', null, `Each copy is due at this time on the day it appears${state.tz ? ` (${state.tz} time)` : ''}.`)
    );
    repeatSel.addEventListener('change', () => {
      dayLabel.hidden = repeatSel.value !== 'weekly';
      timeLabel.hidden = !repeatSel.value;
      onToggle(!!repeatSel.value);
    });
    const repeatLabel = h('label', { class: 'field' }, h('span', null, 'Repeat'), repeatSel, h('small', null, 'A repeating task appears in the person\'s list automatically each time it is due.'));
    return [repeatLabel, dayLabel, timeLabel];
  }

  function formDialog({ title, fields, submit, onSubmit }) {
    const err = h('p', { class: 'form-error', role: 'alert' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, submit);
    const dlg = h('dialog', { class: 'dlg' });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        try {
          const after = await onSubmit(new FormData(form));
          dlg.close();
          if (typeof after === 'function') after();
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      },
    });
    form.append(
      h('h2', null, title),
      ...fields,
      err,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), btn)
    );
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  function infoDialog({ title, intro, body, closeLabel = 'Close' }) {
    const dlg = h('dialog', { class: 'dlg' });
    dlg.append(
      h(
        'div',
        { class: 'dlg-body' },
        h('h2', null, title),
        intro ? h('p', { class: 'hint' }, intro) : null,
        body,
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close() }, closeLabel))
      )
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // Shown right after assigning: one WhatsApp button per person.
  function notifyDialog(ids, task) {
    const people = ids.map((id) => state.users.find((u) => u.id === id)).filter(Boolean);
    const missing = people.some((p) => !p.phone);
    infoDialog({
      title: 'Task assigned',
      intro: 'Tell them on WhatsApp so they see it right away. WhatsApp opens with the message ready, and you just press send.',
      body: h(
        'div',
        null,
        h(
          'ul',
          { class: 'notify-list' },
          people.map((p) =>
            h('li', null, avatar(p.name, p), h('div', { class: 'grow' }, h('strong', null, p.name), h('small', null, p.team || 'No team')), waButton(p, task, 'new'))
          )
        ),
        missing ? h('p', { class: 'hint' }, 'Add missing numbers under People → Edit.') : null
      ),
      closeLabel: 'Done',
    });
  }

  function taskDialog(task, opts = {}) {
    const editing = !!task;
    // A "personal" task is an admin's own to-do: no assignee, private to that admin.
    const personal = task ? task.assignee_id === state.user.id : state.view === 'mine';
    const members = state.users.filter((u) => u.role === 'member' && (u.active || (task && u.id === task.assignee_id)));

    let assigneeField = null;
    if (!personal) {
      if (editing) {
        assigneeField = h(
          'label',
          { class: 'field' },
          h('span', null, 'Assigned to'),
          h('select', { name: 'assignee', value: String(task.assignee_id) }, members.map((u) => h('option', { value: String(u.id) }, u.name + (u.team ? ` (${u.team})` : ''))))
        );
      } else if (!members.length) {
        assigneeField = h('p', { class: 'hint' }, 'There are no members yet. Add people under People first.');
      } else {
        const byTeam = new Map();
        for (const u of members) {
          const key = u.team || 'No team';
          if (!byTeam.has(key)) byTeam.set(key, []);
          byTeam.get(key).push(u);
        }
        const groups = [...byTeam.entries()].map(([team, list]) => {
          const boxes = list.map((u) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', name: 'assignee', value: String(u.id) }), u.name));
          const toggleAll = h(
            'button',
            {
              type: 'button',
              class: 'link',
              onclick: (e) => {
                const inputs = e.target.closest('fieldset').querySelectorAll('input[type=checkbox]');
                const allOn = [...inputs].every((i) => i.checked);
                inputs.forEach((i) => (i.checked = !allOn));
              },
            },
            'Select team'
          );
          return h('fieldset', null, h('div', { class: 'team-head' }, h('legend', null, team), toggleAll), boxes);
        });
        assigneeField = h('div', { class: 'field' }, h('span', null, 'Assign to'), h('div', { class: 'people-pick' }, groups), h('small', null, 'Each person you pick gets their own copy of the task.'));
      }
    }

    const deadlineLabel = h(
      'label',
      { class: 'field', hidden: !!opts.repeating },
      h('span', null, 'Deadline'),
      h('input', { type: 'datetime-local', name: 'deadline', value: task && task.deadline ? toLocalInput(task.deadline) : '' }),
      h('small', null, 'Leave empty for no deadline.')
    );
    const repeatFields = !personal && !editing ? scheduleFields({ repeat: opts.repeating ? 'daily' : '' }, (rep) => { deadlineLabel.hidden = rep; }) : [];

    formDialog({
      title: opts.repeating ? 'Add a repeating task' : personal ? (editing ? 'Edit your task' : 'Add a task for yourself') : editing ? 'Edit task' : 'Assign a task',
      submit: opts.repeating ? 'Schedule task' : editing ? 'Save changes' : personal ? 'Add task' : 'Assign task',
      fields: [
        h('label', { class: 'field' }, h('span', null, 'Title'), h('input', { type: 'text', name: 'title', required: true, maxlength: 200, value: task ? task.title : '' })),
        h('label', { class: 'field' }, h('span', null, 'Details (optional)'), h('textarea', { name: 'description', maxlength: 2000 }, task ? task.description : '')),
        deadlineLabel,
        ...repeatFields,
        priorityField(task ? task.priority : 0),
        assigneeField,
      ],
      onSubmit: async (fd) => {
        const deadline = fd.get('deadline');
        const body = {
          title: fd.get('title'),
          description: fd.get('description'),
          deadline: deadline ? new Date(deadline).toISOString() : null,
          priority: Number(fd.get('priority')) || 0,
        };
        let after = null;
        if (personal) {
          if (editing) await api('/tasks/' + task.id, { method: 'PUT', body });
          else await api('/tasks/mine', { method: 'POST', body });
        } else if (editing) {
          body.assignee_id = Number(fd.get('assignee'));
          await api('/tasks/' + task.id, { method: 'PUT', body });
        } else {
          body.assignee_ids = fd.getAll('assignee').map(Number);
          if (!body.assignee_ids.length) throw new Error('Pick at least one person.');
          if (fd.get('repeat')) {
            await api('/recurring', {
              method: 'POST',
              body: {
                title: body.title,
                description: body.description,
                priority: body.priority,
                repeat: fd.get('repeat'),
                weekday: Number(fd.get('weekday')),
                due_time: fd.get('due_time') || null,
                assignee_ids: body.assignee_ids,
              },
            });
            await Promise.all([loadRecurring(), loadTasks()]);
            render();
            toast('Repeating task scheduled.');
            return null;
          }
          await api('/tasks', { method: 'POST', body });
          const ids = body.assignee_ids;
          const info = { title: body.title, description: body.description, deadline: body.deadline, priority: body.priority };
          after = () => notifyDialog(ids, info);
        }
        await loadTasks();
        if (state.view === 'all') await loadUsers();
        render();
        toast(editing ? 'Task updated.' : personal ? 'Task added.' : 'Task assigned.');
        return after;
      },
    });
  }

  function personDialog(person) {
    const editing = !!person;
    const startRole = person ? person.role : 'member';

    // Admins have no team and are never assigned tasks, so these fields hide for them.
    const teamField = h(
      'label',
      { class: 'field', hidden: startRole === 'admin' },
      h('span', null, 'Team'),
      h(
        'select',
        { name: 'team', value: person ? person.team : '' },
        h('option', { value: '' }, 'No team'),
        state.teams.map((t) => h('option', { value: t.name }, t.name))
      ),
      state.teams.length ? null : h('small', null, 'No teams yet. Add some under the Teams tab.')
    );
    const phoneField = h(
      'label',
      { class: 'field', hidden: startRole === 'admin' },
      h('span', null, 'WhatsApp number (optional)'),
      h('input', { type: 'tel', name: 'phone', inputmode: 'tel', autocomplete: 'off', placeholder: '+91 98765 43210', value: person && person.phone ? '+' + person.phone : '' }),
      h('small', null, 'Include the country code. Used for the WhatsApp message button.')
    );

    formDialog({
      title: editing ? `Edit ${person.name}` : 'Add a person',
      submit: editing ? 'Save changes' : 'Add person',
      fields: [
        editing
          ? h('p', { class: 'hint' }, `Username: ${person.username}`)
          : field('Username', 'username', 'text', { required: true, autocapitalize: 'none', autocomplete: 'off' }, 'Letters, numbers, dot, dash or underscore.'),
        h('label', { class: 'field' }, h('span', null, 'Full name'), h('input', { type: 'text', name: 'name', required: true, maxlength: 80, value: person ? person.name : '' })),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Access'),
          h(
            'select',
            {
              name: 'role',
              value: startRole,
              onchange: (e) => {
                const isAdmin = e.target.value === 'admin';
                teamField.hidden = isAdmin;
                phoneField.hidden = isAdmin;
              },
            },
            h('option', { value: 'member' }, 'Member – sees own tasks'),
            h('option', { value: 'admin' }, 'Admin – manages everyone')
          )
        ),
        teamField,
        phoneField,
        h(
          'label',
          { class: 'field' },
          h('span', null, editing ? 'New password' : 'Password'),
          h('input', { type: 'password', name: 'password', minlength: 8, autocomplete: 'new-password', required: !editing }),
          h('small', null, editing ? 'Leave blank to keep the current password. Setting one signs them out everywhere.' : 'At least 8 characters. Share it with them privately.')
        ),
      ],
      onSubmit: async (fd) => {
        const role = fd.get('role');
        const team = role === 'admin' ? '' : fd.get('team');
        const phone = role === 'admin' ? '' : fd.get('phone');
        if (editing) {
          const body = { name: fd.get('name'), team, role, phone };
          if (fd.get('password')) body.password = fd.get('password');
          await api('/users/' + person.id, { method: 'PATCH', body });
        } else {
          await api('/users', { method: 'POST', body: { username: fd.get('username'), name: fd.get('name'), team, role, phone, password: fd.get('password') } });
        }
        await Promise.all([loadUsers(), loadTeams()]);
        render();
        toast(editing ? 'Changes saved.' : 'Person added.');
      },
    });
  }

  function passwordDialog() {
    formDialog({
      title: 'Change your password',
      submit: 'Change password',
      fields: [
        field('Current password', 'current', 'password', { required: true, autocomplete: 'current-password' }),
        field('New password', 'next', 'password', { required: true, minlength: 8, autocomplete: 'new-password' }, 'At least 8 characters.'),
      ],
      onSubmit: async (fd) => {
        await api('/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } });
        toast('Password changed.');
      },
    });
  }

  /* ---------- people ---------- */

  async function setActive(u, active) {
    if (!active && !confirm(`Deactivate ${u.name}? They will be signed out and cannot sign in until you reactivate them. Their tasks are kept.`)) return;
    try {
      await api('/users/' + u.id, { method: 'PATCH', body: { active } });
      await loadUsers();
      render();
      toast(active ? `${u.name} can sign in again.` : `${u.name} has been deactivated.`);
    } catch (e) {
      toast(e.message);
    }
  }

  async function removePerson(u) {
    const ok = confirm(
      `Delete ${u.name} permanently?\n\nTheir account and every task assigned to them will be removed. This cannot be undone.\n\nTo keep their task history, use Deactivate instead.`
    );
    if (!ok) return;
    try {
      await api('/users/' + u.id, { method: 'DELETE' });
      await Promise.all([loadUsers(), loadTeams()]);
      render();
      toast(`${u.name} was deleted.`);
    } catch (e) {
      toast(e.message);
    }
  }

  function peopleView() {
    const cards = state.users.map((u) => {
      const self = u.id === state.user.id;
      const workload = !u.active
        ? 'Deactivated'
        : u.role === 'admin'
        ? 'Manages everyone'
        : u.todo_tasks || u.progress_tasks
        ? `${u.todo_tasks} to do · ${u.progress_tasks} in progress`
        : 'No open tasks';
      return h(
        'li',
        { class: 'card' + (u.active ? '' : ' off') },
        h(
          'div',
          { class: 'card-top' },
          avatar(u.name, u),
          h('div', null, h('strong', null, u.name, self ? h('span', { class: 'you' }, ' (you)') : null), h('small', null, '@' + u.username))
        ),
        h(
          'div',
          { class: 'chips' },
          h('span', { class: 'badge' + (u.role === 'admin' ? ' admin' : '') }, u.role === 'admin' ? 'Admin' : 'Member'),
          u.role === 'member' ? h('span', { class: 'badge' }, u.team || 'No team') : null
        ),
        h(
          'div',
          { class: 'meta' },
          h('span', null, workload),
          u.role === 'member' ? h('span', null, u.phone ? `WhatsApp: +${u.phone}` : 'No WhatsApp number') : null
        ),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'link', type: 'button', onclick: () => personDialog(u) }, 'Edit'),
          u.avatar_v && !self ? h('button', { class: 'link', type: 'button', onclick: () => removePhoto(u) }, 'Remove photo') : null,
          self ? null : h('button', { class: 'link', type: 'button', onclick: () => setActive(u, !u.active) }, u.active ? 'Deactivate' : 'Reactivate'),
          self ? null : h('button', { class: 'link danger', type: 'button', onclick: () => removePerson(u) }, 'Delete')
        )
      );
    });
    return h(
      'main',
      { class: 'page' },
      h(
        'div',
        { class: 'page-head' },
        h('div', null, h('h1', null, 'People'), h('p', { class: 'summary' }, plural(state.users.filter((u) => u.active).length, 'active account'))),
        h('button', { class: 'btn primary', type: 'button', onclick: () => personDialog() }, icon('plus', 18), 'Add person')
      ),
      h('ul', { class: 'cards' }, stagger(cards))
    );
  }

  /* ---------- repeating tasks (admins) ---------- */

  function recurringDialog(r) {
    const members = state.users.filter((u) => u.role === 'member' && (u.active || u.id === r.assignee_id));
    formDialog({
      title: 'Edit repeating task',
      submit: 'Save changes',
      fields: [
        h('label', { class: 'field' }, h('span', null, 'Title'), h('input', { type: 'text', name: 'title', required: true, maxlength: 200, value: r.title })),
        h('label', { class: 'field' }, h('span', null, 'Details (optional)'), h('textarea', { name: 'description', maxlength: 2000 }, r.description)),
        ...scheduleFields({ repeat: r.repeat, weekday: r.weekday, due_time: r.due_time }),
        priorityField(r.priority),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Assigned to'),
          h('select', { name: 'assignee', value: String(r.assignee_id) }, members.map((u) => h('option', { value: String(u.id) }, u.name + (u.team ? ` (${u.team})` : ''))))
        ),
      ],
      onSubmit: async (fd) => {
        if (!fd.get('repeat')) throw new Error('Pick how often it repeats, or delete the schedule.');
        await api('/recurring/' + r.id, {
          method: 'PATCH',
          body: {
            title: fd.get('title'),
            description: fd.get('description'),
            repeat: fd.get('repeat'),
            weekday: Number(fd.get('weekday')),
            due_time: fd.get('due_time') || null,
            priority: Number(fd.get('priority')) || 0,
            assignee_id: Number(fd.get('assignee')),
          },
        });
        await loadRecurring();
        render();
        toast('Schedule updated. Changes apply from the next copy.');
      },
    });
  }

  async function toggleRecurring(r) {
    try {
      await api('/recurring/' + r.id, { method: 'PATCH', body: { active: !r.active } });
      await loadRecurring();
      render();
      toast(r.active ? 'Paused. No new copies will be created.' : 'Resumed.');
    } catch (e) {
      toast(e.message);
    }
  }

  async function removeRecurring(r) {
    if (!confirm(`Delete the repeating task "${r.title}"?\n\nCopies already created stay in the task list; no new ones will be made.`)) return;
    try {
      await api('/recurring/' + r.id, { method: 'DELETE' });
      await loadRecurring();
      render();
      toast('Schedule deleted.');
    } catch (e) {
      toast(e.message);
    }
  }

  function recurringView() {
    const cards = state.recurring.map((r) => {
      const person = state.users.find((u) => u.id === r.assignee_id);
      return h(
        'li',
        { class: 'card' + (r.active ? '' : ' off') },
        h('div', { class: 'card-top' }, avatar(r.assignee_name, person), h('div', null, h('strong', null, r.title), h('small', null, r.assignee_name + (r.assignee_team ? ` · ${r.assignee_team}` : '')))),
        h(
          'div',
          { class: 'chips' },
          h('span', { class: 'chip repeat' }, icon('repeat', 13), scheduleText(r)),
          r.priority ? h('span', { class: `chip prio p${r.priority}` }, icon('zap', 13), PRIO_LABEL[r.priority]) : null,
          r.active ? null : h('span', { class: 'chip' }, 'Paused')
        ),
        r.description ? h('p', { class: 'desc' }, r.description) : null,
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'link', type: 'button', onclick: () => recurringDialog(r) }, 'Edit'),
          h('button', { class: 'link', type: 'button', onclick: () => toggleRecurring(r) }, r.active ? 'Pause' : 'Resume'),
          h('button', { class: 'link danger', type: 'button', onclick: () => removeRecurring(r) }, 'Delete')
        )
      );
    });
    return h(
      'main',
      { class: 'page' },
      h(
        'div',
        { class: 'page-head' },
        h('div', null, h('h1', null, 'Repeating tasks'), h('p', { class: 'summary' }, `${plural(state.recurring.filter((r) => r.active).length, 'active schedule')}${state.tz ? ` · ${state.tz} time` : ''}`)),
        h('button', { class: 'btn primary', type: 'button', onclick: () => taskDialog(null, { repeating: true }) }, icon('plus', 18), 'Add repeating task')
      ),
      cards.length ? h('ul', { class: 'cards' }, stagger(cards)) : emptyState('No repeating tasks yet. Add one and it will appear in the person\'s list every day (or week) automatically.')
    );
  }

  /* ---------- sheets and materials ---------- */

  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

  // Recognises common spreadsheet / document links so each one gets a clear badge.
  function linkKind(url) {
    let u;
    try { u = new URL(url); } catch { return { key: 'link', label: 'Link', ic: 'link' }; }
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.toLowerCase();
    if (host === 'docs.google.com' && path.startsWith('/spreadsheets')) return { key: 'sheets', label: 'Google Sheet', ic: 'grid' };
    if (host === 'docs.google.com' && path.startsWith('/document')) return { key: 'docs', label: 'Google Doc', ic: 'file' };
    if (host === 'docs.google.com' && path.startsWith('/presentation')) return { key: 'slides', label: 'Google Slides', ic: 'file' };
    if (host === 'drive.google.com') return { key: 'drive', label: 'Google Drive', ic: 'folder' };
    if (/\.(xlsx|xlsm|xlsb|xls|csv)$/.test(path) || path.includes('/:x:/') || /excel/.test(u.href.toLowerCase())) return { key: 'excel', label: 'Excel', ic: 'grid' };
    if (/sharepoint\.com$|onedrive\.live\.com$|1drv\.ms$/.test(host)) return { key: 'drive', label: 'OneDrive / SharePoint', ic: 'folder' };
    if (/notion\.(so|site)$/.test(host)) return { key: 'docs', label: 'Notion', ic: 'file' };
    if (/airtable\.com$/.test(host)) return { key: 'sheets', label: 'Airtable', ic: 'grid' };
    return { key: 'link', label: host, ic: 'link' };
  }

  function resourceDialog(r) {
    const editing = !!r;
    const cats = [...new Set(['Reports', 'Templates', 'Reference', ...state.resources.map((x) => x.category).filter(Boolean)])];
    formDialog({
      title: editing ? 'Edit saved link' : 'Save a sheet or link',
      submit: editing ? 'Save changes' : 'Save',
      fields: [
        h('label', { class: 'field' }, h('span', null, 'Link'), h('input', { type: 'text', name: 'url', required: true, inputmode: 'url', autocapitalize: 'none', autocomplete: 'off', placeholder: 'Paste the sheet or file link', value: r ? r.url : '' })),
        h('label', { class: 'field' }, h('span', null, 'Name (optional)'), h('input', { type: 'text', name: 'title', maxlength: 120, placeholder: 'e.g. Weekly content calendar', value: r ? r.title : '' })),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Group (optional)'),
          h('input', { type: 'text', name: 'category', list: 'cat-list', maxlength: 40, placeholder: 'e.g. Reports', value: r ? r.category : '' }),
          h('datalist', { id: 'cat-list' }, cats.map((c) => h('option', { value: c }))),
          h('small', null, 'Groups let you filter your list quickly.')
        ),
        h('label', { class: 'field' }, h('span', null, 'Note (optional)'), h('textarea', { name: 'note', maxlength: 300, placeholder: 'What is it for? Which tab or sheet to open?' }, r ? r.note : '')),
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', name: 'pinned', checked: !!(r && r.pinned) }), 'Pin to the top'),
      ],
      onSubmit: async (fd) => {
        const body = { url: fd.get('url'), title: fd.get('title'), category: fd.get('category'), note: fd.get('note'), pinned: fd.get('pinned') === 'on' };
        if (editing) await api('/resources/' + r.id, { method: 'PATCH', body });
        else await api('/resources', { method: 'POST', body });
        await loadResources();
        render();
        toast(editing ? 'Saved.' : 'Link saved.');
      },
    });
  }

  async function togglePin(r) {
    try {
      await api('/resources/' + r.id, { method: 'PATCH', body: { pinned: !r.pinned } });
      await loadResources();
      render();
    } catch (e) {
      toast(e.message);
    }
  }

  async function copyLink(r) {
    try {
      await navigator.clipboard.writeText(r.url);
      toast('Link copied.');
    } catch {
      toast('Could not copy. Long-press the link to copy it.');
    }
  }

  async function removeResource(r) {
    if (!confirm(`Remove "${r.title}" from your saved links? The sheet itself is not affected.`)) return;
    try {
      await api('/resources/' + r.id, { method: 'DELETE' });
      await loadResources();
      render();
      toast('Removed.');
    } catch (e) {
      toast(e.message);
    }
  }

  function resourceCard(r, i) {
    const kind = linkKind(r.url);
    const li = h(
      'li',
      { class: 'res' },
      h(
        'a',
        { class: 'res-main', href: r.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${r.title}` },
        h('span', { class: 'res-badge k-' + kind.key }, icon(kind.ic, 22)),
        h(
          'span',
          { class: 'res-text' },
          h('strong', null, r.title),
          h('small', null, kind.key === 'link' ? kind.label : `${kind.label} · ${hostOf(r.url)}`),
          r.note ? h('span', { class: 'res-note' }, r.note) : null
        )
      ),
      h(
        'div',
        { class: 'res-foot' },
        h('div', { class: 'chips' }, r.category ? h('span', { class: 'chip' }, r.category) : null),
        h(
          'div',
          { class: 'res-actions' },
          h('button', { class: 'icon-sm star' + (r.pinned ? ' on' : ''), type: 'button', 'aria-pressed': String(r.pinned), title: r.pinned ? 'Unpin' : 'Pin to top', 'aria-label': (r.pinned ? 'Unpin ' : 'Pin ') + r.title, onclick: () => togglePin(r) }, icon('star', 18)),
          h('button', { class: 'icon-sm', type: 'button', title: 'Copy link', 'aria-label': 'Copy link to ' + r.title, onclick: () => copyLink(r) }, icon('copy', 18)),
          h('button', { class: 'link', type: 'button', onclick: () => resourceDialog(r) }, 'Edit'),
          h('button', { class: 'link danger', type: 'button', onclick: () => removeResource(r) }, 'Remove')
        )
      )
    );
    li.style.setProperty('--i', Math.min(i, 12));
    return li;
  }

  function sheetsView() {
    const items = state.resources;
    const cats = [...new Set(items.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const pinned = items.filter((r) => r.pinned).length;

    const head = h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h1', null, 'Sheets & materials'), h('p', { class: 'summary' }, `${plural(items.length, 'link')} saved · only you can see these`)),
      h('button', { class: 'btn primary', type: 'button', onclick: () => resourceDialog() }, icon('plus', 18), 'Save a link')
    );
    if (!items.length) {
      return h('main', { class: 'page' }, head, emptyState('Save the sheets and files you work with (Google Sheets, Excel online, Drive folders) and open them in one tap.'));
    }

    const listBox = h('div');
    function fill() {
      const q = state.resQuery.trim().toLowerCase();
      const list = items.filter((r) => {
        const inGroup = state.resCat === 'all' || (state.resCat === '__pinned' ? r.pinned : r.category === state.resCat);
        const hit = !q || `${r.title} ${r.note} ${r.category} ${hostOf(r.url)}`.toLowerCase().includes(q);
        return inGroup && hit;
      });
      listBox.replaceChildren(list.length ? h('ul', { class: 'res-list' }, list.map(resourceCard)) : emptyState('Nothing matches. Try a different word or group.'));
    }

    const catChip = (key, label, count) =>
      h('button', { type: 'button', class: 'cat' + (state.resCat === key ? ' on' : ''), 'aria-pressed': String(state.resCat === key), onclick: () => { state.resCat = key; render(); } }, label, h('span', { class: 'n' }, count));

    const search = h('input', {
      type: 'search',
      class: 'search',
      placeholder: 'Search your sheets…',
      'aria-label': 'Search saved links',
      autocomplete: 'off',
      value: state.resQuery,
      oninput: (e) => { state.resQuery = e.target.value; fill(); },
    });
    fill();
    return h(
      'main',
      { class: 'page' },
      head,
      search,
      h(
        'div',
        { class: 'cat-row', role: 'group', 'aria-label': 'Filter by group' },
        catChip('all', 'All', items.length),
        pinned ? catChip('__pinned', 'Pinned', pinned) : null,
        cats.map((c) => catChip(c, c, items.filter((r) => r.category === c).length))
      ),
      listBox
    );
  }

  /* ---------- teams ---------- */

  function teamDialog(team) {
    const editing = !!team;
    formDialog({
      title: editing ? 'Rename team' : 'Add a team',
      submit: editing ? 'Save name' : 'Add team',
      fields: [
        h('label', { class: 'field' }, h('span', null, 'Team name'), h('input', { type: 'text', name: 'name', required: true, maxlength: 40, value: team ? team.name : '' })),
        editing ? h('p', { class: 'hint' }, 'Everyone in this team moves to the new name automatically.') : null,
      ],
      onSubmit: async (fd) => {
        if (editing) await api('/teams/' + team.id, { method: 'PATCH', body: { name: fd.get('name') } });
        else await api('/teams', { method: 'POST', body: { name: fd.get('name') } });
        await Promise.all([loadTeams(), loadUsers()]);
        render();
        toast(editing ? 'Team renamed.' : 'Team added.');
      },
    });
  }

  async function removeTeam(team) {
    if (!confirm(`Delete the team "${team.name}"?`)) return;
    try {
      await api('/teams/' + team.id, { method: 'DELETE' });
      await loadTeams();
      render();
      toast('Team deleted.');
    } catch (e) {
      toast(e.message);
    }
  }

  function teamsView() {
    const content = state.teams.length
      ? h(
          'ul',
          { class: 'cards' },
          state.teams.map((t) =>
            h(
              'li',
              { class: 'card' },
              h('div', { class: 'card-top' }, avatar(t.name), h('div', null, h('strong', null, t.name), h('small', null, plural(t.members, 'member')))),
              h(
                'div',
                { class: 'row-actions' },
                h('button', { class: 'link', type: 'button', onclick: () => teamDialog(t) }, 'Rename'),
                h('button', { class: 'link danger', type: 'button', onclick: () => removeTeam(t) }, 'Delete')
              )
            )
          )
        )
      : emptyState('No teams yet. Add one, then put people in it from the People tab.');

    return h(
      'main',
      { class: 'page' },
      h(
        'div',
        { class: 'page-head' },
        h('div', null, h('h1', null, 'Teams'), h('p', { class: 'summary' }, 'Admins are not part of any team.')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => teamDialog() }, icon('plus', 18), 'Add team')
      ),
      content
    );
  }

  /* ---------- session ---------- */

  async function logout() {
    try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.user = null;
    state.tasks = [];
    state.users = [];
    state.recurring = [];
    state.resources = [];
    state.animate = true;
    stopLive();
    closeMenus();
    render();
  }

  function render() {
    animating = state.animate;
    state.animate = false;
    root.classList.toggle('animate-in', animating);
    root.replaceChildren();
    if (state.loading) root.append(h('p', { class: 'boot' }, 'Loading…'));
    else if (state.needsSetup) root.append(setupScreen());
    else if (!state.user) root.append(loginScreen());
    else root.append(shell());
  }

  async function boot() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { live.hiddenAt = Date.now(); return; }
      if (!state.user || !live.wanted) return;
      // A connection that sat in the background for a while may be dead without knowing it.
      if (live.ws && Date.now() - live.hiddenAt > 60000) { live.catchUp = true; try { live.ws.close(); } catch { /* ignore */ } }
      else if (!live.ws) { live.retry = 0; reconnectLive(); }
      else if (live.dirty) liveRefresh();
    });
    document.body.append(photoInput);
    document.addEventListener('click', closeMenus);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
    try {
      const r = await api('/me');
      state.user = r.user;
      state.tz = r.tz || '';
      state.needsSetup = !!r.needsSetup;
      state.loading = false;
      if (state.user) await enter();
      else render();
    } catch {
      state.loading = false;
      root.replaceChildren(h('p', { class: 'boot' }, 'Could not reach the server. Refresh to try again.'));
    }
  }

  boot();
})();
