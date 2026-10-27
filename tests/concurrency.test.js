import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createStore } from '../store.js';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      return { bind(...args) { return {
        first: async () => sqlite.prepare(sql).get(...args),
        run: async () => sqlite.prepare(sql).run(...args),
        sql,
        execute() {
          return /^\s*SELECT\b/i.test(sql)
            ? { results: sqlite.prepare(sql).all(...args), meta: { changes: 0 } }
            : { results: [], meta: { changes: sqlite.prepare(sql).run(...args).changes } };
        }
      }; } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return { sqlite, db };
}
function staleReads(db) {
  let reads = 0, release;
  const bothRead = new Promise((resolve) => { release = resolve; });
  return {
    ...db,
    async batch(statements) {
      const result = await db.batch(statements);
      if (statements[0].sql.startsWith('SELECT id, incarnation, timer_revision') && ++reads <= 2) {
        if (reads === 2) release();
        await bothRead;
      }
      return result;
    }
  };
}
const t0 = Date.parse('2026-10-27T08:00:00Z');
const entry = (id, start, end) => ({ id, mode: 'wake', startedAt: start, endedAt: end, duration: (end - start) / 1000 });
const FIRST = '00000000-0000-4000-8000-000000000001';
const MIDDLE = '00000000-0000-4000-8000-000000000002';
const LAST = '00000000-0000-4000-8000-000000000003';

test('same-snapshot pause/stop: no stale pause resurrects a stopped timer', async () => {
  const { db, sqlite } = setup();
  const initial = createStore(db, () => t0);
  await initial.createHousehold('A');
  await initial.mutateTimer('A', 'start', 'nap');
  const concurrent = createStore(staleReads(db), () => t0 + 5100);
  const [pause, stop] = await Promise.allSettled([concurrent.mutateTimer('A', 'pause'), concurrent.mutateTimer('A', 'stop')]);
  assert.equal(stop.status, 'fulfilled');
  if (pause.status === 'rejected') assert.equal(pause.reason.status, 409);
  assert.equal((await initial.getHousehold('A')).activeTimer, null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 1);
  assert.equal((await initial.getHousehold('A')).timerRevision, pause.status === 'fulfilled' ? 3 : 2);
});

test('same-snapshot neighbor edits recompute adjacency from the winner', async () => {
  const { db, sqlite } = setup();
  const initial = createStore(db);
  await initial.createHousehold('A');
  await initial.createEntry('A', entry(FIRST, t0, t0 + 10000));
  await initial.createEntry('A', entry(MIDDLE, t0 + 10000, t0 + 20000));
  await initial.createEntry('A', entry(LAST, t0 + 20000, t0 + 30000));
  const concurrent = createStore(staleReads(db));
  await Promise.all([
    concurrent.updateEntry('A', MIDDLE, entry(MIDDLE, t0 + 11000, t0 + 19000)),
    concurrent.updateEntry('A', MIDDLE, entry(MIDDLE, t0 + 12000, t0 + 18000))
  ]);
  const middle = sqlite.prepare('SELECT started_at, ended_at FROM entries WHERE id=?').get(MIDDLE);
  const first = sqlite.prepare('SELECT ended_at FROM entries WHERE id=?').get(FIRST);
  const last = sqlite.prepare('SELECT started_at FROM entries WHERE id=?').get(LAST);
  assert.equal(first.ended_at, middle.started_at);
  assert.equal(last.started_at, middle.ended_at);
  assert.equal((await initial.getHousehold('A')).timerRevision, 0);
});

test('same-snapshot delete/undo: undo conflict cannot leave stale neighbor changes', async () => {
  const { db, sqlite } = setup();
  const initial = createStore(db);
  await initial.createHousehold('A');
  await initial.createEntry('A', entry(FIRST, t0, t0 + 10000));
  await initial.createEntry('A', entry(MIDDLE, t0 + 10000, t0 + 20000));
  await initial.createEntry('A', entry(LAST, t0 + 20000, t0 + 30000));
  const deletion = await initial.deleteEntry('A', MIDDLE);
  const concurrent = createStore(staleReads(db));
  const [restore, edit] = await Promise.allSettled([
    concurrent.restoreEntry('A', deletion),
    concurrent.updateEntry('A', FIRST, entry(FIRST, t0, t0 + 18000))
  ]);
  assert.equal(restore.status, 'fulfilled');
  assert.equal(edit.status, 'fulfilled');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 3);
  assert.equal(sqlite.prepare('SELECT ended_at FROM entries WHERE id=?').get(FIRST).ended_at, sqlite.prepare('SELECT started_at FROM entries WHERE id=?').get(MIDDLE).started_at);
});
