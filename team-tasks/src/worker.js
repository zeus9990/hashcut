// Team Tasks – Cloudflare Worker API (static files are served by Workers Assets)
// Storage: Cloudflare D1 (SQLite). No external dependencies.

const SESSION_DAYS = 14;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const enc = new TextEncoder();

/* ---------- small helpers ---------- */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });

const fail = (status, message) => json({ error: message }, status);

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// PBKDF2-SHA256. 100,000 iterations is the maximum Workers allows.
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key,
    256
  );
  return { hash: toB64(bits), salt: toB64(salt) };
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const sessionCookie = (token, maxAge, secure) =>
  `sid=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/; Max-Age=${maxAge}`;

async function createSession(env, userId) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), userId, expires)
    .run();
  return token;
}

async function getUser(request, env) {
  const token = getCookie(request, 'sid');
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.team, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
  )
    .bind(await sha256Hex(token), Date.now())
    .first();
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

function parseDeadline(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d.toISOString() };
}

/* ---------- auth routes ---------- */

async function me(env, user) {
  if (user) return json({ user });
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return json({ user: null, needsSetup: row.n === 0 });
}

async function setup(request, env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (row.n > 0) return fail(403, 'Setup is already done.');
  if (!env.SETUP_KEY) return fail(500, 'SETUP_KEY secret is not configured.');

  const body = await readJson(request);
  if (!safeEqual(String(body.key || ''), String(env.SETUP_KEY))) return fail(403, 'Wrong setup key.');

  const username = clean(body.username, 32).toLowerCase();
  const name = clean(body.name, 80);
  const password = String(body.password || '');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return fail(400, 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
  if (!name) return fail(400, 'Enter your name.');
  if (password.length < 8) return fail(400, 'Password must be at least 8 characters.');

  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (username, name, team, role, password_hash, salt, active, created_at)
     VALUES (?, ?, '', 'admin', ?, ?, 1, ?)`
  )
    .bind(username, name, hash, salt, Date.now())
    .run();
  return json({ ok: true });
}

async function login(request, env, secure) {
  const body = await readJson(request);
  const username = clean(body.username, 32).toLowerCase();
  const password = String(body.password || '');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `${username}|${ip}`;
  const now = Date.now();

  const rec = await env.DB.prepare('SELECT count, first_at FROM login_attempts WHERE key = ?').bind(key).first();
  const inWindow = rec && now - rec.first_at < LOGIN_WINDOW_MS;
  if (inWindow && rec.count >= LOGIN_MAX_ATTEMPTS) {
    return fail(429, 'Too many failed attempts. Try again in 15 minutes.');
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND active = 1').bind(username).first();
  let ok = false;
  if (user) {
    const { hash } = await hashPassword(password, user.salt);
    ok = safeEqual(hash, user.password_hash);
  } else {
    await hashPassword(password); // keep timing similar for unknown usernames
  }

  if (!ok) {
    if (inWindow) {
      await env.DB.prepare('UPDATE login_attempts SET count = count + 1 WHERE key = ?').bind(key).run();
    } else {
      await env.DB.prepare('INSERT OR REPLACE INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)')
        .bind(key, now)
        .run();
    }
    return fail(401, 'Wrong username or password.');
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
  ]);
  const token = await createSession(env, user.id);
  return json(
    { user: { id: user.id, username: user.username, name: user.name, team: user.team, role: user.role } },
    200,
    { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400, secure) }
  );
}

async function logout(request, env, secure) {
  const token = getCookie(request, 'sid');
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0, secure) });
}

async function changeOwnPassword(request, env, user) {
  const body = await readJson(request);
  const current = String(body.current || '');
  const next = String(body.next || '');
  if (next.length < 8) return fail(400, 'New password must be at least 8 characters.');

  const row = await env.DB.prepare('SELECT password_hash, salt FROM users WHERE id = ?').bind(user.id).first();
  const { hash } = await hashPassword(current, row.salt);
  if (!safeEqual(hash, row.password_hash)) return fail(400, 'Current password is wrong.');

  const fresh = await hashPassword(next);
  const keep = await sha256Hex(getCookie(request, 'sid'));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').bind(fresh.hash, fresh.salt, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, keep),
  ]);
  return json({ ok: true });
}

/* ---------- tasks ---------- */

const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.deadline, t.status, t.completed_at, t.created_at,
         t.assignee_id, u.name AS assignee_name, u.team AS assignee_team
    FROM tasks t JOIN users u ON u.id = t.assignee_id`;

async function listTasks(env, user, url) {
  const mineOnly = user.role !== 'admin' || url.searchParams.get('mine') === '1';
  const sql =
    TASK_SELECT +
    (mineOnly ? ' WHERE t.assignee_id = ?' : '') +
    ' ORDER BY t.deadline IS NULL, t.deadline ASC, t.id DESC LIMIT 1000';
  const stmt = env.DB.prepare(sql);
  const { results } = await (mineOnly ? stmt.bind(user.id) : stmt).all();
  return json({ tasks: results });
}

async function createTasks(request, env, user) {
  const body = await readJson(request);
  const title = clean(body.title, 200);
  const description = clean(body.description, 2000);
  const dl = parseDeadline(body.deadline);
  const ids = [...new Set((Array.isArray(body.assignee_ids) ? body.assignee_ids : []).map(Number))].filter(Number.isInteger);

  if (!title) return fail(400, 'Give the task a title.');
  if (!dl.ok) return fail(400, 'That deadline is not a valid date.');
  if (!ids.length) return fail(400, 'Pick at least one person.');
  if (ids.length > 100) return fail(400, 'Too many people selected.');

  const marks = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${marks})`).bind(...ids).all();
  if (results.length !== ids.length) return fail(400, 'One of the selected people is not available.');

  const now = Date.now();
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        `INSERT INTO tasks (title, description, assignee_id, assigned_by, deadline, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      ).bind(title, description, id, user.id, dl.value, now)
    )
  );
  return json({ ok: true, created: ids.length }, 201);
}

async function updateTask(request, env, user, id) {
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (!task) return fail(404, 'Task not found.');
  const isAdmin = user.role === 'admin';
  if (!isAdmin && task.assignee_id !== user.id) return fail(403, 'This task is not assigned to you.');

  const body = await readJson(request);

  // Everyone (assignee or admin) can change status.
  if (request.method === 'PATCH') {
    if (!['pending', 'done'].includes(body.status)) return fail(400, 'Invalid status.');
    const completedAt = body.status === 'done' ? Date.now() : null;
    await env.DB.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      .bind(body.status, completedAt, id)
      .run();
    return json({ task: { id, status: body.status, completed_at: completedAt } });
  }

  // Full edit is admin only.
  if (!isAdmin) return fail(403, 'Only admins can edit tasks.');
  const title = clean(body.title, 200);
  const description = clean(body.description, 2000);
  const dl = parseDeadline(body.deadline);
  const assignee = Number(body.assignee_id);
  if (!title) return fail(400, 'Give the task a title.');
  if (!dl.ok) return fail(400, 'That deadline is not a valid date.');
  const person = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(assignee).first();
  if (!person) return fail(400, 'Pick an active person.');

  await env.DB.prepare('UPDATE tasks SET title = ?, description = ?, deadline = ?, assignee_id = ? WHERE id = ?')
    .bind(title, description, dl.value, assignee, id)
    .run();
  return json({ ok: true });
}

async function deleteTask(env, id) {
  await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/* ---------- users (admin) ---------- */

async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.team, u.role, u.active,
            (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status = 'pending') AS open_tasks
       FROM users u
      ORDER BY u.active DESC, u.team, u.name`
  ).all();
  return json({ users: results });
}

async function createUser(request, env) {
  const body = await readJson(request);
  const username = clean(body.username, 32).toLowerCase();
  const name = clean(body.name, 80);
  const team = clean(body.team, 40);
  const role = body.role === 'admin' ? 'admin' : 'member';
  const password = String(body.password || '');

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return fail(400, 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
  if (!name) return fail(400, 'Enter a name.');
  if (password.length < 8) return fail(400, 'Password must be at least 8 characters.');

  const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) return fail(409, 'That username is taken.');

  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (username, name, team, role, password_hash, salt, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  )
    .bind(username, name, team, role, hash, salt, Date.now())
    .run();
  return json({ ok: true }, 201);
}

async function updateUser(request, env, admin, id) {
  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) return fail(404, 'Person not found.');
  const body = await readJson(request);

  const name = body.name !== undefined ? clean(body.name, 80) : target.name;
  const team = body.team !== undefined ? clean(body.team, 40) : target.team;
  const role = body.role !== undefined ? (body.role === 'admin' ? 'admin' : 'member') : target.role;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : target.active;
  if (!name) return fail(400, 'Enter a name.');

  if (target.id === admin.id && (role !== 'admin' || !active)) {
    return fail(400, 'You cannot remove your own admin access or deactivate yourself.');
  }

  const statements = [];
  let hash = target.password_hash;
  let salt = target.salt;
  const resetPassword = body.password !== undefined && body.password !== '';
  if (resetPassword) {
    if (String(body.password).length < 8) return fail(400, 'Password must be at least 8 characters.');
    ({ hash, salt } = await hashPassword(String(body.password)));
  }

  statements.push(
    env.DB.prepare('UPDATE users SET name = ?, team = ?, role = ?, active = ?, password_hash = ?, salt = ? WHERE id = ?').bind(
      name, team, role, active, hash, salt, id
    )
  );
  if (resetPassword || !active) {
    statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  await env.DB.batch(statements);
  return json({ ok: true });
}

/* ---------- router ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;
    const secure = url.protocol === 'https:';

    if (!path.startsWith('/api/')) return fail(404, 'Not found.');

    // CSRF defence in depth (cookie is also SameSite=Strict)
    if (!['GET', 'HEAD'].includes(method)) {
      const origin = request.headers.get('Origin');
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* ignore */ }
        if (host !== url.host) return fail(403, 'Cross-site request blocked.');
      }
    }

    try {
      // Public routes
      if (path === '/api/login' && method === 'POST') return await login(request, env, secure);
      if (path === '/api/setup' && method === 'POST') return await setup(request, env);

      const user = await getUser(request, env);
      if (path === '/api/me' && method === 'GET') return await me(env, user);
      if (path === '/api/logout' && method === 'POST') return await logout(request, env, secure);

      if (!user) return fail(401, 'Please sign in.');

      if (path === '/api/password' && method === 'POST') return await changeOwnPassword(request, env, user);
      if (path === '/api/tasks' && method === 'GET') return await listTasks(env, user, url);

      const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch) {
        const id = Number(taskMatch[1]);
        if (method === 'PATCH' || method === 'PUT') return await updateTask(request, env, user, id);
        if (method === 'DELETE') {
          if (user.role !== 'admin') return fail(403, 'Admins only.');
          return await deleteTask(env, id);
        }
      }

      // Everything below is admin only
      const adminOnly =
        (path === '/api/tasks' && method === 'POST') ||
        path === '/api/users' ||
        /^\/api\/users\/\d+$/.test(path);
      if (adminOnly && user.role !== 'admin') return fail(403, 'Admins only.');

      if (path === '/api/tasks' && method === 'POST') return await createTasks(request, env, user);
      if (path === '/api/users' && method === 'GET') return await listUsers(env);
      if (path === '/api/users' && method === 'POST') return await createUser(request, env);
      const userMatch = path.match(/^\/api\/users\/(\d+)$/);
      if (userMatch && method === 'PATCH') return await updateUser(request, env, user, Number(userMatch[1]));

      return fail(404, 'Not found.');
    } catch (e) {
      console.error(e);
      return fail(500, 'Something went wrong on the server.');
    }
  },
};
