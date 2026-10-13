(() => {
  'use strict';

  const ORG = 'Team Tasks'; // change to your organisation's name
  const DAY = 864e5;

  const root = document.getElementById('app');
  const state = {
    loading: true,
    needsSetup: false,
    user: null,
    view: 'mine', // mine | all | people
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

  /* ---------- night mode ---------- */

  const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const themeLabel = () => (currentTheme() === 'dark' ? 'Day mode' : 'Night mode');

  function themeButton(extra = '') {
    return h(
      'button',
      {
        class: 'link theme-toggle ' + extra,
        type: 'button',
        onclick: () => {
          const next = currentTheme() === 'dark' ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', next);
          try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
          document.querySelectorAll('.theme-toggle').forEach((b) => (b.textContent = themeLabel()));
        },
      },
      themeLabel()
    );
  }

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
      if (view === 'people' || view === 'teams') await Promise.all([loadUsers(), loadTeams()]);
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

  function shell() {
    const u = state.user;
    const admin = u.role === 'admin';
    const tabs = [['mine', 'My tasks']];
    if (admin) tabs.push(['all', 'All tasks'], ['people', 'People'], ['teams', 'Teams']);

    const header = h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, ORG),
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
    const page = state.view === 'people' ? peopleView() : state.view === 'teams' ? teamsView() : taskView(state.view === 'all');
    return h('div', null, header, page);
  }

  /* ---------- tasks view ---------- */

  function taskView(all) {
    const manage = all || state.user.role === 'admin';
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
        : state.user.role === 'admin'
        ? h('button', { class: 'btn primary', onclick: () => taskDialog() }, 'Add my task')
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
      const teams = state.teams.map((t) => t.name);
      const people = state.users.filter((u) => u.role === 'member');
      toolbar.append(
        h(
          'select',
          { 'aria-label': 'Filter by team', value: state.team, onchange: (e) => { state.team = e.target.value; render(); } },
          h('option', { value: 'all' }, 'All teams'),
          teams.map((t) => h('option', { value: t }, t))
        ),
        h(
          'select',
          { 'aria-label': 'Filter by person', value: state.person, onchange: (e) => { state.person = e.target.value; render(); } },
          h('option', { value: 'all' }, 'Everyone'),
          people.map((p) => h('option', { value: String(p.id) }, p.name + (p.active ? '' : ' (inactive)')))
        )
      );
    }

    const content = h('div', null);
    if (state.status === 'open') {
      if (!open.length) {
        content.append(h('div', { class: 'empty' }, all
            ? 'No open tasks match these filters.'
            : state.user.role === 'admin'
            ? 'Nothing on your list. Use "Add my task" to note something down.'
            : 'Nothing on your list. New tasks will show up here.'));
      }
      for (const [key, label] of GROUPS) {
        const items = open.filter((t) => dueInfo(t).group === key);
        if (!items.length) continue;
        content.append(
          h(
            'section',
            { class: 'group g-' + key },
            h('h2', null, label, h('span', { class: 'count' }, items.length)),
            h('ul', { class: 'tasks' }, items.map((t) => taskRow(t, all, manage)))
          )
        );
      }
    } else if (!done.length) {
      content.append(h('div', { class: 'empty' }, 'No completed tasks yet.'));
    } else {
      content.append(h('ul', { class: 'tasks' }, done.map((t) => taskRow(t, all, manage))));
    }

    return h('main', { class: 'page' }, head, toolbar, content);
  }

  function taskRow(t, all, manage) {
    const d = dueInfo(t);
    const done = t.status === 'done';
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
      manage
        ? h(
            'div',
            { class: 'actions' },
            h('button', { class: 'link', onclick: () => taskDialog(t) }, 'Edit'),
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
        assigneeField,
      ],
      onSubmit: async (fd) => {
        const deadline = fd.get('deadline');
        const body = {
          title: fd.get('title'),
          description: fd.get('description'),
          deadline: deadline ? new Date(deadline).toISOString() : null,
        };
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
        }
        await loadTasks();
        if (state.view === 'all') await loadUsers();
        render();
        toast(editing ? 'Task updated.' : personal ? 'Task added.' : 'Task assigned.');
      },
    });
  }

  function personDialog(person) {
    const editing = !!person;
    const startRole = person ? person.role : 'member';

    // Admins do not belong to a team, so the Team field is hidden while Access is "Admin".
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
            { name: 'role', value: startRole, onchange: (e) => { teamField.hidden = e.target.value === 'admin'; } },
            h('option', { value: 'member' }, 'Member – sees own tasks'),
            h('option', { value: 'admin' }, 'Admin – manages everyone')
          )
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
        const role = fd.get('role');
        const team = role === 'admin' ? '' : fd.get('team');
        if (editing) {
          const body = { name: fd.get('name'), team, role };
          if (fd.get('password')) body.password = fd.get('password');
          await api('/users/' + person.id, { method: 'PATCH', body });
        } else {
          await api('/users', { method: 'POST', body: { username: fd.get('username'), name: fd.get('name'), team, role, password: fd.get('password') } });
        }
        await loadUsers();
        await loadTeams();
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

  /* ---------- people view ---------- */

  async function setActive(u, active) {
    const message = active
      ? null
      : `Deactivate ${u.name}? They will be signed out and cannot sign in until you reactivate them. Their tasks are kept.`;
    if (message && !confirm(message)) return;
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
    const rows = state.users.map((u) => {
      const self = u.id === state.user.id;
      return h(
        'tr',
        { class: u.active ? '' : 'off' },
        h('td', null, h('strong', null, u.name), self ? h('span', { class: 'you' }, ' (you)') : null),
        h('td', null, u.username),
        h('td', null, u.role === 'admin' ? '–' : u.team || 'No team'),
        h('td', null, h('span', { class: 'badge' + (u.role === 'admin' ? ' admin' : '') }, u.role === 'admin' ? 'Admin' : 'Member')),
        h('td', null, u.active ? plural(u.open_tasks, 'open task') : 'Deactivated'),
        h(
          'td',
          null,
          h(
            'div',
            { class: 'row-actions' },
            h('button', { class: 'link', onclick: () => personDialog(u) }, 'Edit'),
            self ? null : h('button', { class: 'link', onclick: () => setActive(u, !u.active) }, u.active ? 'Deactivate' : 'Reactivate'),
            self ? null : h('button', { class: 'link danger', onclick: () => removePerson(u) }, 'Delete')
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
      )
    );
  }

  /* ---------- teams view ---------- */

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
      : h('div', { class: 'empty' }, 'No teams yet. Add one, then put people in it from the People tab.');

    return h(
      'main',
      { class: 'page' },
      h(
        'div',
        { class: 'page-head' },
        h('div', null, h('h1', null, 'Teams'), h('p', { class: 'summary' }, 'Admins are not part of any team.')),
        h('button', { class: 'btn primary', onclick: () => teamDialog() }, 'Add team')
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
      const r = await api('/me');
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
