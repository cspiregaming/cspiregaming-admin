/**
 * Public-roster opt-outs. State lives in CONTENT KV under a single key,
 * `public_member_opt_outs`, as a JSON object keyed by Discord user ID:
 *
 *   { "<discordId>": { discordId, optedOutAt, source: 'self'|'officer', actorId? } }
 *
 * Public-site listing is *opt-in by role* — anyone with one of the roles in
 * `CONFIG:role_ids` shows up. This map carves out individual members who've
 * asked to be hidden (either via `/toggle-public-membership` or via the
 * Members admin view).
 *
 * Filtering happens at response time in the public route, not at cache
 * write — so toggling takes effect immediately without busting the 5-min
 * member cache.
 */

const KEY = 'public_member_opt_outs';

export async function getAll(env) {
  const raw = await env.CONTENT.get(KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function getOptedOutIds(env) {
  return new Set(Object.keys(await getAll(env)));
}

export async function setOptedOut(env, discordId, info = {}) {
  const all = await getAll(env);
  all[discordId] = {
    discordId,
    optedOutAt: new Date().toISOString(),
    ...info,
  };
  await env.CONTENT.put(KEY, JSON.stringify(all));
  return all[discordId];
}

export async function clearOptedOut(env, discordId) {
  const all = await getAll(env);
  if (!all[discordId]) return false;
  delete all[discordId];
  await env.CONTENT.put(KEY, JSON.stringify(all));
  return true;
}

export async function toggle(env, discordId, info = {}) {
  const all = await getAll(env);
  if (all[discordId]) {
    delete all[discordId];
    await env.CONTENT.put(KEY, JSON.stringify(all));
    return { optedOut: false };
  }
  all[discordId] = {
    discordId,
    optedOutAt: new Date().toISOString(),
    ...info,
  };
  await env.CONTENT.put(KEY, JSON.stringify(all));
  return { optedOut: true, record: all[discordId] };
}
