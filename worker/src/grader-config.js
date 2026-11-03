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
 * Boards: each entry is `{id, name, parserType, headerRegex, ...optional}`.
 * `parserType` is one of `wordle | framed | connections | strands | custom`.
 * The first four are built-in parser shapes; `custom` is declarative — the
 * board itself says how to pull numbers out of a post and how to turn them
 * into reactions, so a new game needs no code change:
 *
 *   extractors: [{name, kind, pattern, default?}]
 *       kind "regex"   → first capture group of `pattern`, parsed as a number
 *                        (commas stripped, "-100" ok). No match → `default`
 *                        (a number) or null.
 *       kind "count"   → how many times the literal `pattern` appears.
 *       kind "present" → 1 if regex `pattern` matches, else 0.
 *   scoring: {field, offset, cap, failWhen?}
 *       score = clamp(extractor[field] + offset, 1, cap) → legend `score{N}`.
 *       `failWhen: {field, op, value}` → legend `miss` instead.
 *       A null `field` value means "not a board" (no grade).
 *
 * Any board (built-in or custom) may also carry:
 *   legend:  partial per-board override of the global legend.
 *   bonuses: [{field, op, value, emoji}] — extra reactions added when the rule
 *            holds. `field` is an extractor name, `score`, or `fail` (0/1).
 *   samples: [{label, content}] — saved example posts for the admin Test pane.
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

/**
 * One-click boards offered by the admin "Add from preset" menu. Not part of
 * DEFAULT_GRADER_CONFIG so existing saved configs are never altered silently.
 */
export const BOARD_PRESETS = Object.freeze([
  {
    id: 'strands',
    name: 'Strands',
    parserType: 'strands',
    headerRegex: '^Strands\\s+#\\d+',
  },
  {
    id: '4x3',
    name: '4x3.fun',
    parserType: 'custom',
    headerRegex: '4x3\\.fun',
    // Primary reaction: 0 mistakes → score1, 1 → score2, … (cap 6).
    // Points range roughly -100 … 150; bonus bands below are placeholders to tune.
    extractors: [
      { name: 'points', kind: 'regex', pattern: '(-?[\\d,]+)\\s+points?', default: null },
      { name: 'mistakes', kind: 'regex', pattern: '(\\d+)\\s+mistakes?', default: 0 },
    ],
    scoring: { field: 'mistakes', offset: 1, cap: 6 },
    bonuses: [
      { field: 'points', op: '>=', value: 130, emoji: '💯' },
      { field: 'mistakes', op: '==', value: 0, emoji: '✨' },
      { field: 'points', op: '<', value: 0, emoji: '💀' },
    ],
    samples: [
      {
        label: 'Perfect, 138 pts',
        content: 'November 3, 2026\n138 points • No mistakes\n🌟🟨🟨\n🟦🌟🟦\n🟩🌟🟩\n🟪🌟🟪\nhttps://4x3.fun',
      },
    ],
  },
]);

const KV_KEY = 'grader_config';
export const PARSER_TYPES = ['wordle', 'framed', 'connections', 'strands', 'custom'];
export const LEGEND_KEYS = ['score1', 'score2', 'score3', 'score4', 'score5', 'score6', 'miss'];
export const EXTRACTOR_KINDS = ['regex', 'count', 'present'];
export const RULE_OPS = ['==', '!=', '>', '>=', '<', '<='];

const NAME_RE = /^[a-z][a-z0-9_]{0,23}$/i;
const MAX_BOARDS = 32;
const MAX_EXTRACTORS = 8;
const MAX_BONUSES = 8;
const MAX_SAMPLES = 8;

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
  if (input.boards.length > MAX_BOARDS) {
    return { ok: false, error: `No more than ${MAX_BOARDS} boards.` };
  }

  const boards = [];
  const seenIds = new Set();
  for (const b of input.boards) {
    const r = validateBoard(b);
    if (!r.ok) return r;
    if (seenIds.has(r.board.id)) {
      return { ok: false, error: `Duplicate board id "${r.board.id}".` };
    }
    seenIds.add(r.board.id);
    boards.push(r.board);
  }

  return { ok: true, config: { legend, boards } };
}

/** Validate + normalize one board. `{ok, board}` or `{ok:false, error}`. */
export function validateBoard(b) {
  if (!b || typeof b !== 'object') {
    return { ok: false, error: 'Each board must be an object.' };
  }
  const id = String(b.id || '').trim();
  if (!/^[a-z0-9_-]{1,32}$/i.test(id)) {
    return { ok: false, error: `Board id "${id}" must be 1–32 chars, alphanumeric/underscore/hyphen.` };
  }
  const fail = msg => ({ ok: false, error: `Board "${id}" ${msg}` });

  const name = String(b.name || '').trim();
  if (!name || name.length > 64) return fail('name must be 1–64 chars.');

  if (!PARSER_TYPES.includes(b.parserType)) {
    return fail(`parserType must be one of: ${PARSER_TYPES.join(', ')}.`);
  }

  const headerRegex = String(b.headerRegex || '').trim();
  if (!headerRegex || headerRegex.length > 256) return fail('headerRegex must be 1–256 chars.');
  try {
    new RegExp(headerRegex, 'm');
  } catch (err) {
    return fail(`headerRegex is invalid: ${err.message}`);
  }
  if (b.parserType === 'wordle' && !hasCaptureGroup(headerRegex)) {
    return fail('(wordle) headerRegex must contain a capture group for the score token, e.g. "(\\d)/6".');
  }

  const board = { id, name, parserType: b.parserType, headerRegex };

  // Per-board legend override (partial).
  if (b.legend != null) {
    if (typeof b.legend !== 'object') return fail('legend must be an object.');
    const lg = {};
    for (const key of LEGEND_KEYS) {
      const v = b.legend[key];
      if (v == null || v === '') continue;
      if (typeof v !== 'string' || v.length > 64) return fail(`legend.${key} must be a string ≤ 64 chars.`);
      lg[key] = v;
    }
    if (Object.keys(lg).length) board.legend = lg;
  }

  // Custom: extractors + scoring.
  const names = new Set(['score', 'fail']);
  if (b.parserType === 'custom') {
    if (!Array.isArray(b.extractors) || !b.extractors.length) return fail('(custom) needs at least one extractor.');
    if (b.extractors.length > MAX_EXTRACTORS) return fail(`can have at most ${MAX_EXTRACTORS} extractors.`);
    board.extractors = [];
    const extNames = new Set();
    for (const e of b.extractors) {
      const ename = String(e?.name || '').trim();
      if (!NAME_RE.test(ename)) return fail(`extractor name "${ename}" must be a letter followed by letters/digits/underscore (≤ 24).`);
      if (ename === 'score' || ename === 'fail' || extNames.has(ename)) return fail(`extractor name "${ename}" is reserved or duplicated.`);
      if (!EXTRACTOR_KINDS.includes(e.kind)) return fail(`extractor "${ename}" kind must be one of: ${EXTRACTOR_KINDS.join(', ')}.`);
      const pattern = String(e.pattern ?? '');
      if (!pattern || pattern.length > 256) return fail(`extractor "${ename}" pattern must be 1–256 chars.`);
      if (e.kind !== 'count') {
        try {
          new RegExp(pattern, 'm');
        } catch (err) {
          return fail(`extractor "${ename}" pattern is invalid: ${err.message}`);
        }
        if (e.kind === 'regex' && !hasCaptureGroup(pattern)) {
          return fail(`extractor "${ename}" (regex) needs a capture group around the number.`);
        }
      }
      const ex = { name: ename, kind: e.kind, pattern };
      if (e.kind === 'regex') {
        if (e.default != null && e.default !== '') {
          const d = Number(e.default);
          if (!Number.isFinite(d)) return fail(`extractor "${ename}" default must be a number.`);
          ex.default = d;
        } else {
          ex.default = null;
        }
      }
      extNames.add(ename);
      names.add(ename);
      board.extractors.push(ex);
    }

    const sc = b.scoring;
    if (!sc || typeof sc !== 'object') return fail('(custom) needs scoring.');
    if (!extNames.has(sc.field)) return fail(`scoring.field "${sc.field}" must be one of the extractors.`);
    const offset = Number(sc.offset ?? 0);
    const cap = Number(sc.cap ?? 6);
    if (!Number.isInteger(offset) || offset < -10 || offset > 10) return fail('scoring.offset must be an integer −10…10.');
    if (!Number.isInteger(cap) || cap < 1 || cap > 6) return fail('scoring.cap must be an integer 1…6.');
    board.scoring = { field: sc.field, offset, cap };
    if (sc.failWhen) {
      const fw = validateCondition(sc.failWhen, extNames);
      if (!fw.ok) return fail(`scoring.failWhen: ${fw.error}`);
      board.scoring.failWhen = fw.cond;
    }
  }

  // Bonus reactions (any board type).
  if (b.bonuses != null) {
    if (!Array.isArray(b.bonuses)) return fail('bonuses must be an array.');
    if (b.bonuses.length > MAX_BONUSES) return fail(`can have at most ${MAX_BONUSES} bonus rules.`);
    board.bonuses = [];
    for (const r of b.bonuses) {
      const c = validateCondition(r, names);
      if (!c.ok) return fail(`bonus: ${c.error}`);
      const emoji = typeof r.emoji === 'string' ? r.emoji.trim() : '';
      if (!emoji || emoji.length > 64) return fail('bonus emoji must be a string 1–64 chars.');
      board.bonuses.push({ ...c.cond, emoji });
    }
  }

  // Saved sample posts.
  if (b.samples != null) {
    if (!Array.isArray(b.samples)) return fail('samples must be an array.');
    if (b.samples.length > MAX_SAMPLES) return fail(`can have at most ${MAX_SAMPLES} samples.`);
    board.samples = b.samples.map(sm => ({
      label: String(sm?.label || '').trim().slice(0, 64),
      content: String(sm?.content || '').slice(0, 4000),
    })).filter(sm => sm.content);
  }

  return { ok: true, board };
}

function validateCondition(c, fieldNames) {
  if (!c || typeof c !== 'object') return { ok: false, error: 'must be an object.' };
  if (!fieldNames.has(c.field)) return { ok: false, error: `field "${c.field}" is not a known field.` };
  if (!RULE_OPS.includes(c.op)) return { ok: false, error: `op must be one of: ${RULE_OPS.join(' ')}.` };
  const value = Number(c.value);
  if (c.value === '' || c.value == null || !Number.isFinite(value)) return { ok: false, error: 'value must be a number.' };
  return { ok: true, cond: { field: c.field, op: c.op, value } };
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
    // Lenient: drop any stored board that no longer validates rather than
    // failing the whole config (the grader must keep running).
    out.boards = parsed.boards
      .map(validateBoard)
      .filter(r => r.ok)
      .map(r => r.board);
  }
  return out;
}
