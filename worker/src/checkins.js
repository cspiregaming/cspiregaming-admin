/**
 * Event check-in storage layer.
 *
 * Lives in the `CHECKINS` KV namespace. Key layout:
 *
 *   checkin:<uuid>            → full record JSON (see CheckInRecord)
 *   event:<eventId>:checkins  → JSON array of uuids ordered oldest→newest
 *   event:none:checkins       → uuids written while no event was active
 *   index:email:<lower>       → uuids for cross-event identity lookup
 *   index:gamertag:<lower>    → uuids (used only when email is empty)
 *
 * The active-event pointer lives in CONFIG as `active_event` — a snapshot
 * of the event at the time an officer activated it, so check-ins survive the
 * 30-day Discord-event archive window.
 *
 * Index writes are append-then-put and not atomic. Acceptable for meetup
 * volume; the legacy csg-events worker accepted the same trade-off.
 */
import { getDiscordEventsWithArchive } from './discord-events.js';

const ACTIVE_EVENT_KEY = 'active_event';
const MAX_KIOSK_HISTORY = 50;

// ─── Active event ───────────────────────────────────────────────────────────

export async function getActiveEvent(env) {
  const raw = await env.CONFIG.get(ACTIVE_EVENT_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function setActiveEvent(env, snapshot) {
  await env.CONFIG.put(ACTIVE_EVENT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function clearActiveEvent(env) {
  await env.CONFIG.delete(ACTIVE_EVENT_KEY);
}

/**
 * Look up an event by id+source against the live data sources and build the
 * snapshot we'll store on CONFIG:active_event and stamp onto every check-in
 * while it's active. Returns null when the event isn't found.
 */
export async function buildEventSnapshot(env, { eventId, source }) {
  if (!eventId || !source) return null;

  if (source === 'discord') {
    const { all } = await getDiscordEventsWithArchive(env);
    const ev = all.find(e => e.id === eventId);
    if (!ev) return null;
    return {
      eventId: ev.id,
      source: 'discord',
      title: ev.title || '',
      startTime: ev.startTime || null,
    };
  }

  if (source === 'manual') {
    const raw = await env.CONTENT.get('events');
    const list = raw ? JSON.parse(raw) : [];
    const ev = list.find(e => e.id === eventId);
    if (!ev) return null;
    return {
      eventId: ev.id,
      source: 'manual',
      title: ev.title || '',
      // Manual events don't carry an ISO startTime — only a free-form subtitle.
      startTime: null,
      subtitle: ev.subtitle || null,
    };
  }

  return null;
}

// ─── Check-in writes ────────────────────────────────────────────────────────

/**
 * Validate + write a check-in. Stamps the active-event snapshot if one is set.
 * Returns { record, priorVisits } so the kiosk can render the success view.
 */
export async function recordCheckIn(env, input) {
  const gamertag = trimField(input.gamertag, 30);
  const fullName = trimField(input.fullName, 60);
  const email = trimField(input.email, 120);
  const employeeFlag = !!input.employeeFlag;
  const outreachFlag = !employeeFlag && !!input.outreachFlag;

  if (!gamertag || !fullName) {
    return { error: 'gamertag and fullName are required' };
  }

  const active = await getActiveEvent(env);
  const record = {
    id: crypto.randomUUID(),
    gamertag,
    fullName,
    email,
    employeeFlag,
    outreachFlag,
    checkedInAt: new Date().toISOString(),
    eventId: active?.eventId || null,
    eventTitle: active?.title || null,
    eventStartTime: active?.startTime || null,
    eventSource: active?.source || null,
  };

  const identityKey = identityKeyFor(email, gamertag);
  const eventBucketKey = eventBucketKeyFor(record.eventId);

  // Read prior history before appending this new record.
  const priorVisits = await loadHistoryByIndex(env, identityKey);

  await env.CHECKINS.put(`checkin:${record.id}`, JSON.stringify(record));
  await Promise.all([
    appendToIndex(env, identityKey, record.id),
    appendToIndex(env, eventBucketKey, record.id),
  ]);

  return { record, priorVisits };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Kiosk history lookup. Identity is "email if present, else gamertag" — this
 * matches the legacy csg-events worker and the documented behavior in the
 * project's CLAUDE.md.
 */
export async function loadCrossEventHistory(env, email, gamertag) {
  return loadHistoryByIndex(env, identityKeyFor(email, gamertag));
}

/**
 * Load all check-ins associated with a given event bucket. Pass `null` to get
 * the "no active event" bucket. Records are returned oldest→newest.
 *
 * Filtering by date is done in JS after fetch — the KV index is indexed by
 * event, not by time, so a date filter still needs to read every record in
 * the bucket. Acceptable at meetup scale.
 */
export async function loadCheckinsForEvent(env, eventId, { from, to } = {}) {
  const bucketKey = eventBucketKeyFor(eventId);
  const ids = await readIndex(env, bucketKey);
  const records = await hydrateRecords(env, ids);
  return filterByDate(records, from, to);
}

/**
 * Load every check-in in the namespace (no event filter). Used by the admin
 * "All check-ins" CSV export. We walk the KV list rather than iterating event
 * buckets because that handles any orphans cleanly.
 */
export async function loadAllCheckins(env, { from, to } = {}) {
  const ids = [];
  let cursor;
  do {
    const page = await env.CHECKINS.list({ prefix: 'checkin:', cursor });
    for (const k of page.keys) ids.push(k.name.slice('checkin:'.length));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const records = await hydrateRecords(env, ids);
  records.sort((a, b) => (a.checkedInAt || '').localeCompare(b.checkedInAt || ''));
  return filterByDate(records, from, to);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function identityKeyFor(email, gamertag) {
  if (email) return `index:email:${email.toLowerCase()}`;
  return `index:gamertag:${gamertag.toLowerCase()}`;
}

function eventBucketKeyFor(eventId) {
  return `event:${eventId || 'none'}:checkins`;
}

async function readIndex(env, key) {
  const raw = await env.CHECKINS.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendToIndex(env, key, id) {
  const ids = await readIndex(env, key);
  ids.push(id);
  await env.CHECKINS.put(key, JSON.stringify(ids));
}

async function hydrateRecords(env, ids) {
  if (!ids.length) return [];
  const values = await Promise.all(ids.map(id => env.CHECKINS.get(`checkin:${id}`)));
  return values
    .filter(v => v != null)
    .map(v => {
      try { return JSON.parse(v); } catch { return null; }
    })
    .filter(Boolean);
}

async function loadHistoryByIndex(env, key) {
  const ids = await readIndex(env, key);
  // Cap kiosk-facing history at the most recent N to keep the response small.
  const recent = ids.slice(-MAX_KIOSK_HISTORY);
  return hydrateRecords(env, recent);
}

function filterByDate(records, from, to) {
  if (!from && !to) return records;
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;
  return records.filter(r => {
    const t = Date.parse(r.checkedInAt || '');
    if (Number.isNaN(t)) return false;
    if (fromMs != null && t < fromMs) return false;
    if (toMs != null && t > toMs) return false;
    return true;
  });
}

function trimField(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}
