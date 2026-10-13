CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  team          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  assignee_id  INTEGER NOT NULL REFERENCES users(id),
  assigned_by  INTEGER REFERENCES users(id),
  deadline     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  completed_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);

CREATE TABLE IF NOT EXISTS login_attempts (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);

-- Teams are managed by admins (People > Teams). users.team stores the team name.
CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

-- Keep any team names already used by existing people.
INSERT OR IGNORE INTO teams (name, created_at)
  SELECT DISTINCT team, 0 FROM users WHERE team != '';

-- Starter teams, only added when there are no teams at all (edit or delete them in the app).
INSERT INTO teams (name, created_at)
  SELECT name, 0 FROM (SELECT 'Social Media' AS name UNION ALL SELECT 'Production' UNION ALL SELECT 'BD')
  WHERE NOT EXISTS (SELECT 1 FROM teams);

-- Organisation name and logo (Settings tab).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
