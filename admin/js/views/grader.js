import { api } from '../api.js';
import { escHtml } from '../app.js';

/**
 * Daily Games admin view — manages the boards + legend the auto-grader uses
 * when it reacts to messages in #daily-games.
 *
 * Officers and mods both reach this view; everything is one big edit form
 * with a single Save button that PUTs the whole config. A separate Test
 * panel runs the current draft against pasted Discord message content so
 * officers can verify before saving.
 */
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
  const draft = {
    legend: { ...payload.config.legend },
    boards: payload.config.boards.map(b => ({ ...b })),
  };
  const parserTypes = payload.parserTypes;
  const legendKeys = payload.legendKeys;

  function render() {
    container.innerHTML = `
      <div class="card__header">
        <h1>Daily Games</h1>
        <button class="btn btn-primary" id="btn-save-grader">Save Changes</button>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Configure the auto-grader that watches <code>#daily-games</code>. Boards are matched against incoming messages
        in order; the first one that matches gets the score-emoji reaction from the legend.
      </p>
      <div id="grader-feedback"></div>

      <div class="card">
        <h2>Legend</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
          Reaction emoji for each score (lower&nbsp;=&nbsp;better). Boards with a max score below 6 just never use the higher entries.
          Each cell can hold a single unicode emoji <em>or</em> a Discord custom-emoji reference in <code>name:id</code> form
          — see <a href="#" data-nav="emojis">Custom Emojis</a> for the bot's available catalog.
        </p>
        <div class="grader-legend-grid" id="legend-grid">
          ${legendKeys.map(renderLegendRow).join('')}
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h2 style="margin:0">Boards</h2>
          <button class="btn btn-outline" id="btn-add-board">+ Add Board</button>
        </div>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
          Each board picks a built-in parser type and a header regex.
          The <strong>wordle</strong> parser needs one capture group that holds the score token (a digit or <code>X</code>).
          The <strong>framed</strong> parser scores by the first 🟩 in a 6-square row.
          The <strong>connections</strong> parser scores 1&nbsp;+&nbsp;mistakes and requires a "Puzzle #N" line.
          The <strong>strands</strong> parser scores by hints used (💡 count&nbsp;+&nbsp;1), capped at score6; no miss state.
        </p>
        <div id="boards-list">
          ${renderBoardsList()}
        </div>
      </div>

      <div class="card">
        <h2>Test</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
          Paste a Discord message body to see what the current draft would grade it as. Uses your unsaved edits above —
          you don't have to Save first.
        </p>
        <textarea id="test-content" rows="8" placeholder="Paste a board message here…&#10;e.g. Wordle 1,234 4/6"></textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-primary" id="btn-test">Grade it</button>
          <div id="test-result" style="flex:1"></div>
        </div>
      </div>
    `;

    wireLegend();
    wireBoards();
    wireTest();
    wireSave();
    wireInternalNav();
  }

  function wireInternalNav() {
    container.querySelectorAll('[data-nav]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        import('../app.js').then(m => m.navigateTo(el.dataset.nav));
      });
    });
  }

  function renderLegendRow(key) {
    const value = draft.legend[key] || '';
    const label = key === 'miss' ? 'Miss / failed' : `Score ${key.replace('score', '')}`;
    return `
      <div class="grader-legend-row">
        <span class="grader-legend-row__label">${escHtml(label)}</span>
        <span class="grader-legend-row__preview" data-preview-for="${escHtml(key)}">${renderEmojiPreview(value)}</span>
        <input class="grader-legend-row__input" data-legend-key="${escHtml(key)}" value="${escHtml(value)}" maxlength="64" placeholder="🌟 or name:id">
      </div>
    `;
  }

  function renderBoardsList() {
    if (!draft.boards.length) {
      return '<p style="color:var(--text-muted)">No boards. Add one above.</p>';
    }
    return `
      <table>
        <thead>
          <tr>
            <th style="width:30px"></th>
            <th>ID</th>
            <th>Name</th>
            <th>Parser</th>
            <th>Header Regex</th>
            <th style="width:120px">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${draft.boards.map((b, idx) => `
            <tr data-board-idx="${idx}">
              <td>
                <span class="drag-handle" title="Drag to reorder" data-move="${idx}">⋮⋮</span>
              </td>
              <td><code>${escHtml(b.id)}</code></td>
              <td>${escHtml(b.name)}</td>
              <td><span class="badge badge-muted">${escHtml(b.parserType)}</span></td>
              <td><code style="font-size:11px;color:var(--text-muted)">${escHtml(b.headerRegex)}</code></td>
              <td style="display:flex;gap:6px">
                <button class="btn btn-outline" data-edit-board="${idx}" style="padding:4px 10px;font-size:12px">Edit</button>
                <button class="btn btn-danger" data-delete-board="${idx}" style="padding:4px 10px;font-size:12px">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderEmojiPreview(value) {
    if (!value) return '<span style="color:var(--text-muted);font-size:12px">—</span>';
    const customMatch = /^([A-Za-z0-9_]{2,32}):(\d{15,21})$/.exec(value);
    if (customMatch) {
      const id = customMatch[2];
      // We don't know if it's animated from a name:id string alone — try png
      // first, fall back to gif on error.
      return `<img src="https://cdn.discordapp.com/emojis/${id}.png?size=32" alt="${escHtml(value)}" style="width:24px;height:24px;vertical-align:middle" onerror="this.onerror=null;this.src='https://cdn.discordapp.com/emojis/${id}.gif?size=32'">`;
    }
    return `<span style="font-size:20px;line-height:1">${escHtml(value)}</span>`;
  }

  function wireLegend() {
    container.querySelectorAll('[data-legend-key]').forEach(input => {
      input.addEventListener('input', () => {
        const key = input.dataset.legendKey;
        draft.legend[key] = input.value;
        const preview = container.querySelector(`[data-preview-for="${key}"]`);
        if (preview) preview.innerHTML = renderEmojiPreview(input.value);
      });
    });
  }

  function wireBoards() {
    container.querySelector('#btn-add-board')?.addEventListener('click', () => openBoardForm(null));
    container.querySelectorAll('[data-edit-board]').forEach(btn => {
      btn.addEventListener('click', () => openBoardForm(Number(btn.dataset.editBoard)));
    });
    container.querySelectorAll('[data-delete-board]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.deleteBoard);
        const board = draft.boards[idx];
        if (!board) return;
        if (!confirm(`Delete board "${board.name}"?`)) return;
        draft.boards.splice(idx, 1);
        render();
      });
    });
  }

  function openBoardForm(idx) {
    const editing = idx != null ? draft.boards[idx] : null;
    const placeholders = {
      wordle: '^Wordle\\s+\\S+\\s+([X1-6])/6\\*?',
      framed: '^Framed\\s+#\\d+',
      connections: '^Connections\\b',
      strands: '^Strands\\s+#\\d+',
    };
    const dialog = document.createElement('div');
    dialog.className = 'grader-board-dialog';
    dialog.innerHTML = `
      <div class="grader-board-dialog__backdrop"></div>
      <div class="grader-board-dialog__panel card">
        <h2>${editing ? 'Edit Board' : 'Add Board'}</h2>
        <form id="board-form">
          <div class="form-row">
            <div class="form-group">
              <label>ID</label>
              <input name="id" value="${escHtml(editing?.id || '')}" placeholder="strands" required pattern="[A-Za-z0-9_-]{1,32}" ${editing ? 'readonly' : ''}>
            </div>
            <div class="form-group">
              <label>Display Name</label>
              <input name="name" value="${escHtml(editing?.name || '')}" placeholder="Strands" required maxlength="64">
            </div>
          </div>
          <div class="form-group">
            <label>Parser Type</label>
            <select name="parserType">
              ${parserTypes.map(t => `<option value="${t}" ${editing?.parserType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Header Regex</label>
            <input name="headerRegex" value="${escHtml(editing?.headerRegex || '')}" placeholder="${escHtml(placeholders[editing?.parserType || 'wordle'])}" required maxlength="256" style="font-family:ui-monospace,monospace">
            <p style="color:var(--text-muted);font-size:12px;margin-top:6px" id="parser-hint">${parserHint(editing?.parserType || 'wordle')}</p>
          </div>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button type="submit" class="btn btn-primary">${editing ? 'Save Board' : 'Add Board'}</button>
            <button type="button" class="btn btn-outline" id="btn-cancel-board">Cancel</button>
          </div>
          <div id="board-form-feedback" style="margin-top:12px"></div>
        </form>
      </div>
    `;
    document.body.appendChild(dialog);

    const close = () => dialog.remove();
    dialog.querySelector('.grader-board-dialog__backdrop')?.addEventListener('click', close);
    dialog.querySelector('#btn-cancel-board')?.addEventListener('click', close);

    const parserSelect = dialog.querySelector('[name=parserType]');
    const regexInput = dialog.querySelector('[name=headerRegex]');
    const hint = dialog.querySelector('#parser-hint');
    parserSelect?.addEventListener('change', () => {
      regexInput.placeholder = placeholders[parserSelect.value] || '';
      hint.textContent = parserHint(parserSelect.value);
    });

    dialog.querySelector('#board-form')?.addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const board = {
        id: String(fd.get('id') || '').trim(),
        name: String(fd.get('name') || '').trim(),
        parserType: fd.get('parserType'),
        headerRegex: String(fd.get('headerRegex') || '').trim(),
      };
      const fbk = dialog.querySelector('#board-form-feedback');
      const dupIdx = draft.boards.findIndex(b => b.id === board.id);
      if (editing == null && dupIdx !== -1) {
        fbk.innerHTML = `<div class="alert alert-error">A board with id "${escHtml(board.id)}" already exists.</div>`;
        return;
      }
      try {
        new RegExp(board.headerRegex, 'm');
      } catch (err) {
        fbk.innerHTML = `<div class="alert alert-error">Header regex is invalid: ${escHtml(err.message)}</div>`;
        return;
      }
      if (editing == null) {
        draft.boards.push(board);
      } else {
        draft.boards[idx] = board;
      }
      close();
      render();
    });
  }

  function parserHint(type) {
    switch (type) {
      case 'wordle':      return 'Must contain one capture group for the score token (a digit or "X"). E.g. ^Wordle.*?([X1-6])/6\\*?';
      case 'framed':      return 'Just a presence gate — scoring uses the first 🟩 in any 6-square line of the message.';
      case 'connections': return 'Just a presence gate — scoring uses solid same-color rows of 4 squares plus a "Puzzle #N" line.';
      case 'strands':     return 'Just a presence gate — scoring counts 💡 hint emojis (score = hints + 1, capped at score6). No miss state.';
      default:            return '';
    }
  }

  function wireTest() {
    container.querySelector('#btn-test')?.addEventListener('click', async () => {
      const content = container.querySelector('#test-content')?.value || '';
      const resultBox = container.querySelector('#test-result');
      resultBox.innerHTML = '<span style="color:var(--text-muted)">Grading…</span>';
      try {
        const { grade } = await api.testGrader(content, draft);
        resultBox.innerHTML = renderTestResult(grade);
      } catch (err) {
        resultBox.innerHTML = `<div class="alert alert-error" style="margin:0">${escHtml(err.message)}</div>`;
      }
    });
  }

  function renderTestResult(grade) {
    if (!grade) {
      return '<span style="color:var(--text-muted)">No board matched.</span>';
    }
    const pretty = grade.fail ? 'miss' : `score ${grade.score}`;
    return `
      <div style="display:flex;align-items:center;gap:10px">
        <span>Matched <strong>${escHtml(grade.game)}</strong> — ${pretty} →</span>
        <span style="font-size:20px">${renderEmojiPreview(grade.emoji)}</span>
        <code style="font-size:11px;color:var(--text-muted)">${escHtml(grade.emoji)}</code>
      </div>
    `;
  }

  function wireSave() {
    container.querySelector('#btn-save-grader')?.addEventListener('click', async () => {
      const btn = container.querySelector('#btn-save-grader');
      const fbk = container.querySelector('#grader-feedback');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      fbk.innerHTML = '';
      try {
        await api.putGrader(draft);
        fbk.innerHTML = '<div class="alert alert-success">✓ Grader config saved. New boards take effect on the next cron tick (≤ 1 minute).</div>';
      } catch (err) {
        fbk.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Changes';
      }
    });
  }

  render();
}
