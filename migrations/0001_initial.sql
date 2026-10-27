-- Import UTC timestamps as YYYY-MM-DDTHH:MM:SS.ffffffZ text, never via JS Date.
-- name_key is the Unicode-lowercased household id.
CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name_key TEXT NOT NULL UNIQUE,
  incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  timer_revision INTEGER NOT NULL DEFAULT 0 CHECK (timer_revision >= 0),
  created_at TEXT NOT NULL,
  name TEXT,
  mutation_nonce TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
);
CREATE TABLE active_timers (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('wake', 'nap')),
  started_at TEXT NOT NULL,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_seconds >= 0),
  last_resumed_at TEXT,
  is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE active_tummy_timers (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('wake', 'nap', 'tummy')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX entries_household_started_idx ON entries(household_id, started_at DESC);
