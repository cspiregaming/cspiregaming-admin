/**
 * New-member welcome DM.
 *
 * Every cron tick this function fetches the current guild member list, diffs
 * it against a KV snapshot, and DMs anyone who joined since the last tick.
 * Bots are excluded. The snapshot is updated before DMs are sent so a failed
 * DM doesn't produce a retry storm on the next minute tick.
 *
 * First-run bootstrap: if no snapshot exists yet, the current member list is
 * saved as the baseline and no DMs are sent. This prevents mass-DMing the
 * entire server on first deploy.
 *
 * KV keys:
 *   welcome_config           { enabled, message }
 *   welcome_member_snapshot  JSON array of member IDs (the known set)
 */

import { sendDirectMessage } from './discord-outbound.js';

const SNAPSHOT_KEY = 'welcome_member_snapshot';
const CONFIG_KEY = 'welcome_config';

export const DEFAULT_WELCOME_MESSAGE =
`👋 Welcome to **C Spire Gaming Club**, {displayName}!

We're a community of gamers at C Spire. Here are a few things to get you started:

📺 **Channels worth checking out**
• #general-gaming — main hangout
• #daily-games — Wordle, Connections & more
• #bot-commands — bot stuff goes here

🎮 **Customize your profile**
Head to #bot-commands and use the roles command to pick your gaming interests.

❓ **Need help?**
Tag any officer in #general-gaming and someone will help you out.

See you in the server!`;

export async function maybeWelcomeNewMembers(env) {
  if (!env.BOT_TOKEN || !env.GUILD_ID) return;

  const [rawSnapshot, rawConfig] = await Promise.all([
    env.CONFIG.get(SNAPSHOT_KEY),
    env.CONFIG.get(CONFIG_KEY),
  ]);

  const config = rawConfig ? JSON.parse(rawConfig) : {};
  if (config.enabled === false) return;

  let members;
  try {
    members = await fetchNonBotMembers(env);
  } catch (err) {
    console.error('welcome: member fetch failed', err);
    return;
  }

  const currentIds = new Set(members.map(m => m.user.id));

  // First run: save the baseline without sending any DMs.
  if (rawSnapshot === null) {
    await env.CONFIG.put(SNAPSHOT_KEY, JSON.stringify([...currentIds]));
    return;
  }

  const knownIds = new Set(JSON.parse(rawSnapshot));
  const newMembers = members.filter(m => !knownIds.has(m.user.id));

  // Persist the updated snapshot before DMing so a slow or failed DM doesn't
  // trigger a retry on the next tick.
  await env.CONFIG.put(SNAPSHOT_KEY, JSON.stringify([...currentIds]));

  if (!newMembers.length) return;

  const template = config.message || DEFAULT_WELCOME_MESSAGE;

  for (const member of newMembers) {
    const displayName = member.nick || member.user.global_name || member.user.username;
    const content = template.replace(/\{displayName\}/g, displayName);
    try {
      const res = await sendDirectMessage(env, member.user.id, content);
      if (!res.ok) console.error(`welcome: DM failed for ${member.user.id} — ${res.status}`);
    } catch (err) {
      console.error(`welcome: DM error for ${member.user.id}`, err);
    }
  }
}

async function fetchNonBotMembers(env) {
  const all = [];
  let after = '0';
  while (true) {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${env.GUILD_ID}/members?limit=1000&after=${after}`,
      { headers: { Authorization: `Bot ${env.BOT_TOKEN}` } },
    );
    if (!res.ok) throw new Error(`Discord members fetch failed: ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    all.push(...batch.filter(m => !m.user?.bot));
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return all;
}
