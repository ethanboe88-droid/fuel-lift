-- 0002: multi-user support. ADDITIVE ONLY: no existing table, column or row is changed or deleted.
-- The old single-user tables (settings, checks) stay as-is so the current live app keeps working
-- and so the owner's data can be copied into per-user tables on first login.

ALTER TABLE meals ADD COLUMN user_id TEXT;   -- NULL = legacy row from before accounts (belongs to the owner)
ALTER TABLE lifts ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS meals_user_day ON meals(user_id, day);
CREATE INDEX IF NOT EXISTS lifts_user_ex ON lifts(user_id, exercise, day);

-- per-user settings (goal, proteinGoal, groups, plan, favorites)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- per-user workout check-offs
CREATE TABLE IF NOT EXISTS user_checks (
  user_id TEXT NOT NULL,
  week TEXT NOT NULL,
  k TEXT NOT NULL,
  PRIMARY KEY (user_id, week, k)
);

-- daily AI request counter (cost cap)
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- app-level flags (e.g. whether legacy data has been claimed by the owner)
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
