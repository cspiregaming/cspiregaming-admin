import { api } from '../api.js';
import { escHtml } from '../app.js';

/**
 * Daily Games admin view — manages the boards + legend the auto-grader uses
 * when it reacts to messages in #daily-games.
 *
 * Layout:
 *   - Global legend (score → emoji), with an emoji picker.
 *   - Boards table (reorderable). Each board opens in an editor dialog with a
 *     live test pane: paste a post, see what matched, which numbers were
 *     extracted and which reactions would be added.
 *   - A global Test panel that runs the whole unsaved draft.
 *
 * A "custom" board is declarative: extractors pull numbers out of a post,
 * `scoring` maps one of them to the 1…N legend, and bonus rules add extra
 * reactions ("points ≥ 130 → 💯"). New games need no worker code change.
 */

const COMMON_EMOJI = ['🌟', '⭐', '💫', '✨', '💯', '🔥', '🎉', '🏆', '👏', '😎', '🧠', '👀', '😬', '😅', '💀', '🐢', '🔸', '▪️', '✴️', '❌'];

const PARSER_BLURBS = {
  wordle:      'One capture group in the detect regex holds the score token (a digit or X).',
  framed:      'Scores by the position of the first 🟩 in a 6-square row.',
  connections: 'Scores 1 + mistakes; needs a "Puzzle #N" line and four solid rows to count as solved.',
  strands:     'Scores by 💡 hints used (+1), capped at score 6. No miss state.',
  custom:      'Define your own extractors, scoring and bonus reactions below.',
};

const SPECIAL = '.*+?^${}()|[]\\/-';

// ─── Detect-regex helpers ("starts with / contains" instead of raw regex) ──

function escapeRegex(text) {
  return [...text].map(ch => (SPECIAL.includes(ch) ? `\\${ch}` : ch)).join('');
}

/** If `re` is just an (optionally anchored) literal, return {mode, text}. */
function parseSimpleRegex(re) {
  const anchored = re.startsWith('^');
  const body = anchored ? re.slice(1) : re;
  let text = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      const next = body[i + 1];
      if (next == null || !SPECIAL.includes(next)) return null;
      text += next;
      i++;
    } else if (SPECIAL.includes(ch)) {
      return null;
    } else {
      text += ch;
    }
  }
  return text ? { mode: anchored ? 'starts' : 'contains', text } : null;
}

function buildRegex(mode, text) {
  return `${mode === 'starts' ? '^' : ''}${escapeRegex(text)}`;
}

function describeDetect(re) {
  const simple = parseSimpleRegex(re);
  if (!simple) return `<code style="font-size:11px;color:var(--text-muted)">${escHtml(re)}</code>`;
  return `${simple.mode === 'starts' ? 'starts with' : 'contains'} <strong>${escHtml(simple.text)}</strong>`;
}

// ─── Emoji rendering + picker ──────────────────────────────────────────────

function renderEmojiPreview(value) {
  if (!value) return '<span style="color:var(--text-muted);font-size:12px">—</span>';
  const custom = /^([A-Za-z0-9_]{2,32}):(\d{15,21})$/.exec(value);
  if (custom) {
    const id = custom[2];
    // Animated-ness isn't encoded in name:id — try png, fall back to gif.
    return `<img src="https://cdn.discordapp.com/emojis/${id}.png?size=32" alt="${escHtml(value)}" style="width:24px;height:24px;vertical-align:middle" onerror="this.onerror=null;this.src='https://cdn.discordapp.com/emojis/${id}.gif?size=32'">`;
  }
  return `<span style="font-size:20px;line-height:1">${escHtml(value)}</span>`;
}

let emojiCatalogPromise = null;
function loadEmojiCatalog() {
  if (!emojiCatalogPromise) {
    emojiCatalogPromise = api.getEmojis()
      .then(p => p.emojis || [])
      .catch(() => []);
  }
  return emojiCatalogPromise;
}

/** Input + live preview + Pick button. Wire with `attachEmojiFields(root)`. */
function emojiField(attrs, value, placeholder = '🌟 or name:id') {
  return `
    <span class="emoji-field">
      <span class="emoji-field__preview">${renderEmojiPreview(value)}</span>
      <input class="emoji-field__input" ${attrs} value="${escHtml(value || '')}" maxlength="64" placeholder="${escHtml(placeholder)}">
      <button type="button" class="btn btn-outline emoji-field__pick" data-pick title="Pick emoji">😀</button>
    </span>`;
}

function attachEmojiFields(root) {
  if (root.dataset.emojiFields) return; // render() runs repeatedly on the same container
  root.dataset.emojiFields = '1';
  root.addEventListener('input', e => {
    const field = e.target.closest?.('.emoji-field');
    if (!field || !e.target.classList.contains('emoji-field__input')) return;
    field.querySelector('.emoji-field__preview').innerHTML = renderEmojiPreview(e.target.value);
  });
  root.addEventListener('click', e => {
    const btn = e.target.closest?.('[data-pick]');
    if (!btn) return;
    const input = btn.closest('.emoji-field').querySelector('input');
    openEmojiPicker(btn, value => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

function openEmojiPicker(anchor, onPick) {
  document.querySelector('.emoji-picker')?.remove();
  const pop = document.createElement('div');
  pop.className = 'emoji-picker';
  pop.innerHTML = `
    <div class="emoji-picker__title">Common</div>
    <div class="emoji-picker__grid">${COMMON_EMOJI.map(e => `<button type="button" data-val="${escHtml(e)}">${escHtml(e)}</button>`).join('')}</div>
    <div class="emoji-picker__title">Server emojis</div>
    <div class="emoji-picker__grid" id="picker-custom"><span style="color:var(--text-muted);font-size:12px">Loading…</span></div>
  `;
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 6 + window.scrollY, window.scrollY + window.innerHeight - 320)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 300))}px`;

  const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = e => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  document.addEventListener('mousedown', outside, true);

  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-val]');
    if (!b) return;
    onPick(b.dataset.val);
    close();
  });

  loadEmojiCatalog().then(list => {
    const box = pop.querySelector('#picker-custom');
    if (!box) return;
    box.innerHTML = list.length
      ? list.map(e => `<button type="button" data-val="${escHtml(`${e.name}:${e.id}`)}" title="${escHtml(e.name)}"><img src="${escHtml(e.url || `https://cdn.discordapp.com/emojis/${e.id}.png?size=32`)}" alt="${escHtml(e.name)}"></button>`).join('')
      : '<span style="color:var(--text-muted);font-size:12px">None available.</span>';
  });
}

// ─── Trace rendering (shared by global test + editor live test) ────────────

function renderTrace(grade, boardName) {
  if (!grade) {
    return `<div class="grader-trace grader-trace--miss">${boardName ? `Doesn't match “${escHtml(boardName)}”.` : 'No board matched.'} <span style="color:var(--text-muted)">Check the detect text, or that the post has the numbers your extractors look for.</span></div>`;
  }
  const pretty = grade.fail ? 'miss' : `score ${grade.score}`;
  const vals = Object.entries(grade.values || {}).filter(([k]) => k !== 'score' && k !== 'fail');
  return `
    <div class="grader-trace grader-trace--hit">
      <div>Matched <strong>${escHtml(grade.game)}</strong> — ${pretty}</div>
      ${vals.length ? `<div class="grader-trace__vals">${vals.map(([k, v]) => `<span><em>${escHtml(k)}</em> ${v == null ? '<i>not found</i>' : escHtml(v)}</span>`).join('')}</div>` : ''}
      <div class="grader-trace__reacts">
        <span class="grader-trace__label">Reacts with</span>
        ${(grade.emojis || [grade.emoji]).map(e => `<span class="grader-trace__emoji" title="${escHtml(e)}">${renderEmojiPreview(e)}</span>`).join('')}
      </div>
      ${(grade.bonuses || []).length ? `<div class="grader-trace__bonus">${grade.bonuses.map(r => `${escHtml(r.field)} ${escHtml(r.op)} ${escHtml(r.value)} → ${renderEmojiPreview(r.emoji)}`).join(' &nbsp;·&nbsp; ')}</div>` : ''}
    </div>`;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ─── View ──────────────────────────────────────────────────────────────────

export async function renderGrader(container) {
  container.innerHTML = '<div class="loading">Loading…</div>';

  let payload;
  try {
    payload = await api.getGrader();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load grader config: ${escHtml(err.message)}</div>`;
    return;
  }

  // Working copy — `payload.config` from the server is the saved state.
  const draft = JSON.parse(JSON.stringify(payload.config));
  const { parserTypes, legendKeys } = payload;
  const ruleOps = payload.ruleOps || ['==', '!=', '>', '>=', '<', '<='];
  const presets = payload.presets || [];
  const legendLabel = key => (key === 'miss' ? 'Miss / failed' : `Score ${key.replace('score', '')}`);

  function render() {
    const addable = presets.map(p => ({ ...p, exists: draft.boards.some(b => b.id === p.id) }));
    container.innerHTML = `
      <div class="card__header">
        <h1>Daily Games</h1>
        <button class="btn btn-primary" id="btn-save-grader">Save Changes</button>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        The auto-grader watches <code>#daily-games</code>. Boards are matched against each message in order;
        the first match gets a score reaction from the legend, plus any bonus reactions that board defines.
      </p>
      <div id="grader-feedback"></div>

      <div class="card">
        <h2>Default legend</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
          Reaction for each score (lower&nbsp;=&nbsp;better). Individual boards can override these in their editor.
          Use <strong>😀</strong> to pick a unicode or server emoji, or type a custom one as <code>name:id</code>
          (see <a href="#" data-nav="emojis">Custom Emojis</a>).
        </p>
        <div class="grader-legend-grid">
          ${legendKeys.map(key => `
            <div class="grader-legend-row">
              <span class="grader-legend-row__label">${escHtml(legendLabel(key))}</span>
              ${emojiField(`data-legend-key="${escHtml(key)}"`, draft.legend[key])}
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap">
          <h2 style="margin:0">Boards</h2>
          <select id="add-board-menu" style="width:auto">
            <option value="">+ Add board…</option>
            <option value="__blank">Blank custom board</option>
            ${addable.length ? '<optgroup label="Presets">' : ''}
            ${addable.map(p => `<option value="${escHtml(p.id)}" ${p.exists ? 'disabled' : ''}>${escHtml(p.name)}${p.exists ? ' (already added)' : ''}</option>`).join('')}
            ${addable.length ? '</optgroup>' : ''}
          </select>
        </div>
        ${renderBoardsTable()}
      </div>

      <div class="card">
        <h2>Test all boards</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
          Paste a Discord post to see how the current draft grades it. Uses unsaved edits — no need to Save first.
        </p>
        <textarea id="test-content" rows="6" placeholder="Paste a board message here…"></textarea>
        <div id="test-result" style="margin-top:12px"></div>
      </div>
    `;

    wireMain();
  }

  function renderBoardsTable() {
    if (!draft.boards.length) return '<p style="color:var(--text-muted)">No boards yet. Add one above.</p>';
    return `
      <table>
        <thead><tr>
          <th style="width:64px">Order</th><th>Board</th><th>Detects</th><th>Reactions</th><th style="width:130px"></th>
        </tr></thead>
        <tbody>
          ${draft.boards.map((b, i) => {
            const lg = { ...draft.legend, ...(b.legend || {}) };
            const nb = (b.bonuses || []).length;
            return `
            <tr>
              <td style="white-space:nowrap">
                <button class="btn btn-ghost grader-move" data-move="${i}:-1" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button><button class="btn btn-ghost grader-move" data-move="${i}:1" ${i === draft.boards.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
              </td>
              <td><strong>${escHtml(b.name)}</strong><br><code style="font-size:11px;color:var(--text-muted)">${escHtml(b.id)}</code> <span class="badge badge-muted">${escHtml(b.parserType)}</span></td>
              <td>${describeDetect(b.headerRegex)}</td>
              <td><span class="grader-mini">${['score1', 'score2', 'score3', 'miss'].map(k => renderEmojiPreview(lg[k])).join('')}</span>${b.legend ? ' <span class="badge badge-blue">own legend</span>' : ''}${nb ? ` <span class="badge badge-green">+${nb} bonus</span>` : ''}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-outline" data-edit-board="${i}" style="padding:4px 10px;font-size:12px">Edit</button>
                <button class="btn btn-danger" data-delete-board="${i}" style="padding:4px 10px;font-size:12px">Delete</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  function wireMain() {
    attachEmojiFields(container);

    container.querySelectorAll('[data-nav]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        import('../app.js').then(m => m.navigateTo(el.dataset.nav));
      });
    });

    container.querySelectorAll('[data-legend-key]').forEach(input => {
      input.addEventListener('input', () => { draft.legend[input.dataset.legendKey] = input.value; });
      // Refresh the boards table previews once the user leaves the field.
      input.addEventListener('change', refreshBoardsTable);
    });

    container.querySelector('#add-board-menu')?.addEventListener('change', e => {
      const v = e.target.value;
      e.target.value = '';
      if (!v) return;
      if (v === '__blank') return openBoardEditor(null, null);
      const preset = presets.find(p => p.id === v);
      if (preset) openBoardEditor(null, preset);
    });

    wireBoardsTable();

    const test = container.querySelector('#test-content');
    const out = container.querySelector('#test-result');
    const run = debounce(async () => {
      if (!test.value.trim()) { out.innerHTML = ''; return; }
      try {
        const { grade } = await api.testGrader(test.value, draft);
        out.innerHTML = renderTrace(grade);
      } catch (err) {
        out.innerHTML = `<div class="alert alert-error" style="margin:0">${escHtml(err.message)}</div>`;
      }
    }, 300);
    test.addEventListener('input', run);

    container.querySelector('#btn-save-grader')?.addEventListener('click', saveAll);
  }

  function refreshBoardsTable() {
    const holder = container.querySelector('#add-board-menu')?.parentElement?.parentElement;
    if (!holder) return;
    holder.querySelector('table, p')?.remove();
    holder.insertAdjacentHTML('beforeend', renderBoardsTable());
    wireBoardsTable();
  }

  function wireBoardsTable() {
    container.querySelectorAll('[data-edit-board]').forEach(btn => {
      btn.addEventListener('click', () => openBoardEditor(Number(btn.dataset.editBoard), null));
    });
    container.querySelectorAll('[data-delete-board]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.deleteBoard);
        if (!confirm(`Delete board "${draft.boards[idx].name}"?`)) return;
        draft.boards.splice(idx, 1);
        render();
      });
    });
    container.querySelectorAll('[data-move]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [i, d] = btn.dataset.move.split(':').map(Number);
        const j = i + d;
        if (j < 0 || j >= draft.boards.length) return;
        [draft.boards[i], draft.boards[j]] = [draft.boards[j], draft.boards[i]];
        refreshBoardsTable();
      });
    });
  }

  async function saveAll() {
    const btn = container.querySelector('#btn-save-grader');
    const fbk = container.querySelector('#grader-feedback');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    fbk.innerHTML = '';
    try {
      await api.putGrader(draft);
      fbk.innerHTML = '<div class="alert alert-success">✓ Grader config saved. Changes take effect on the next cron tick (≤ 1 minute).</div>';
    } catch (err) {
      fbk.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  }

  // ─── Board editor dialog ─────────────────────────────────────────────────

  function openBoardEditor(idx, seed) {
    const editing = idx != null;
    const b = JSON.parse(JSON.stringify(editing ? draft.boards[idx] : (seed || {
      id: '', name: '', parserType: 'custom', headerRegex: '',
      extractors: [{ name: 'points', kind: 'regex', pattern: '(\\d+)\\s+points', default: null }],
      scoring: { field: 'points', offset: 0, cap: 6 },
    })));
    b.bonuses ||= [];
    b.samples ||= [];
    let detectMode = parseSimpleRegex(b.headerRegex)?.mode || (b.headerRegex ? 'regex' : 'contains');
    let detectText = parseSimpleRegex(b.headerRegex)?.text || '';
    let sampleIdx = b.samples.length ? 0 : -1;
    let sampleText = b.samples[0]?.content || '';
    let showLegend = !!b.legend;

    const dialog = document.createElement('div');
    dialog.className = 'grader-board-dialog';
    dialog.innerHTML = `
      <div class="grader-board-dialog__backdrop"></div>
      <div class="grader-board-dialog__panel grader-board-dialog__panel--wide card">
        <div class="card__header"><h2 style="margin:0">${editing ? 'Edit board' : 'Add board'}</h2></div>
        <div class="grader-editor">
          <div class="grader-editor__form" id="ed-form"></div>
          <div class="grader-editor__test">
            <h3>Live test</h3>
            <div id="ed-samples" class="grader-samples"></div>
            <textarea id="ed-sample-text" rows="9" placeholder="Paste an example post to test this board…"></textarea>
            <div style="display:flex;gap:8px;margin:8px 0 12px">
              <button type="button" class="btn btn-outline" id="ed-save-sample" style="padding:4px 10px;font-size:12px">Save as sample</button>
            </div>
            <div id="ed-result"></div>
          </div>
        </div>
        <div id="ed-feedback" style="margin-top:12px"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button type="button" class="btn btn-primary" id="ed-apply">${editing ? 'Apply' : 'Add board'}</button>
          <button type="button" class="btn btn-outline" id="ed-cancel">Cancel</button>
          <span style="margin-left:auto;color:var(--text-muted);font-size:12px;align-self:center">Remember to “Save Changes” on the page to publish.</span>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    attachEmojiFields(dialog);

    const form = dialog.querySelector('#ed-form');
    const close = () => dialog.remove();
    dialog.querySelector('.grader-board-dialog__backdrop').addEventListener('click', close);
    dialog.querySelector('#ed-cancel').addEventListener('click', close);

    function syncRegex() {
      if (detectMode !== 'regex') b.headerRegex = detectText ? buildRegex(detectMode, detectText) : '';
    }

    // ── Form (re-rendered on structural changes only) ──
    function renderForm() {
      const isCustom = b.parserType === 'custom';
      const fieldOptions = sel => (b.extractors || []).map(x => `<option value="${escHtml(x.name)}" ${x.name === sel ? 'selected' : ''}>${escHtml(x.name)}</option>`).join('');
      const bonusFieldOptions = sel => ['score', 'fail', ...(b.extractors || []).map(x => x.name)]
        .map(n => `<option value="${escHtml(n)}" ${n === sel ? 'selected' : ''}>${escHtml(n)}</option>`).join('');
      const opOptions = sel => ruleOps.map(o => `<option ${o === sel ? 'selected' : ''}>${escHtml(o)}</option>`).join('');
      const wordle = b.parserType === 'wordle';

      form.innerHTML = `
        <div class="form-row">
          <div class="form-group"><label>Display name</label>
            <input data-f="name" value="${escHtml(b.name)}" maxlength="64" placeholder="4x3.fun"></div>
          <div class="form-group"><label>ID</label>
            <input data-f="id" value="${escHtml(b.id)}" ${editing ? 'readonly' : ''} maxlength="32" placeholder="4x3"></div>
        </div>

        <div class="form-group"><label>How to recognise a post</label>
          <div class="grader-detect">
            ${wordle ? '' : `<select data-f="detectMode" style="width:auto">
              <option value="starts" ${detectMode === 'starts' ? 'selected' : ''}>Starts with</option>
              <option value="contains" ${detectMode === 'contains' ? 'selected' : ''}>Contains</option>
              <option value="regex" ${detectMode === 'regex' ? 'selected' : ''}>Regex (advanced)</option>
            </select>`}
            ${wordle || detectMode === 'regex'
              ? `<input data-f="headerRegex" value="${escHtml(b.headerRegex)}" maxlength="256" style="font-family:ui-monospace,monospace" placeholder="^Wordle\\s+\\S+\\s+([X1-6])/6">`
              : `<input data-f="detectText" value="${escHtml(detectText)}" maxlength="120" placeholder="e.g. 4x3.fun">`}
          </div>
          <p class="grader-hint">${detectMode === 'regex' || wordle ? `Regex: <code>${escHtml(b.headerRegex || '…')}</code>` : `Matches posts that ${detectMode === 'starts' ? 'start with' : 'contain'} this text anywhere on a line. Generated regex: <code>${escHtml(b.headerRegex || '…')}</code>`}</p>
        </div>

        <div class="form-group"><label>How to score it</label>
          <select data-f="parserType">
            ${parserTypes.map(t => `<option value="${t}" ${t === b.parserType ? 'selected' : ''}>${t}${t === 'custom' ? ' (build your own)' : ' (built-in)'}</option>`).join('')}
          </select>
          <p class="grader-hint">${escHtml(PARSER_BLURBS[b.parserType] || '')}</p>
        </div>

        ${isCustom ? `
        <div class="grader-section">
          <div class="grader-section__head"><h4>Extractors</h4>
            <button type="button" class="btn btn-outline" data-add-ext style="padding:2px 10px;font-size:12px">+ Add</button></div>
          <p class="grader-hint">Pull numbers out of the post. <strong>regex</strong>: number in the first capture group (commas ok, negatives ok). <strong>count</strong>: how often a literal text/emoji appears. <strong>present</strong>: 1 if the regex matches. <strong>matches</strong>: how many times the regex matches (e.g. count lines of a shape).</p>
          ${(b.extractors || []).map((x, i) => `
            <div class="grader-rule grader-rule--ext">
              <input data-ext="${i}:name" value="${escHtml(x.name)}" placeholder="name" maxlength="24" style="width:110px">
              <select data-ext="${i}:kind" style="width:100px">${(payload.extractorKinds || ['regex', 'count', 'present', 'matches']).map(k => `<option ${k === x.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>
              <input data-ext="${i}:pattern" value="${escHtml(x.pattern)}" placeholder="${x.kind === 'count' ? 'text to count, e.g. 💡' : '(-?[\\d,]+)\\s+points'}" style="flex:1;min-width:150px;font-family:ui-monospace,monospace">
              ${x.kind === 'regex' ? `<input data-ext="${i}:default" value="${x.default == null ? '' : escHtml(x.default)}" placeholder="default" title="Value when the pattern isn't found (blank = not a board)" style="width:80px">` : ''}
              <button type="button" class="btn btn-ghost" data-del-ext="${i}" title="Remove">✕</button>
            </div>`).join('')}
        </div>

        <div class="grader-section">
          <div class="grader-section__head"><h4>Primary reaction</h4></div>
          <div class="grader-rule">
            Score from
            <select data-sc="field" style="width:auto">${fieldOptions(b.scoring?.field)}</select>
            <select data-sc="mode" style="width:auto">
              <option value="offset" ${b.scoring?.bands ? '' : 'selected'}>plus an offset (lower is better)</option>
              <option value="bands" ${b.scoring?.bands ? 'selected' : ''}>by value bands (e.g. higher is better)</option>
            </select>
          </div>
          ${b.scoring?.bands ? `
            ${b.scoring.bands.map((bd, i) => `
              <div class="grader-rule">
                ≥ <input data-band="${i}:min" type="number" value="${escHtml(bd.min)}" style="width:90px">
                → score <input data-band="${i}:score" type="number" min="1" max="6" value="${escHtml(bd.score)}" style="width:64px">
                <span class="grader-band-preview">${renderEmojiPreview({ ...draft.legend, ...(b.legend || {}) }[`score${bd.score}`])}</span>
                <button type="button" class="btn btn-ghost" data-del-band="${i}" title="Remove">✕</button>
              </div>`).join('')}
            <div class="grader-rule"><button type="button" class="btn btn-outline" data-add-band style="padding:2px 10px;font-size:12px">+ Add band</button></div>
            <p class="grader-hint">The band with the highest “≥” the value reaches wins; anything lower uses the lowest band.</p>`
          : `<div class="grader-rule">
              + <input data-sc="offset" type="number" value="${b.scoring?.offset ?? 0}" style="width:64px">
              , at most score <input data-sc="cap" type="number" min="1" max="6" value="${b.scoring?.cap ?? 6}" style="width:64px">
            </div>`}
          <div class="grader-rule">
            <label class="grader-check"><input type="checkbox" data-sc="hasFail" ${b.scoring?.failWhen ? 'checked' : ''}> Use the miss reaction when</label>
            ${b.scoring?.failWhen ? `
              <select data-sc="failField" style="width:auto">${fieldOptions(b.scoring.failWhen.field)}</select>
              <select data-sc="failOp" style="width:70px">${opOptions(b.scoring.failWhen.op)}</select>
              <input data-sc="failValue" type="number" value="${escHtml(b.scoring.failWhen.value)}" style="width:80px">` : ''}
          </div>
          <p class="grader-hint">E.g. “mistakes + 1, at most 6”: 0 mistakes → score 1 reaction, 1 → score 2…</p>
        </div>` : ''}

        <div class="grader-section">
          <div class="grader-section__head"><h4>Bonus reactions</h4>
            <button type="button" class="btn btn-outline" data-add-bonus style="padding:2px 10px;font-size:12px">+ Add</button></div>
          <p class="grader-hint">Extra reactions added on top of the primary one when a rule holds. Fields: <code>score</code>, <code>fail</code> (0/1)${isCustom ? ' and your extractors' : ''}.</p>
          ${b.bonuses.map((r, i) => `
            <div class="grader-rule">
              When
              <select data-bonus="${i}:field" style="width:auto">${bonusFieldOptions(r.field)}</select>
              <select data-bonus="${i}:op" style="width:70px">${opOptions(r.op)}</select>
              <input data-bonus="${i}:value" type="number" value="${escHtml(r.value)}" style="width:80px">
              → ${emojiField(`data-bonus="${i}:emoji"`, r.emoji, 'emoji')}
              <button type="button" class="btn btn-ghost" data-del-bonus="${i}" title="Remove">✕</button>
            </div>`).join('') || '<p class="grader-hint" style="margin:0">None.</p>'}
        </div>

        <div class="grader-section">
          <div class="grader-section__head"><h4>Legend for this board</h4>
            <label class="grader-check"><input type="checkbox" data-f="ownLegend" ${showLegend ? 'checked' : ''}> Use its own reactions</label></div>
          ${showLegend ? `
            <p class="grader-hint">Blank cells fall back to the default legend.</p>
            <div class="grader-legend-grid grader-legend-grid--tight">
              ${legendKeys.map(k => `
                <div class="grader-legend-row">
                  <span class="grader-legend-row__label">${escHtml(legendLabel(k))}</span>
                  ${emojiField(`data-blegend="${escHtml(k)}"`, b.legend?.[k] || '', draft.legend[k])}
                </div>`).join('')}
            </div>` : ''}
        </div>`;
    }

    // ── Delegated form input handling ──
    form.addEventListener('input', e => {
      const t = e.target;
      const f = t.dataset.f;
      if (f === 'name') b.name = t.value;
      else if (f === 'id') b.id = t.value;
      else if (f === 'detectText') { detectText = t.value; syncRegex(); updateRegexHint(); }
      else if (f === 'headerRegex') b.headerRegex = t.value;
      else if (t.dataset.ext) {
        const [i, key] = t.dataset.ext.split(':');
        const x = b.extractors[+i];
        x[key] = key === 'default' ? (t.value === '' ? null : t.value) : t.value;
      } else if (t.dataset.bonus) {
        const [i, key] = t.dataset.bonus.split(':');
        b.bonuses[+i][key] = t.value;
      } else if (t.dataset.sc) {
        const k = t.dataset.sc;
        if (k === 'offset' || k === 'cap') b.scoring[k] = t.value === '' ? '' : Number(t.value);
        if (k === 'failValue') b.scoring.failWhen.value = t.value;
      } else if (t.dataset.band) {
        const [i, key] = t.dataset.band.split(':');
        b.scoring.bands[+i][key] = t.value === '' ? '' : Number(t.value);
      } else if (t.dataset.blegend) {
        b.legend ||= {};
        if (t.value) b.legend[t.dataset.blegend] = t.value; else delete b.legend[t.dataset.blegend];
      }
      runLive();
    });

    // Select / checkbox / structural changes re-render the form.
    form.addEventListener('change', e => {
      const t = e.target;
      const f = t.dataset.f;
      if (f === 'parserType') {
        b.parserType = t.value;
        if (t.value === 'custom' && !b.extractors?.length) {
          b.extractors = [{ name: 'points', kind: 'regex', pattern: '(\\d+)\\s+points', default: null }];
          b.scoring = { field: 'points', offset: 0, cap: 6 };
        }
        if (t.value === 'wordle' && detectMode !== 'regex') detectMode = 'regex';
      } else if (f === 'detectMode') {
        const next = t.value;
        if (next === 'regex') { detectMode = 'regex'; }
        else {
          // Going from regex → simple: keep text if the regex was already simple.
          const simple = parseSimpleRegex(b.headerRegex);
          detectMode = next;
          detectText = simple ? simple.text : detectText;
          syncRegex();
        }
      } else if (f === 'ownLegend') {
        showLegend = t.checked;
        if (!showLegend) delete b.legend;
      } else if (t.dataset.ext) {
        const [i, key] = t.dataset.ext.split(':');
        if (key !== 'kind') return;
        const x = b.extractors[+i];
        x.kind = t.value;
        if (t.value !== 'regex') delete x.default;
      } else if (t.dataset.bonus) {
        const [, key] = t.dataset.bonus.split(':');
        if (key !== 'field' && key !== 'op') return;
        return runLive();
      } else if (t.dataset.band) {
        // Re-render so the legend preview next to the band updates.
      } else if (t.dataset.sc) {
        const k = t.dataset.sc;
        if (k === 'field') b.scoring.field = t.value;
        else if (k === 'mode') {
          if (t.value === 'bands') b.scoring.bands = [{ min: 0, score: 1 }];
          else delete b.scoring.bands;
        }
        else if (k === 'hasFail') b.scoring.failWhen = t.checked ? { field: b.scoring.field, op: '==', value: 0 } : undefined;
        else if (k === 'failField') b.scoring.failWhen.field = t.value;
        else if (k === 'failOp') b.scoring.failWhen.op = t.value;
        else return;
      } else {
        return;
      }
      renderForm();
      runLive();
    });

    form.addEventListener('click', e => {
      const t = e.target.closest('button');
      if (!t) return;
      if ('addExt' in t.dataset) b.extractors.push({ name: `value${b.extractors.length + 1}`, kind: 'regex', pattern: '(\\d+)', default: null });
      else if (t.dataset.delExt != null) { if (b.extractors.length <= 1) return; const [rm] = b.extractors.splice(+t.dataset.delExt, 1); if (b.scoring?.field === rm.name) b.scoring.field = b.extractors[0].name; }
      else if ('addBand' in t.dataset) b.scoring.bands.push({ min: 0, score: Math.min(b.scoring.bands.length + 1, 6) });
      else if (t.dataset.delBand != null) { if (b.scoring.bands.length <= 1) return; b.scoring.bands.splice(+t.dataset.delBand, 1); }
      else if ('addBonus' in t.dataset) b.bonuses.push({ field: b.extractors?.[0]?.name || 'score', op: '>=', value: 0, emoji: '' });
      else if (t.dataset.delBonus != null) b.bonuses.splice(+t.dataset.delBonus, 1);
      else return;
      renderForm();
      runLive();
    });

    function updateRegexHint() {
      const code = form.querySelector('.grader-detect + .grader-hint code');
      if (code) code.textContent = b.headerRegex || '…';
    }

    // ── Live test pane ──
    const sampleBox = dialog.querySelector('#ed-sample-text');
    const result = dialog.querySelector('#ed-result');
    sampleBox.value = sampleText;

    function renderSamples() {
      dialog.querySelector('#ed-samples').innerHTML = b.samples.map((s, i) => `
        <span class="chip ${i === sampleIdx ? 'is-active' : ''}" data-sample="${i}">${escHtml(s.label || `Sample ${i + 1}`)}
          <button type="button" class="chip__x" data-del-sample="${i}" title="Delete sample">×</button></span>`).join('');
    }
    dialog.querySelector('#ed-samples').addEventListener('click', e => {
      const del = e.target.closest('[data-del-sample]');
      if (del) { b.samples.splice(+del.dataset.delSample, 1); sampleIdx = -1; renderSamples(); return; }
      const chip = e.target.closest('[data-sample]');
      if (!chip) return;
      sampleIdx = +chip.dataset.sample;
      sampleBox.value = b.samples[sampleIdx].content;
      renderSamples();
      runLive();
    });
    dialog.querySelector('#ed-save-sample').addEventListener('click', () => {
      const content = sampleBox.value.trim();
      if (!content) return;
      if (b.samples.length >= 8) { alert('At most 8 samples per board.'); return; }
      const label = prompt('Label for this sample (e.g. "Perfect, 138 pts")', '') ?? '';
      b.samples.push({ label: label.trim(), content });
      sampleIdx = b.samples.length - 1;
      renderSamples();
    });

    const runLive = debounce(async () => {
      const content = sampleBox.value;
      if (!content.trim()) {
        result.innerHTML = '<p class="grader-hint">Paste a post (or pick a saved sample) to see what this board does with it.</p>';
        return;
      }
      try {
        const { grade } = await api.testGrader(content, { legend: draft.legend, boards: [b] });
        result.innerHTML = renderTrace(grade, b.name || 'this board');
      } catch (err) {
        // Validation errors while mid-edit are expected; show them softly.
        result.innerHTML = `<div class="grader-trace grader-trace--err">${escHtml(err.message)}</div>`;
      }
    }, 250);
    sampleBox.addEventListener('input', () => { sampleIdx = -1; renderSamples(); runLive(); });

    // ── Apply ──
    dialog.querySelector('#ed-apply').addEventListener('click', async () => {
      const fbk = dialog.querySelector('#ed-feedback');
      fbk.innerHTML = '';
      b.id = b.id.trim();
      b.name = b.name.trim();
      if (!editing && draft.boards.some(x => x.id === b.id)) {
        fbk.innerHTML = `<div class="alert alert-error">A board with id "${escHtml(b.id)}" already exists.</div>`;
        return;
      }
      try {
        await api.testGrader('', { legend: draft.legend, boards: [b] }); // server-side validation
      } catch (err) {
        fbk.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
        return;
      }
      if (editing) draft.boards[idx] = b; else draft.boards.push(b);
      close();
      render();
    });

    renderForm();
    renderSamples();
    runLive();
  }

  render();
}
