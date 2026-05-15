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
          <tr><th>Posts to</th><td>${renderChannels(status)}</td></tr>
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
        const { embed: _embed, ...raw } = data;
        out.innerHTML = `<pre class="statbot-json">${escHtml(JSON.stringify(raw, null, 2))}</pre>`;
      } else {
        out.innerHTML = data.embed
          ? renderDiscordEmbed(data.embed)
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

  render();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderKeyBadge(configured) {
  return configured
    ? '<span class="badge badge-green">configured</span>'
    : '<span class="badge" style="background:rgba(224,82,82,.2);color:var(--red)">missing — run <code>wrangler secret put STATBOT_API_KEY</code></span>';
}

function renderChannels(status) {
  const parts = [];
  if (status.logsChannelId) parts.push(`<code>#bot-logs</code> <span style="color:var(--text-muted);font-size:11px">(${escHtml(status.logsChannelId)})</span>`);
  if (status.commandsChannelId) parts.push(`<code>#bot-commands</code> <span style="color:var(--text-muted);font-size:11px">(${escHtml(status.commandsChannelId)})</span>`);
  return parts.length ? parts.join(', ') : '<em style="color:var(--text-muted)">no channels configured</em>';
}

/**
 * Render a Discord embed object as styled HTML. Approximates Discord's visual:
 * colored left border, dark card, title, fields with name + value. Channel and
 * user mentions are converted to inert <#id>/<@id> placeholders since the SPA
 * doesn't have the lookup data Discord does — the actual post will resolve them.
 */
function renderDiscordEmbed(embed) {
  const color = '#' + ((embed.color || 0x4c9fff) >>> 0).toString(16).padStart(6, '0');
  const fields = (embed.fields || []).map(f => `
    <div class="statbot-embed__field">
      <div class="statbot-embed__field-name">${escHtml(f.name || '')}</div>
      <div class="statbot-embed__field-value">${renderEmbedValue(f.value || '')}</div>
    </div>
  `).join('');

  return `
    <div class="statbot-embed" style="border-left-color:${escHtml(color)}">
      ${embed.title ? `<div class="statbot-embed__title">${escHtml(embed.title)}</div>` : ''}
      ${fields}
      ${embed.footer?.text ? `<div class="statbot-embed__footer">${escHtml(embed.footer.text)}</div>` : ''}
    </div>
  `;
}

function renderEmbedValue(value) {
  // Order matters: escape first (so subsequent regex replacements get clean
  // HTML), then convert the small set of Discord-flavored tokens we emit
  // (bold, italic placeholders, channel/user mentions).
  let v = escHtml(String(value));
  v = v.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  v = v.replace(/_\((.+?)\)_/g, '<em style="color:var(--text-muted)">($1)</em>');
  v = v.replace(/&lt;#(\d+)&gt;/g, '<span style="color:var(--blue)">#channel-$1</span>');
  v = v.replace(/&lt;@(\d+)&gt;/g, '<span style="color:var(--blue)">@member-$1</span>');
  // Preserve newlines.
  v = v.replace(/\n/g, '<br>');
  return v;
}
