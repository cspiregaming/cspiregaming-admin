import { api } from '../api.js';
import { escHtml } from '../app.js';

/**
 * Statbot admin view — surfaces the daily-report integration.
 *
 *   • Status panel: API key state, last-run date, next scheduled run, server's
 *     view of "now" in Central, and the two target channels.
 *   • Preview Raw JSON: hits /preview and dumps every Statbot API response so
 *     you can see exactly what came back. Useful when iterating on the embed
 *     formatter or debugging an "unexpected payload" line.
 *   • Preview Embed: same /preview fetch, but renders the formatted embed
 *     in-page using a Discord-styled card so you can eyeball the result
 *     before posting.
 *   • Post Now: confirms, then fires /run which posts to #bot-logs AND
 *     #bot-commands. Does NOT touch the last-run guard, so today's scheduled
 *     18:00 Central post still happens after a manual fire-off.
 */

export async function renderStatbot(container) {
  container.innerHTML = '<div class="loading">Loading…</div>';

  let status;
  try {
    status = await api.getStatbotStatus();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load status: ${escHtml(err.message)}</div>`;
    return;
  }

  // Cached preview payload — Preview Raw and Preview Embed share one fetch
  // since the Statbot API has rate limits and the responses don't change
  // meaningfully within a single SPA session.
  let lastPreview = null;

  function render() {
    container.innerHTML = `
      <div class="card__header">
        <h1>Statbot</h1>
        <button class="btn btn-primary" id="btn-post-now" ${status.apiKeyConfigured ? '' : 'disabled'}>Post Now</button>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Daily Statbot stats post automatically at 6:00 PM Central. Use this view to inspect the live
        API responses, preview what will post, or trigger an off-schedule post.
      </p>

      <div class="card" style="margin-bottom:16px">
        <h2 style="margin-top:0">Status</h2>
        <table class="kv-table">
          <tr><th>API key</th><td>${renderKeyBadge(status.apiKeyConfigured)}</td></tr>
          <tr><th>Last daily run</th><td>${status.lastRunDate ? escHtml(status.lastRunDate) : '<em style="color:var(--text-muted)">never</em>'}</td></tr>
          <tr><th>Next scheduled run</th><td>${escHtml(status.nextRunLabel)}</td></tr>
          <tr><th>Server time</th><td>${escHtml(status.centralNow)}</td></tr>
          <tr><th>Posts to</th><td id="statbot-channel-chips">${renderChannelChips(status)}</td></tr>
        </table>
      </div>

      <div class="card">
        <h2 style="margin-top:0">Preview</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
          Fetches the live Statbot data for the same windows the daily report uses (last 30 days
          for the overview, last 24 hours for the leaderboards) without posting anywhere.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
          <button class="btn btn-outline" id="btn-preview-embed" ${status.apiKeyConfigured ? '' : 'disabled'}>Preview Embed</button>
          <button class="btn btn-outline" id="btn-preview-raw" ${status.apiKeyConfigured ? '' : 'disabled'}>Preview Raw JSON</button>
          <button class="btn btn-ghost" id="btn-refresh-preview" ${status.apiKeyConfigured ? '' : 'disabled'} title="Discard cached payload and re-fetch from Statbot">↻ Refresh</button>
        </div>
        <div id="preview-output"></div>
      </div>

      <div id="statbot-feedback" style="margin-top:16px"></div>
    `;

    document.getElementById('btn-preview-raw')?.addEventListener('click', () => showPreview('raw'));
    document.getElementById('btn-preview-embed')?.addEventListener('click', () => showPreview('embed'));
    document.getElementById('btn-refresh-preview')?.addEventListener('click', () => {
      lastPreview = null;
      const out = document.getElementById('preview-output');
      out.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Cache cleared. Click Preview Embed or Preview Raw JSON to re-fetch.</p>';
    });
    document.getElementById('btn-post-now')?.addEventListener('click', onPostNow);
    attachChannelChipListeners();
  }

  async function ensurePreview() {
    if (lastPreview) return lastPreview;
    lastPreview = await api.previewStatbot();
    return lastPreview;
  }

  async function showPreview(mode) {
    const out = document.getElementById('preview-output');
    out.innerHTML = '<div class="loading" style="padding:24px 0">Fetching from Statbot…</div>';
    try {
      const data = await ensurePreview();
      if (mode === 'raw') {
        const { embed: _embed, repPromptEmbed: _rep, ...raw } = data;
        out.innerHTML = `<pre class="statbot-json">${escHtml(JSON.stringify(raw, null, 2))}</pre>`;
      } else {
        const parts = [];
        if (data.embed) parts.push(renderDiscordEmbed(data.embed));
        if (data.repPromptEmbed) parts.push(renderDiscordEmbed(data.repPromptEmbed));
        out.innerHTML = parts.length
          ? parts.join('<div style="height:8px"></div>')
          : '<div class="alert alert-error">No embed in preview response.</div>';
      }
    } catch (err) {
      out.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    }
  }

  async function onPostNow() {
    if (!confirm(
      'This will post the daily Statbot report to #bot-logs AND #bot-commands.\n\n' +
      '#bot-commands is visible to everyone in the server. Continue?',
    )) return;

    const btn = document.getElementById('btn-post-now');
    const feedback = document.getElementById('statbot-feedback');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Posting…';
    feedback.innerHTML = '';

    try {
      const result = await api.runStatbot();
      const lines = (result.posted || []).map(p => {
        const channelLabel = p.channelId === status.logsChannelId
          ? '#bot-logs'
          : p.channelId === status.commandsChannelId
            ? '#bot-commands'
            : p.channelId;
        return p.ok
          ? `✓ <strong>${escHtml(channelLabel)}</strong>`
          : `✗ <strong>${escHtml(channelLabel)}</strong> (${p.status})`;
      });
      const allOk = (result.posted || []).every(p => p.ok);
      feedback.innerHTML = `<div class="alert ${allOk ? 'alert-success' : 'alert-error'}">Posted: ${lines.join(' · ')}</div>`;
      btn.textContent = '✓ Posted';
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 3000);
    } catch (err) {
      feedback.innerHTML = `<div class="alert alert-error">Post failed: ${escHtml(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function attachChannelChipListeners() {
    document.querySelectorAll('[data-channel-chip]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.channelChip;
        const current = new Set(status.enabledChannelIds || []);
        if (current.has(id)) current.delete(id); else current.add(id);
        const enabledChannelIds = [...current];

        btn.disabled = true;
        try {
          await api.updateStatbotChannels(enabledChannelIds);
          status.enabledChannelIds = enabledChannelIds;
          const cell = document.getElementById('statbot-channel-chips');
          if (cell) {
            cell.innerHTML = renderChannelChips(status);
            attachChannelChipListeners();
          }
        } catch {
          btn.disabled = false;
        }
      });
    });
  }

  render();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderKeyBadge(configured) {
  return configured
    ? '<span class="badge badge-green">configured</span>'
    : '<span class="badge" style="background:rgba(224,82,82,.2);color:var(--red)">missing — run <code>wrangler secret put STATBOT_API_KEY</code></span>';
}

function renderChannelChips(status) {
  const channels = [
    { id: status.logsChannelId, name: '#bot-logs' },
    { id: status.commandsChannelId, name: '#bot-commands' },
  ].filter(c => c.id);
  if (!channels.length) return '<em style="color:var(--text-muted)">no channels configured</em>';
  const enabled = new Set(status.enabledChannelIds || []);
  return channels.map(c => {
    const active = enabled.has(c.id);
    return `<button class="chip ${active ? 'is-active' : ''}" data-channel-chip="${escHtml(c.id)}" title="${active ? 'Enabled — click to disable' : 'Disabled — click to enable'}">${escHtml(c.name)}</button>`;
  }).join(' ');
}

/**
 * Render a Discord embed object as styled HTML. Approximates Discord's
 * layout:
 *   - colored left border, dark card, title
 *   - consecutive `inline: true` fields render in a row (flex)
 *   - `inline: false` (or absent) fields take a full-width row
 *   - triple-backtick values render as <pre> blocks
 *   - inline mentions resolve to inert "@member-id" / "#channel-id" placeholders
 *     since the SPA can't do the live Discord lookup (the actual post will)
 */
function renderDiscordEmbed(embed) {
  const color = '#' + ((embed.color || 0x4c9fff) >>> 0).toString(16).padStart(6, '0');
  const rows = groupFieldsIntoRows(embed.fields || []);
  const fieldsHtml = rows.map(row => {
    if (row.length === 1) {
      return `<div class="statbot-embed__row">${renderField(row[0])}</div>`;
    }
    return `<div class="statbot-embed__row statbot-embed__row--inline">${row.map(renderField).join('')}</div>`;
  }).join('');

  return `
    <div class="statbot-embed" style="border-left-color:${escHtml(color)}">
      ${embed.title ? `<div class="statbot-embed__title">${escHtml(embed.title)}</div>` : ''}
      ${fieldsHtml}
      ${embed.footer?.text ? `<div class="statbot-embed__footer">${escHtml(embed.footer.text)}</div>` : ''}
    </div>
  `;
}

function groupFieldsIntoRows(fields) {
  // Discord packs consecutive inline:true fields into a row (max 3 per row);
  // block (inline:false) fields force a row break and stand alone.
  const rows = [];
  let bucket = [];
  for (const f of fields) {
    if (f.inline) {
      bucket.push(f);
      if (bucket.length === 3) { rows.push(bucket); bucket = []; }
    } else {
      if (bucket.length) { rows.push(bucket); bucket = []; }
      rows.push([f]);
    }
  }
  if (bucket.length) rows.push(bucket);
  return rows;
}

function renderField(f) {
  return `
    <div class="statbot-embed__field">
      <div class="statbot-embed__field-name">${escHtml(f.name || '')}</div>
      <div class="statbot-embed__field-value">${renderEmbedValue(f.value || '')}</div>
    </div>
  `;
}

function renderEmbedValue(value) {
  const raw = String(value);

  // Triple-backtick code block. Discord's actual renderer respects an optional
  // language tag on the fence; we strip it for the preview since we're not
  // syntax-highlighting anyway.
  const codeFence = raw.match(/^```(?:\w*\n)?([\s\S]*?)```\s*$/);
  if (codeFence) {
    return `<pre class="statbot-embed__code">${escHtml(codeFence[1].replace(/^\n|\n$/g, ''))}</pre>`;
  }

  // Order matters: escape first (so subsequent regex replacements get clean
  // HTML), then convert the small set of Discord-flavored tokens we emit
  // (bold, italic placeholders, channel/user mentions).
  let v = escHtml(raw);
  v = v.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  v = v.replace(/`([^`]+)`/g, '<code class="statbot-embed__inline-code">$1</code>');
  v = v.replace(/_\((.+?)\)_/g, '<em style="color:var(--text-muted)">($1)</em>');
  v = v.replace(/&lt;#(\d+)&gt;/g, '<span style="color:var(--blue)">#channel-$1</span>');
  v = v.replace(/&lt;@(\d+)&gt;/g, '<span style="color:var(--blue)">@member-$1</span>');
  v = v.replace(/\n/g, '<br>');
  return v;
}
