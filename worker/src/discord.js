const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Fetch all members of a guild who have at least one of the specified roles.
 * Uses the bot token stored as a Worker secret.
 * Returns { members, roles, fetchedAt } shaped for the public API.
 */
export async function fetchGuildMembers(env, guildId, roleIds) {
  const botToken = env.BOT_TOKEN;
  if (!botToken) throw new Error('BOT_TOKEN secret is not configured');

  // Fetch all guild members (up to 1000; paginate if needed)
  const members = await fetchAllMembers(botToken, guildId);

  // Fetch role metadata so we can attach names/colors
  const rolesRes = await discordFetch(`/guilds/${guildId}/roles`, botToken);
  if (!rolesRes.ok) throw new Error(`Discord roles fetch failed: ${rolesRes.status}`);
  const allRoles = await rolesRes.json();

  // Build role lookup and filter to only the configured roles
  const roleSet = new Set(roleIds);
  const relevantRoles = allRoles
    .filter(r => roleSet.has(r.id))
    .map(r => ({
      id: r.id,
      name: r.name,
      position: r.position,
      color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null,
    }))
    .sort((a, b) => b.position - a.position);

  // Filter members to only those with at least one relevant role
  const filteredMembers = members
    .filter(m => m.roles.some(rid => roleSet.has(rid)))
    .map(m => ({
      username: m.user.username,
      displayName: m.nick || m.user.global_name || m.user.username,
      avatar: resolveAvatar(m.user),
      roles: m.roles.filter(rid => roleSet.has(rid)),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    members: filteredMembers,
    roles: relevantRoles,
    totalMembers: filteredMembers.length,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch the guild's scheduled events. Discord returns SCHEDULED, ACTIVE, and
 * recently-COMPLETED/CANCELED events; older completed events fall off the API.
 */
export async function fetchGuildScheduledEvents(env, guildId) {
  const botToken = env.BOT_TOKEN;
  if (!botToken) throw new Error('BOT_TOKEN secret is not configured');

  const res = await discordFetch(`/guilds/${guildId}/scheduled-events`, botToken);
  if (!res.ok) throw new Error(`Discord scheduled-events fetch failed: ${res.status}`);
  const raw = await res.json();

  return raw.map(ev => normalizeScheduledEvent(ev, guildId));
}

const DISCORD_EVENT_STATUS = {
  1: 'SCHEDULED',
  2: 'ACTIVE',
  3: 'COMPLETED',
  4: 'CANCELED',
};

export function normalizeScheduledEvent(ev, guildId) {
  return {
    id: ev.id,
    title: ev.name,
    description: ev.description || '',
    startTime: ev.scheduled_start_time,
    endTime: ev.scheduled_end_time || null,
    status: DISCORD_EVENT_STATUS[ev.status] || 'SCHEDULED',
    location: ev.entity_metadata?.location || null,
    coverImage: ev.image
      ? `https://cdn.discordapp.com/guild-events/${ev.id}/${ev.image}.png?size=1024`
      : null,
    discordUrl: `https://discord.com/events/${guildId}/${ev.id}`,
  };
}

async function fetchAllMembers(botToken, guildId) {
  const all = [];
  let after = '0';

  while (true) {
    const res = await discordFetch(
      `/guilds/${guildId}/members?limit=1000&after=${after}`,
      botToken
    );
    if (!res.ok) throw new Error(`Discord members fetch failed: ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }

  return all;
}

function discordFetch(path, botToken) {
  return fetch(DISCORD_API + path, {
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
  });
}

function resolveAvatar(user) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
  }
  // Default Discord avatar based on discriminator or pomelo index
  const index = user.discriminator === '0'
    ? Number(BigInt(user.id) >> 22n) % 6
    : parseInt(user.discriminator) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Exchange an OAuth2 code for an access token, then fetch the user's guild member record
 * to verify they have the required admin role.
 */
export async function discordOAuthExchange(env, code, redirectUri) {
  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;

  const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) throw new Error(`OAuth token exchange failed: ${tokenRes.status}`);
  const tokenData = await tokenRes.json();

  // Fetch the authenticated user
  const userRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) throw new Error(`Failed to fetch Discord user: ${userRes.status}`);
  const user = await userRes.json();

  // Fetch their guild member record to check roles
  const memberRes = await fetch(
    `https://discord.com/api/v10/users/@me/guilds/${env.GUILD_ID || '379707231077138442'}/member`,
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
  );
  if (!memberRes.ok) throw new Error(`User is not a member of the guild: ${memberRes.status}`);
  const member = await memberRes.json();

  return { user, member, accessToken: tokenData.access_token };
}
