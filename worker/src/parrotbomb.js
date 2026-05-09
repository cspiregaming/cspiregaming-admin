/**
 * `/parrotbomb` — homage to the Slack-era parrotBomb(); ritual.
 *
 * Auto-discovers every animated parrot emoji uploaded to the guild and lays
 * out a randomized grid of them. The pool refreshes hourly via the discord.js
 * emoji cache, so adding/removing parrots in the guild is a no-code change.
 *
 * Discord caps message content at 2000 characters. With custom-emoji refs
 * averaging ~28-38 chars (`<a:name:id>`), a 7×7 grid (49 parrots) is the
 * sweet spot — fits the lead message comfortably and lands as one chunk.
 */

import { fetchGuildEmojis } from './discord.js';

const COLS = 7;
const ROWS = 7;
const CHAR_BUDGET = 1850; // leave ~150 chars for the lead text + safety margin

/**
 * Returns the list of parrot-themed animated emoji visible to the bot in the
 * guild. The pool is matched by name pattern: any emoji whose name contains
 * "parrot" (case-insensitive) plus the numbered frame variants like `1_`,
 * `2_`, …, `9_` that we know are party-parrot animation frames.
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
 * Render a 7×7 grid of randomly-picked parrots from the pool. The grid is
 * trimmed cell-by-cell to stay under CHAR_BUDGET, so even unusually long emoji
 * names won't blow the message limit.
 */
export function buildParrotGrid(pool) {
  if (!pool.length) return null;

  const rows = [];
  let used = 0;
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const e = pool[Math.floor(Math.random() * pool.length)];
      const ref = formatEmoji(e);
      if (used + ref.length + 1 > CHAR_BUDGET) {
        // Out of room — return whatever we've got so far.
        if (row.length) rows.push(row.join(''));
        return rows.join('\n');
      }
      row.push(ref);
      used += ref.length;
    }
    rows.push(row.join(''));
    used += 1; // newline
  }
  return rows.join('\n');
}

function formatEmoji(e) {
  return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
}
