import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderDashboard(container) {
  const [config, members] = await Promise.all([
    api.getConfig().catch(() => ({})),
    api.getMembers().catch(() => ({ members: [], totalMembers: 0, fetchedAt: null })),
  ]);

  const roleCount = (config.role_ids || []).length;
  const memberCount = members.totalMembers || 0;
  const lastSync = members.fetchedAt ? new Date(members.fetchedAt).toLocaleString() : 'Never';
  const guildId = config.guild_id || '379707231077138442';

  container.innerHTML = `
    <h1>Dashboard</h1>
    <p style="color:var(--text-muted);margin-bottom:24px">C Spire Gaming — Guild <code>${escHtml(guildId)}</code></p>

    <div class="stat-row">
      <div class="stat">
        <div class="stat__value">${memberCount}</div>
        <div class="stat__label">Members</div>
      </div>
      <div class="stat">
        <div class="stat__value">${roleCount}</div>
        <div class="stat__label">Configured Roles</div>
      </div>
      <div class="stat">
        <div class="stat__value" style="font-size:1rem">${escHtml(lastSync)}</div>
        <div class="stat__label">Last Synced</div>
      </div>
      <div class="stat">
        <div class="stat__value" style="font-size:1rem">${config.bot_token_set ? '✓' : '✗'}</div>
        <div class="stat__label">Bot Token</div>
      </div>
    </div>

    <div class="card">
      <h2>Quick Actions</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-outline" id="btn-refresh-cache">↻ Refresh Member Cache</button>
        <button class="btn btn-outline" id="btn-export-csv">⬇ Export Members CSV</button>
      </div>
    </div>

    ${!config.bot_token_set ? `
      <div class="alert alert-error">
        Bot token is not configured. Go to <strong>Settings</strong> to add your Discord bot token before members will load.
      </div>
    ` : ''}
    ${!roleCount ? `
      <div class="alert alert-error">
        No roles are configured. Go to <strong>Roles Config</strong> to choose which Discord roles appear in the members section.
      </div>
    ` : ''}
  `;

  document.getElementById('btn-export-csv')?.addEventListener('click', async () => {
    const blob = await api.exportMembersCsv();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'members.csv'; a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btn-refresh-cache')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Refreshing...';
    // Trigger a fresh fetch by putting an empty role_ids then restoring (simplest cache bust)
    // In practice the admin can just wait for the 5-min TTL, or we force via config write
    await api.putConfig({ role_ids: config.role_ids || [] });
    e.target.textContent = '✓ Cache cleared';
    setTimeout(() => { e.target.disabled = false; e.target.textContent = '↻ Refresh Member Cache'; }, 2000);
  });
}
