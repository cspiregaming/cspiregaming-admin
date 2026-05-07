import { fetchGuildMembers } from '../discord.js';

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
  const [officersRaw, eventsRaw, socialRaw] = await Promise.all([
    env.CONTENT.get('officers'),
    env.CONTENT.get('events'),
    env.CONTENT.get('social'),
  ]);

  return jsonResponse({
    officers: officersRaw ? JSON.parse(officersRaw) : [],
    events: eventsRaw ? JSON.parse(eventsRaw) : [],
    social: socialRaw ? JSON.parse(socialRaw) : {},
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
