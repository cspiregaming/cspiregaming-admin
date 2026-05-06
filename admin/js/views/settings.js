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
      <p style="color:var(--text-muted);font-size:12px;margin-top:8px">
        Guild ID and Admin Role ID are managed in <code>worker/wrangler.toml</code> by developers.
        Current guild: <code>${escHtml(config.guild_id || '')}</code>
      </p>
    </div>

    <div class="card" style="margin-top:0">
      <h2>Session</h2>
      <button class="btn btn-outline" id="btn-logout">Sign Out</button>
    </div>
  `;

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await api.logout().catch(() => {});
    clearToken();
    window.dispatchEvent(new Event('auth:expired'));
  });
}
