import { api } from '../api.js';
import { escHtml } from '../app.js';

/**
 * Custom Emojis admin view — read-only catalog of every custom emoji the bot
 * can see in the guild. Each cell shows the emoji, its name, and the `name:id`
 * reaction string that worker code (or admin controls like the Daily Games
 * legend) needs when referring to a custom emoji.
 *
 * Mod-or-officer accessible. The data comes from the bot's cached guild emoji
 * fetch (1-hour TTL) via `/api/admin/emojis`.
 */
export async function renderEmojis(container) {
  container.innerHTML = '<div class="loading">Loading guild emojis…</div>';

  let emojis;
  try {
    const payload = await api.getEmojis();
    emojis = payload.emojis || [];
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load guild emojis: ${escHtml(err.message)}</div>`;
    return;
  }

  let filter = '';
  let mode = 'all'; // 'all' | 'static' | 'animated'

  function visible() {
    const f = filter.trim().toLowerCase();
    return emojis.filter(e => {
      if (mode === 'static' && e.animated) return false;
      if (mode === 'animated' && !e.animated) return false;
      if (!f) return true;
      return e.name.toLowerCase().includes(f) || e.id.includes(f);
    });
  }

  function render() {
    const list = visible();
    const animatedCount = emojis.filter(e => e.animated).length;
    const staticCount = emojis.length - animatedCount;

    container.innerHTML = `
      <h1>Custom Emojis</h1>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Every custom emoji the bot can see in this guild — cached for one hour from Discord.
        Click any cell to copy its <code>name:id</code> reaction string, which is what the
        Daily Games legend and other admin controls accept for custom emojis.
      </p>

      <div class="card">
        <div class="toolbar">
          <button class="chip ${mode === 'all' ? 'is-active' : ''}" data-mode="all">
            All <span class="chip__count">${emojis.length}</span>
          </button>
          <button class="chip ${mode === 'static' ? 'is-active' : ''}" data-mode="static">
            Static <span class="chip__count">${staticCount}</span>
          </button>
          <button class="chip ${mode === 'animated' ? 'is-active' : ''}" data-mode="animated">
            Animated <span class="chip__count">${animatedCount}</span>
          </button>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <input id="emoji-filter" type="search" placeholder="Filter by name or ID…" value="${escHtml(filter)}">
        </div>
        ${list.length ? `
          <div class="emoji-grid">
            ${list.map(renderCell).join('')}
          </div>
        ` : '<p style="color:var(--text-muted);margin:0">No emojis match.</p>'}
      </div>
    `;

    container.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => { mode = btn.dataset.mode; render(); });
    });

    const input = container.querySelector('#emoji-filter');
    input?.addEventListener('input', e => {
      filter = e.target.value;
      render();
      const refreshed = container.querySelector('#emoji-filter');
      if (refreshed) { refreshed.focus(); refreshed.setSelectionRange(filter.length, filter.length); }
    });

    container.querySelectorAll('[data-emoji]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.emoji);
          const label = btn.querySelector('.emoji-grid__cell-label');
          if (!label) return;
          const old = label.textContent;
          label.textContent = 'Copied!';
          setTimeout(() => { label.textContent = old; }, 900);
        } catch {}
      });
    });
  }

  function renderCell(e) {
    return `
      <button type="button" class="emoji-grid__cell" data-emoji="${escHtml(e.reaction)}"
        title="${escHtml(e.name)} — click to copy ${escHtml(e.reaction)}">
        <img src="${escHtml(e.url)}" alt="${escHtml(e.name)}" loading="lazy">
        <span class="emoji-grid__cell-label">${escHtml(e.name)}</span>
        ${e.animated ? '<span class="badge badge-muted" style="font-size:9px;padding:1px 6px">GIF</span>' : ''}
      </button>
    `;
  }

  render();
}
