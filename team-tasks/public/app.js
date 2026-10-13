(() => {
  'use strict';

  const DEFAULT_ORG = 'Team Tasks'; // shown until an admin sets a name in Settings
  const DAY = 864e5;

  const root = document.getElementById('app');
  const iconLink = document.querySelector('link[rel="icon"]');
  const defaultIcon = iconLink ? iconLink.getAttribute('href') : null;
  const state = {
    loading: true,
    needsSetup: false,
    user: null,
    brand: { name: DEFAULT_ORG, logo: null },
    view: 'mine', // mine | all | people | teams | settings
    tasks: [],
    users: [],
    teams: [],
    status: 'open', // open | done
    person: 'all',
    team: 'all',
  };

  /* ---------- helpers ---------- */

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

  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fmtDate = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /* ---------- theme (day / night) ---------- */

  const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
  const themeLabel = () => (isDark() ? '☀ Day mode' : '☾ Night mode');

  function toggleTheme() {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
    // Update in place so nothing typed into a form is lost.
    document.querySelectorAll('.theme-toggle').forEach((b) => { b.textContent = themeLabel(); });
  }

  function themeButton() {
    return h('button', { class: 'link theme-toggle', type: 'button', onclick: toggleTheme }, themeLabel());
  }

  /* ---------- branding ---------- */

  function applyBrand() {
    document.title = state.brand.name;
    if (iconLink) iconLink.setAttribute('href', state.brand.logo || defaultIcon);
  }

  function brandMark() {
    return h(
      'div',
      { class: 'brand' },
      state.brand.logo ? h('img', { class: 'logo', src: state.brand.logo, alt: '' }) : null,
      h('span', null, state.brand.name)
    );
  }

  function authHeading() {
    return h(
      'div',
      { class: 'auth-brand' },
      state.brand.logo ? h('img', { class: 'logo-lg', src: state.brand.logo, alt: '' }) : null,
      h('h1', null, state.brand.name)
    );
  }

  // Resizes a chosen image to at most 256px and returns it as a small data URL.
  function fileToLogo(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a PNG, JPG or WebP image.'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Could not open that image.'));
        img.onload = () => {
          const scale = Math.min(1, 256 / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          let out = canvas.toDataURL('image/png');
          if (out.length > 250000) out = canvas.toDataURL('image/webp', 0.85);
          if (!/^data:image\/(png|jpeg|webp);base64,/.test(out) || out.length > 280000) {
            return reject(new Error('That image is too detailed. Try a simpler or smaller one.'));
          }
          resolve(out);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Works out how a task's deadline should be shown and which urgency group it belongs to.
  function dueInfo(task) {
    if (task.status === 'done') {
      const when = task.completed_at ? fmtDate(new Date(task.completed_at)) : '';
      return { group: 'done', tone: 'done', date: 'Done', rel: when };
    }
    if (!task.deadline) return { group: 'none', tone: 'none', date: 'No deadline', rel: '' };

    const due = new Date(task.deadline);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const days = Math.round((startDue - startToday) / DAY);
    const date = `${fmtDate(due)}, ${fmtTime(due)}`;

    if (due < now) {
      const late = days < 0 ? `${plural(-days, 'day')} overdue` : 'Overdue today';
      return { group: 'overdue', tone: 'late', date, rel: late };
    }
    if (days === 0) return { group: 'today', tone: 'today', date, rel: 'Due today' };
    if (days === 1) return { group: 'week', tone: 'soon', date, rel: 'Due tomorrow' };
    if (days <= 7) return { group: 'week', tone: 'soon', date, rel: `In ${days} days` };
    return { group: 'later', tone: 'none', date, rel: `In ${days} days` };
  }

  const GROUPS = [
    ['overdue', 'Overdue'],
    ['today', 'Today'],
    ['week', 'Next 7 days'],
    ['later', 'Later'],
    ['none', 'No deadline'],
  ];

  /* ---------- data loading ---------- */

  async function loadTasks() {
    const path = state.user.role === 'admin' && state.view === 'all' ? '/tasks' : '/tasks?mine=1';
    state.tasks = (await api(path)).tasks;
  }

  async function loadUsers() {
    state.users = (await api('/users')).users;
  }

  async function loadTeams() {
    state.teams = (await api('/teams')).teams;
  }

  async function enter() {
    state.view = 'mine';
    state.status = 'open';
    state.person = 'all';
    state.team = 'all';
    await loadTasks();
    if (state.user.role === 'admin') await Promise.all([loadUsers(), loadTeams()]);
    render();
  }

  async function go(view) {
    state.view = view;
    state.person = 'all';
    state.team = 'all';
    try {
      if (view === 'people') await Promise.all([loadUsers(), loadTeams()]);
      else if (view === 'teams') await loadTeams();
      else if (view === 'settings') { /* nothing to load */ }
      else {
        await loadTasks();
        if (view === 'all') await Promise.all([loadUsers(), loadTeams()]);
      }
    } catch (e) {
      toast(e.message);
    }
    render();
  }

  /* ---------- screens ---------- */

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
            await enter();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      authHeading(),
      h('p', { class: 'sub' }, 'Sign in to see your tasks.'),
      field('Username', 'username', 'text', { autocomplete: 'username', required: true, autocapitalize: 'none' }),
      field('Password', 'password', 'password', { autocomplete: 'current-password', required: true }),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')
    );
    return h('main', { class: 'auth' }, h('div', { class: 'auth-tools' }, themeButton()), form);
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
      h('h1', null, 'Create the first admin'),
      h('p', { class: 'sub' }, 'This only works once, while no accounts exist.'),
      field('Setup key', 'key', 'password', { required: true, autocomplete: 'off' }, 'The SETUP_KEY secret you set on Cloudflare.'),
      field('Your name', 'name', 'text', { required: true }),
      field('Username', 'username', 'text', { required: true, autocapitalize: 'none' }),
      field('Password', 'password', 'password', { required: true, minlength: 8, autocomplete: 'new-password' }, 'At least 8 characters.'),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Create admin account')
    );
    return h('main', { class: 'auth' }, h('div', { class: 'auth-tools' }, themeButton()), form);
  }

  function shell() {
    const u = state.user;
    const admin = u.role === 'admin';
    const tabs = [['mine', 'My tasks']];
    if (admin) tabs.push(['all', 'All tasks'], ['people', 'People'], ['teams', 'Teams'], ['settings', 'Settings']);

    const header = h(
      'header',
      { class: 'top' },
      brandMark(),
      h(
        'nav',
        { class: 'tabs', 'aria-label': 'Sections' },
        tabs.map(([key, label]) =>
          h('button', { class: 'tab' + (state.view === key ? ' on' : ''), 'aria-current': state.view === key ? 'page' : null, onclick: () => go(key) }, label)
        )
      ),
      h(
        'div',
        { class: 'who' },
        h('span', null, u.name),
        themeButton(),
        h('button', { class: 'link', onclick: passwordDialog }, 'Change password'),
        h('button', { class: 'link', onclick: logout }, 'Sign out')
      )
    );

    let body;
    if (state.view === 'people') body = peopleView();
    else if (state.view === 'teams') body = teamsView();
    else if (state.view === 'settings') body = settingsView();
    else body = taskView(state.view === 'all');
    return h('div', null, header, body);
  }

  /* ---------- tasks view ---------- */

  function taskView(all) {
    const admin = state.user.role === 'admin';
    let tasks = state.tasks.slice();
    if (all) {
      if (state.person !== 'all') tasks = tasks.filter((t) => String(t.assignee_id) === state.person);
      if (state.team !== 'all') tasks = tasks.filter((t) => t.assignee_team === state.team);
    }
    const open = tasks.filter((t) => t.status === 'pending');
    const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));
    const overdue = open.filter((t) => dueInfo(t).group === 'overdue').length;

    const title = all ? 'All tasks' : `Hi, ${state.user.name.split(' ')[0]}`;
    const head = h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('h1', null, title),
        h('p', { class: 'summary' }, plural(open.length, 'open task'), overdue ? [', ', h('span', { class: 'late' }, `${overdue} overdue`)] : null)
      ),
      all
        ? h('button', { class: 'btn primary', onclick: () => taskDialog() }, 'Assign task')
        : admin
          ? h('button', { class: 'btn primary', onclick: () => personalDialog() }, 'Add my task')
          : null
    );

    const seg = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Task status' },
      h('button', { class: state.status === 'open' ? 'on' : '', onclick: () => { state.status = 'open'; render(); } }, `Open (${open.length})`),
      h('button', { class: state.status === 'done' ? 'on' : '', onclick: () => { state.status = 'done'; render(); } }, `Done (${done.length})`)
    );

    const toolbar = h('div', { class: 'toolbar' }, seg);
    if (all) {
      const people = state.users.filter((u) => u.active && u.role === 'member');
      toolbar.append(
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
          people.map((p) => h('option', { value: String(p.id) }, p.name))
        )
      );
    }

    const emptyOpen = all
      ? 'No open tasks match these filters.'
      : admin
        ? 'Nothing on your list. Use “Add my task” to note something for yourself.'
        : 'Nothing on your list. New tasks will show up here.';

    const content = h('div', null);
    if (state.status === 'open') {
      if (!open.length) content.append(h('div', { class: 'empty' }, emptyOpen));
      for (const [key, label] of GROUPS) {
        const items = open.filter((t) => dueInfo(t).group === key);
        if (!items.length) continue;
        content.append(
          h(
            'section',
            { class: 'group g-' + key },
            h('h2', null, label, h('span', { class: 'count' }, items.length)),
            h('ul', { class: 'tasks' }, items.map((t) => taskRow(t, all)))
          )
        );
      }
    } else if (!done.length) {
      content.append(h('div', { class: 'empty' }, 'No completed tasks yet.'));
    } else {
      content.append(h('ul', { class: 'tasks' }, done.map((t) => taskRow(t, all))));
    }

    return h('main', { class: 'page' }, head, toolbar, content);
  }

  function taskRow(t, all) {
    const d = dueInfo(t);
    const done = t.status === 'done';
    // An admin's own note (assigned to themselves) can be edited or deleted from My tasks.
    const personal = !all && state.user.role === 'admin' && t.assignee_id === state.user.id && t.assigned_by === state.user.id;
    const check = h(
      'button',
      {
        class: 'check' + (done ? ' on' : ''),
        role: 'checkbox',
        'aria-checked': String(done),
        'aria-label': (done ? 'Mark as not done: ' : 'Mark as done: ') + t.title,
        onclick: () => toggle(t),
      },
      done ? '✓' : ''
    );
    return h(
      'li',
      { class: 'task tone-' + d.tone + (done ? ' done' : '') },
      h('div', { class: 'due' }, h('span', { class: 'due-date' }, d.date), h('span', { class: 'due-rel' }, d.rel)),
      check,
      h(
        'div',
        { class: 'body' },
        h('p', { class: 'title' }, t.title),
        t.description ? h('p', { class: 'desc' }, t.description) : null,
        all ? h('p', { class: 'meta' }, t.assignee_name + (t.assignee_team ? ` · ${t.assignee_team}` : '')) : null
      ),
      all || personal
        ? h(
            'div',
            { class: 'actions' },
            h('button', { class: 'link', onclick: () => (personal ? personalDialog(t) : taskDialog(t)) }, 'Edit'),
            h('button', { class: 'link danger', onclick: () => removeTask(t) }, 'Delete')
          )
        : null
    );
  }

  async function toggle(t) {
    const next = t.status === 'done' ? 'pending' : 'done';
    try {
      const r = await api('/tasks/' + t.id, { method: 'PATCH', body: { status: next } });
      t.status = r.task.status;
      t.completed_at = r.task.completed_at;
      render();
    } catch (e) {
      toast(e.message);
    }
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
          await onSubmit(new FormData(form));
          dlg.close();
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

  const titleField = (value) =>
    h('label', { class: 'field' }, h('span', null, 'Title'), h('input', { type: 'text', name: 'title', required: true, maxlength: 200, value: value || '' }));
  const detailsField = (value) =>
    h('label', { class: 'field' }, h('span', null, 'Details (optional)'), h('textarea', { name: 'description', maxlength: 2000 }, value || ''));
  const deadlineField = (iso) =>
    h(
      'label',
      { class: 'field' },
      h('span', null, 'Deadline'),
      h('input', { type: 'datetime-local', name: 'deadline', value: iso ? toLocalInput(iso) : '' }),
      h('small', null, 'Leave empty for no deadline.')
    );
  const deadlineValue = (fd) => (fd.get('deadline') ? new Date(fd.get('deadline')).toISOString() : null);

  // Assign a task to team members, or edit an assigned task. Admins never appear in the list.
  function taskDialog(task) {
    const editing = !!task;
    const members = state.users.filter((u) => u.active && u.role === 'member');

    let assigneeField;
    if (editing) {
      const options = members.map((u) => ({ id: u.id, label: u.name + (u.team ? ` (${u.team})` : '') }));
      if (!members.some((u) => u.id === task.assignee_id)) {
        options.push({ id: task.assignee_id, label: `${task.assignee_name} – not active` });
      }
      assigneeField = h(
        'label',
        { class: 'field' },
        h('span', null, 'Assigned to'),
        h('select', { name: 'assignee', value: String(task.assignee_id) }, options.map((o) => h('option', { value: String(o.id) }, o.label)))
      );
    } else if (!members.length) {
      assigneeField = h('p', { class: 'hint' }, 'There are no team members yet. Add people in the People tab first.');
    } else {
      const byTeam = new Map();
      for (const u of members) {
        const key = u.team || 'No team';
        if (!byTeam.has(key)) byTeam.set(key, []);
        byTeam.get(key).push(u);
      }
      const groups = [...byTeam.entries()].map(([team, list]) => {
        const boxes = list.map((u) =>
          h('label', { class: 'check-row' }, h('input', { type: 'checkbox', name: 'assignee', value: String(u.id) }), u.name)
        );
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

    formDialog({
      title: editing ? 'Edit task' : 'Assign a task',
      submit: editing ? 'Save changes' : 'Assign task',
      fields: [titleField(task && task.title), detailsField(task && task.description), deadlineField(task && task.deadline), assigneeField],
      onSubmit: async (fd) => {
        const body = { title: fd.get('title'), description: fd.get('description'), deadline: deadlineValue(fd) };
        if (editing) {
          body.assignee_id = Number(fd.get('assignee'));
          await api('/tasks/' + task.id, { method: 'PUT', body });
        } else {
          body.assignee_ids = fd.getAll('assignee').map(Number);
          if (!body.assignee_ids.length) throw new Error('Pick at least one person.');
          await api('/tasks', { method: 'POST', body });
        }
        await Promise.all([loadTasks(), loadUsers()]);
        render();
        toast(editing ? 'Task updated.' : 'Task assigned.');
      },
    });
  }

  // An admin's private to-do for themselves (shows only under My tasks).
  function personalDialog(task) {
    const editing = !!task;
    formDialog({
      title: editing ? 'Edit my task' : 'Add my task',
      submit: editing ? 'Save changes' : 'Add task',
      fields: [titleField(task && task.title), detailsField(task && task.description), deadlineField(task && task.deadline)],
      onSubmit: async (fd) => {
        const body = { title: fd.get('title'), description: fd.get('description'), deadline: deadlineValue(fd) };
        if (editing) await api('/tasks/' + task.id, { method: 'PUT', body });
        else await api('/tasks', { method: 'POST', body: { ...body, personal: true } });
        await loadTasks();
        render();
        toast(editing ? 'Task updated.' : 'Task added.');
      },
    });
  }

  function personDialog(person) {
    const editing = !!person;
    const self = editing && person.id === state.user.id;

    // Admins don't belong to a team, so the Team field is hidden while Access is "Admin".
    const teamField = h(
      'label',
      { class: 'field', hidden: editing && person.role === 'admin' },
      h('span', null, 'Team'),
      h('select', { name: 'team', value: person ? person.team : '' }, h('option', { value: '' }, 'No team'), state.teams.map((t) => h('option', { value: t.name }, t.name))),
      state.teams.length ? null : h('small', null, 'No teams yet. Create them in the Teams tab.')
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
              value: person ? person.role : 'member',
              disabled: self,
              onchange: (e) => { teamField.hidden = e.target.value === 'admin'; },
            },
            h('option', { value: 'member' }, 'Member – sees own tasks'),
            h('option', { value: 'admin' }, 'Admin – manages everyone')
          ),
          self ? h('small', null, 'You cannot change your own access.') : null
        ),
        teamField,
        h(
          'label',
          { class: 'field' },
          h('span', null, editing ? 'New password' : 'Password'),
          h('input', { type: 'password', name: 'password', minlength: 8, autocomplete: 'new-password', required: !editing }),
          h('small', null, editing ? 'Leave blank to keep the current password. Setting one signs them out everywhere.' : 'At least 8 characters. Share it with them privately.')
        ),
      ],
      onSubmit: async (fd) => {
        const role = self ? 'admin' : fd.get('role');
        const team = role === 'admin' ? '' : fd.get('team') || '';
        if (editing) {
          const body = { name: fd.get('name'), team };
          if (!self) body.role = role;
          if (fd.get('password')) body.password = fd.get('password');
          await api('/users/' + person.id, { method: 'PATCH', body });
        } else {
          await api('/users', {
            method: 'POST',
            body: { username: fd.get('username'), name: fd.get('name'), team, role, password: fd.get('password') },
          });
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

  function teamDialog(team) {
    const editing = !!team;
    formDialog({
      title: editing ? 'Rename team' : 'Add a team',
      submit: editing ? 'Save' : 'Add team',
      fields: [field('Team name', 'name', 'text', { required: true, maxlength: 40, value: team ? team.name : '', autocomplete: 'off' })],
      onSubmit: async (fd) => {
        if (editing) await api('/teams/' + team.id, { method: 'PATCH', body: { name: fd.get('name') } });
        else await api('/teams', { method: 'POST', body: { name: fd.get('name') } });
        await Promise.all([loadTeams(), loadUsers()]);
        render();
        toast(editing ? 'Team renamed.' : 'Team added.');
      },
    });
  }

  /* ---------- people view ---------- */

  async function setActive(u, active) {
    if (!active && !confirm(`Deactivate ${u.name}? They are signed out and cannot sign in. Their tasks and history are kept, and you can reactivate them any time.`)) return;
    try {
      await api('/users/' + u.id, { method: 'PATCH', body: { active } });
      await loadUsers();
      render();
      toast(active ? `${u.name} can sign in again.` : `${u.name} deactivated.`);
    } catch (e) {
      toast(e.message);
    }
  }

  async function deletePerson(u) {
    if (!confirm(`Permanently delete ${u.name}? All of their tasks, open and done, are deleted with them. This cannot be undone.`)) return;
    try {
      await api('/users/' + u.id, { method: 'DELETE' });
      await Promise.all([loadUsers(), loadTeams()]);
      render();
      toast(`${u.name} deleted.`);
    } catch (e) {
      toast(e.message);
    }
  }

  function peopleView() {
    const rows = state.users.map((u) => {
      const self = u.id === state.user.id;
      return h(
        'tr',
        { class: u.active ? '' : 'off' },
        h('td', null, h('strong', null, u.name), self ? h('span', { class: 'you' }, ' (you)') : null),
        h('td', null, u.username),
        h('td', null, u.role === 'admin' ? '–' : u.team || 'No team'),
        h('td', null, h('span', { class: 'badge' + (u.role === 'admin' ? ' admin' : '') }, u.role === 'admin' ? 'Admin' : 'Member')),
        h('td', null, u.active ? (u.role === 'member' ? plural(u.open_tasks, 'open task') : '–') : 'Deactivated'),
        h(
          'td',
          null,
          h(
            'div',
            { class: 'row-actions' },
            h('button', { class: 'link', onclick: () => personDialog(u) }, 'Edit'),
            self ? null : h('button', { class: 'link', onclick: () => setActive(u, !u.active) }, u.active ? 'Deactivate' : 'Reactivate'),
            self || u.active ? null : h('button', { class: 'link danger', onclick: () => deletePerson(u) }, 'Delete')
          )
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
        h('button', { class: 'btn primary', onclick: () => personDialog() }, 'Add person')
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, ['Name', 'Username', 'Team', 'Access', 'Workload', 'Actions'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', null, rows)
        )
      ),
      h('p', { class: 'hint note' }, 'Deactivate stops someone signing in but keeps their tasks. Once deactivated, a Delete button appears to remove them and their tasks for good.')
    );
  }

  /* ---------- teams view ---------- */

  async function removeTeam(t) {
    const msg = t.members
      ? `Delete the team "${t.name}"? Its ${plural(t.members, 'member')} stay in the system but will have no team.`
      : `Delete the team "${t.name}"?`;
    if (!confirm(msg)) return;
    try {
      await api('/teams/' + t.id, { method: 'DELETE' });
      await Promise.all([loadTeams(), loadUsers()]);
      render();
      toast('Team deleted.');
    } catch (e) {
      toast(e.message);
    }
  }

  function teamsView() {
    const content = state.teams.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'narrow' },
            h('thead', null, h('tr', null, ['Team', 'Members', 'Actions'].map((c) => h('th', { scope: 'col' }, c)))),
            h(
              'tbody',
              null,
              state.teams.map((t) =>
                h(
                  'tr',
                  null,
                  h('td', null, h('strong', null, t.name)),
                  h('td', null, plural(t.members, 'member')),
                  h(
                    'td',
                    null,
                    h(
                      'div',
                      { class: 'row-actions' },
                      h('button', { class: 'link', onclick: () => teamDialog(t) }, 'Rename'),
                      h('button', { class: 'link danger', onclick: () => removeTeam(t) }, 'Delete')
                    )
                  )
                )
              )
            )
          )
        )
      : h('div', { class: 'empty' }, 'No teams yet. Add one, then choose it when you add or edit people.');

    return h(
      'main',
      { class: 'page' },
      h(
        'div',
        { class: 'page-head' },
        h('div', null, h('h1', null, 'Teams'), h('p', { class: 'summary' }, plural(state.teams.length, 'team'))),
        h('button', { class: 'btn primary', onclick: () => teamDialog() }, 'Add team')
      ),
      content,
      h('p', { class: 'hint note' }, 'Renaming a team updates everyone in it. Admins do not belong to a team.')
    );
  }

  /* ---------- settings view ---------- */

  function settingsView() {
    const nameErr = h('p', { class: 'form-error', role: 'alert' });
    const logoErr = h('p', { class: 'form-error', role: 'alert' });

    const nameForm = h(
      'form',
      {
        class: 'card',
        onsubmit: async (e) => {
          e.preventDefault();
          nameErr.textContent = '';
          try {
            state.brand = await api('/branding', { method: 'PUT', body: { name: new FormData(nameForm).get('name') } });
            applyBrand();
            render();
            toast('Name saved.');
          } catch (ex) {
            nameErr.textContent = ex.message;
          }
        },
      },
      h('h2', null, 'Organisation name'),
      h('p', { class: 'hint' }, 'Shown in the header, on the sign-in page and as the browser tab title.'),
      field('Name', 'name', 'text', { required: true, maxlength: 60, value: state.brand.name, autocomplete: 'off' }),
      nameErr,
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Save name'))
    );

    const saveLogo = async (logo) => {
      logoErr.textContent = '';
      try {
        state.brand = await api('/branding', { method: 'PUT', body: { logo } });
        applyBrand();
        render();
        toast(logo ? 'Logo updated.' : 'Logo removed.');
      } catch (ex) {
        logoErr.textContent = ex.message;
      }
    };

    const fileInput = h('input', {
      type: 'file',
      class: 'sr-only',
      accept: 'image/png,image/jpeg,image/webp',
      onchange: async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        logoErr.textContent = '';
        try {
          await saveLogo(await fileToLogo(file));
        } catch (ex) {
          logoErr.textContent = ex.message;
        }
      },
    });

    const logoCard = h(
      'div',
      { class: 'card' },
      h('h2', null, 'Logo'),
      h('p', { class: 'hint' }, 'PNG, JPG or WebP. It is resized automatically. A square or wide logo on a transparent background works best.'),
      h(
        'div',
        { class: 'logo-row' },
        state.brand.logo
          ? h('img', { class: 'logo-preview', src: state.brand.logo, alt: 'Current logo' })
          : h('div', { class: 'logo-preview empty-logo', 'aria-hidden': 'true' }, state.brand.name.slice(0, 1).toUpperCase()),
        h(
          'div',
          { class: 'logo-actions' },
          h('label', { class: 'btn' }, state.brand.logo ? 'Change logo' : 'Upload logo', fileInput),
          state.brand.logo ? h('button', { class: 'btn', type: 'button', onclick: () => saveLogo(null) }, 'Remove logo') : null
        )
      ),
      logoErr
    );

    return h(
      'main',
      { class: 'page' },
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'), h('p', { class: 'summary' }, 'Make this site your own.'))),
      h('div', { class: 'cards' }, nameForm, logoCard)
    );
  }

  /* ---------- session ---------- */

  async function logout() {
    try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.user = null;
    state.tasks = [];
    state.users = [];
    state.teams = [];
    render();
  }

  function render() {
    root.replaceChildren();
    if (state.loading) root.append(h('p', { class: 'boot' }, 'Loading…'));
    else if (state.needsSetup) root.append(setupScreen());
    else if (!state.user) root.append(loginScreen());
    else root.append(shell());
  }

  async function boot() {
    try {
      const [brand, r] = await Promise.all([api('/branding').catch(() => null), api('/me')]);
      if (brand) {
        state.brand = { name: brand.name || DEFAULT_ORG, logo: brand.logo || null };
        applyBrand();
      }
      state.user = r.user;
      state.needsSetup = !!r.needsSetup;
      state.loading = false;
      if (state.user) await enter();
      else render();
    } catch (e) {
      state.loading = false;
      root.replaceChildren(h('p', { class: 'boot' }, 'Could not reach the server. Refresh to try again.'));
    }
  }

  boot();
})();
