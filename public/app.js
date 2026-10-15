(() => {
  'use strict';

  const ORG = 'Team Tasks'; // change to your organisation's name
  const DAY = 864e5;

  const root = document.getElementById('app');
  const state = {
    loading: true,
    needsSetup: false,
    user: null,
    view: 'mine', // mine | all | people | teams
    tasks: [],
    users: [],
    teams: [],
    status: 'pending', // pending | in_progress | done (which list is showing)
    person: 'all',
    team: 'all',
    flag: 'all', // all | priority | blocked (admin All tasks filter)
    animate: true, // play entrance animations on the next render only
  };
  let animating = false;

  const STATUSES = [
    ['pending', 'To do'],
    ['in_progress', 'In progress'],
    ['done', 'Done'],
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES);

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
  const avatar = (name) => h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name));

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
    ['priority', 'Priority – do these first'],
    ['overdue', 'Overdue'],
    ['today', 'Today'],
    ['week', 'Next 7 days'],
    ['later', 'Later'],
    ['none', 'No deadline'],
  ];

  /* ---------- WhatsApp (click-to-send via the admin's own WhatsApp) ---------- */

  function waText(person, task, kind) {
    const first = person.name.trim().split(/\s+/)[0];
    const flag = task.priority ? '🔥 *PRIORITY* – needs to be done ASAP.\n' : '';
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
  }

  async function go(view) {
    state.view = view;
    state.person = 'all';
    state.team = 'all';
    state.flag = 'all';
    state.animate = true;
    try {
      if (view === 'people' || view === 'teams') await Promise.all([loadUsers(), loadTeams()]);
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

  /* ---------- sign-in screens ---------- */

  function field(label, name, type = 'text', attrs = {}, hint) {
    return h('label', { class: 'field' }, h('span', null, label), h('input', { name, type, ...attrs }), hint ? h('small', null, hint) : null);
  }

  function authDeco() {
    return h(
      'div',
      { class: 'deco', 'aria-hidden': 'true' },
      h('span', { class: 'deco-chip d1' }, h('i', { class: 'dot' }), 'To do'),
      h('span', { class: 'deco-chip d2' }, h('i', { class: 'dot blue' }), 'In progress'),
      h('span', { class: 'deco-chip d3' }, h('i', { class: 'dot green' }), 'Done'),
      h('span', { class: 'deco-chip d4 hot' }, icon('zap', 14), 'Priority')
    );
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
    return h('main', { class: 'auth' }, authDeco(), themeButton('floating'), form);
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
    return h('main', { class: 'auth' }, authDeco(), themeButton('floating'), form);
  }

  /* ---------- shell: header, account menu, navigation ---------- */

  function closeMenus() {
    document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    document.querySelectorAll('.avatar-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

  function accountMenu() {
    const u = state.user;
    const sub = u.role === 'admin' ? 'Admin' : u.team || 'Member';
    const menu = h(
      'div',
      { class: 'menu', hidden: true },
      h('div', { class: 'menu-who' }, h('strong', null, u.name), h('span', null, `@${u.username} · ${sub}`)),
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
      initials(u.name)
    );
    return h('div', { class: 'account' }, btn, menu);
  }

  function shell() {
    const admin = state.user.role === 'admin';
    const tabs = [['mine', 'My tasks', 'tasks']];
    if (admin) tabs.push(['all', 'All tasks', 'layers'], ['people', 'People', 'users'], ['teams', 'Teams', 'tag']);

    const nav = admin
      ? h(
          'nav',
          { class: 'tabs', 'aria-label': 'Sections' },
          tabs.map(([key, label, ic]) =>
            h(
              'button',
              { class: 'tab' + (state.view === key ? ' on' : ''), type: 'button', 'aria-current': state.view === key ? 'page' : null, onclick: () => go(key) },
              icon(ic, 20),
              h('span', null, label)
            )
          )
        )
      : null;

    const header = h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, logoMark(), h('span', null, ORG)),
      nav,
      h('div', { class: 'top-right' }, themeButton(), accountMenu())
    );

    const page = state.view === 'people' ? peopleView() : state.view === 'teams' ? teamsView() : taskView(state.view === 'all');
    if (admin) page.classList.add('has-nav');
    return h('div', null, header, page);
  }

  /* ---------- tasks ---------- */

  const blockersOf = (t) => t.blockers || [];
  const groupOf = (t) => (t.priority ? 'priority' : dueInfo(t).group);

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
            h('option', { value: 'priority' }, 'Priority only'),
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
            h('h2', null, key === 'priority' ? icon('zap', 16) : null, label, h('span', { class: 'count' }, items.length)),
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
      t.priority && open ? h('span', { class: 'chip prio' }, icon('zap', 13), 'Priority') : null,
      dueChip,
      blockers.length ? h('span', { class: 'chip blocked' }, icon('alert', 13), 'Blocked') : null,
      all ? h('span', { class: 'chip person' }, avatar(t.assignee_name), t.assignee_name + (t.assignee_team ? ` · ${t.assignee_team}` : '')) : null
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
      { class: `task is-${t.status} tone-${d.tone}` + (t.priority && open ? ' is-priority' : '') + (blockers.length ? ' is-blocked' : '') },
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
            h('li', null, avatar(p.name), h('div', { class: 'grow' }, h('strong', null, p.name), h('small', null, p.team || 'No team')), waButton(p, task, 'new'))
          )
        ),
        missing ? h('p', { class: 'hint' }, 'Add missing numbers under People → Edit.') : null
      ),
      closeLabel: 'Done',
    });
  }

  function taskDialog(task) {
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

    formDialog({
      title: personal ? (editing ? 'Edit your task' : 'Add a task for yourself') : editing ? 'Edit task' : 'Assign a task',
      submit: editing ? 'Save changes' : personal ? 'Add task' : 'Assign task',
      fields: [
        h('label', { class: 'field' }, h('span', null, 'Title'), h('input', { type: 'text', name: 'title', required: true, maxlength: 200, value: task ? task.title : '' })),
        h('label', { class: 'field' }, h('span', null, 'Details (optional)'), h('textarea', { name: 'description', maxlength: 2000 }, task ? task.description : '')),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Deadline'),
          h('input', { type: 'datetime-local', name: 'deadline', value: task && task.deadline ? toLocalInput(task.deadline) : '' }),
          h('small', null, 'Leave empty for no deadline.')
        ),
        h(
          'label',
          { class: 'check-row prio-check' },
          h('input', { type: 'checkbox', name: 'priority', checked: !!(task && task.priority) }),
          icon('zap', 16),
          'Priority – needs to be done ASAP'
        ),
        assigneeField,
      ],
      onSubmit: async (fd) => {
        const deadline = fd.get('deadline');
        const body = {
          title: fd.get('title'),
          description: fd.get('description'),
          deadline: deadline ? new Date(deadline).toISOString() : null,
          priority: fd.get('priority') === 'on',
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
          avatar(u.name),
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
    state.animate = true;
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
    document.addEventListener('click', closeMenus);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
    try {
      const r = await api('/me');
      state.user = r.user;
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
