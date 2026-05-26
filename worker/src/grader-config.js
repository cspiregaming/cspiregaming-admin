/**
 * Persistent config for the #daily-games auto-grader.
 *
 * Stored under `CONFIG:grader_config` as JSON; the admin SPA edits this through
 * `/api/admin/grader`. Defaults below mirror the original hardcoded behavior so
 * a fresh deploy with no KV entry grades Wordle / Framed / Connections out of
 * the box.
 *
 * Legend keys: `score1`–`score6` are the emoji reactions for a 1-best / 6-worst
 * score, and `miss` is the reaction for an unsolved board. Boards with a max
 * score below 6 simply never use the higher entries. Emoji values can be:
 *   - a raw unicode emoji (e.g. "🌟"), or
 *   - a Discord custom-emoji reference in `name:id` form (e.g. "csgwin:12345").
 * Both formats are accepted by Discord's add-reaction REST endpoint.
 *
 * Boards: each entry is `{id, name, parserType, headerRegex}`. `parserType` is
 * one of `wordle | framed | connections` — the three built-in parser shapes —
 * and `headerRegex` is the per-board regex that identifies the message as a
 * board of that type. For the Wordle parser the regex MUST contain exactly one
 * capture group (the score token, either a digit or "X"). For Framed and
 * Connections the regex is a presence gate; the square/row logic is fixed.
 */

export const DEFAULT_GRADER_CONFIG = Object.freeze({
  legend: Object.freeze({
    score1: '🌟',
    score2: '⭐',
    score3: '💫',
    score4: '✴️',
    score5: '🔸',
    score6: '▪️',
    miss: '❌',
  }),
  boards: Object.freeze([
    Object.freeze({
      id: 'wordle',
      name: 'Wordle',
      parserType: 'wordle',
      headerRegex: '^Wordle\\s+\\S+\\s+([X1-6])/6\\*?',
    }),
    Object.freeze({
      id: 'framed',
      name: 'Framed',
      parserType: 'framed',
      headerRegex: '^Framed\\s+#\\d+',
    }),
    Object.freeze({
      id: 'connections',
      name: 'Connections',
      parserType: 'connections',
      headerRegex: '^Connections\\b',
    }),
  ]),
});

const KV_KEY = 'grader_config';
export const PARSER_TYPES = ['wordle', 'framed', 'connections', 'strands'];
export const LEGEND_KEYS = ['score1', 'score2', 'score3', 'score4', 'score5', 'score6', 'miss'];

export async function loadGraderConfig(env) {
  const raw = await env.CONFIG.get(KV_KEY);
  if (!raw) return cloneDefaults();
  try {
    const parsed = JSON.parse(raw);
    return mergeWithDefaults(parsed);
  } catch (err) {
    console.error('grader-config: stored JSON invalid, using defaults', err);
    return cloneDefaults();
  }
}

export async function saveGraderConfig(env, config) {
  await env.CONFIG.put(KV_KEY, JSON.stringify(config));
}

/**
 * Validates an incoming config payload from the admin SPA. Returns
 * `{ok: true, config}` on success or `{ok: false, error}` otherwise.
 */
export function validateGraderConfig(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Body must be an object.' };
  }

  // Legend
  const legend = {};
  for (const key of LEGEND_KEYS) {
    const val = input.legend?.[key];
    if (val == null || val === '') {
      return { ok: false, error: `legend.${key} is required.` };
    }
    if (typeof val !== 'string' || val.length > 64) {
      return { ok: false, error: `legend.${key} must be a string ≤ 64 chars.` };
    }
    legend[key] = val;
  }

  // Boards
  if (!Array.isArray(input.boards)) {
    return { ok: false, error: 'boards must be an array.' };
  }
  if (input.boards.length > 32) {
    return { ok: false, error: 'No more than 32 boards.' };
  }

  const boards = [];
  const seenIds = new Set();
  for (const b of input.boards) {
    if (!b || typeof b !== 'object') {
      return { ok: false, error: 'Each board must be an object.' };
    }
    const id = String(b.id || '').trim();
    if (!/^[a-z0-9_-]{1,32}$/i.test(id)) {
      return { ok: false, error: `Board id "${id}" must be 1–32 chars, alphanumeric/underscore/hyphen.` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `Duplicate board id "${id}".` };
    }
    seenIds.add(id);

    const name = String(b.name || '').trim();
    if (!name || name.length > 64) {
      return { ok: false, error: `Board "${id}" name must be 1–64 chars.` };
    }

    if (!PARSER_TYPES.includes(b.parserType)) {
      return { ok: false, error: `Board "${id}" parserType must be one of: ${PARSER_TYPES.join(', ')}.` };
    }

    const headerRegex = String(b.headerRegex || '').trim();
    if (!headerRegex || headerRegex.length > 256) {
      return { ok: false, error: `Board "${id}" headerRegex must be 1–256 chars.` };
    }
    try {
      new RegExp(headerRegex, 'm');
    } catch (err) {
      return { ok: false, error: `Board "${id}" headerRegex is invalid: ${err.message}` };
    }
    if (b.parserType === 'wordle' && !hasCaptureGroup(headerRegex)) {
      return { ok: false, error: `Board "${id}" (wordle) headerRegex must contain a capture group for the score token, e.g. "(\\d)/6".` };
    }

    boards.push({ id, name, parserType: b.parserType, headerRegex });
  }

  return { ok: true, config: { legend, boards } };
}

function hasCaptureGroup(regexSource) {
  // True if there's a '(' that isn't immediately followed by '?:' / '?=' / '?!'
  // and isn't escaped. Best-effort — false negatives are tolerable since the
  // wordle parser also no-ops gracefully on missing capture.
  let escaped = false;
  for (let i = 0; i < regexSource.length; i++) {
    const ch = regexSource[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '(' && regexSource[i + 1] !== '?') return true;
  }
  return false;
}

function cloneDefaults() {
  return {
    legend: { ...DEFAULT_GRADER_CONFIG.legend },
    boards: DEFAULT_GRADER_CONFIG.boards.map(b => ({ ...b })),
  };
}

function mergeWithDefaults(parsed) {
  const out = cloneDefaults();
  if (parsed.legend && typeof parsed.legend === 'object') {
    for (const key of LEGEND_KEYS) {
      if (typeof parsed.legend[key] === 'string' && parsed.legend[key]) {
        out.legend[key] = parsed.legend[key];
      }
    }
  }
  if (Array.isArray(parsed.boards)) {
    out.boards = parsed.boards
      .filter(b => b && PARSER_TYPES.includes(b.parserType) && b.id && b.name && b.headerRegex)
      .map(b => ({
        id: String(b.id),
        name: String(b.name),
        parserType: b.parserType,
        headerRegex: String(b.headerRegex),
      }));
  }
  return out;
}
