/**
 * Statbot Premium REST client. Authenticated with a guild-scoped API key
 * minted from the Statbot dashboard (Server Settings → Developers → API Key).
 *
 * The public docs at https://docs.statbot.net/docs/api/ list the endpoint
 * paths but don't fully document query parameters or response shapes. The
 * functions below pass the parameters Statbot's UI surfaces (`before`,
 * `after`, `limit`, `full`) and return the parsed JSON as-is — callers are
 * responsible for tolerating shape drift.
 */

const STATBOT_API_BASE = 'https://api.statbot.net';

// Query params per https://docs.statbot.net/docs/api/ — all Tops endpoints share:
//   start, end          unix-ms timestamps (inclusive window bounds)
//   interval            hour | day | week | month (defaults to day)
//   timezone_offset     hours from UTC (so day boundaries align with Central)

export async function fetchTopMessageChannels(env, params) {
  return statbotGet(env, `/v1/guilds/${env.GUILD_ID}/messages/tops/channels`, params);
}

export async function fetchTopMessageMembers(env, params) {
  return statbotGet(env, `/v1/guilds/${env.GUILD_ID}/messages/tops/members`, params);
}

export async function fetchMessageSums(env, params) {
  return statbotGet(env, `/v1/guilds/${env.GUILD_ID}/messages/sums`, params);
}

export function msDaysAgo(days, now = Date.now()) {
  return now - days * 24 * 60 * 60 * 1000;
}

async function statbotGet(env, path, params) {
  if (!env.STATBOT_API_KEY) {
    return { ok: false, status: 0, error: 'STATBOT_API_KEY not configured' };
  }

  const url = new URL(STATBOT_API_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${env.STATBOT_API_KEY}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    console.error(`statbot: GET ${path} fetch failed`, err);
    return { ok: false, status: 0, error: String(err) };
  }

  let json = null;
  try { json = await res.json(); } catch { /* may be empty */ }

  if (!res.ok) {
    console.error(`statbot: GET ${path} → ${res.status}`, json);
    return { ok: false, status: res.status, error: json?.message || res.statusText, json };
  }

  return { ok: true, status: res.status, json };
}
