/**
 * Outbound Discord API helpers using BOT_TOKEN (parallels read-only discord.js).
 * All helpers return { ok, status, json? } — they log errors but never throw,
 * so callers can decide whether a failure is fatal.
 */

const DISCORD_API = 'https://discord.com/api/v10';

export async function postChannelMessage(env, channelId, payload) {
  return discordRequest(env, 'POST', `/channels/${channelId}/messages`, payload);
}

export async function editChannelMessage(env, channelId, messageId, payload) {
  return discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
}

/**
 * Edit the original interaction response (the deferred message we ack'd with).
 * Discord allows this for up to 15 minutes after the interaction.
 */
export async function editOriginalInteractionResponse(env, applicationId, interactionToken, payload) {
  return discordRequest(env, 'PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, payload);
}

export async function addGuildMemberRole(env, guildId, userId, roleId) {
  return discordRequest(env, 'PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, null);
}

export async function removeGuildMemberRole(env, guildId, userId, roleId) {
  return discordRequest(env, 'DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, null);
}

async function discordRequest(env, method, path, payload) {
  const botToken = env.BOT_TOKEN;
  if (!botToken) {
    console.error('discord-outbound: BOT_TOKEN missing');
    return { ok: false, status: 0 };
  }

  let res;
  try {
    res = await fetch(DISCORD_API + path, {
      method,
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: payload != null ? JSON.stringify(payload) : undefined,
    });
  } catch (err) {
    console.error(`discord-outbound: ${method} ${path} fetch failed`, err);
    return { ok: false, status: 0 };
  }

  let json = null;
  if (res.status !== 204) {
    try { json = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok) {
    console.error(`discord-outbound: ${method} ${path} → ${res.status}`, json);
  }
  return { ok: res.ok, status: res.status, json };
}
