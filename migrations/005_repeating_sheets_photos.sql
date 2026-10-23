ALTER TABLE tasks ADD COLUMN recurring_id INTEGER;
CREATE TABLE IF NOT EXISTS recurring_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', assignee_id INTEGER NOT NULL REFERENCES users(id), assigned_by INTEGER REFERENCES users(id), priority INTEGER NOT NULL DEFAULT 0, repeat TEXT NOT NULL CHECK (repeat IN ('daily', 'weekdays', 'weekly')), weekday INTEGER NOT NULL DEFAULT 1, due_time TEXT, active INTEGER NOT NULL DEFAULT 1, last_generated TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_tasks(active, last_generated);
CREATE TABLE IF NOT EXISTS resources (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, url TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_resources_user ON resources(user_id);
CREATE TABLE IF NOT EXISTS avatars (user_id INTEGER PRIMARY KEY REFERENCES users(id), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
