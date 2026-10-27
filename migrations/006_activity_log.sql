CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL, actor_name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('added', 'done', 'rescheduled')), task_id INTEGER, task_title TEXT NOT NULL, old_value TEXT, new_value TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_log_created ON activity_log(created_at);
ALTER TABLE users ADD COLUMN log_seen_id INTEGER NOT NULL DEFAULT 0;
