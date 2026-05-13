/**
 * Event check-in routes.
 *
 * Public (kiosk):
 *   POST /api/checkin                         → record a visit, return prior visits
 *
 * Admin (officer-gated):
 *   GET  /api/admin/checkins/active-event     → current snapshot or null
 *   PUT  /api/admin/checkins/active-event     → body { eventId, source }
 *   DEL  /api/admin/checkins/active-event     → clear active event
 *   GET  /api/admin/checkins/event-candidates → { discord, manual }
 *   GET  /api/admin/checkins                  → list (filter by eventId/date/format)
 */
import { requireOfficer } from '../auth.js';
import {
  buildEventSnapshot,
  clearActiveEvent,
  getActiveEvent,
  loadAllCheckins,
  loadCheckinsForEvent,
  recordCheckIn,
  setActiveEvent,
} from '../checkins.js';
import { getDiscordEventsWithArchive } from '../discord-events.js';

// ─── Public ─────────────────────────────────────────────────────────────────

export async function handlePublicCheckIn(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const result = await recordCheckIn(env, body || {});
  if (result.error) return jsonResponse({ error: result.error }, 400);

  return jsonResponse({ checkin: result.record, priorVisits: result.priorVisits });
}

// ─── Admin: active event ────────────────────────────────────────────────────

export async function handleAdminActiveEvent(request, env) {
  const session = await requireOfficer(request, env);

  if (request.method === 'GET') {
    return jsonResponse({ activeEvent: await getActiveEvent(env) });
  }

  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const eventId = (body?.eventId || '').trim();
    const source = body?.source;
    if (!eventId || (source !== 'discord' && source !== 'manual')) {
      return jsonResponse({ error: 'Body must be { eventId, source: "discord" | "manual" }' }, 400);
    }

    const snapshot = await buildEventSnapshot(env, { eventId, source });
    if (!snapshot) {
      return jsonResponse({ error: `Event ${eventId} not found in ${source} events` }, 404);
    }

    const stored = await setActiveEvent(env, {
      ...snapshot,
      activatedAt: new Date().toISOString(),
      activatedBy: { id: session.sub, displayName: session.displayName || session.username },
    });
    return jsonResponse({ activeEvent: stored });
  }

  if (request.method === 'DELETE') {
    await clearActiveEvent(env);
    return jsonResponse({ activeEvent: null });
  }

  return methodNotAllowed();
}

// ─── Admin: event candidates ────────────────────────────────────────────────

/**
 * Returns the pool of events the active-event picker can select from:
 * live + recently-archived Discord events, plus curated manual events.
 * Same data sources the existing Events admin view already consumes.
 */
export async function handleAdminEventCandidates(request, env) {
  await requireOfficer(request, env);
  if (request.method !== 'GET') return methodNotAllowed();

  const [{ live, archived }, manualRaw] = await Promise.all([
    getDiscordEventsWithArchive(env).catch(() => ({ live: [], archived: [] })),
    env.CONTENT.get('events'),
  ]);

  const manual = manualRaw ? JSON.parse(manualRaw) : [];

  return jsonResponse({
    discord: {
      live: live.map(toDiscordCandidate),
      archived: archived.map(toDiscordCandidate),
    },
    manual: manual.map(toManualCandidate),
  });
}

function toDiscordCandidate(ev) {
  return {
    id: ev.id,
    title: ev.title,
    startTime: ev.startTime || null,
    status: ev.status || null,
  };
}

function toManualCandidate(ev) {
  return {
    id: ev.id,
    title: ev.title || '',
    subtitle: ev.subtitle || null,
  };
}

// ─── Admin: check-ins list / export ─────────────────────────────────────────

export async function handleAdminCheckins(request, env) {
  await requireOfficer(request, env);
  if (request.method !== 'GET') return methodNotAllowed();

  const url = new URL(request.url);
  const eventIdParam = url.searchParams.get('eventId');
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;
  const format = url.searchParams.get('format') || 'json';

  // `eventId=all` (or absent) → every record. `eventId=none` → unaffiliated bucket.
  // Anything else → that specific event bucket.
  let records;
  if (!eventIdParam || eventIdParam === 'all') {
    records = await loadAllCheckins(env, { from, to });
  } else {
    const bucket = eventIdParam === 'none' ? null : eventIdParam;
    records = await loadCheckinsForEvent(env, bucket, { from, to });
  }

  if (format === 'csv') {
    return new Response(toCsv(records), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${csvFilename(eventIdParam)}"`,
      },
    });
  }

  return jsonResponse({ checkins: records, count: records.length });
}

function toCsv(records) {
  const header = [
    'id',
    'checkedInAt',
    'gamertag',
    'fullName',
    'email',
    'employeeFlag',
    'outreachFlag',
    'eventId',
    'eventTitle',
    'eventStartTime',
    'eventSource',
  ];
  const lines = [header.join(',')];
  for (const r of records) {
    lines.push([
      r.id,
      r.checkedInAt,
      r.gamertag,
      r.fullName,
      r.email,
      r.employeeFlag ? 'true' : 'false',
      r.outreachFlag ? 'true' : 'false',
      r.eventId || '',
      r.eventTitle || '',
      r.eventStartTime || '',
      r.eventSource || '',
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvFilename(eventIdParam) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (!eventIdParam || eventIdParam === 'all') return `checkins-all-${stamp}.csv`;
  if (eventIdParam === 'none') return `checkins-unaffiliated-${stamp}.csv`;
  return `checkins-${eventIdParam}-${stamp}.csv`;
}

// ─── Shared ─────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function methodNotAllowed() {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
