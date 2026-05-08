/**
 * Streamer registry. State lives in CONTENT KV under two keys:
 *   - `streamers`            map keyed by Discord user ID (canonical record)
 *   - `streamers_by_twitch`  map keyed by Twitch user ID → Discord user ID
 *
 * The reverse index lets the Twitch EventSub webhook look up the owning
 * Discord user without scanning the full streamers map. Both keys are written
 * atomically by upsert/remove; do not edit one without the other.
 *
 * Record shape:
 *   {
 *     discordId, discordUsername, displayName,
 *     registeredAt, updatedAt,
 *     twitch: { userId, login, displayName, eventSubIds: { online: '...', offline: '...' } },
 *     youtube?: { channelId, name }   // stored from connections but not watched in v1
 *   }
 */

const REG_KEY = 'streamers';
const TWITCH_INDEX_KEY = 'streamers_by_twitch';

export async function getAll(env) {
  const raw = await env.CONTENT.get(REG_KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function getByDiscordId(env, discordId) {
  const all = await getAll(env);
  return all[discordId] || null;
}

export async function getByTwitchUserId(env, twitchUserId) {
  const indexRaw = await env.CONTENT.get(TWITCH_INDEX_KEY);
  const index = indexRaw ? JSON.parse(indexRaw) : {};
  const discordId = index[twitchUserId];
  if (!discordId) return null;
  return getByDiscordId(env, discordId);
}

/**
 * Upsert a streamer record. If the prior record had a Twitch user ID different
 * from the new one, the reverse index is updated to drop the old entry.
 */
export async function upsert(env, record) {
  const all = await getAll(env);
  const prior = all[record.discordId] || null;
  const next = {
    ...prior,
    ...record,
    updatedAt: new Date().toISOString(),
    registeredAt: prior?.registeredAt || new Date().toISOString(),
  };
  all[record.discordId] = next;
  await env.CONTENT.put(REG_KEY, JSON.stringify(all));

  const indexRaw = await env.CONTENT.get(TWITCH_INDEX_KEY);
  const index = indexRaw ? JSON.parse(indexRaw) : {};
  const priorTwitchId = prior?.twitch?.userId;
  const nextTwitchId = next.twitch?.userId;
  let indexDirty = false;
  if (priorTwitchId && priorTwitchId !== nextTwitchId) {
    delete index[priorTwitchId];
    indexDirty = true;
  }
  if (nextTwitchId && index[nextTwitchId] !== record.discordId) {
    index[nextTwitchId] = record.discordId;
    indexDirty = true;
  }
  if (indexDirty) await env.CONTENT.put(TWITCH_INDEX_KEY, JSON.stringify(index));

  return next;
}

export async function remove(env, discordId) {
  const all = await getAll(env);
  const prior = all[discordId];
  if (!prior) return null;
  delete all[discordId];
  await env.CONTENT.put(REG_KEY, JSON.stringify(all));

  if (prior.twitch?.userId) {
    const indexRaw = await env.CONTENT.get(TWITCH_INDEX_KEY);
    const index = indexRaw ? JSON.parse(indexRaw) : {};
    if (index[prior.twitch.userId] === discordId) {
      delete index[prior.twitch.userId];
      await env.CONTENT.put(TWITCH_INDEX_KEY, JSON.stringify(index));
    }
  }
  return prior;
}
