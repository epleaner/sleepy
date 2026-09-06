import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const port = Number(process.env.PORT || 3000);
const distDirectory = path.resolve("dist");

const schema = `
  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS entries (
    id UUID PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('wake', 'nap')),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
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
  console.log(`Nappy server listening on port ${port}`);
});

async function createStore() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set; using an in-memory store for local development");
    return createMemoryStore();
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
  await pool.query(schema);
  return {
    async createHousehold() {
      for (;;) {
        const id = createHouseholdId();
        try {
          const result = await pool.query("INSERT INTO households (id) VALUES ($1) RETURNING id", [id]);
          return { id: result.rows[0].id, entries: [] };
        } catch (error) {
          if (error.code !== "23505") throw error;
        }
      }
    },
    async getHousehold(id) {
      const household = await pool.query("SELECT id FROM households WHERE id = $1", [id]);
      if (!household.rowCount) return null;
      const result = await pool.query(
        "SELECT id, mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at, EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at, duration_seconds FROM entries WHERE household_id = $1 ORDER BY started_at DESC",
        [id]
      );
      return { id, entries: result.rows.map(serializeEntry) };
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
      await assertHousehold(pool, householdId);
      const result = await pool.query(
        "UPDATE entries SET mode = $1, started_at = TO_TIMESTAMP($2 / 1000.0), ended_at = TO_TIMESTAMP($3 / 1000.0), duration_seconds = $4 WHERE household_id = $5 AND id = $6 RETURNING id, mode, EXTRACT(EPOCH FROM started_at) * 1000 AS started_at, EXTRACT(EPOCH FROM ended_at) * 1000 AS ended_at, duration_seconds",
        [entry.mode, entry.startedAt, entry.endedAt, entry.duration, householdId, entryId]
      );
      return result.rowCount ? serializeEntry(result.rows[0]) : null;
    },
    async deleteEntry(householdId, entryId) {
      await assertHousehold(pool, householdId);
      const result = await pool.query("DELETE FROM entries WHERE household_id = $1 AND id = $2", [householdId, entryId]);
      return Boolean(result.rowCount);
    }
  };
}

function createMemoryStore() {
  const households = new Set();
  const entries = new Map();
  return {
    async createHousehold() {
      let id;
      do id = createHouseholdId(); while (households.has(id));
      households.add(id);
      entries.set(id, []);
      return { id, entries: [] };
    },
    async getHousehold(id) {
      return households.has(id) ? { id, entries: [...entries.get(id)].sort((a, b) => b.startedAt - a.startedAt) } : null;
    },
    async createEntry(householdId, entry) {
      assertMemoryHousehold(households, householdId);
      entries.get(householdId).push(entry);
      return entry;
    },
    async updateEntry(householdId, entryId, entry) {
      assertMemoryHousehold(households, householdId);
      const householdEntries = entries.get(householdId);
      const index = householdEntries.findIndex((candidate) => candidate.id === entryId);
      if (index === -1) return null;
      householdEntries[index] = { ...entry, id: entryId };
      return householdEntries[index];
    },
    async deleteEntry(householdId, entryId) {
      assertMemoryHousehold(households, householdId);
      const householdEntries = entries.get(householdId);
      const remaining = householdEntries.filter((entry) => entry.id !== entryId);
      entries.set(householdId, remaining);
      return remaining.length !== householdEntries.length;
    }
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

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
    sendJson(response, 201, await store.createHousehold());
    return;
  }

  const householdId = parts[2] ? normalizeHouseholdId(parts[2]) : null;
  if (!householdId) {
    sendJson(response, 400, { error: "Household ID must be eight hexadecimal characters" });
    return;
  }
  if (parts.length === 4 && parts[3] === "join" && request.method === "POST") {
    const household = await store.getHousehold(householdId);
    if (!household) sendJson(response, 404, { error: "Household not found" });
    else sendJson(response, 200, { id: household.id });
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
  if (!payload || !["wake", "nap"].includes(payload.mode)) throw httpError(400, "Mode must be wake or nap");
  const startedAt = Number(payload.startedAt);
  const endedAt = Number(payload.endedAt);
  const duration = Math.floor(Number(payload.duration));
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || !Number.isInteger(duration) || duration < 0) throw httpError(400, "Entry timestamps and duration are invalid");
  return { id, mode: payload.mode, startedAt, endedAt, duration };
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
  const id = value.toUpperCase();
  return /^[A-F0-9]{8}$/.test(id) ? id : null;
}

function createHouseholdId() {
  return randomBytes(4).toString("hex").toUpperCase();
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
