/**
 * Event-publish request queue. State lives in CONTENT KV under
 * `event_publish_requests` as a map keyed by Discord interaction id (snowflake).
 *
 * Decision pathway (applyDecision) is the single point where a request
 * transitions out of pending — used by both the button-click handler and
 * the admin SPA reconciliation. It calls setOverlay() to flip the public
 * publish flag and edits the originating Discord channel message.
 */

import { getDiscordEventsWithArchive, setOverlay, getOverlays } from './discord-events.js';
import { editChannelMessage } from './discord-outbound.js';

const KEY = 'event_publish_requests';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function getAll(env) {
  const raw = await env.CONTENT.get(KEY);
  const map = raw ? JSON.parse(raw) : {};
  const now = Date.now();
  let pruned = false;
  for (const id of Object.keys(map)) {
    const r = map[id];
    const decidedAt = r.decidedAt ? new Date(r.decidedAt).getTime() : null;
    if (decidedAt && now - decidedAt > MAX_AGE_MS) {
      delete map[id];
      pruned = true;
    }
  }
  if (pruned) {
    await env.CONTENT.put(KEY, JSON.stringify(map));
  }
  return map;
}

export async function getPending(env) {
  const map = await getAll(env);
  return Object.values(map)
    .filter(r => r.status === 'pending')
    .sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt));
}

export async function getPendingByEventId(env, eventId) {
  const map = await getAll(env);
  return Object.values(map).find(r => r.eventId === eventId && r.status === 'pending') || null;
}

export async function getById(env, id) {
  const map = await getAll(env);
  return map[id] || null;
}

export async function create(env, { id, eventId, requestedBy, channelId, channelMessageId }) {
  const map = await getAll(env);
  map[id] = {
    id,
    eventId,
    requestedBy,
    requestedAt: new Date().toISOString(),
    status: 'pending',
    channelId,
    channelMessageId,
  };
  await env.CONTENT.put(KEY, JSON.stringify(map));
  return map[id];
}

/**
 * Single decision pathway. Idempotent: re-deciding a non-pending request
 * returns { alreadyDecided: true, prior } without further side effects.
 *
 * Steps:
 *   1. Mark the request decided in KV.
 *   2. If approved, re-fetch live events; if event is still SCHEDULED/ACTIVE,
 *      flip the overlay published flag (preserving existing button overrides).
 *      If the event has been canceled or removed, downgrade to denied with a
 *      synthetic decidedBy={id:'system'}.
 *   3. Edit the originating Discord channel message to strip the buttons and
 *      append a status footer. Failure here is logged but not fatal — the
 *      decision still applies.
 */
export async function applyDecision(env, id, status, decidedBy) {
  const map = await getAll(env);
  const req = map[id];
  if (!req) return { error: 'not_found' };
  if (req.status !== 'pending') return { alreadyDecided: true, prior: req };

  let finalStatus = status;
  let finalDecidedBy = decidedBy;
  let downgradeReason = null;

  if (status === 'approved') {
    // Re-validate event still exists and is publishable.
    const { live, archived } = await getDiscordEventsWithArchive(env);
    const all = [...live, ...archived];
    const event = all.find(e => e.id === req.eventId);
    if (!event || event.status === 'CANCELED') {
      finalStatus = 'denied';
      finalDecidedBy = { id: 'system', displayName: 'system' };
      downgradeReason = event ? 'event canceled' : 'event no longer exists';
    } else {
      // Preserve existing button overrides; only flip published.
      const overlays = await getOverlays(env);
      const existing = overlays[req.eventId] || {};
      await setOverlay(env, req.eventId, {
        published: true,
        actionButtonText: existing.actionButtonText || null,
        actionButtonUrl: existing.actionButtonUrl || null,
        eventButtonText: existing.eventButtonText || null,
        eventButtonUrl: existing.eventButtonUrl || null,
      });
    }
  }

  // Mark the request decided
  map[id] = {
    ...req,
    status: finalStatus,
    decidedBy: finalDecidedBy,
    decidedAt: new Date().toISOString(),
    ...(downgradeReason ? { downgradeReason } : {}),
  };
  await env.CONTENT.put(KEY, JSON.stringify(map));

  // Best-effort: update the originating Discord message so officers see the
  // outcome where they decided.
  if (req.channelId && req.channelMessageId) {
    const verb = finalStatus === 'approved' ? 'Approved' : 'Denied';
    const decidedTime = formatCentral(map[id].decidedAt);
    const footer = downgradeReason
      ? `**${verb} (${downgradeReason})** at ${decidedTime}`
      : `**${verb}** by ${escapeMarkdown(finalDecidedBy.displayName || finalDecidedBy.id)} · ${decidedTime}`;

    await editChannelMessage(env, req.channelId, req.channelMessageId, {
      content: footer,
      components: [],
    });
  }

  return { decided: map[id] };
}

function escapeMarkdown(s) {
  return String(s).replace(/[*_`~|\\]/g, ch => '\\' + ch);
}

function formatCentral(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(d);
  const get = type => parts.find(p => p.type === type)?.value || '';
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}
