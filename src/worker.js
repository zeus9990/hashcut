// Team Tasks – Cloudflare Worker API (static files are served by Workers Assets)
// Storage: Cloudflare D1 (SQLite). No external dependencies.

import { DurableObject } from 'cloudflare:workers';

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
    `SELECT u.id, u.username, u.name, u.team, u.role,
            (SELECT updated_at FROM avatars a WHERE a.user_id = u.id) AS avatar_v
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

// Priority levels: 0 = none, 1 = 1st priority (ASAP), 2 = 2nd, 3 = 3rd.
const PRIORITY_LABEL = { 1: '1st priority', 2: '2nd priority', 3: '3rd priority' };
function normPriority(v) {
  if (v === true) return 1; // older clients sent a plain true/false
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 0;
}

// Saved links must be web links. A missing "https://" is added for convenience.
function normUrl(value) {
  let raw = String(value ?? '').trim();
  if (!raw || raw.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

// Repeating tasks follow one organisation-wide time zone (set TIMEZONE in wrangler.jsonc).
function tzOf(env) {
  const tz = env.TIMEZONE || 'Asia/Kolkata';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}
function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
const localDate = (tz) => tzParts(Date.now(), tz).date;
const dowOf = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
};
// "2026-10-23" + "10:30" in the given zone -> UTC milliseconds
function localToUtcMs(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = tzParts(guess, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return guess - (asUtc - guess);
}

// WhatsApp numbers are stored as digits only, country code included (e.g. 919876543210).
function parsePhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: true, value: '' };
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return { ok: false };
  return { ok: true, value: digits };
}

/* ---------- live updates (Durable Object + WebSockets) ---------- */

const STATUS_LABEL = { pending: 'To do', in_progress: 'In progress', done: 'Done' };
const q = (t) => `\u201c${t.length > 60 ? t.slice(0, 57) + '\u2026' : t}\u201d`;

function realtimeStub(env) {
  return env.REALTIME.get(env.REALTIME.idFromName('main'));
}

// Tell connected browsers that something changed. Live updates must never break the API,
// so every failure here is swallowed.
//   ev = { by, users: [ids], admins: bool, userText, adminText }
async function emit(env, ev) {
  if (!env.REALTIME) return;
  try {
    await realtimeStub(env).publish(ev);
  } catch (e) {
    console.error('live publish failed', e);
  }
}

// Close open connections for these people (after deactivation, role change, password reset, delete).
async function kick(env, ids) {
  if (!env.REALTIME) return;
  try {
    await realtimeStub(env).kick(ids);
  } catch (e) {
    console.error('live kick failed', e);
  }
}

async function live(request, env, user) {
  if (request.headers.get('Upgrade') !== 'websocket') return fail(426, 'Expected a WebSocket connection.');
  const origin = request.headers.get('Origin');
  let host = '';
  try { host = new URL(origin).host; } catch { /* missing or invalid */ }
  if (host !== new URL(request.url).host) return fail(403, 'Cross-site connection blocked.');
  if (!env.REALTIME) return fail(503, 'Live updates are not configured.');

  const req = new Request(request);
  req.headers.set('X-Live-User', String(user.id));
  req.headers.set('X-Live-Role', user.role);
  return realtimeStub(env).fetch(req);
}

/* ---------- auth routes ---------- */

async function me(env, user) {
  if (user) return json({ user, tz: tzOf(env) });
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
  const av = await env.DB.prepare('SELECT updated_at FROM avatars WHERE user_id = ?').bind(user.id).first();
  return json(
    { user: { id: user.id, username: user.username, name: user.name, team: user.team, role: user.role, avatar_v: av ? av.updated_at : null }, tz: tzOf(env) },
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
  await kick(env, [user.id]); // other devices are signed out; this one reconnects on its own
  return json({ ok: true });
}

/* ---------- tasks ---------- */

const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.deadline, t.status, t.priority, t.completed_at, t.created_at,
         t.assignee_id, t.recurring_id, r.repeat AS repeat, u.name AS assignee_name, u.team AS assignee_team
    FROM tasks t JOIN users u ON u.id = t.assignee_id
    LEFT JOIN recurring_tasks r ON r.id = t.recurring_id`;

// Admins never belong to a team and are not assignable. Tasks an admin writes for
// themselves are private to that admin and never appear in "All tasks".
async function listTasks(env, user, url) {
  // Safety net in case the scheduled job has not run yet: create today's repeating tasks now.
  try { await generateDue(env); } catch (e) { console.error('repeat generation failed', e); }
  const mineOnly = user.role !== 'admin' || url.searchParams.get('mine') === '1';
  const where = mineOnly ? ' WHERE t.assignee_id = ?' : " WHERE u.role = 'member'";
  const taskStmt = env.DB.prepare(TASK_SELECT + where + ' ORDER BY t.deadline IS NULL, t.deadline ASC, t.id DESC LIMIT 1000');
  // Open blockers for the same set of tasks (a single IN (...) list would exceed D1's 100-parameter limit).
  const blockerStmt = env.DB.prepare(
    `SELECT b.id, b.task_id, b.body, b.created_at, a.name AS author_name
       FROM task_blockers b
       JOIN tasks t ON t.id = b.task_id
       JOIN users u ON u.id = t.assignee_id
       JOIN users a ON a.id = b.author_id` +
      where +
      ' AND b.resolved_at IS NULL ORDER BY b.created_at ASC'
  );
  const [taskRes, blockerRes] = await env.DB.batch([
    mineOnly ? taskStmt.bind(user.id) : taskStmt,
    mineOnly ? blockerStmt.bind(user.id) : blockerStmt,
  ]);

  const byTask = new Map();
  for (const b of blockerRes.results) {
    if (!byTask.has(b.task_id)) byTask.set(b.task_id, []);
    byTask.get(b.task_id).push({ id: b.id, body: b.body, created_at: b.created_at, author_name: b.author_name });
  }
  const tasks = taskRes.results.map((t) => ({ ...t, priority: Number(t.priority) || 0, blockers: byTask.get(t.id) || [] }));
  return json({ tasks });
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
  const { results } = await env.DB.prepare(
    `SELECT id FROM users WHERE active = 1 AND role = 'member' AND id IN (${marks})`
  ).bind(...ids).all();
  if (results.length !== ids.length) return fail(400, 'Tasks can only be assigned to active members.');

  const now = Date.now();
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        `INSERT INTO tasks (title, description, assignee_id, assigned_by, deadline, priority, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).bind(title, description, id, user.id, dl.value, normPriority(body.priority), now)
    )
  );
  await emit(env, {
    by: user.id,
    users: ids,
    admins: true,
    userText: normPriority(body.priority) ? `New ${PRIORITY_LABEL[normPriority(body.priority)]} task: ${q(title)}` : `New task: ${q(title)}`,
  });
  return json({ ok: true, created: ids.length }, 201);
}

// An admin's own to-do item.
async function createOwnTask(request, env, user) {
  const body = await readJson(request);
  const title = clean(body.title, 200);
  const description = clean(body.description, 2000);
  const dl = parseDeadline(body.deadline);
  if (!title) return fail(400, 'Give the task a title.');
  if (!dl.ok) return fail(400, 'That deadline is not a valid date.');

  await env.DB.prepare(
    `INSERT INTO tasks (title, description, assignee_id, assigned_by, deadline, priority, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(title, description, user.id, user.id, dl.value, normPriority(body.priority), Date.now())
    .run();
  await emit(env, { by: user.id, users: [user.id], admins: false }); // private: only this admin's other devices
  return json({ ok: true }, 201);
}

async function fetchTask(env, id) {
  return env.DB.prepare(
    'SELECT t.*, u.role AS assignee_role FROM tasks t JOIN users u ON u.id = t.assignee_id WHERE t.id = ?'
  ).bind(id).first();
}

function taskPermissions(user, task) {
  const personal = task.assignee_role === 'admin'; // an admin's private to-do
  const canManage = personal ? task.assignee_id === user.id : user.role === 'admin';
  return { personal, canManage, canTick: canManage || task.assignee_id === user.id };
}

async function updateTask(request, env, user, id) {
  const task = await fetchTask(env, id);
  if (!task) return fail(404, 'Task not found.');
  const perm = taskPermissions(user, task);
  const body = await readJson(request);

  // Status: the assignee, or an admin for member tasks.
  if (request.method === 'PATCH') {
    if (!perm.canTick) return fail(403, 'This task is not assigned to you.');
    if (!['pending', 'in_progress', 'done'].includes(body.status)) return fail(400, 'Invalid status.');
    const completedAt = body.status === 'done' ? Date.now() : null;
    await env.DB.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      .bind(body.status, completedAt, id)
      .run();
    const byAssignee = task.assignee_id === user.id;
    await emit(env, {
      by: user.id,
      users: [task.assignee_id],
      admins: !perm.personal,
      userText: byAssignee ? null : `An admin set ${q(task.title)} to ${STATUS_LABEL[body.status]}`,
      adminText: byAssignee ? `${user.name} moved ${q(task.title)} to ${STATUS_LABEL[body.status]}` : null,
    });
    return json({ task: { id, status: body.status, completed_at: completedAt } });
  }

  // Full edit.
  if (!perm.canManage) return fail(403, 'You cannot edit this task.');
  const title = clean(body.title, 200);
  const description = clean(body.description, 2000);
  const dl = parseDeadline(body.deadline);
  if (!title) return fail(400, 'Give the task a title.');
  if (!dl.ok) return fail(400, 'That deadline is not a valid date.');

  let assignee = task.assignee_id;
  if (!perm.personal && Number(body.assignee_id) !== task.assignee_id) {
    assignee = Number(body.assignee_id);
    const person = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role = 'member'")
      .bind(assignee)
      .first();
    if (!person) return fail(400, 'Pick an active member.');
  }

  await env.DB.prepare('UPDATE tasks SET title = ?, description = ?, deadline = ?, assignee_id = ?, priority = ? WHERE id = ?')
    .bind(title, description, dl.value, assignee, normPriority(body.priority), id)
    .run();
  if (assignee !== task.assignee_id) {
    await emit(env, { by: user.id, users: [assignee], admins: true, userText: `New task: ${q(title)}` });
    await emit(env, { by: user.id, users: [task.assignee_id], admins: false, userText: `${q(task.title)} was reassigned` });
  } else {
    await emit(env, {
      by: user.id,
      users: [assignee],
      admins: !perm.personal,
      userText:
        normPriority(body.priority) && normPriority(body.priority) !== task.priority
          ? `${q(title)} is now ${PRIORITY_LABEL[normPriority(body.priority)]}`
          : `${q(title)} was updated`,
    });
  }
  return json({ ok: true });
}

async function deleteTask(env, user, id) {
  const task = await fetchTask(env, id);
  if (!task) return fail(404, 'Task not found.');
  const perm = taskPermissions(user, task);
  if (!perm.canManage) return fail(403, 'You cannot delete this task.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM task_blockers WHERE task_id = ?').bind(id),
    env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id),
  ]);
  await emit(env, { by: user.id, users: [task.assignee_id], admins: !perm.personal, userText: `${q(task.title)} was removed` });
  return json({ ok: true });
}

/* ---------- repeating tasks ---------- */

function occursOn(r, dateStr) {
  const dow = dowOf(dateStr);
  if (r.repeat === 'daily') return true;
  if (r.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  return dow === r.weekday; // weekly
}

// Creates today's copy of one repeating task, at most once per day. Returns true if a task was created.
async function materialize(env, r, tz, { skipIfPast = false } = {}) {
  const today = localDate(tz);
  // Claim today first so two overlapping runs can never create duplicates.
  const claim = await env.DB.prepare(
    'UPDATE recurring_tasks SET last_generated = ? WHERE id = ? AND (last_generated IS NULL OR last_generated < ?)'
  ).bind(today, r.id, today).run();
  if (!claim.meta.changes) return false;
  if (!occursOn(r, today)) return false;

  let deadline = null;
  if (r.due_time) {
    const ms = localToUtcMs(today, r.due_time, tz);
    if (skipIfPast && ms < Date.now()) return false; // created after today's due time: start tomorrow
    deadline = new Date(ms).toISOString();
  }
  await env.DB.prepare(
    `INSERT INTO tasks (title, description, assignee_id, assigned_by, deadline, priority, status, created_at, recurring_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(r.title, r.description, r.assignee_id, r.assigned_by, deadline, r.priority, Date.now(), r.id).run();
  return true;
}

// Runs from the scheduled trigger (every 30 minutes) and as a safety net when tasks are listed.
async function generateDue(env) {
  const tz = tzOf(env);
  const today = localDate(tz);
  const { results } = await env.DB.prepare(
    `SELECT r.* FROM recurring_tasks r JOIN users u ON u.id = r.assignee_id
      WHERE r.active = 1 AND u.active = 1 AND u.role = 'member'
        AND (r.last_generated IS NULL OR r.last_generated < ?)`
  ).bind(today).all();

  const people = new Set();
  for (const r of results) {
    if (await materialize(env, r, tz)) people.add(r.assignee_id);
  }
  if (people.size) {
    await emit(env, { by: null, users: [...people], admins: true, userText: 'Your repeating tasks for today are ready' });
  }
  return people.size;
}

function parseSchedule(body, base = {}) {
  const repeat = body.repeat !== undefined ? body.repeat : base.repeat;
  if (!['daily', 'weekdays', 'weekly'].includes(repeat)) return { error: 'Pick how often it repeats.' };
  const weekday = body.weekday !== undefined ? Number(body.weekday) : base.weekday ?? 1;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: 'Pick a valid day of the week.' };
  let due = body.due_time !== undefined ? body.due_time : base.due_time ?? null;
  if (due === '') due = null;
  if (due !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(due))) return { error: 'Enter the due time like 17:30.' };
  return { repeat, weekday, due_time: due };
}

async function listRecurring(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, r.description, r.assignee_id, r.priority, r.repeat, r.weekday, r.due_time, r.active,
            u.name AS assignee_name, u.team AS assignee_team
       FROM recurring_tasks r JOIN users u ON u.id = r.assignee_id
      ORDER BY r.active DESC, r.title COLLATE NOCASE`
  ).all();
  return json({ recurring: results });
}

async function createRecurring(request, env, user) {
  const body = await readJson(request);
  const title = clean(body.title, 200);
  const description = clean(body.description, 2000);
  const ids = [...new Set((Array.isArray(body.assignee_ids) ? body.assignee_ids : []).map(Number))].filter(Number.isInteger);
  const sched = parseSchedule(body);
  if (!title) return fail(400, 'Give the task a title.');
  if (sched.error) return fail(400, sched.error);
  if (!ids.length) return fail(400, 'Pick at least one person.');
  if (ids.length > 100) return fail(400, 'Too many people selected.');

  const marks = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT id FROM users WHERE active = 1 AND role = 'member' AND id IN (${marks})`).bind(...ids).all();
  if (results.length !== ids.length) return fail(400, 'Tasks can only be scheduled for active members.');

  const tz = tzOf(env);
  const priority = normPriority(body.priority);
  const got = [];
  for (const id of ids) {
    const res = await env.DB.prepare(
      `INSERT INTO recurring_tasks (title, description, assignee_id, assigned_by, priority, repeat, weekday, due_time, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(title, description, id, user.id, priority, sched.repeat, sched.weekday, sched.due_time, Date.now()).run();
    const r = { id: res.meta.last_row_id, title, description, assignee_id: id, assigned_by: user.id, priority, ...sched };
    if (await materialize(env, r, tz, { skipIfPast: true })) got.push(id);
  }
  await emit(env, { by: user.id, users: ids, admins: true, userText: `New repeating task: ${q(title)}` });
  return json({ ok: true, created: ids.length, today: got.length }, 201);
}

async function updateRecurring(request, env, user, id) {
  const r = await env.DB.prepare('SELECT * FROM recurring_tasks WHERE id = ?').bind(id).first();
  if (!r) return fail(404, 'Repeating task not found.');
  const body = await readJson(request);

  const title = body.title !== undefined ? clean(body.title, 200) : r.title;
  const description = body.description !== undefined ? clean(body.description, 2000) : r.description;
  const priority = body.priority !== undefined ? normPriority(body.priority) : r.priority;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : r.active;
  const sched = parseSchedule(body, r);
  if (!title) return fail(400, 'Give the task a title.');
  if (sched.error) return fail(400, sched.error);

  let assignee = r.assignee_id;
  if (body.assignee_id !== undefined && Number(body.assignee_id) !== r.assignee_id) {
    assignee = Number(body.assignee_id);
    const person = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role = 'member'").bind(assignee).first();
    if (!person) return fail(400, 'Pick an active member.');
  }
  await env.DB.prepare(
    `UPDATE recurring_tasks SET title = ?, description = ?, priority = ?, repeat = ?, weekday = ?, due_time = ?, active = ?, assignee_id = ? WHERE id = ?`
  ).bind(title, description, priority, sched.repeat, sched.weekday, sched.due_time, active, assignee, id).run();
  return json({ ok: true });
}

// Past copies stay in the task list; only the schedule is removed.
async function deleteRecurring(env, id) {
  await env.DB.batch([
    env.DB.prepare('UPDATE tasks SET recurring_id = NULL WHERE recurring_id = ?').bind(id),
    env.DB.prepare('DELETE FROM recurring_tasks WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

/* ---------- saved sheets and materials (private to each person) ---------- */

const RESOURCE_LIMIT = 200;

async function listResources(env, user) {
  const { results } = await env.DB.prepare(
    'SELECT id, title, url, category, note, pinned, created_at FROM resources WHERE user_id = ? ORDER BY pinned DESC, created_at DESC LIMIT 500'
  ).bind(user.id).all();
  return json({ resources: results.map((r) => ({ ...r, pinned: !!r.pinned })) });
}

async function createResource(request, env, user) {
  const body = await readJson(request);
  const url = normUrl(body.url);
  if (!url) return fail(400, 'Paste a web link that starts with http:// or https://.');
  const host = new URL(url).hostname.replace(/^www\./, '');
  const title = clean(body.title, 120) || host;

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM resources WHERE user_id = ?').bind(user.id).first();
  if (count.n >= RESOURCE_LIMIT) return fail(400, `You can save up to ${RESOURCE_LIMIT} links. Remove some first.`);

  await env.DB.prepare('INSERT INTO resources (user_id, title, url, category, note, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, title, url, clean(body.category, 40), clean(body.note, 300), body.pinned ? 1 : 0, Date.now())
    .run();
  await emit(env, { by: user.id, users: [user.id], admins: false }); // keeps your other devices in sync
  return json({ ok: true }, 201);
}

async function updateResource(request, env, user, id) {
  const r = await env.DB.prepare('SELECT * FROM resources WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!r) return fail(404, 'Link not found.');
  const body = await readJson(request);

  let url = r.url;
  if (body.url !== undefined) {
    url = normUrl(body.url);
    if (!url) return fail(400, 'Paste a web link that starts with http:// or https://.');
  }
  const host = new URL(url).hostname.replace(/^www\./, '');
  const title = body.title !== undefined ? clean(body.title, 120) || host : r.title;
  const category = body.category !== undefined ? clean(body.category, 40) : r.category;
  const note = body.note !== undefined ? clean(body.note, 300) : r.note;
  const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : r.pinned;

  await env.DB.prepare('UPDATE resources SET title = ?, url = ?, category = ?, note = ?, pinned = ? WHERE id = ?')
    .bind(title, url, category, note, pinned, id)
    .run();
  await emit(env, { by: user.id, users: [user.id], admins: false });
  return json({ ok: true });
}

async function deleteResource(env, user, id) {
  const res = await env.DB.prepare('DELETE FROM resources WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (!res.meta.changes) return fail(404, 'Link not found.');
  await emit(env, { by: user.id, users: [user.id], admins: false });
  return json({ ok: true });
}

/* ---------- profile photos ---------- */

// The page shrinks every photo to a small square JPEG before upload; the server re-checks size and type.
async function setAvatar(request, env, user) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 4 || buf.byteLength > 150 * 1024) return fail(400, 'That photo is too large. Try a smaller picture.');
  const b = new Uint8Array(buf);
  if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return fail(400, 'The photo must be a JPEG image.');
  const v = Date.now();
  await env.DB.prepare(
    'INSERT INTO avatars (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  ).bind(user.id, bytesToBase64(b), v).run();
  await emit(env, { by: user.id, users: [user.id], admins: true });
  return json({ ok: true, v });
}

async function getAvatar(env, user, id) {
  if (id !== user.id && user.role !== 'admin') return fail(403, 'Not allowed.');
  const row = await env.DB.prepare('SELECT data FROM avatars WHERE user_id = ?').bind(id).first();
  if (!row) return fail(404, 'No photo.');
  const bytes = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable', // the page adds ?v=<version>, so a new photo is a new URL
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function removeAvatar(env, user, id) {
  if (id !== user.id && user.role !== 'admin') return fail(403, 'Not allowed.');
  await env.DB.prepare('DELETE FROM avatars WHERE user_id = ?').bind(id).run();
  await emit(env, { by: user.id, users: [id], admins: true });
  return json({ ok: true });
}

/* ---------- blockers ---------- */

// The person doing a task can report what is holding it up; admins see it and can resolve it.
async function addBlocker(request, env, user, taskId) {
  const task = await fetchTask(env, taskId);
  if (!task) return fail(404, 'Task not found.');
  if (task.assignee_id !== user.id) return fail(403, 'Only the person assigned to this task can report a blocker.');
  if (task.status === 'done') return fail(400, 'This task is already done.');

  const body = clean((await readJson(request)).body, 500);
  if (!body) return fail(400, 'Describe what is holding the task up.');

  const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND resolved_at IS NULL')
    .bind(taskId)
    .first();
  if (open.n >= 10) return fail(400, 'This task already has 10 open blockers. Resolve some first.');

  await env.DB.prepare('INSERT INTO task_blockers (task_id, author_id, body, created_at) VALUES (?, ?, ?, ?)')
    .bind(taskId, user.id, body, Date.now())
    .run();
  await emit(env, { by: user.id, users: [user.id], admins: true, adminText: `${user.name} reported a blocker on ${q(task.title)}` });
  return json({ ok: true }, 201);
}

async function resolveBlocker(env, user, id) {
  const row = await env.DB.prepare(
    `SELECT b.id, b.resolved_at, t.title, t.assignee_id, u.role AS assignee_role
       FROM task_blockers b JOIN tasks t ON t.id = b.task_id JOIN users u ON u.id = t.assignee_id
      WHERE b.id = ?`
  ).bind(id).first();
  if (!row) return fail(404, 'Blocker not found.');
  if (!taskPermissions(user, row).canTick) return fail(403, 'You cannot resolve this blocker.');
  if (!row.resolved_at) {
    await env.DB.prepare('UPDATE task_blockers SET resolved_at = ?, resolved_by = ? WHERE id = ?')
      .bind(Date.now(), user.id, id)
      .run();
    await emit(env, {
      by: user.id,
      users: [row.assignee_id],
      admins: row.assignee_role !== 'admin',
      userText: row.assignee_id === user.id ? null : `Your blocker on ${q(row.title)} was marked resolved`,
    });
  }
  return json({ ok: true });
}

/* ---------- teams (admin) ---------- */

async function findTeam(env, name) {
  const row = await env.DB.prepare('SELECT name FROM teams WHERE name = ? COLLATE NOCASE').bind(name).first();
  return row ? row.name : null;
}

async function listTeams(env) {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name,
            (SELECT COUNT(*) FROM users u WHERE u.team = t.name COLLATE NOCASE AND u.role = 'member') AS members
       FROM teams t
      ORDER BY t.name COLLATE NOCASE`
  ).all();
  return json({ teams: results });
}

async function createTeam(request, env) {
  const body = await readJson(request);
  const name = clean(body.name, 40);
  if (!name) return fail(400, 'Enter a team name.');
  if (await findTeam(env, name)) return fail(409, 'A team with that name already exists.');
  await env.DB.prepare('INSERT INTO teams (name) VALUES (?)').bind(name).run();
  return json({ ok: true }, 201);
}

async function renameTeam(request, env, id) {
  const team = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?').bind(id).first();
  if (!team) return fail(404, 'Team not found.');
  const body = await readJson(request);
  const name = clean(body.name, 40);
  if (!name) return fail(400, 'Enter a team name.');

  const clash = await env.DB.prepare('SELECT id FROM teams WHERE name = ? COLLATE NOCASE AND id != ?').bind(name, id).first();
  if (clash) return fail(409, 'A team with that name already exists.');

  await env.DB.batch([
    env.DB.prepare('UPDATE teams SET name = ? WHERE id = ?').bind(name, id),
    env.DB.prepare('UPDATE users SET team = ? WHERE team = ? COLLATE NOCASE').bind(name, team.name),
  ]);
  return json({ ok: true });
}

async function deleteTeam(env, id) {
  const team = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?').bind(id).first();
  if (!team) return fail(404, 'Team not found.');
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE team = ? COLLATE NOCASE').bind(team.name).first();
  if (row.n > 0) {
    return fail(400, `${team.name} still has ${row.n} ${row.n === 1 ? 'member' : 'members'}. Move them to another team first.`);
  }
  await env.DB.prepare('DELETE FROM teams WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/* ---------- users (admin) ---------- */

async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.team, u.role, u.active, u.phone,
            (SELECT updated_at FROM avatars a WHERE a.user_id = u.id) AS avatar_v,
            (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status = 'pending') AS todo_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status = 'in_progress') AS progress_tasks
       FROM users u
      ORDER BY u.role DESC, u.active DESC, u.team, u.name`
  ).all();
  return json({ users: results });
}

async function createUser(request, env) {
  const body = await readJson(request);
  const username = clean(body.username, 32).toLowerCase();
  const name = clean(body.name, 80);
  const role = body.role === 'admin' ? 'admin' : 'member';
  const password = String(body.password || '');
  let team = role === 'admin' ? '' : clean(body.team, 40);
  const ph = role === 'admin' ? { ok: true, value: '' } : parsePhone(body.phone);

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return fail(400, 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
  if (!name) return fail(400, 'Enter a name.');
  if (!ph.ok) return fail(400, 'Enter the WhatsApp number with its country code (8–15 digits).');
  if (password.length < 8) return fail(400, 'Password must be at least 8 characters.');

  if (team) {
    const found = await findTeam(env, team);
    if (!found) return fail(400, 'Pick a team from the list, or add it under Teams first.');
    team = found;
  }

  const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) return fail(409, 'That username is taken.');

  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (username, name, team, role, phone, password_hash, salt, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )
    .bind(username, name, team, role, ph.value, hash, salt, Date.now())
    .run();
  return json({ ok: true }, 201);
}

async function updateUser(request, env, admin, id) {
  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) return fail(404, 'Person not found.');
  const body = await readJson(request);

  const name = body.name !== undefined ? clean(body.name, 80) : target.name;
  const role = body.role !== undefined ? (body.role === 'admin' ? 'admin' : 'member') : target.role;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : target.active;
  if (!name) return fail(400, 'Enter a name.');

  if (target.id === admin.id && (role !== 'admin' || !active)) {
    return fail(400, 'You cannot remove your own admin access or deactivate yourself.');
  }

  let phone = target.phone || '';
  if (role === 'admin') {
    phone = '';
  } else if (body.phone !== undefined) {
    const ph = parsePhone(body.phone);
    if (!ph.ok) return fail(400, 'Enter the WhatsApp number with its country code (8–15 digits).');
    phone = ph.value;
  }

  let team = body.team !== undefined ? clean(body.team, 40) : target.team;
  if (role === 'admin') {
    team = ''; // admins do not belong to a team
  } else if (body.team !== undefined && team) {
    const found = await findTeam(env, team);
    if (!found) return fail(400, 'Pick a team from the list, or add it under Teams first.');
    team = found;
  }

  let hash = target.password_hash;
  let salt = target.salt;
  const resetPassword = body.password !== undefined && body.password !== '';
  if (resetPassword) {
    if (String(body.password).length < 8) return fail(400, 'Password must be at least 8 characters.');
    ({ hash, salt } = await hashPassword(String(body.password)));
  }

  const statements = [
    env.DB.prepare('UPDATE users SET name = ?, team = ?, role = ?, phone = ?, active = ?, password_hash = ?, salt = ? WHERE id = ?').bind(
      name, team, role, phone, active, hash, salt, id
    ),
  ];
  if (resetPassword || !active) {
    statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  await env.DB.batch(statements);
  if (resetPassword || !active || role !== target.role) await kick(env, [id]);
  return json({ ok: true });
}

// Permanently removes the account and every task assigned to it.
async function deleteUser(env, admin, id) {
  if (id === admin.id) return fail(400, 'You cannot delete your own account.');
  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!target) return fail(404, 'Person not found.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM task_blockers WHERE task_id IN (SELECT id FROM tasks WHERE assignee_id = ?)').bind(id),
    env.DB.prepare('DELETE FROM task_blockers WHERE author_id = ?').bind(id),
    env.DB.prepare('UPDATE tasks SET assigned_by = NULL WHERE assigned_by = ?').bind(id),
    env.DB.prepare('DELETE FROM tasks WHERE assignee_id = ?').bind(id),
    env.DB.prepare('UPDATE recurring_tasks SET assigned_by = NULL WHERE assigned_by = ?').bind(id),
    env.DB.prepare('DELETE FROM recurring_tasks WHERE assignee_id = ?').bind(id),
    env.DB.prepare('DELETE FROM resources WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM avatars WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  await kick(env, [id]);
  return json({ ok: true });
}

/* ---------- router ---------- */

export default {
  // Cron trigger (see wrangler.jsonc): creates each day's copies of repeating tasks.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(generateDue(env));
  },

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

      if (path === '/api/live' && method === 'GET') return await live(request, env, user);
      if (path === '/api/password' && method === 'POST') return await changeOwnPassword(request, env, user);
      if (path === '/api/tasks' && method === 'GET') return await listTasks(env, user, url);

      // Per-task routes: permissions are checked inside each handler
      const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch) {
        const id = Number(taskMatch[1]);
        if (method === 'PATCH' || method === 'PUT') return await updateTask(request, env, user, id);
        if (method === 'DELETE') return await deleteTask(env, user, id);
      }
      const blockerAdd = path.match(/^\/api\/tasks\/(\d+)\/blockers$/);
      if (blockerAdd && method === 'POST') return await addBlocker(request, env, user, Number(blockerAdd[1]));
      const blockerResolve = path.match(/^\/api\/blockers\/(\d+)\/resolve$/);
      if (blockerResolve && method === 'POST') return await resolveBlocker(env, user, Number(blockerResolve[1]));

      // Saved sheets and profile photos: every signed-in person, for their own account
      if (path === '/api/resources' && method === 'GET') return await listResources(env, user);
      if (path === '/api/resources' && method === 'POST') return await createResource(request, env, user);
      const resMatch = path.match(/^\/api\/resources\/(\d+)$/);
      if (resMatch && (method === 'PATCH' || method === 'PUT')) return await updateResource(request, env, user, Number(resMatch[1]));
      if (resMatch && method === 'DELETE') return await deleteResource(env, user, Number(resMatch[1]));

      if (path === '/api/avatar' && method === 'POST') return await setAvatar(request, env, user);
      if (path === '/api/avatar' && method === 'DELETE') return await removeAvatar(env, user, user.id);
      const avMatch = path.match(/^\/api\/avatar\/(\d+)$/);
      if (avMatch && method === 'GET') return await getAvatar(env, user, Number(avMatch[1]));
      if (avMatch && method === 'DELETE') return await removeAvatar(env, user, Number(avMatch[1]));

      // Everything below is admin only
      const adminOnly =
        (path === '/api/tasks' && method === 'POST') ||
        path === '/api/tasks/mine' ||
        path === '/api/users' ||
        /^\/api\/users\/\d+$/.test(path) ||
        path === '/api/teams' ||
        /^\/api\/teams\/\d+$/.test(path) ||
        path === '/api/recurring' ||
        /^\/api\/recurring\/\d+$/.test(path);
      if (adminOnly && user.role !== 'admin') return fail(403, 'Admins only.');

      if (path === '/api/tasks' && method === 'POST') return await createTasks(request, env, user);
      if (path === '/api/tasks/mine' && method === 'POST') return await createOwnTask(request, env, user);

      if (path === '/api/users' && method === 'GET') return await listUsers(env);
      // People and team changes: refresh every admin screen after a successful change
      const refreshAdmins = async (fn) => {
        const res = await fn();
        if (res.ok) await emit(env, { by: user.id, admins: true });
        return res;
      };
      if (path === '/api/users' && method === 'POST') return await refreshAdmins(() => createUser(request, env));
      const userMatch = path.match(/^\/api\/users\/(\d+)$/);
      if (userMatch && method === 'PATCH') return await refreshAdmins(() => updateUser(request, env, user, Number(userMatch[1])));
      if (userMatch && method === 'DELETE') return await refreshAdmins(() => deleteUser(env, user, Number(userMatch[1])));

      if (path === '/api/recurring' && method === 'GET') return await listRecurring(env);
      if (path === '/api/recurring' && method === 'POST') return await createRecurring(request, env, user);
      const recMatch = path.match(/^\/api\/recurring\/(\d+)$/);
      if (recMatch && method === 'PATCH') return await refreshAdmins(() => updateRecurring(request, env, user, Number(recMatch[1])));
      if (recMatch && method === 'DELETE') return await refreshAdmins(() => deleteRecurring(env, Number(recMatch[1])));

      if (path === '/api/teams' && method === 'GET') return await listTeams(env);
      if (path === '/api/teams' && method === 'POST') return await refreshAdmins(() => createTeam(request, env));
      const teamMatch = path.match(/^\/api\/teams\/(\d+)$/);
      if (teamMatch && method === 'PATCH') return await refreshAdmins(() => renameTeam(request, env, Number(teamMatch[1])));
      if (teamMatch && method === 'DELETE') return await refreshAdmins(() => deleteTeam(env, Number(teamMatch[1])));

      return fail(404, 'Not found.');
    } catch (e) {
      console.error(e);
      return fail(500, 'Something went wrong on the server.');
    }
  },
};

/* ---------- Durable Object: one hub that keeps every browser connected ---------- */

// Uses the WebSocket Hibernation API: connections stay open while the object sleeps,
// so nothing is billed for compute while the team is idle. Per-connection details live
// in the socket "attachment", which survives hibernation (plain memory does not).
export class Realtime extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Browsers send "ping" every ~40s to keep the connection alive. Cloudflare answers
    // "pong" without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });

    const userId = Number(request.headers.get('X-Live-User'));
    const role = request.headers.get('X-Live-Role') === 'admin' ? 'admin' : 'member';
    if (!Number.isInteger(userId)) return new Response('Bad request.', { status: 400 });

    const mine = this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() || {}).userId === userId);
    if (mine.length >= 20) return new Response('Too many open connections.', { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, role });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Browsers never need to send anything except the auto-answered ping.
  async webSocketMessage() {}
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'closing'); } catch { /* already closed */ } }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch { /* already closed */ } }

  // Called by the Worker (RPC). Sends only a tiny "something changed" signal plus an optional
  // short message; each browser then re-fetches its own data through the normal, permission-checked API.
  async publish(ev) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      let hit = false;
      let text = null;
      if (Array.isArray(ev.users) && ev.users.includes(a.userId)) {
        hit = true;
        text = ev.userText ?? null;
      }
      if (ev.admins && a.role === 'admin') {
        if (!hit) text = ev.adminText ?? null;
        hit = true;
      }
      if (!hit) continue;
      try {
        ws.send(JSON.stringify({ type: 'changed', by: ev.by ?? null, text }));
      } catch { /* socket already gone */ }
    }
  }

  async kick(ids) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && ids.includes(a.userId)) {
        // Tell the page first so it can re-check its session right away, then close.
        try { ws.send(JSON.stringify({ type: 'bye' })); } catch { /* socket already gone */ }
        try { ws.close(4001, 'session changed'); } catch { /* already closed */ }
      }
    }
  }
}
