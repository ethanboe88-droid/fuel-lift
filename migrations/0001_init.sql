-- Fuel & Lift schema
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,              -- YYYY-MM-DD (your local date)
  name TEXT NOT NULL DEFAULT '',
  calories INTEGER NOT NULL,
  protein INTEGER,                -- grams, optional
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS meals_day ON meals(day);

CREATE TABLE IF NOT EXISTS checks (
  week TEXT NOT NULL,             -- Monday of the week, YYYY-MM-DD
  k TEXT NOT NULL,                -- "Mon|Chest|Bench press"
  PRIMARY KEY (week, k)
);

CREATE TABLE IF NOT EXISTS lifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  exercise TEXT NOT NULL,
  weight REAL,
  reps INTEGER,
  sets INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lifts_ex ON lifts(exercise, day);
