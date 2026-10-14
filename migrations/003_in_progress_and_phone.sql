-- Run this ONCE in the D1 console of an already-deployed database.
-- (Fresh installs get all of this from schema.sql.)

-- WhatsApp number for each person
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';

-- Allow the new "in_progress" status. SQLite cannot edit a CHECK rule in place,
-- so the tasks table is rebuilt and the existing rows are copied across.
CREATE TABLE tasks_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  assignee_id  INTEGER NOT NULL REFERENCES users(id),
  assigned_by  INTEGER REFERENCES users(id),
  deadline     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
  completed_at INTEGER,
  created_at   INTEGER NOT NULL
);
INSERT INTO tasks_new (id, title, description, assignee_id, assigned_by, deadline, status, completed_at, created_at)
  SELECT id, title, description, assignee_id, assigned_by, deadline, status, completed_at, created_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
