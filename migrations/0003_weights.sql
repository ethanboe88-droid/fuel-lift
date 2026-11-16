-- 0003: bodyweight log (additive only)
CREATE TABLE IF NOT EXISTS weights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,          -- YYYY-MM-DD, one entry per user per day
  weight REAL NOT NULL,       -- lbs
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, day)
);
