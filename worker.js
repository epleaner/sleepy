import { createStore } from './store.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (body, status = 200) => body === undefined ? new Response(null, { status }) : Response.json(body, { status });

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || [...name].length > 64 || /[\u0000-\u001F\u007F/?#]/u.test(name)) return null;
  return name;
}
function pathParts(pathname) {
  try { return pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw fail(400, 'Household link is invalid.'); }
}
async function body(request) {
  if (Number(request.headers.get('content-length')) > 65536) throw fail(413, 'Request body is too large');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw fail(413, 'Request body is too large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes) || '{}'); }
  catch { throw fail(400, 'Request body must be valid JSON'); }
}
function entry(payload, id = payload?.id || crypto.randomUUID()) {
  if (!payload || !['wake', 'nap', 'tummy'].includes(payload.mode)) throw fail(400, 'Mode must be wake, nap, or tummy');
  const startedAt = Number(payload.startedAt), endedAt = Number(payload.endedAt), duration = Math.floor(Number(payload.duration));
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || !Number.isInteger(duration) || duration < 0 || !Number.isFinite(new Date(startedAt).getTime()) || !Number.isFinite(new Date(endedAt).getTime())) throw fail(400, 'Entry timestamps and duration are invalid');
  if (endedAt < startedAt) throw fail(400, 'Entry end must be after its start.');
  if (duration > Math.floor((endedAt - startedAt) / 1000)) throw fail(400, 'Entry duration cannot exceed its timestamps.');
  return { id, mode: payload.mode, startedAt, endedAt, duration };
}
function deletion(payload) {
  if (!payload?.deleted?.id) throw fail(400, 'Deleted entry data is invalid');
  return { deleted: entry(payload.deleted, payload.deleted.id), previous: payload.previous ? entry(payload.previous, payload.previous.id) : null };
}
async function handle(request, store, parts) {
  const method = request.method;
  if (parts.length === 2 && parts[1] === 'health' && method === 'GET') return json({ ok: true });
  if (parts.length === 2 && parts[1] === 'households' && method === 'POST') {
    const name = normalizeName((await body(request))?.name);
    if (!name) throw fail(400, 'Enter a valid household name.');
    return json(await store.createHousehold(name), 201);
  }
  const id = parts[2] && normalizeName(parts[2]);
  if (!id) return json({ error: 'Enter a valid household name.' }, 400);
  if (parts.length === 4 && parts[3] === 'join' && method === 'POST') {
    const household = await store.getHousehold(id);
    return household ? json({ id: household.id }) : json({ error: 'Household not found' }, 404);
  }
  if (parts.length === 4 && parts[3] === 'timer' && method === 'POST') {
    const payload = await body(request), action = payload?.action;
    if (!['start', 'pause', 'resume', 'stop'].includes(action)) throw fail(400, 'Timer action is invalid');
    if (action === 'start' && !['wake', 'nap'].includes(payload.mode)) throw fail(400, 'Timer mode must be wake or nap');
    return json(await store.mutateTimer(id, action, payload.mode));
  }
  if (parts.length === 4 && parts[3] === 'tummy-timer' && method === 'POST') {
    const action = (await body(request))?.action;
    if (!['start', 'stop'].includes(action)) throw fail(400, 'Tummy timer action is invalid');
    return json(await store.mutateTummyTimer(id, action));
  }
  if (parts.length === 3 && method === 'GET') {
    const household = await store.getHousehold(id);
    return household ? json(household) : json({ error: 'Household not found' }, 404);
  }
  if (parts.length === 3 && method === 'DELETE') return await store.deleteHousehold(id) ? json(undefined, 204) : json({ error: 'Household not found' }, 404);
  if (parts[3] === 'entries' && parts.length === 4 && method === 'POST') return json(await store.createEntry(id, entry(await body(request))), 201);
  if (parts[3] === 'entries' && parts.length === 5) {
    const entryId = parts[4];
    if (method === 'POST' && entryId === 'restore') return json(await store.restoreEntry(id, deletion(await body(request))));
    if (method === 'PUT') {
      const result = await store.updateEntry(id, entryId, entry(await body(request), entryId));
      return result ? json(result) : json({ error: 'Entry not found' }, 404);
    }
    if (method === 'DELETE') {
      const result = await store.deleteEntry(id, entryId);
      return result ? json(result) : json({ error: 'Entry not found' }, 404);
    }
  }
  return json({ error: 'Not found' }, 404);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await handle(request, createStore(env.DB), pathParts(url.pathname)); }
    catch (cause) {
      if (!cause.status) console.error(JSON.stringify({ message: 'Nappy request failed', error: String(cause) }));
      return json({ error: cause.status ? cause.message : 'Unexpected server error' }, cause.status || 500);
    }
  }
};
