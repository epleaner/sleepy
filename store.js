import { canonicalUuid } from './uuid.js';
const timestamp = (ms) => {
  const totalMicros = Math.round(ms * 1000);
  const epochMs = Math.floor(totalMicros / 1000);
  return new Date(epochMs).toISOString().replace(/Z$/, `${String(totalMicros - epochMs * 1000).padStart(3, '0')}Z`);
};
const milliseconds = (text) => Date.parse(text) + Number(text.slice(-4, -1)) / 1000;
const microseconds = (text) => Date.parse(text) * 1000 + Number(text.slice(-4, -1));
const entryFromRow = (row) => row && ({ id: row.id, mode: row.mode, startedAt: milliseconds(row.started_at), endedAt: milliseconds(row.ended_at), duration: row.duration_seconds });
const timerFromRow = (row, now) => row && ({ mode: row.mode, startedAt: milliseconds(row.started_at), accumulatedSeconds: row.accumulated_seconds, lastResumedAt: row.last_resumed_at === null ? null : milliseconds(row.last_resumed_at), isPaused: Boolean(row.is_paused), serverNow: now });
const tummyFromRow = (row, now) => row && ({ startedAt: milliseconds(row.started_at), serverNow: now });
const error = (status, message) => Object.assign(new Error(message), { status });
const key = (id) => id.toLowerCase();
const requiredEntryId = (value) => {
  const id = canonicalUuid(value);
  if (!id) throw error(400, 'Entry ID is invalid.');
  return id;
};
const entrySelect = 'SELECT id, mode, started_at, ended_at, duration_seconds FROM entries WHERE household_id = (SELECT id FROM households WHERE name_key = ?) ORDER BY started_at ASC, ended_at ASC, id ASC';
const timerSelect = 'SELECT mode, started_at, accumulated_seconds, last_resumed_at, is_paused FROM active_timers WHERE household_id = (SELECT id FROM households WHERE name_key = ?)';
const tummySelect = 'SELECT started_at FROM active_tummy_timers WHERE household_id = (SELECT id FROM households WHERE name_key = ?)';

export function createStore(db, clock = Date.now) {
  const statement = (sql, ...args) => db.prepare(sql).bind(...args);
  const one = async (sql, ...args) => statement(sql, ...args).first();

  async function snapshot(id, withEntries = false) {
    const nameKey = key(id);
    const statements = [
      statement('SELECT id, incarnation, timer_revision, mutation_nonce FROM households WHERE name_key = ?', nameKey),
      statement(timerSelect, nameKey),
      statement(tummySelect, nameKey)
    ];
    if (withEntries) statements.push(statement(entrySelect, nameKey));
    const [household, timer, tummy, entries] = await db.batch(statements);
    if (!household.results[0]) return null;
    return { household: household.results[0], timer: timer.results[0] || null, tummy: tummy.results[0] || null, entries: entries?.results || [] };
  }

  // Atomic D1 batches CAS the previous nonce and fence every subsequent write
  // on the new request-unique nonce. A losing batch cannot write stale rows.
  async function change(id, prepare, withEntries = false, expectedIncarnation = null) {
    let incarnation = expectedIncarnation;
    for (let attempt = 0; attempt < 16; attempt++) {
      const state = await snapshot(id, withEntries);
      if (!state || incarnation && incarnation !== state.household.incarnation) throw error(404, 'Household not found');
      incarnation = state.household.incarnation;
      const plan = prepare(state);
      if (!plan) return null;
      const householdId = state.household.id;
      const nonce = crypto.randomUUID();
      const guard = statement('UPDATE households SET mutation_nonce = ? WHERE id = ? AND incarnation = ? AND mutation_nonce = ?', nonce, householdId, incarnation, state.household.mutation_nonce);
      const results = await db.batch([guard, ...plan.writes(statement, householdId, nonce)]);
      if (results[0].meta.changes !== 1) continue;
      return plan.result;
    }
    throw error(503, 'Household is busy; try again.');
  }

  const eligible = 'EXISTS (SELECT 1 FROM households WHERE id = ? AND mutation_nonce = ?)';
  const insertEntry = (s, householdId, nonce, entry, now) => s(
    `INSERT INTO entries (id, household_id, mode, started_at, ended_at, duration_seconds, created_at)
     SELECT ?, id, ?, ?, ?, ?, ? FROM households WHERE id = ? AND mutation_nonce = ?`,
    entry.id, entry.mode, entry.started_at || timestamp(entry.startedAt), timestamp(entry.endedAt), entry.duration, now, householdId, nonce
  );
  const stateResponse = (state, now, entry = null, timer = state.timer, tummy = state.tummy, increment = 1) => ({
    timerRevision: state.household.timer_revision + increment,
    activeTimer: timerFromRow(timer, now), activeTummyTimer: tummyFromRow(tummy, now), entry: entry && { id: entry.id, mode: entry.mode, startedAt: entry.startedAt, endedAt: entry.endedAt, duration: entry.duration }
  });
  const elapsed = (timer, now) => Math.max(0, Math.floor(timer.accumulated_seconds + (!timer.is_paused && timer.last_resumed_at !== null ? (now * 1000 - microseconds(timer.last_resumed_at)) / 1000000 : 0)));

  return {
    async createHousehold(name) {
      const now = timestamp(clock());
      try {
        await statement('INSERT INTO households (id, name_key, created_at) VALUES (?, ?, ?)', name, key(name), now).run();
      } catch (cause) {
        if (await one('SELECT id FROM households WHERE name_key = ?', key(name))) throw error(409, 'That household name already exists.');
        throw cause;
      }
      return { id: name, timerRevision: 0, activeTimer: null, activeTummyTimer: null, entries: [] };
    },
    async getHousehold(id) {
      const state = await snapshot(id, true);
      if (!state) return null;
      const now = clock();
      return { id: state.household.id, timerRevision: state.household.timer_revision, activeTimer: timerFromRow(state.timer, now), activeTummyTimer: tummyFromRow(state.tummy, now), entries: state.entries.reverse().map(entryFromRow) };
    },
    async mutateTimer(id, action, mode) {
      return change(id, (state) => {
        const current = state.timer;
        const nowMs = clock(), now = timestamp(nowMs);
        if (action === 'start' && current?.mode === mode || action === 'stop' && !current) return { result: stateResponse(state, nowMs, null, current, state.tummy, 0), writes: () => [] };
        if ((action === 'pause' || action === 'resume') && !current) throw error(409, 'No active timer');
        let finished = null;
        if (current && (action === 'stop' || action === 'start' && current.mode !== mode)) {
          finished = { id: crypto.randomUUID(), mode: current.mode, startedAt: milliseconds(current.started_at), endedAt: nowMs, duration: elapsed(current, nowMs), started_at: current.started_at };
        }
        const timer = action === 'start' ? { mode, started_at: now, accumulated_seconds: 0, last_resumed_at: now, is_paused: 0 }
          : action === 'stop' ? null
          : action === 'pause' ? { ...current, accumulated_seconds: elapsed(current, nowMs), last_resumed_at: null, is_paused: 1 }
          : { ...current, last_resumed_at: now, is_paused: 0 };
        return {
          result: stateResponse(state, nowMs, finished, timer),
          writes(s, householdId, version) {
            const writes = [];
            if (finished) writes.push(insertEntry(s, householdId, version, finished, now));
            if (current && (finished || action === 'stop')) writes.push(s(`DELETE FROM active_timers WHERE household_id = ? AND ${eligible}`, householdId, householdId, version));
            if (action === 'start') writes.push(s(`INSERT INTO active_timers (household_id, mode, started_at, accumulated_seconds, last_resumed_at, is_paused, updated_at)
              SELECT id, ?, ?, 0, ?, 0, ? FROM households WHERE id = ? AND mutation_nonce = ?`, mode, now, now, now, householdId, version));
            if (action === 'pause' || action === 'resume') writes.push(s(`UPDATE active_timers SET accumulated_seconds = ?, last_resumed_at = ?, is_paused = ?, updated_at = ? WHERE household_id = ? AND ${eligible}`, timer.accumulated_seconds, timer.last_resumed_at, timer.is_paused, now, householdId, householdId, version));
            writes.push(s('UPDATE households SET timer_revision = timer_revision + 1 WHERE id = ? AND mutation_nonce = ?', householdId, version));
            return writes;
          }
        };
      });
    },
    async mutateTummyTimer(id, action) {
      return change(id, (state) => {
        const nowMs = clock(), now = timestamp(nowMs);
        if (action === 'start' && state.tummy || action === 'stop' && !state.tummy) return { result: stateResponse(state, nowMs, null, state.timer, state.tummy, 0), writes: () => [] };
        if (action === 'start' && state.timer?.mode !== 'wake') throw error(409, 'Start a wake window before tummy time.');
        const finished = action === 'stop' ? { id: crypto.randomUUID(), mode: 'tummy', startedAt: milliseconds(state.tummy.started_at), endedAt: nowMs, duration: Math.max(0, Math.floor((nowMs * 1000 - microseconds(state.tummy.started_at)) / 1000000)), started_at: state.tummy.started_at } : null;
        return {
          result: stateResponse(state, nowMs, finished, state.timer, action === 'start' ? { started_at: now } : null),
          writes(s, householdId, version) {
            const writes = [];
            if (finished) {
              writes.push(insertEntry(s, householdId, version, finished, now));
              writes.push(s(`DELETE FROM active_tummy_timers WHERE household_id = ? AND ${eligible}`, householdId, householdId, version));
            } else writes.push(s('INSERT INTO active_tummy_timers (household_id, started_at, updated_at) SELECT id, ?, ? FROM households WHERE id = ? AND mutation_nonce = ?', now, now, householdId, version));
            writes.push(s('UPDATE households SET timer_revision = timer_revision + 1 WHERE id = ? AND mutation_nonce = ?', householdId, version));
            return writes;
          }
        };
      });
    },
    async createEntry(id, entry) {
      entry = { ...entry, id: requiredEntryId(entry.id) };
      return change(id, (state) => ({
        result: entry,
        writes: (s, householdId, version) => [insertEntry(s, householdId, version, entry, timestamp(clock()))]
      }));
    },
    async updateEntry(id, entryId, entry) {
      entryId = canonicalUuid(entryId);
      if (!entryId) throw error(400, 'Entry ID is invalid.');
      entry = { ...entry, id: entryId };
      return change(id, (state) => {
        const rows = state.entries;
        const index = rows.findIndex((row) => row.id === entryId);
        if (index < 0) return null;
        const previous = rows[index - 1], next = rows[index + 1];
        if (previous && entry.startedAt * 1000 < microseconds(previous.started_at)) throw error(400, 'Entry cannot start before the previous entry.');
        if (next && entry.endedAt * 1000 > microseconds(next.ended_at)) throw error(400, 'Entry cannot end after the next entry.');
        return {
          result: entry,
          writes(s, householdId, version) {
            const writes = [s(`UPDATE entries SET mode = ?, started_at = ?, ended_at = ?, duration_seconds = ? WHERE household_id = ? AND id = ? AND ${eligible}`, entry.mode, timestamp(entry.startedAt), timestamp(entry.endedAt), entry.duration, householdId, entryId, householdId, version)];
            if (previous) writes.push(s(`UPDATE entries SET ended_at = ?, duration_seconds = ? WHERE household_id = ? AND id = ? AND ${eligible}`, timestamp(entry.startedAt), Math.floor((entry.startedAt * 1000 - microseconds(previous.started_at)) / 1000000), householdId, previous.id, householdId, version));
            if (next) writes.push(s(`UPDATE entries SET started_at = ?, duration_seconds = ? WHERE household_id = ? AND id = ? AND ${eligible}`, timestamp(entry.endedAt), Math.floor((microseconds(next.ended_at) - entry.endedAt * 1000) / 1000000), householdId, next.id, householdId, version));
            return writes;
          }
        };
      }, true);
    },
    async deleteEntry(id, entryId) {
      entryId = canonicalUuid(entryId);
      if (!entryId) throw error(400, 'Entry ID is invalid.');
      return change(id, (state) => {
        const rows = state.entries;
        const index = rows.findIndex((row) => row.id === entryId);
        if (index < 0) return null;
        const previous = rows[index - 1], next = rows[index + 1];
        return {
          result: { deleted: entryFromRow(rows[index]), previous: previous && next ? entryFromRow(previous) : null },
          writes(s, householdId, version) {
            const writes = [s(`DELETE FROM entries WHERE household_id = ? AND id = ? AND ${eligible}`, householdId, entryId, householdId, version)];
            if (previous && next) writes.push(s(`UPDATE entries SET ended_at = ?, duration_seconds = ? WHERE household_id = ? AND id = ? AND ${eligible}`, next.started_at, Math.floor((microseconds(next.started_at) - microseconds(previous.started_at)) / 1000000), householdId, previous.id, householdId, version));
            return writes;
          }
        };
      }, true);
    },
    async restoreEntry(id, deletion) {
      deletion = {
        deleted: { ...deletion.deleted, id: requiredEntryId(deletion.deleted.id) },
        previous: deletion.previous ? { ...deletion.previous, id: requiredEntryId(deletion.previous.id) } : null
      };
      return change(id, (state) => {
        if (state.entries.some((entry) => entry.id === deletion.deleted.id)) throw error(409, 'That entry already exists.');
        if (deletion.previous && !state.entries.some((entry) => entry.id === deletion.previous.id)) throw error(409, 'The neighboring entry no longer exists.');
        const now = timestamp(clock());
        return {
          result: deletion.deleted,
          writes(s, householdId, version) {
            const writes = [];
            if (deletion.previous) writes.push(s(`UPDATE entries SET mode = ?, started_at = ?, ended_at = ?, duration_seconds = ? WHERE household_id = ? AND id = ? AND ${eligible}`, deletion.previous.mode, timestamp(deletion.previous.startedAt), timestamp(deletion.previous.endedAt), deletion.previous.duration, householdId, deletion.previous.id, householdId, version));
            writes.push(insertEntry(s, householdId, version, deletion.deleted, now));
            return writes;
          }
        };
      }, true);
    },
    async deleteHousehold(id) {
      const state = await snapshot(id);
      if (!state) return false;
      await change(id, () => ({ result: true, writes: (s, householdId, nonce) => [s('DELETE FROM households WHERE id = ? AND mutation_nonce = ?', householdId, nonce)] }), false, state.household.incarnation);
      return true;
    }
  };
}
