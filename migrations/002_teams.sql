-- Run this ONCE in the D1 console of an already-deployed database.
-- (Fresh installs get this from schema.sql.)
CREATE TABLE IF NOT EXISTS teams (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
INSERT OR IGNORE INTO teams (name) VALUES ('Social Media'), ('Production'), ('BD');
INSERT OR IGNORE INTO teams (name) SELECT DISTINCT team FROM users WHERE team != '';
-- Admins do not belong to a team
UPDATE users SET team = '' WHERE role = 'admin';
