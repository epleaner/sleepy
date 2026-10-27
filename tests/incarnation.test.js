import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createStore } from '../store.js';

test('an operation computed before delete/recreate cannot mutate the new household', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) { return { bind(...args) { return {
      run: async () => sqlite.prepare(sql).run(...args),
      execute() {
        return /^\s*SELECT\b/.test(sql)
          ? { results: sqlite.prepare(sql).all(...args), meta: { changes: 0 } }
          : { results: [], meta: { changes: sqlite.prepare(sql).run(...args).changes } };
      }
    }; } }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return result; }
      catch (cause) { sqlite.exec('ROLLBACK'); throw cause; }
    }
  };
  await createStore(db).createHousehold('Home');
  let replaced = false;
  const racing = {
    ...db,
    async batch(statements) {
      const snapshot = await db.batch(statements);
      if (!replaced && statements.length === 3) {
        replaced = true;
        const original = sqlite.prepare('SELECT incarnation FROM households').get().incarnation;
        sqlite.exec("DELETE FROM households WHERE id='Home'");
        sqlite.prepare('INSERT INTO households (id, name_key, created_at) VALUES (?, ?, ?)').run('Home', 'home', '2026-10-27T08:00:00.000000Z');
        assert.notEqual(sqlite.prepare('SELECT incarnation FROM households').get().incarnation, original);
      }
      return snapshot;
    }
  };
  await assert.rejects(createStore(racing).mutateTimer('Home', 'start', 'wake'), { status: 404 });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM active_timers').get().count, 0);
  assert.equal(sqlite.prepare('SELECT timer_revision FROM households').get().timer_revision, 0);
});
