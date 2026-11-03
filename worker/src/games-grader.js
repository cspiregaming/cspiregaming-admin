/**
 * Auto-grader for boards posted in #daily-games.
 *
 * `gradeMessage(content, config)` walks the configured boards in order and
 * returns the first hit's `{game, score, emoji, fail}`. The scheduler then
 * reacts with `emoji`. The poller skips unknown / non-board messages by
 * receiving `null`.
 *
 * Three built-in parser types match the layouts of the original boards:
 *   - wordle      → header regex captures the score token (digit or "X")
 *   - framed      → header regex gates; score = first 🟩 in a 6-square row
 *   - connections → header regex gates; score = 1 + mistake rows (solid same-
 *                   color rows count as solved groups)
 *   - strands     → header regex gates; score = hints used + 1 (💡 count),
 *                   capped at score6; no miss state
 *   - custom      → declarative: board-defined extractors → score + bonuses
 *                   (see grader-config.js)
 *
 * Every grade is `{game, score, emoji, emojis, fail, values, bonuses}`:
 * `emoji` is the primary reaction, `emojis` is primary + fired bonus reactions
 * (deduped, in order) and is what the scheduler applies.
 *
 * Legend (score → emoji) and the per-board header regex live in
 * `CONFIG:grader_config` — editable from the Daily Games admin view. See
 * `grader-config.js` for the schema + defaults.
 */

import { DEFAULT_GRADER_CONFIG } from './grader-config.js';

export function gradeMessage(content, config = DEFAULT_GRADER_CONFIG) {
  if (!content) return null;
  for (const board of config.boards || []) {
    const result = runBoard(board, content, { ...config.legend, ...(board.legend || {}) });
    if (result) return finalize(board, result);
  }
  return null;
}

function runBoard(board, content, legend) {
  let header;
  try {
    header = new RegExp(board.headerRegex, 'm');
  } catch {
    return null;
  }
  const match = header.exec(content);
  if (!match) return null;

  switch (board.parserType) {
    case 'wordle':      return parseWordle(board, match, legend);
    case 'framed':      return parseFramed(board, content, legend);
    case 'connections': return parseConnections(board, content, legend);
    case 'strands':     return parseStrands(board, content, legend);
    case 'custom':      return parseCustom(board, content, legend);
    default:            return null;
  }
}

/** Attach the combined reaction list + bonus rule results to a parser result. */
function finalize(board, result) {
  const values = { ...(result.values || {}), score: result.score, fail: result.fail ? 1 : 0 };
  const bonuses = [];
  for (const rule of board.bonuses || []) {
    if (compare(values[rule.field], rule.op, rule.value)) bonuses.push(rule);
  }
  const emojis = [...new Set([result.emoji, ...bonuses.map(r => r.emoji)].filter(Boolean))];
  return { ...result, values, emojis, bonuses };
}

function compare(actual, op, expected) {
  if (actual == null) return false;
  switch (op) {
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    case '>':  return actual > expected;
    case '>=': return actual >= expected;
    case '<':  return actual < expected;
    case '<=': return actual <= expected;
    default:   return false;
  }
}

// ─── Custom (declarative) ───────────────────────────────────────────────────
//
// Extractors turn the post into numbers; `scoring` turns one of them into a
// 1…cap score (or the miss reaction). Missing primary value → not a board.

function parseCustom(board, content, legend) {
  const values = {};
  for (const ex of board.extractors || []) {
    values[ex.name] = extract(ex, content);
  }
  const sc = board.scoring;
  if (!sc) return null;
  const base = values[sc.field];
  if (base == null) return null;

  if (sc.failWhen && compare(values[sc.failWhen.field], sc.failWhen.op, sc.failWhen.value)) {
    return { game: board.id, score: null, emoji: legend.miss, fail: true, values };
  }
  let raw;
  if (sc.bands?.length) {
    const sorted = [...sc.bands].sort((a, b) => b.min - a.min);
    const hit = sorted.find(bd => base >= bd.min) || sorted[sorted.length - 1];
    raw = hit.score;
  } else {
    raw = Math.trunc(base) + (sc.offset || 0);
  }
  const score = Math.min(Math.max(raw, 1), sc.cap || 6);
  return { game: board.id, score, emoji: legend[`score${score}`], fail: false, values };
}

function extract(ex, content) {
  if (ex.kind === 'count') {
    return ex.pattern ? content.split(ex.pattern).length - 1 : 0;
  }
  let re;
  try {
    re = new RegExp(ex.pattern, ex.kind === 'matches' ? 'gm' : 'm');
  } catch {
    return null;
  }
  if (ex.kind === 'matches') return (content.match(re) || []).length;
  const m = re.exec(content);
  if (ex.kind === 'present') return m ? 1 : 0;
  // regex
  if (!m || m[1] == null) return ex.default ?? null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : (ex.default ?? null);
}

// ─── Wordle-style ───────────────────────────────────────────────────────────
//
// Header regex captures the score token. Default board: `Wordle 1,234 4/6` →
// captures `4` (or `X` for miss). Token "X" / "x" → miss. A digit token is
// looked up in the legend by `score{N}`.

function parseWordle(board, match, legend) {
  const token = match[1];
  if (!token) return null;
  if (token === 'X' || token === 'x') {
    return { game: board.id, score: null, emoji: legend.miss, fail: true };
  }
  const n = parseInt(token, 10);
  if (!Number.isFinite(n) || n < 1 || n > 6) return null;
  return { game: board.id, score: n, emoji: legend[`score${n}`], fail: false };
}

// ─── Framed-style ───────────────────────────────────────────────────────────
//
// Format:
//   Framed #1520
//   🎬 🟥🟥🟥🟩⬛⬛
//
// Score = 1-indexed position of the first 🟩 in the squares line. No 🟩 = miss.

const FRAMED_SQUARES = new Set([0x1F7E5, 0x1F7E9, 0x2B1B]); // 🟥 🟩 ⬛

function parseFramed(board, content, legend) {
  for (const line of content.split('\n')) {
    const squares = [...line].filter(ch => FRAMED_SQUARES.has(ch.codePointAt(0)));
    if (squares.length < 6) continue;
    const idx = squares.findIndex(ch => ch === '🟩');
    if (idx === -1) {
      return { game: board.id, score: null, emoji: legend.miss, fail: true };
    }
    const score = idx + 1;
    if (score < 1 || score > 6) return null;
    return { game: board.id, score, emoji: legend[`score${score}`], fail: false };
  }
  return null;
}

// ─── Connections-style ──────────────────────────────────────────────────────
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
// mistakes → score1, 3 mistakes → score4, failed → miss).

const CONN_COLORS = new Set([0x1F7E8, 0x1F7E9, 0x1F7E6, 0x1F7EA]); // 🟨 🟩 🟦 🟪

function parseConnections(board, content, legend) {
  // Require a "Puzzle #N" line in addition to the header gate so partial-text
  // messages mentioning "Connections" don't match accidentally.
  if (!/Puzzle\s+#\d+/i.test(content)) return null;

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
  if (!solved || mistakes < 0 || mistakes > 3) {
    return { game: board.id, score: null, emoji: legend.miss, fail: true };
  }
  const score = mistakes + 1;
  return { game: board.id, score, emoji: legend[`score${score}`], fail: false };
}

// ─── Strands-style ──────────────────────────────────────────────────────────
//
// Format:
//   Strands #813
//   "Thank you"
//   🔵🔵🟡🔵
//   🔵🔵
//
// 🔵 = word found, 🟡 = spangram found, 💡 = hint used.
// Score = hints + 1 (0 hints → score1), capped at score6. No miss state.

function parseStrands(board, content, legend) {
  let hints = 0;
  let hasGrid = false;
  for (const line of content.split('\n')) {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp === 0x1F4A1) hints++;                       // 💡
      if (cp === 0x1F535 || cp === 0x1F7E1) hasGrid = true; // 🔵 🟡
    }
  }
  if (!hasGrid) return null;
  const score = Math.min(hints + 1, 6);
  return { game: board.id, score, emoji: legend[`score${score}`], fail: false };
}
