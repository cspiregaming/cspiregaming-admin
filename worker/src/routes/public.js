import { fetchGuildMembers } from '../discord.js';
import { getDiscordEventsWithArchive, getOverlays } from '../discord-events.js';

const MEMBERS_CACHE_TTL = 300; // 5 minutes

export async function handlePublicMembers(request, env) {
  const guildId = env.GUILD_ID;

  // Load configured role IDs and default selection from KV (set via admin UI)
  const [roleIdsRaw, defaultRoleIdRaw] = await Promise.all([
    env.CONFIG.get('role_ids'),
    env.CONFIG.get('default_role_id'),
  ]);
  const roleIds = roleIdsRaw ? JSON.parse(roleIdsRaw) : [];
  const defaultRoleId = defaultRoleIdRaw && roleIds.includes(defaultRoleIdRaw)
    ? defaultRoleIdRaw
    : null;

  if (!roleIds.length) {
    return jsonResponse({ members: [], roles: [], totalMembers: 0, defaultRoleId, fetchedAt: new Date().toISOString() });
  }

  // Check cache
  const cacheKey = `members_${guildId}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return jsonResponse({ ...cached, defaultRoleId });

  // Fetch from Discord
  const data = await fetchGuildMembers(env, guildId, roleIds);

  // Store in KV with TTL (defaultRoleId is layered on at response time so
  // changing it doesn't require invalidating the member roster cache)
  await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: MEMBERS_CACHE_TTL });

  return jsonResponse({ ...data, defaultRoleId });
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
