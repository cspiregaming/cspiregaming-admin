/**
 * Cron-driven poller for #daily-games board grading.
 *
 * Runs on the worker's scheduled trigger. Each tick:
 *   1. Reads `daily_games_last_seen` from CONTENT KV (a Discord message ID).
 *   2. Fetches messages in DAILY_GAMES_CHANNEL_ID newer than that ID.
 *   3. Skips bot authors and any message that doesn't parse as a known board.
 *   4. Reacts with the grade emoji on each parseable message.
 *   5. Updates the high-water mark to the newest message ID seen.
 *
 * The high-water mark is intentionally advanced to the newest message ID even
 * if some messages didn't parse — we don't want to re-poll the whole channel
 * every minute looking for graders we'll never apply. Reactions on the same
 * message are idempotent (Discord ignores duplicate same-emoji-from-same-user
 * PUTs), so a re-run by hand wouldn't double-stamp.
 *
 * On first run (no high-water mark) the scheduler grabs the most recent
 * message ID and stops there — we don't backfill historical posts.
 */

import { fetchRecentMessages } from './discord.js';
import { addReaction } from './discord-outbound.js';
import { gradeMessage } from './games-grader.js';
import { loadGraderConfig } from './grader-config.js';

const STATE_KEY = 'daily_games_last_seen';

export async function runDailyGamesGrader(env) {
  const channelId = env.DAILY_GAMES_CHANNEL_ID;
  if (!channelId) {
    console.error('games-grader: DAILY_GAMES_CHANNEL_ID not set; tick skipped');
    return;
  }

  const [lastSeen, graderConfig] = await Promise.all([
    env.CONTENT.get(STATE_KEY),
    loadGraderConfig(env),
  ]);

  let messages;
  try {
    messages = await fetchRecentMessages(env, channelId, { after: lastSeen, limit: 100 });
  } catch (err) {
    console.error('games-grader: fetch failed', err);
    return;
  }

  if (!messages.length) {
    return;
  }

  // Discord returns newest-first; iterate oldest-first so reactions land in
  // post order if any of them are slow.
  const ordered = [...messages].sort((a, b) => snowflakeCompare(a.id, b.id));

  // First-run guard: if there was no prior high-water mark, just remember the
  // newest message and skip grading the backlog. Without this, every fresh
  // worker (e.g. after a KV wipe) would re-grade the channel's recent history.
  if (!lastSeen) {
    const newestId = ordered[ordered.length - 1].id;
    await env.CONTENT.put(STATE_KEY, newestId);
    return;
  }

  let highWater = lastSeen;
  for (const msg of ordered) {
    if (snowflakeCompare(msg.id, highWater) > 0) highWater = msg.id;

    if (msg.author?.bot) continue;
    const grade = gradeMessage(msg.content, graderConfig);
    if (!grade) continue;

    const r = await addReaction(env, channelId, msg.id, grade.emoji);
    if (!r.ok && r.status !== 204) {
      console.error(
        `games-grader: react ${grade.game} score=${grade.score ?? 'X'} on ${msg.id} → ${r.status}`,
        r.json,
      );
    }
  }

  if (highWater !== lastSeen) {
    await env.CONTENT.put(STATE_KEY, highWater);
  }
}

/**
 * Compare two Discord snowflakes lexicographically by length-then-string.
 * Snowflakes are decimal-as-string IDs that grow over time, so a longer
 * string is always larger and equal-length strings compare as ASCII.
 */
function snowflakeCompare(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
