import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../worker.js';
import { canonicalUuid } from '../uuid.js';

const id = '5aef1f41-c9e0-408c-b117-344d790ebea6';
const start = Date.parse('2026-10-27T08:00:00Z');
const entry = (value) => ({ id: value, mode: 'wake', startedAt: start, endedAt: start + 10000, duration: 10 });

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) { return { bind(...args) { return {
      first: async () => sqlite.prepare(sql).get(...args),
      run: async () => sqlite.prepare(sql).run(...args),
      execute() {
        return /^\s*SELECT\b/i.test(sql)
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
  async function request(path, method = 'GET', payload) {
    const response = await worker.fetch(new Request(`https://nappy.test/api/households${path}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload) }), { DB: db });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  return { sqlite, request };
}

test('UUID inputs accepted by PostgreSQL refer to the same lowercase entry', async () => {
  const { sqlite, request } = setup();
  assert.equal((await request('', 'POST', { name: 'Home' })).status, 201);
  assert.equal(canonicalUuid(`{${id.toUpperCase()}}`), id);
  assert.equal(canonicalUuid(id.replaceAll('-', '').toUpperCase()), id);
  assert.equal(canonicalUuid('not-a-uuid'), null);
  const created = await request('/Home/entries', 'POST', entry(`{${id.toUpperCase()}}`));
  assert.equal(created.status, 201);
  assert.equal(created.body.id, id);
  assert.equal((await request('/Home')).body.entries[0].id, id);
  const duplicate = await request('/Home/entries', 'POST', entry(id.replaceAll('-', '').toUpperCase()));
  assert.notEqual(duplicate.status, 201);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 1);
  const updated = await request(`/Home/entries/${id.toUpperCase()}`, 'PUT', { ...entry(id.toUpperCase()), mode: 'nap' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.id, id);
  const removed = await request(`/Home/entries/${encodeURIComponent(`{${id.toUpperCase()}}`)}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted.id, id);
  const restored = await request('/Home/entries/restore', 'POST', { ...removed.body, deleted: { ...removed.body.deleted, id: id.toUpperCase() } });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.id, id);
  assert.equal((await request('/Home/entries/restore', 'POST', { ...removed.body, deleted: { ...removed.body.deleted, id: id.toUpperCase() } })).status, 409);
  assert.equal((await request('/Home/entries', 'POST', entry('not-a-uuid'))).status, 400);
  assert.equal((await request('/Home/entries/not-a-uuid', 'DELETE')).status, 400);
});
