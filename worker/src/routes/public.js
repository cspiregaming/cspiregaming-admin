import { fetchGuildMembers } from '../discord.js';

const MEMBERS_CACHE_TTL = 300; // 5 minutes

export async function handlePublicMembers(request, env) {
  const guildId = (await env.CONFIG.get('guild_id')) || env.GUILD_ID || '379707231077138442';

  // Load configured role IDs from KV (set via admin UI)
  const roleIdsRaw = await env.CONFIG.get('role_ids');
  const roleIds = roleIdsRaw ? JSON.parse(roleIdsRaw) : [];

  if (!roleIds.length) {
    return jsonResponse({ members: [], roles: [], totalMembers: 0, fetchedAt: new Date().toISOString() });
  }

  // Check cache
  const cacheKey = `members_${guildId}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return jsonResponse(cached);

  // Fetch from Discord
  const data = await fetchGuildMembers(env, guildId, roleIds);

  // Store in KV with TTL
  await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: MEMBERS_CACHE_TTL });

  return jsonResponse(data);
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
