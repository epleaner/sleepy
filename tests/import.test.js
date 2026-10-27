import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createStore } from '../store.js';
import worker from '../worker.js';

const start = '2026-10-27T08:00:00.123456Z';
const end = '2026-10-27T08:05:00.987654Z';
const created = '2026-10-26T23:59:59.999999Z';
const startMs = Date.parse(start) + 0.456;
const endMs = Date.parse(end) + 0.654;

test('microsecond timestamps survive API reads, edits, and undo', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO households (id, name_key, timer_revision, created_at) VALUES (?, ?, ?, ?)').run('Home', 'home', 42, created);
  sqlite.prepare('INSERT INTO active_timers (household_id, mode, started_at, accumulated_seconds, last_resumed_at, is_paused, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('Home', 'nap', start, 63, null, 1, end);
  sqlite.prepare('INSERT INTO active_tummy_timers (household_id, started_at, updated_at) VALUES (?, ?, ?)').run('Home', start, end);
  const id = '00000000-0000-4000-8000-000000000001';
  sqlite.prepare('INSERT INTO entries (id, household_id, mode, started_at, ended_at, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'Home', 'wake', start, end, 300, created);
  const db = {
    prepare(sql) { return { bind(...args) { return {
      execute() {
        return /^\s*SELECT\b/i.test(sql)
          ? { results: sqlite.prepare(sql).all(...args), meta: { changes: 0 } }
          : { results: [], meta: { changes: sqlite.prepare(sql).run(...args).changes } };
      }
    }; } }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const store = createStore(db, () => Date.parse(end));
  const call = async (path, method = 'GET', payload) => {
    const response = await worker.fetch(new Request(`https://nappy.test/api/households/${path}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload) }), { DB: db });
    assert.ok(response.ok);
    return response.json();
  };
  const household = await store.getHousehold('hOmE');
  assert.equal(household.id, 'Home');
  assert.equal(household.timerRevision, 42);
  assert.deepEqual(household.activeTimer, { mode: 'nap', startedAt: startMs, accumulatedSeconds: 63, lastResumedAt: null, isPaused: true, serverNow: Date.parse(end) });
  assert.deepEqual(household.activeTummyTimer, { startedAt: startMs, serverNow: Date.parse(end) });
  assert.deepEqual(household.entries, [{ id, mode: 'wake', startedAt: startMs, endedAt: endMs, duration: 300 }]);
  const overHttp = await call('HOME');
  assert.equal(overHttp.activeTimer.startedAt, startMs);
  assert.equal(overHttp.activeTummyTimer.startedAt, startMs);
  assert.deepEqual(overHttp.entries, household.entries);
  const deletion = await call(`HOME/entries/${id}`, 'DELETE');
  assert.equal(deletion.deleted.startedAt, startMs);
  assert.equal(deletion.deleted.endedAt, endMs);
  const restored = await call('home/entries/restore', 'POST', deletion);
  assert.equal(restored.startedAt, startMs);
  assert.equal(restored.endedAt, endMs);
  assert.deepEqual({ ...sqlite.prepare('SELECT started_at, ended_at FROM entries').get() }, { started_at: start, ended_at: end });
  const edited = await call(`Home/entries/${id}`, 'PUT', { ...restored, mode: 'nap' });
  assert.equal(edited.startedAt, startMs);
  assert.equal(edited.endedAt, endMs);
  assert.deepEqual({ ...sqlite.prepare('SELECT mode, started_at, ended_at FROM entries').get() }, { mode: 'nap', started_at: start, ended_at: end });
});
