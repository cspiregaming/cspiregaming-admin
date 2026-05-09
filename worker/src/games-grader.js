/**
 * Auto-grader for boards posted in #daily-games.
 *
 * Each parser inspects the raw message content; if the message looks like a
 * board for that game it returns `{game, score, emoji, fail}`. The scheduled
 * poller adds the emoji as a reaction. Unknown / non-board messages return
 * `null` so the poller knows to skip.
 *
 * Scoring legend (shared by Wordle + Framed; Connections uses 1-4 + miss):
 *   1 → 🌟   2 → ⭐   3 → 💫   4 → ✴️   5 → 🔸   6 → ▪️   miss → ❌
 */

const SCORE_EMOJI = ['🌟', '⭐', '💫', '✴️', '🔸', '▪️'];
const FAIL_EMOJI = '❌';

export function gradeMessage(content) {
  if (!content) return null;
  return parseWordle(content) || parseFramed(content) || parseConnections(content);
}

// ─── Wordle ─────────────────────────────────────────────────────────────────
//
// First line looks like `Wordle 1,234 4/6` (puzzle number can be `1,234`,
// `1234`, or `4/6` directly). Optional trailing `*` denotes hard mode. `X/6`
// means failed.

function parseWordle(content) {
  const m = content.match(/^Wordle\s+\S+\s+([X1-6])\/6\*?/m);
  if (!m) return null;
  const token = m[1];
  if (token === 'X') return { game: 'wordle', score: null, emoji: FAIL_EMOJI, fail: true };
  const n = parseInt(token, 10);
  return { game: 'wordle', score: n, emoji: SCORE_EMOJI[n - 1], fail: false };
}

// ─── Framed ─────────────────────────────────────────────────────────────────
//
// Format:
//   Framed #1520
//   🎬 🟥🟥🟥🟩⬛⬛
//
// Score = 1-indexed position of the first 🟩 in the squares line. No 🟩 = miss.

const SQUARE_CODEPOINTS = new Set([0x1F7E5, 0x1F7E9, 0x2B1B]); // 🟥 🟩 ⬛

function parseFramed(content) {
  if (!/^Framed\s+#\d+/m.test(content)) return null;

  for (const line of content.split('\n')) {
    const squares = [...line].filter(ch => SQUARE_CODEPOINTS.has(ch.codePointAt(0)));
    if (squares.length < 6) continue;
    const idx = squares.findIndex(ch => ch === '🟩');
    if (idx === -1) {
      return { game: 'framed', score: null, emoji: FAIL_EMOJI, fail: true };
    }
    const score = idx + 1; // 1-indexed
    if (score < 1 || score > 6) return null;
    return { game: 'framed', score, emoji: SCORE_EMOJI[score - 1], fail: false };
  }
  return null;
}

// ─── Connections ────────────────────────────────────────────────────────────
//
// Format:
//   Connections
//   Puzzle #1063
//   🟩🟩🟩🟩
//   🟦🟦🟦🟦
//   🟪🟪🟪🟪
//   🟨🟨🟨🟨
//
// Each row of 4 squares is one guess. A row of all-same-color squares = a
// correctly-identified group. Mixed rows = mistakes. The puzzle is solved if
// all four group colors appear as solid rows. Score = 1 + mistakes (so 0
// mistakes → 🌟, 3 mistakes → ✴️, failed → ❌).

const CONN_COLORS = new Set([0x1F7E8, 0x1F7E9, 0x1F7E6, 0x1F7EA]); // 🟨 🟩 🟦 🟪

function parseConnections(content) {
  if (!/^Connections\b/im.test(content) || !/Puzzle\s+#\d+/i.test(content)) return null;

  const rows = [];
  for (const line of content.split('\n')) {
    const squares = [...line].filter(ch => CONN_COLORS.has(ch.codePointAt(0)));
    if (squares.length === 4) rows.push(squares);
  }
  if (!rows.length) return null;

  const solidColors = new Set();
  let mistakes = 0;
  for (const row of rows) {
    const allSame = row.every(c => c === row[0]);
    if (allSame) solidColors.add(row[0]);
    else mistakes++;
  }

  const solved = solidColors.size === 4;
  if (!solved) {
    return { game: 'connections', score: null, emoji: FAIL_EMOJI, fail: true };
  }
  if (mistakes < 0 || mistakes > 3) {
    // Should be impossible if solved (max 3 mistakes allowed), but be safe.
    return { game: 'connections', score: null, emoji: FAIL_EMOJI, fail: true };
  }
  return {
    game: 'connections',
    score: mistakes + 1,
    emoji: SCORE_EMOJI[mistakes], // 0 mistakes → 🌟 (index 0)
    fail: false,
  };
}
