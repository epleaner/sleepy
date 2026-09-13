import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const port = Number(process.env.PORT || 3000);
const distDirectory = path.resolve("dist");

const schema = `
  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    timer_revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE households ADD COLUMN IF NOT EXISTS timer_revision BIGINT NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX IF NOT EXISTS households_name_ci_idx ON households (LOWER(id));
  CREATE TABLE IF NOT EXISTS active_timers (
    household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('wake', 'nap')),
    started_at TIMESTAMPTZ NOT NULL,
    accumulated_seconds INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_seconds >= 0),
    last_resumed_at TIMESTAMPTZ,
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS active_tummy_timers (
    household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS entries (
    id UUID PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('wake', 'nap', 'tummy')),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_mode_check;
  ALTER TABLE entries ADD CONSTRAINT entries_mode_check CHECK (mode IN ('wake', 'nap', 'tummy'));
  CREATE INDEX IF NOT EXISTS entries_household_started_idx ON entries(household_id, started_at DESC);
`;

const store = await createStore();

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error);
    sendJson(response, error.status || 500, { error: error.status ? error.message : "Unexpected server error" });
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Sleepy server listening on port ${port}`);
});

async function createStore() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set; using an in-memory store for local development");
    return createMemoryStore();
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
  await pool.query(schema);
  return {
    async createHousehold(name) {
      try {
        return { id: result.rows[0].id, timerRevision: 0, activeTimer: null, activeTummyTimer: null, entries: [] };
      } catch (error) {
        if (error.code === "23505") throw httpError(409, "That household name already exists.");
        throw error;
      }
    },
    async getHousehold(id) {
      const household = await pool.query(
        `SELECT h.id, h.timer_revision, EXTRACT(EPOCH FROM NOW()) * 1000 AS server_now,
                t.mode, EXTRACT(EPOCH FROM t.started_at) * 1000 AS started_at,
                t.accumulated_seconds, EXTRACT(EPOCH FROM t.last_resumed_at) * 1000 AS last_resumed_at,
                t.is_paused,
                EXTRACT(EPOCH FROM tt.started_at) * 1000 AS tummy_started_at
         FROM households h
         LEFT JOIN active_timers t ON t.household_id = h.id
         LEFT JOIN active_tummy_timers tt ON tt.household_id = h.id
         WHERE LOWER(h.id) = LOWER($1)`,
        [id]
      );
      if (!household.rowCount) return null;
      const row = household.rows[0];
      const result = await pool.query(
        "SELECT id, mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at, EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at, duration_seconds FROM entries WHERE household_id = $1 ORDER BY started_at DESC",
        [row.id]
      );
      return {
        id: row.id,
        timerRevision: Number(row.timer_revision),
        activeTimer: serializeTimer(row, Number(row.server_now)),
        activeTummyTimer: serializeTummyTimer(row, Number(row.server_now)),
        entries: result.rows.map(serializeEntry)
      };
    },
    async mutateTimer(householdId, action, mode) {
      return withTransaction(pool, async (client) => {
        const household = await client.query("SELECT id, timer_revision FROM households WHERE id = $1 FOR UPDATE", [householdId]);
        if (!household.rowCount) throw httpError(404, "Household not found");
        const currentResult = await client.query(
          "SELECT mode, started_at, accumulated_seconds, last_resumed_at, is_paused FROM active_timers WHERE household_id = $1 FOR UPDATE",
          [householdId]
        );
        const current = currentResult.rows[0] || null;
        const revision = Number(household.rows[0].timer_revision);
        if (action === "start" && current?.mode === mode) return readTimerState(client, householdId, revision);
        if ((action === "pause" || action === "resume") && !current) throw httpError(409, "No active timer");
        if (action === "stop" && !current) return readTimerState(client, householdId, revision);

        let entry = null;
        if (current && (action === "stop" || (action === "start" && current.mode !== mode))) {
          entry = await completeActiveTimer(client, householdId);
          await client.query("DELETE FROM active_timers WHERE household_id = $1", [householdId]);
        }
        if (action === "start") {
          await client.query(
            "INSERT INTO active_timers (household_id, mode, started_at, accumulated_seconds, last_resumed_at, is_paused) VALUES ($1, $2, NOW(), 0, NOW(), FALSE)",
            [householdId, mode]
          );
        } else if (action === "pause") {
          await client.query(
            "UPDATE active_timers SET accumulated_seconds = FLOOR(accumulated_seconds + CASE WHEN is_paused OR last_resumed_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (NOW() - last_resumed_at)) END)::integer, last_resumed_at = NULL, is_paused = TRUE, updated_at = NOW() WHERE household_id = $1",
            [householdId]
          );
        } else if (action === "resume") {
          await client.query("UPDATE active_timers SET last_resumed_at = NOW(), is_paused = FALSE, updated_at = NOW() WHERE household_id = $1", [householdId]);
        }
        const revisionResult = await client.query("UPDATE households SET timer_revision = timer_revision + 1 WHERE id = $1 RETURNING timer_revision", [householdId]);
        return { ...(await readTimerState(client, householdId, Number(revisionResult.rows[0].timer_revision))), entry };
      });
    },
    async mutateTummyTimer(householdId, action) {
      return withTransaction(pool, async (client) => {
        const household = await client.query("SELECT id, timer_revision FROM households WHERE id = $1 FOR UPDATE", [householdId]);
        if (!household.rowCount) throw httpError(404, "Household not found");
        const currentResult = await client.query(
          "SELECT started_at FROM active_tummy_timers WHERE household_id = $1 FOR UPDATE",
          [householdId]
        );
        const current = currentResult.rows[0] || null;
        const revision = Number(household.rows[0].timer_revision);
        if (action === "start") {
          if (current) return readTimerState(client, householdId, revision);
          const wake = await client.query("SELECT 1 FROM active_timers WHERE household_id = $1 AND mode = 'wake'", [householdId]);
          if (!wake.rowCount) throw httpError(409, "Start a wake window before tummy time.");
          await client.query(
            "INSERT INTO active_tummy_timers (household_id, started_at) VALUES ($1, NOW())",
            [householdId]
          );
        } else if (action === "stop") {
          if (!current) return readTimerState(client, householdId, revision);
          const entry = await completeActiveTummyTimer(client, householdId);
          await client.query("DELETE FROM active_tummy_timers WHERE household_id = $1", [householdId]);
          const revisionResult = await client.query("UPDATE households SET timer_revision = timer_revision + 1 WHERE id = $1 RETURNING timer_revision", [householdId]);
          return { ...(await readTimerState(client, householdId, Number(revisionResult.rows[0].timer_revision))), entry };
        }
        const revisionResult = await client.query("UPDATE households SET timer_revision = timer_revision + 1 WHERE id = $1 RETURNING timer_revision", [householdId]);
        return readTimerState(client, householdId, Number(revisionResult.rows[0].timer_revision));
      });
    },
    async createEntry(householdId, entry) {
      await assertHousehold(pool, householdId);
      const result = await pool.query(
        "INSERT INTO entries (id, household_id, mode, started_at, ended_at, duration_seconds) VALUES ($1, $2, $3, TO_TIMESTAMP($4 / 1000.0), TO_TIMESTAMP($5 / 1000.0), $6) RETURNING id, mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at, EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at, duration_seconds",
        [entry.id, householdId, entry.mode, entry.startedAt, entry.endedAt, entry.duration]
      );
      return serializeEntry(result.rows[0]);
    },
    async updateEntry(householdId, entryId, entry) {
      return withTransaction(pool, async (client) => {
        const household = await client.query("SELECT id FROM households WHERE id = $1 FOR UPDATE", [householdId]);
        if (!household.rowCount) throw httpError(404, "Household not found");
        const result = await client.query(
          "SELECT id, mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at, EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at, duration_seconds FROM entries WHERE household_id = $1 ORDER BY started_at ASC, ended_at ASC, id ASC FOR UPDATE",
          [householdId]
        );
        const index = result.rows.findIndex((candidate) => candidate.id === entryId);
        if (index === -1) return null;
        const previous = result.rows[index - 1] || null;
        const next = result.rows[index + 1] || null;
        assertEntryBoundary(entry, previous, next);
        const updated = await client.query(
          "UPDATE entries SET mode = $1, started_at = TO_TIMESTAMP($2 / 1000.0), ended_at = TO_TIMESTAMP($3 / 1000.0), duration_seconds = $4 WHERE household_id = $5 AND id = $6 RETURNING id, mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at, EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at, duration_seconds",
          [entry.mode, entry.startedAt, entry.endedAt, entry.duration, householdId, entryId]
        );
        if (previous) {
          await client.query(
            "UPDATE entries SET ended_at = TO_TIMESTAMP($1 / 1000.0), duration_seconds = FLOOR(EXTRACT(EPOCH FROM (TO_TIMESTAMP($1 / 1000.0) - started_at)))::integer WHERE household_id = $2 AND id = $3",
            [entry.startedAt, householdId, previous.id]
          );
        }
        if (next) {
          await client.query(
            "UPDATE entries SET started_at = TO_TIMESTAMP($1 / 1000.0), duration_seconds = FLOOR(EXTRACT(EPOCH FROM (ended_at - TO_TIMESTAMP($1 / 1000.0))))::integer WHERE household_id = $2 AND id = $3",
            [entry.endedAt, householdId, next.id]
          );
        }
        return serializeEntry(updated.rows[0]);
      });
    },
    async deleteEntry(householdId, entryId) {
      return withTransaction(pool, async (client) => {
        const household = await client.query("SELECT id FROM households WHERE id = $1 FOR UPDATE", [householdId]);
        if (!household.rowCount) throw httpError(404, "Household not found");
        const result = await client.query(
          "SELECT id, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at, EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at FROM entries WHERE household_id = $1 ORDER BY started_at ASC, ended_at ASC, id ASC FOR UPDATE",
          [householdId]
        );
        const index = result.rows.findIndex((entry) => entry.id === entryId);
        if (index === -1) return false;
        const previous = result.rows[index - 1] || null;
        const next = result.rows[index + 1] || null;
        await client.query("DELETE FROM entries WHERE household_id = $1 AND id = $2", [householdId, entryId]);
        if (previous && next) {
          await client.query(
            "UPDATE entries SET ended_at = TO_TIMESTAMP($1 / 1000.0), duration_seconds = FLOOR(EXTRACT(EPOCH FROM (TO_TIMESTAMP($1 / 1000.0) - started_at)))::integer WHERE household_id = $2 AND id = $3",
            [next.started_at, householdId, previous.id]
          );
        }
        return true;
      });
    },
    async deleteHousehold(householdId) {
      const result = await pool.query("DELETE FROM households WHERE id = $1", [householdId]);
      return Boolean(result.rowCount);
    }
  };
}

function createMemoryStore() {
  const households = new Map();
  const entries = new Map();
  const timers = new Map();
  const tummyTimers = new Map();
  const timerRevisions = new Map();
  return {
    async createHousehold(name) {
      const key = name.toLocaleLowerCase();
      if ([...households.keys()].some((existing) => existing.toLocaleLowerCase() === key)) {
        throw httpError(409, "That household name already exists.");
      }
      households.set(name, true);
      entries.set(name, []);
      timerRevisions.set(name, 0);
      return { id: name, timerRevision: 0, activeTimer: null, activeTummyTimer: null, entries: [] };
    },
    async getHousehold(id) {
      const storedId = [...households.keys()].find((existing) => existing.toLocaleLowerCase() === id.toLocaleLowerCase());
      if (!storedId) return null;
      return {
        id: storedId,
        timerRevision: timerRevisions.get(storedId),
        activeTimer: timers.has(storedId) ? serializeTimer(timers.get(storedId)) : null,
        activeTummyTimer: tummyTimers.has(storedId) ? serializeTummyTimer(tummyTimers.get(storedId)) : null,
        entries: [...entries.get(storedId)].sort((a, b) => b.startedAt - a.startedAt)
      };
    },
    async mutateTimer(householdId, action, mode) {
      assertMemoryHousehold(households, householdId);
      const current = timers.get(householdId) || null;
      const revision = timerRevisions.get(householdId);
      if (action === "start" && current?.mode === mode) {
        return { timerRevision: revision, activeTimer: serializeTimer(current), entry: null };
      }
      if ((action === "pause" || action === "resume") && !current) throw httpError(409, "No active timer");
      if (action === "stop" && !current) return { timerRevision: revision, activeTimer: null, entry: null };

      let entry = null;
      if (current && (action === "stop" || (action === "start" && current.mode !== mode))) {
        entry = completeMemoryTimer(entries.get(householdId), current);
        timers.delete(householdId);
      }
      if (action === "start") {
        const now = Date.now();
        timers.set(householdId, { mode, startedAt: now, accumulatedSeconds: 0, lastResumedAt: now, isPaused: false });
      } else if (action === "pause") {
        current.accumulatedSeconds = timerElapsedSeconds(current, Date.now());
        current.lastResumedAt = null;
        current.isPaused = true;
      } else if (action === "resume") {
        current.lastResumedAt = Date.now();
        current.isPaused = false;
      }
      const nextRevision = revision + 1;
      timerRevisions.set(householdId, nextRevision);
      return {
        timerRevision: nextRevision,
        activeTimer: timers.has(householdId) ? serializeTimer(timers.get(householdId)) : null,
        activeTummyTimer: tummyTimers.has(householdId) ? serializeTummyTimer(tummyTimers.get(householdId)) : null,
        entry
      };
    },
    async mutateTummyTimer(householdId, action) {
      assertMemoryHousehold(households, householdId);
      const current = tummyTimers.get(householdId) || null;
      const revision = timerRevisions.get(householdId);
      if (action === "start") {
        if (current) {
          return {
            timerRevision: revision,
            activeTimer: timers.has(householdId) ? serializeTimer(timers.get(householdId)) : null,
            activeTummyTimer: serializeTummyTimer(current),
            entry: null
          };
        }
        if (timers.get(householdId)?.mode !== "wake") throw httpError(409, "Start a wake window before tummy time.");
        tummyTimers.set(householdId, { startedAt: Date.now() });
      } else if (action === "stop") {
        if (!current) {
          return {
            timerRevision: revision,
            activeTimer: timers.has(householdId) ? serializeTimer(timers.get(householdId)) : null,
            activeTummyTimer: null,
            entry: null
          };
        }
        const entry = completeMemoryTummyTimer(entries.get(householdId), current);
        tummyTimers.delete(householdId);
        const nextRevision = revision + 1;
        timerRevisions.set(householdId, nextRevision);
        return {
          timerRevision: nextRevision,
          activeTimer: timers.has(householdId) ? serializeTimer(timers.get(householdId)) : null,
          activeTummyTimer: null,
          entry
        };
      }
      const nextRevision = revision + 1;
      timerRevisions.set(householdId, nextRevision);
      return {
        timerRevision: nextRevision,
        activeTimer: timers.has(householdId) ? serializeTimer(timers.get(householdId)) : null,
        activeTummyTimer: serializeTummyTimer(tummyTimers.get(householdId)),
        entry: null
      };
    },
    async createEntry(householdId, entry) {
      assertMemoryHousehold(households, householdId);
      entries.get(householdId).push(entry);
      return entry;
    },
    async updateEntry(householdId, entryId, entry) {
      assertMemoryHousehold(households, householdId);
      const householdEntries = entries.get(householdId);
      const target = householdEntries.find((candidate) => candidate.id === entryId);
      if (!target) return null;
      const ordered = [...householdEntries].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt || a.id.localeCompare(b.id));
      const index = ordered.findIndex((candidate) => candidate.id === entryId);
      const previous = ordered[index - 1] || null;
      const next = ordered[index + 1] || null;
      assertEntryBoundary(entry, previous, next);
      Object.assign(target, { ...entry, id: entryId });
      if (previous) {
        previous.endedAt = entry.startedAt;
        previous.duration = Math.floor((previous.endedAt - previous.startedAt) / 1000);
      }
      if (next) {
        next.startedAt = entry.endedAt;
        next.duration = Math.floor((next.endedAt - next.startedAt) / 1000);
      }
      return target;
    },
    async deleteEntry(householdId, entryId) {
      assertMemoryHousehold(households, householdId);
      const householdEntries = entries.get(householdId);
      const ordered = [...householdEntries].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt || a.id.localeCompare(b.id));
      const index = ordered.findIndex((entry) => entry.id === entryId);
      if (index === -1) return false;
      const previous = ordered[index - 1] || null;
      const next = ordered[index + 1] || null;
      if (previous && next) {
        previous.endedAt = next.startedAt;
        previous.duration = Math.floor((previous.endedAt - previous.startedAt) / 1000);
      }
      entries.set(householdId, householdEntries.filter((entry) => entry.id !== entryId));
      return true;
    },
    async deleteHousehold(householdId) {
      if (!households.has(householdId)) return false;
      households.delete(householdId);
      entries.delete(householdId);
      timers.delete(householdId);
      tummyTimers.delete(householdId);
      timerRevisions.delete(householdId);
      return true;
    }
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const parts = decodePathParts(url.pathname);

  if (parts[0] === "api") {
    await handleApi(request, response, parts);
    return;
  }
  await serveStatic(url.pathname, response);
}

async function handleApi(request, response, parts) {
  if (parts.length === 2 && parts[1] === "health" && request.method === "GET") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (parts.length === 2 && parts[1] === "households" && request.method === "POST") {
    const name = parseHouseholdName(await readJson(request));
    sendJson(response, 201, await store.createHousehold(name));
    return;
  }

  const householdId = parts[2] ? normalizeHouseholdId(parts[2]) : null;
  if (!householdId) {
    sendJson(response, 400, { error: "Enter a valid household name." });
    return;
  }
  if (parts.length === 4 && parts[3] === "join" && request.method === "POST") {
    const household = await store.getHousehold(householdId);
    if (!household) sendJson(response, 404, { error: "Household not found" });
    else sendJson(response, 200, { id: household.id });
    return;
  }
  if (parts.length === 4 && parts[3] === "tummy-timer" && request.method === "POST") {
    const { action } = parseTummyTimerAction(await readJson(request));
    sendJson(response, 200, await store.mutateTummyTimer(householdId, action));
    return;
  }
  if (parts.length === 4 && parts[3] === "timer" && request.method === "POST") {
    const { action, mode } = parseTimerAction(await readJson(request));
    sendJson(response, 200, await store.mutateTimer(householdId, action, mode));
    return;
  }
  if (parts.length === 3 && request.method === "DELETE") {
    if (await store.deleteHousehold(householdId)) sendJson(response, 204);
    else sendJson(response, 404, { error: "Household not found" });
    return;
  }
  if (parts.length === 3 && request.method === "GET") {
    const household = await store.getHousehold(householdId);
    if (!household) sendJson(response, 404, { error: "Household not found" });
    else sendJson(response, 200, household);
    return;
  }
  if (parts.length >= 4 && parts[3] === "entries") {
    await handleEntryApi(request, response, householdId, parts[4]);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

async function handleEntryApi(request, response, householdId, entryId) {
  if (request.method === "POST" && !entryId) {
    const entry = parseEntry(await readJson(request));
    sendJson(response, 201, await store.createEntry(householdId, entry));
    return;
  }
  if (request.method === "PUT" && entryId) {
    const entry = parseEntry(await readJson(request), entryId);
    const updated = await store.updateEntry(householdId, entryId, entry);
    if (!updated) sendJson(response, 404, { error: "Entry not found" });
    else sendJson(response, 200, updated);
    return;
  }
  if (request.method === "DELETE" && entryId) {
    if (await store.deleteEntry(householdId, entryId)) sendJson(response, 204);
    else sendJson(response, 404, { error: "Entry not found" });
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

async function serveStatic(requestPath, response) {
  const requested = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(distDirectory, requested);
  const insideDist = filePath === distDirectory || filePath.startsWith(`${distDirectory}${path.sep}`);
  try {
    if (!insideDist) throw new Error("Invalid path");
    const content = await readFile(filePath);
    sendStatic(response, 200, content, contentType(filePath));
  } catch {
    try {
      const content = await readFile(path.join(distDirectory, "index.html"));
      sendStatic(response, 200, content, "text/html; charset=utf-8");
    } catch {
      sendJson(response, 503, { error: "Application is still building" });
    }
  }
}

function parseEntry(payload, id = payload?.id || randomUUID()) {
  if (!payload || !["wake", "nap", "tummy"].includes(payload.mode)) throw httpError(400, "Mode must be wake, nap, or tummy");
  const startedAt = Number(payload.startedAt);
  const endedAt = Number(payload.endedAt);
  const duration = Math.floor(Number(payload.duration));
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || !Number.isInteger(duration) || duration < 0) throw httpError(400, "Entry timestamps and duration are invalid");
  return { id, mode: payload.mode, startedAt, endedAt, duration };
}
function parseTimerAction(payload) {
  const action = payload?.action;
  if (!["start", "pause", "resume", "stop"].includes(action)) throw httpError(400, "Timer action is invalid");
  if (action === "start" && !["wake", "nap"].includes(payload.mode)) throw httpError(400, "Timer mode must be wake or nap");
  return { action, mode: payload.mode };
}
function parseTummyTimerAction(payload) {
  const action = payload?.action;
  if (!["start", "stop"].includes(action)) throw httpError(400, "Tummy timer action is invalid");
  return { action };
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readActiveTimer(client, householdId) {
  const result = await client.query(
    `SELECT mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at,
            accumulated_seconds, EXTRACT(EPOCH FROM last_resumed_at) * 1000 AS last_resumed_at,
            is_paused, EXTRACT(EPOCH FROM NOW()) * 1000 AS server_now
     FROM active_timers WHERE household_id = $1`,
    [householdId]
  );
  return result.rows[0] || null;
}
async function readActiveTummyTimer(client, householdId) {
  const result = await client.query(
    "SELECT EXTRACT(EPOCH FROM started_at) * 1000 AS started_at, EXTRACT(EPOCH FROM NOW()) * 1000 AS server_now FROM active_tummy_timers WHERE household_id = $1",
    [householdId]
  );
  return result.rows[0] || null;
}

async function readTimerState(client, householdId, timerRevision) {
  const active = await readActiveTimer(client, householdId);
  const tummy = await readActiveTummyTimer(client, householdId);
  return {
    timerRevision,
    activeTimer: serializeTimer(active, Number(active?.server_now ?? Date.now())),
    activeTummyTimer: serializeTummyTimer(tummy, Number(tummy?.server_now ?? Date.now())),
    entry: null
  };
}


async function completeActiveTimer(client, householdId) {
  const result = await client.query(
    `INSERT INTO entries (id, household_id, mode, started_at, ended_at, duration_seconds)
     SELECT $1, $2, mode, started_at, NOW(),
            FLOOR(accumulated_seconds + CASE WHEN is_paused OR last_resumed_at IS NULL
              THEN 0 ELSE EXTRACT(EPOCH FROM (NOW() - last_resumed_at)) END)::integer
     FROM active_timers WHERE household_id = $3
     RETURNING id, mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at,
               EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at, duration_seconds`,
    [randomUUID(), householdId, householdId]
  );
  return serializeEntry(result.rows[0]);
}
async function completeActiveTummyTimer(client, householdId) {
  const result = await client.query(
    `INSERT INTO entries (id, household_id, mode, started_at, ended_at, duration_seconds)
     SELECT $1, $2, 'tummy', started_at, NOW(),
            FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)))::integer
     FROM active_tummy_timers WHERE household_id = $3
     RETURNING id, mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at,
               EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at, duration_seconds`,
    [randomUUID(), householdId, householdId]
  );
  return serializeEntry(result.rows[0]);
}


function serializeTimer(row, serverNow = Date.now()) {
  if (!row?.mode) return null;
  const lastResumedAt = row.last_resumed_at ?? row.lastResumedAt;
  return {
    mode: row.mode,
    startedAt: Number(row.started_at ?? row.startedAt),
    accumulatedSeconds: Number(row.accumulated_seconds ?? row.accumulatedSeconds),
    lastResumedAt: lastResumedAt === null || lastResumedAt === undefined ? null : Number(lastResumedAt),
    isPaused: Boolean(row.is_paused ?? row.isPaused),
    serverNow: Number(serverNow)
  };
}
function serializeTummyTimer(row, serverNow = Date.now()) {
  const startedAt = row?.tummy_started_at !== undefined
    ? row.tummy_started_at
    : row?.started_at ?? row?.startedAt;
  if (startedAt === null || startedAt === undefined) return null;
  return { startedAt: Number(startedAt), serverNow: Number(serverNow) };
}

function timerElapsedSeconds(timer, now) {
  const resumedAt = timer.last_resumed_at ?? timer.lastResumedAt;
  const isPaused = timer.is_paused ?? timer.isPaused;
  const accumulated = Number(timer.accumulated_seconds ?? timer.accumulatedSeconds);
  return Math.max(0, Math.floor(accumulated + (!isPaused && resumedAt !== null && resumedAt !== undefined ? (now - Number(resumedAt)) / 1000 : 0)));
}

function completeMemoryTimer(householdEntries, timer) {
  const endedAt = Date.now();
  const entry = { id: randomUUID(), mode: timer.mode, startedAt: timer.startedAt, endedAt, duration: timerElapsedSeconds(timer, endedAt) };
  householdEntries.push(entry);
  return entry;
}
function completeMemoryTummyTimer(householdEntries, timer) {
  const endedAt = Date.now();
  const entry = { id: randomUUID(), mode: "tummy", startedAt: timer.startedAt, endedAt, duration: Math.max(0, Math.floor((endedAt - timer.startedAt) / 1000)) };
  householdEntries.push(entry);
  return entry;
}


async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw httpError(413, "Request body is too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

function normalizeHouseholdId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (/^[A-F0-9]{8}$/.test(id)) return id;
  return normalizeHouseholdName(id);
}

function normalizeHouseholdName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || [...name].length > 64 || /[\u0000-\u001F\u007F/?#]/u.test(name)) return null;
  return name;
}

function parseHouseholdName(payload) {
  const name = normalizeHouseholdName(payload?.name);
  if (!name) throw httpError(400, "Enter a valid household name.");
  return name;
}

function decodePathParts(pathname) {
  try {
    return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw httpError(400, "Household link is invalid.");
  }
}


function assertEntryBoundary(entry, previous, next) {
  const previousStartedAt = previous ? Number(previous.started_at ?? previous.startedAt) : null;
  const nextEndedAt = next ? Number(next.ended_at ?? next.endedAt) : null;
  if (previousStartedAt !== null && entry.startedAt < previousStartedAt) {
    throw httpError(400, "Entry cannot start before the previous entry.");
  }
  if (nextEndedAt !== null && entry.endedAt > nextEndedAt) {
    throw httpError(400, "Entry cannot end after the next entry.");
  }
}

function serializeEntry(row) {
  return {
    id: row.id,
    mode: row.mode,
    startedAt: Number(row.started_at ?? row.startedAt),
    endedAt: Number(row.ended_at ?? row.endedAt),
    duration: Number(row.duration_seconds ?? row.duration)
  };
}

function assertMemoryHousehold(households, id) {
  if (!households.has(id)) throw httpError(404, "Household not found");
}

async function assertHousehold(pool, id) {
  const result = await pool.query("SELECT 1 FROM households WHERE id = $1", [id]);
  if (!result.rowCount) throw httpError(404, "Household not found");
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(response, status, body) {
  response.writeHead(status, body ? { "content-type": "application/json; charset=utf-8" } : undefined);
  response.end(body ? JSON.stringify(body) : undefined);
}

function sendStatic(response, status, body, contentTypeValue) {
  response.writeHead(status, { "content-type": contentTypeValue, "cache-control": "no-cache" });
  response.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json") || filePath.endsWith(".webmanifest")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
