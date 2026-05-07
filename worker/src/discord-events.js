import { fetchGuildScheduledEvents } from './discord.js';

const LIVE_CACHE_KEY = 'discord_events_live';
const LIVE_CACHE_TTL = 300; // 5 minutes
const ARCHIVE_KEY = 'past_discord_events';
const ARCHIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Returns combined live + recently-archived Discord scheduled events, refreshing
 * the archive on the way through (events that disappeared from live or completed
 * are snapshotted for up to 30 days). Only canceled events are excluded from
 * archiving.
 *
 * Result shape: { live: [...], archived: [...], all: [...] }
 *
 * Note: this mutates KV (CONTENT:past_discord_events) as a side effect of every
 * call, but only when the live cache misses — so at most once every 5 minutes.
 */
export async function getDiscordEventsWithArchive(env) {
  const guildId = env.GUILD_ID;

  // Load live (with cache)
  let live = await env.CACHE.get(LIVE_CACHE_KEY, 'json');
  let cacheMissed = false;
  if (!live) {
    live = await fetchGuildScheduledEvents(env, guildId);
    await env.CACHE.put(LIVE_CACHE_KEY, JSON.stringify(live), { expirationTtl: LIVE_CACHE_TTL });
    cacheMissed = true;
  }

  // Load archive
  const archiveRaw = await env.CONTENT.get(ARCHIVE_KEY);
  const archive = archiveRaw ? JSON.parse(archiveRaw) : {};

  if (cacheMissed) {
    const now = Date.now();
    const liveById = new Map(live.map(ev => [ev.id, ev]));
    let archiveDirty = false;

    // Snapshot any live event that has completed
    for (const ev of live) {
      if (ev.status === 'COMPLETED' && !archive[ev.id]) {
        archive[ev.id] = { ...ev, archivedAt: new Date().toISOString() };
        archiveDirty = true;
      }
    }

    // Snapshot anything previously seen but no longer in live (Discord drops it)
    const seenRaw = await env.CACHE.get('discord_events_seen', 'json');
    if (seenRaw) {
      for (const prev of seenRaw) {
        if (!liveById.has(prev.id) && !archive[prev.id] && prev.status !== 'CANCELED') {
          archive[prev.id] = { ...prev, status: 'COMPLETED', archivedAt: new Date().toISOString() };
          archiveDirty = true;
        }
      }
    }
    // Refresh seen with current live (longer TTL than the live cache so we can
    // detect dropped events even after the live cache expires)
    await env.CACHE.put('discord_events_seen', JSON.stringify(live), {
      expirationTtl: 7 * 24 * 60 * 60, // 7 days
    });

    // Prune archive entries older than the window
    for (const id of Object.keys(archive)) {
      const archivedAt = new Date(archive[id].archivedAt).getTime();
      if (Number.isNaN(archivedAt) || now - archivedAt > ARCHIVE_WINDOW_MS) {
        delete archive[id];
        archiveDirty = true;
      }
    }

    if (archiveDirty) {
      await env.CONTENT.put(ARCHIVE_KEY, JSON.stringify(archive));
    }
  }

  // Build archived list (those not currently in live, since live wins for dupes)
  const liveIds = new Set(live.map(ev => ev.id));
  const archived = Object.values(archive).filter(ev => !liveIds.has(ev.id));

  return { live, archived, all: [...live, ...archived] };
}

export async function getOverlays(env) {
  const raw = await env.CONTENT.get('discord_event_overlays');
  return raw ? JSON.parse(raw) : {};
}

export async function setOverlay(env, eventId, overlay) {
  const overlays = await getOverlays(env);
  applyOverlay(overlays, eventId, overlay);
  await env.CONTENT.put('discord_event_overlays', JSON.stringify(overlays));
  return overlays;
}

/**
 * Replace the overlay map for the given event IDs in a single read-modify-write.
 * Pass an object keyed by event ID; entries whose `published` is falsy AND have
 * no action button fields are removed, otherwise they overwrite the existing
 * entry. Event IDs not in `updates` are left untouched.
 */
export async function setOverlaysBatch(env, updates) {
  const overlays = await getOverlays(env);
  for (const [eventId, overlay] of Object.entries(updates)) {
    applyOverlay(overlays, eventId, overlay);
  }
  await env.CONTENT.put('discord_event_overlays', JSON.stringify(overlays));
  return overlays;
}

function applyOverlay(overlays, eventId, overlay) {
  const next = {
    published: !!overlay.published,
    actionButtonText: overlay.actionButtonText || null,
    actionButtonUrl: overlay.actionButtonUrl || null,
  };
  if (!next.published && !next.actionButtonText && !next.actionButtonUrl) {
    delete overlays[eventId];
  } else {
    overlays[eventId] = next;
  }
}
