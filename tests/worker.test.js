import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../worker.js';
import { createStore } from '../store.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => sqlite.prepare(sql).get(...args),
            run: async () => sqlite.prepare(sql).run(...args),
            execute() {
              if (/^\s*SELECT\b/i.test(sql)) return { results: sqlite.prepare(sql).all(...args), meta: { changes: 0 } };
              return { results: [], meta: { changes: sqlite.prepare(sql).run(...args).changes } };
            }
          };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return { sqlite, db };
}
function client(db) {
  const env = { DB: db, ASSETS: { fetch: async () => new Response('static asset') } };
  return async (path, method = 'GET', payload) => {
    const response = await worker.fetch(new Request(`https://nappy.test${path}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload) }), env);
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
}
const url = (id, suffix = '') => `/api/households/${encodeURIComponent(id)}${suffix}`;
const IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
const row = (id, start, end, mode = 'wake') => ({ id, mode, startedAt: start, endedAt: end, duration: (end - start) / 1000 });

// Force two real SQLite transaction batches to be constructed from the SAME
// observed state; the second batch must not write under the winner's nonce.
function staleSnapshotBarrier(db) {
  let reads = 0, release;
  const barrier = new Promise((resolve) => { release = resolve; });
  return {
    ...db,
    async batch(statements) {
      const result = await db.batch(statements);
      if (statements.length >= 3 && /^SELECT id, incarnation, timer_revision/.test(statements[0].sql || '')) {
        if (++reads === 2) release();
        if (reads <= 2) await barrier;
      }
      return result;
    },
    prepare(sql) {
      const prepared = db.prepare(sql);
      return { bind(...args) { return Object.assign(prepared.bind(...args), { sql }); } };
    }
  };
}

test('Worker create/join/read, case identity, validation, isolation, deletion', async () => {
  const { db } = database(), api = client(db);
  assert.equal((await api('/api/health')).body.ok, true);
  assert.equal((await api('/api/households', 'POST', { name: ' Home ' })).body.id, 'Home');
  assert.equal((await api('/api/households', 'POST', { name: 'home' })).status, 409);
  assert.deepEqual((await api(url('hOmE', '/join'), 'POST')).body, { id: 'Home' });
  assert.equal((await api(url('HOME'))).body.timerRevision, 0);
  assert.equal((await api(url('Other'))).status, 404);
  assert.equal((await api(url('Other', '/timer'), 'POST', { action: 'start', mode: 'nap' })).status, 404);
  assert.equal((await api('/api/households', 'POST', { name: '?' })).status, 400);
  assert.equal((await api(url('Home', '/timer'), 'POST', { action: 'invalid' })).status, 400);
  assert.equal((await api(url('Home', '/entries'), 'POST', { mode: 'nap', startedAt: 'no', endedAt: 5, duration: 0 })).status, 400);
  const malformed = await worker.fetch(new Request('https://nappy.test/api/households/Home/timer', { method: 'POST', body: '{' }), { DB: db });
  assert.equal(malformed.status, 400);
  assert.equal((await api(url('HOME'), 'DELETE')).status, 204);
  assert.equal((await api(url('Home'))).status, 404);
});

test('timers preserve revisions, pause duration, tummy independence and imported microseconds', async () => {
  const { sqlite, db } = database();
  let now = Date.parse('2026-10-27T08:00:00Z');
  const store = createStore(db, () => now);
  await store.createHousehold('Home');
  const start = await store.mutateTimer('home', 'start', 'wake');
  assert.equal(start.timerRevision, 1);
  assert.equal((await store.mutateTimer('Home', 'start', 'wake')).timerRevision, 1);
  assert.equal((await store.mutateTummyTimer('HOME', 'start')).timerRevision, 2);
  now += 5200;
  const tummy = await store.mutateTummyTimer('home', 'stop');
  assert.equal(tummy.entry.duration, 5);
  assert.equal(tummy.activeTimer.mode, 'wake');
  assert.equal(tummy.timerRevision, 3);
  sqlite.prepare('UPDATE active_timers SET started_at = ? WHERE household_id = ?').run('2026-10-27T08:00:00.123456Z', 'Home');
  now += 800;
  const nap = await store.mutateTimer('HOME', 'start', 'nap');
  assert.equal(nap.entry.mode, 'wake');
  assert.equal(sqlite.prepare("SELECT started_at FROM entries WHERE mode='wake'").get().started_at, '2026-10-27T08:00:00.123456Z');
  now += 2300;
  const pause = await store.mutateTimer('Home', 'pause');
  assert.equal(pause.activeTimer.accumulatedSeconds, 2);
  now += 10000;
  const resumed = await store.mutateTimer('Home', 'resume');
  assert.equal(resumed.timerRevision, 6);
  now += 3800;
  const stopped = await store.mutateTimer('home', 'stop');
  assert.equal(stopped.entry.duration, 5);
  assert.equal(stopped.activeTimer, null);
  assert.equal(stopped.timerRevision, 7);
  assert.equal((await store.mutateTimer('home', 'stop')).timerRevision, 7);
});

test('entry edit/delete/undo adjusts neighbors and respects household boundaries', async () => {
  const { db, sqlite } = database(), api = client(db);
  await api('/api/households', 'POST', { name: 'A' });
  await api('/api/households', 'POST', { name: 'B' });
  const base = Date.parse('2026-10-27T08:00:00Z');
  const first = (await api(url('A', '/entries'), 'POST', row(IDS[0], base, base + 10000))).body;
  const middle = (await api(url('A', '/entries'), 'POST', row(IDS[1], base + 10000, base + 20000))).body;
  const last = (await api(url('A', '/entries'), 'POST', row(IDS[2], base + 20000, base + 30000))).body;
  assert.equal((await api(url('B', `/entries/${first.id.toUpperCase()}`), 'DELETE')).status, 404);
  assert.equal((await api(url('A', `/entries/${middle.id}`), 'PUT', row(middle.id, base - 1000, base + 20000))).status, 400);
  assert.equal((await api(url('A', `/entries/${middle.id.toUpperCase()}`), 'PUT', row(middle.id, base + 12000, base + 18000, 'nap'))).status, 200);
  let entries = (await api(url('A'))).body.entries;
  assert.equal(entries.find((entry) => entry.id === first.id).endedAt, base + 12000);
  assert.equal(entries.find((entry) => entry.id === last.id).startedAt, base + 18000);
  const removed = (await api(url('A', `/entries/${middle.id.toUpperCase()}`), 'DELETE')).body;
  assert.equal(removed.previous.endedAt, base + 12000);
  assert.equal((await api(url('A'))).body.entries.find((entry) => entry.id === first.id).endedAt, base + 18000);
  assert.equal((await api(url('A', '/entries/restore'), 'POST', { deleted: { ...removed.deleted, id: removed.deleted.id.toUpperCase() }, previous: { ...removed.previous, id: removed.previous.id.toUpperCase() } })).status, 200);
  entries = (await api(url('A'))).body.entries;
  assert.equal(entries.find((entry) => entry.id === first.id).endedAt, base + 12000);
  assert.equal((await api(url('A', '/entries/restore'), 'POST', { ...removed, deleted: { ...removed.deleted, id: removed.deleted.id.toUpperCase() } })).status, 409);
  assert.equal((await api(url('B'))).body.entries.length, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 3);
});

test('two same-snapshot starts and edits cannot apply losing writes', async () => {
  const { db, sqlite } = database();
  await createStore(db).createHousehold('A');
  const concurrent = createStore(staleSnapshotBarrier(db), () => Date.parse('2026-10-27T08:00:00Z'));
  const [a, b] = await Promise.all([concurrent.mutateTimer('A', 'start', 'wake'), concurrent.mutateTimer('A', 'start', 'nap')]);
  const actual = await createStore(db).getHousehold('A');
  assert.equal(actual.timerRevision, 2);
  assert.equal(actual.entries.length, 1);
  assert.equal(new Set([a.activeTimer.mode, b.activeTimer.mode]).size, 2);
  assert.equal(actual.activeTimer.mode, b.activeTimer.mode);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM active_timers').get().count, 1);
});
