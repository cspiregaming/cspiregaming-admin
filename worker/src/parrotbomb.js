/**
 * `/parrotbomb` — homage to the Slack-era parrotBomb(); ritual.
 *
 * Drops a 9×9 concentric-ring grid using the numbered party-parrot frame
 * emojis (:1_:, :3_:, :5_:, :7_:, :9_:). The ring layers fade from the edge
 * to the center, giving the same visible "explosion" pattern you'd see when
 * Dyno's GIF frames went out of sync — but on purpose, every time.
 *
 * The 81-cell custom-emoji block typically lands at ~2100 characters, just
 * over Discord's 2000-char per-message limit, so `buildBombMessages()`
 * returns one or more chunks: lead text first, then the grid as a follow-up
 * (or two halves if even the bare grid is over budget).
 */

import { fetchGuildEmojis } from './discord.js';

/**
 * Build the bomb payload for a given user — a single Discord message with the
 * lead text as content and the 9×9 grid as an embed description. The grid
 * routinely lands at ~2100 chars (over Discord's 2000-char content cap) but
 * embed descriptions allow up to 4096 chars, so the whole bomb stays in one
 * message — single bot avatar, no awkward multi-message split.
 */
export async function buildBombPayload(env, displayName) {
  const pool = await getParrotPool(env);
  const safeName = escapeMarkdown(displayName);

  if (!pool.length) {
    return {
      content: `${safeName} tried to set off a \`parrotBomb();\` — but the parrot armory is empty 🦜`,
    };
  }

  const grid = buildBullseyeGrid(pool);
  return {
    content: `**${safeName}** set off a \`parrotBomb();\``,
    embeds: [{ description: grid, color: 0x7ec850 }],
  };
}

/**
 * Returns the list of parrot-themed animated emoji visible to the bot in the
 * guild. Includes named variants (parrot, congaparrot, …) and the numbered
 * frames (:1_:, :2_:, …). Cached for an hour by `fetchGuildEmojis`.
 */
export async function getParrotPool(env) {
  const guildId = env.GUILD_ID;
  if (!guildId) return [];
  const emojis = await fetchGuildEmojis(env, guildId).catch(() => []);
  return emojis.filter(e =>
    e.animated &&
    e.available !== false &&
    (
      /parrot/i.test(e.name) ||
      /^[0-9]_$/.test(e.name)
    ),
  );
}

/**
 * The user-supplied bullseye:
 *
 *   9 9 9 9 9 9 9 9 9
 *   9 7 7 7 7 7 7 7 9
 *   9 7 5 5 5 5 5 7 9
 *   9 7 5 3 3 3 5 7 9
 *   9 7 5 3 1 3 5 7 9     ← center
 *   9 7 5 3 3 3 5 7 9
 *   9 7 5 5 5 5 5 7 9
 *   9 7 7 7 7 7 7 7 9
 *   9 9 9 9 9 9 9 9 9
 *
 * If any expected emoji is missing from the guild, falls back to the first
 * parrot in the pool so the grid still renders rather than throwing.
 */
function buildBullseyeGrid(pool) {
  const byName = new Map(pool.map(e => [e.name, e]));
  const fallback = pool[0];
  const ref = key => formatEmoji(byName.get(key) || fallback);

  const N = ref('9_');
  const O = ref('7_');
  const M = ref('5_');
  const I = ref('3_');
  const C = ref('1_');

  const matrix = [
    [N, N, N, N, N, N, N, N, N],
    [N, O, O, O, O, O, O, O, N],
    [N, O, M, M, M, M, M, O, N],
    [N, O, M, I, I, I, M, O, N],
    [N, O, M, I, C, I, M, O, N],
    [N, O, M, I, I, I, M, O, N],
    [N, O, M, M, M, M, M, O, N],
    [N, O, O, O, O, O, O, O, N],
    [N, N, N, N, N, N, N, N, N],
  ];
  return matrix.map(row => row.join('')).join('\n');
}

function formatEmoji(e) {
  return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
}

function escapeMarkdown(s) {
  return String(s).replace(/[*_`~|\\]/g, ch => '\\' + ch);
}
