import { api, clearToken } from '../api.js';
import { escHtml } from '../app.js';

export async function renderSettings(container) {
  container.innerHTML = '<div class="loading">Loading...</div>';
  const config = await api.getConfig();

  container.innerHTML = `
    <h1>Settings</h1>

    <div class="card">
      <h2>Discord Bot Configuration</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
        The bot token is stored as a Cloudflare Worker secret (never in KV) and can only be updated
        via the Wrangler CLI: <code>wrangler secret put BOT_TOKEN</code>
      </p>
      <div class="form-group">
        <label>Bot Token Status</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <span class="badge ${config.bot_token_set ? 'badge-green' : 'badge-muted'}">
            ${config.bot_token_set ? '✓ Configured' : '✗ Not set'}
          </span>
          ${!config.bot_token_set ? '<span style="color:var(--text-muted);font-size:12px">Run <code>wrangler secret put BOT_TOKEN</code> in the worker/ directory</span>' : ''}
        </div>
      </div>
      <div class="form-group">
        <label>JWT Secret Status</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <span class="badge ${config.jwt_secret_set ? 'badge-green' : 'badge-muted'}">
            ${config.jwt_secret_set ? '✓ Configured' : '✗ Not set'}
          </span>
          ${!config.jwt_secret_set ? '<span style="color:var(--text-muted);font-size:12px">Run <code>wrangler secret put JWT_SECRET</code> with a random string</span>' : ''}
        </div>
      </div>
    </div>

    <div class="card">
      <form id="settings-form">
        <h2 style="margin-bottom:16px">Guild & OAuth Configuration</h2>
        <div class="form-group">
          <label>Discord Guild ID</label>
          <input name="guild_id" value="${escHtml(config.guild_id || '379707231077138442')}" placeholder="379707231077138442">
          <small style="color:var(--text-muted)">Right-click your Discord server icon → Copy Server ID (Developer Mode must be on)</small>
        </div>
        <div class="form-group">
          <label>Admin Role ID</label>
          <input name="admin_role_id" value="${escHtml(config.admin_role_id || '')}" placeholder="Role ID required to access this admin panel">
        </div>
        <div class="form-group">
          <label>Discord OAuth Client ID</label>
          <input name="discord_client_id" value="${escHtml(config.discord_client_id || '')}" placeholder="From your Discord application at discord.com/developers">
        </div>
        <p style="color:var(--text-muted);font-size:12px;margin-bottom:16px">
          The OAuth client secret must be set via <code>wrangler secret put DISCORD_CLIENT_SECRET</code>.
          Redirect URI to register in your Discord app:
          <code id="redirect-uri-display">https://&lt;your-worker-url&gt;/api/auth/callback</code>
        </p>
        <button type="submit" class="btn btn-primary">Save Settings</button>
        <div id="settings-feedback" style="margin-top:12px"></div>
      </form>
    </div>

    <div class="card" style="margin-top:0">
      <h2>Session</h2>
      <button class="btn btn-outline" id="btn-logout">Sign Out</button>
    </div>
  `;

  document.getElementById('settings-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('[type=submit]');
    const feedback = document.getElementById('settings-feedback');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await api.putConfig({
        guild_id: fd.get('guild_id'),
        admin_role_id: fd.get('admin_role_id'),
        discord_client_id: fd.get('discord_client_id'),
      });
      feedback.innerHTML = '<div class="alert alert-success">✓ Settings saved.</div>';
    } catch (err) {
      feedback.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Settings';
    }
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await api.logout().catch(() => {});
    clearToken();
    window.dispatchEvent(new Event('auth:expired'));
  });
}
