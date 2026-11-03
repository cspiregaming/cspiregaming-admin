import { fetchGuildMembers } from '../discord.js';
import { getDiscordEventsWithArchive, getOverlays } from '../discord-events.js';
import { getOptedOutIds } from '../member-opt-outs.js';

const MEMBERS_CACHE_TTL = 300; // 5 minutes

export async function handlePublicMembers(request, env) {
  const guildId = env.GUILD_ID;

  // Load configured role IDs and default selection from KV (set via admin UI)
  const [roleIdsRaw, defaultRoleIdRaw, optedOut] = await Promise.all([
    env.CONFIG.get('role_ids'),
    env.CONFIG.get('default_role_id'),
    getOptedOutIds(env),
  ]);
  const roleIds = roleIdsRaw ? JSON.parse(roleIdsRaw) : [];
  let defaultRoleId;
  if (defaultRoleIdRaw === 'random' && roleIds.length) {
    // Pick a different enabled role on each request so the public Members
    // section opens to a varied chip on page load.
    defaultRoleId = roleIds[Math.floor(Math.random() * roleIds.length)];
  } else if (defaultRoleIdRaw && roleIds.includes(defaultRoleIdRaw)) {
    defaultRoleId = defaultRoleIdRaw;
  } else {
    defaultRoleId = null;
  }

  if (!roleIds.length) {
    return jsonResponse({ members: [], roles: [], totalMembers: 0, defaultRoleId, fetchedAt: new Date().toISOString() });
  }

  // Check cache. Opt-outs are filtered at response time so toggling doesn't
  // require a cache bust — the cached payload still contains every role-bearing
  // member, and we mask the opted-out ones on the way out.
  const cacheKey = `members_${guildId}`;
  let payload = await env.CACHE.get(cacheKey, 'json');
  if (!payload) {
    payload = await fetchGuildMembers(env, guildId, roleIds);
    await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: MEMBERS_CACHE_TTL });
  }

  return jsonResponse({
    ...payload,
    ...filterOptOuts(payload, optedOut),
    defaultRoleId,
  });
}

function filterOptOuts(payload, optedOut) {
  if (!optedOut.size) {
    // Strip ids from the public response — they're load-bearing for opt-out
    // filtering on the server but not needed by the public site.
    return { members: (payload.members || []).map(stripId), totalMembers: payload.totalMembers };
  }
  const visible = (payload.members || [])
    .filter(m => !optedOut.has(m.id))
    .map(stripId);
  return { members: visible, totalMembers: visible.length };
}

function stripId({ id, ...rest }) {
  return rest;
}

export async function handlePublicContent(request, env) {
  const [officersRaw, manualEventsRaw, socialRaw, discordEvents, overlays] = await Promise.all([
    env.CONTENT.get('officers'),
    env.CONTENT.get('events'),
    env.CONTENT.get('social'),
    getDiscordEventsWithArchive(env).catch(() => ({ live: [], archived: [] })),
    getOverlays(env),
  ]);

  const manualEvents = (manualEventsRaw ? JSON.parse(manualEventsRaw) : [])
    .map(ev => ({ ...ev, source: 'manual' }));

  const publishedDiscord = [...discordEvents.live, ...discordEvents.archived]
    .filter(ev => overlays[ev.id]?.published)
    // Drop canceled events — even if published, we shouldn't show them.
    .filter(ev => ev.status !== 'CANCELED')
    .map(ev => {
      const overlay = overlays[ev.id] || {};
      return {
        source: 'discord',
        id: ev.id,
        title: ev.title,
        description: ev.description,
        startTime: ev.startTime,
        endTime: ev.endTime,
        status: ev.status,
        location: ev.location,
        coverImage: ev.coverImage,
        discordUrl: ev.discordUrl,
        actionButtonText: overlay.actionButtonText || null,
        actionButtonUrl: overlay.actionButtonUrl || null,
        eventButtonText: overlay.eventButtonUrl ? (overlay.eventButtonText || 'RSVP') : null,
        eventButtonUrl: overlay.eventButtonUrl || null,
      };
    });

  // Order: upcoming/active first by startTime asc, completed last by startTime desc.
  const events = [...publishedDiscord, ...manualEvents].sort(eventSortKey);

  return jsonResponse({
    officers: officersRaw ? JSON.parse(officersRaw) : [],
    events,
    social: socialRaw ? JSON.parse(socialRaw) : {},
  });
}

function eventSortKey(a, b) {
  const aPast = a.status === 'COMPLETED';
  const bPast = b.status === 'COMPLETED';
  if (aPast !== bPast) return aPast ? 1 : -1; // upcoming/active before past
  const at = a.startTime ? new Date(a.startTime).getTime() : 0;
  const bt = b.startTime ? new Date(b.startTime).getTime() : 0;
  return aPast ? bt - at : at - bt;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
