import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderRolesConfig(container) {
  container.innerHTML = '<div class="loading">Loading...</div>';

  const config = await api.getConfig();
  const enabledRoleIds = new Set(config.role_ids || []);

  // Fetch all roles from the guild via the members endpoint (roles come back there)
  // We use the public members endpoint to get role metadata
  let allRoles = [];
  try {
    const res = await fetch(`${(await import('../api.js')).WORKER_BASE}/api/public/members`);
    const data = await res.json();
    allRoles = data.roles || [];
  } catch {
    // Can't get current roles without a bot token — show manual entry instead
  }

  function render() {
    container.innerHTML = `
      <h1>Roles Config</h1>
      <p style="color:var(--text-muted);margin-bottom:24px">
        Select which Discord roles appear in the public Members section on the website.
        Role IDs come from your Discord server's role settings.
      </p>

      <div class="card">
        <div class="card__header">
          <h2>Active Roles</h2>
          <button class="btn btn-primary" id="btn-save-roles">Save Changes</button>
        </div>
        <div id="roles-list">
          ${allRoles.length ? renderRoleToggles(allRoles, enabledRoleIds) : renderManualEntry(enabledRoleIds)}
        </div>
      </div>

      <div class="card" style="margin-top:20px">
        <h2>Add Role by ID</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
          To find a role ID: in Discord, enable Developer Mode (User Settings → Advanced),
          then right-click a role and choose "Copy Role ID".
        </p>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div class="form-group" style="flex:1;margin:0">
            <label>Discord Role ID</label>
            <input id="new-role-id" placeholder="965731779824730243" type="text">
          </div>
          <button class="btn btn-outline" id="btn-add-role">+ Add</button>
        </div>
        <div id="add-role-feedback" style="margin-top:8px"></div>
      </div>

      <div id="save-feedback" style="margin-top:16px"></div>
    `;

    document.getElementById('btn-add-role')?.addEventListener('click', () => {
      const input = document.getElementById('new-role-id');
      const id = input.value.trim();
      if (!id || enabledRoleIds.has(id)) return;
      enabledRoleIds.add(id);
      input.value = '';
      render();
    });

    document.getElementById('btn-save-roles')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-save-roles');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      // Collect checked state from checkboxes if they exist
      document.querySelectorAll('.role-toggle').forEach(cb => {
        if (cb.checked) enabledRoleIds.add(cb.value);
        else enabledRoleIds.delete(cb.value);
      });

      try {
        await api.putConfig({ role_ids: [...enabledRoleIds] });
        document.getElementById('save-feedback').innerHTML =
          '<div class="alert alert-success">✓ Roles saved. The Members section will update within 5 minutes.</div>';
      } catch (err) {
        document.getElementById('save-feedback').innerHTML =
          `<div class="alert alert-error">Save failed: ${escHtml(err.message)}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Changes';
      }
    });
  }

  render();
}

function renderRoleToggles(roles, enabledRoleIds) {
  return roles.map(r => `
    <div class="toggle" style="padding:10px 0;border-bottom:1px solid var(--border)">
      <label class="toggle">
        <input type="checkbox" class="role-toggle" value="${escHtml(r.id)}" ${enabledRoleIds.has(r.id) ? 'checked' : ''}>
        <span class="toggle__track"></span>
        ${r.color ? `<span class="role-dot" style="background:${escHtml(r.color)}"></span>` : ''}
        <span>${escHtml(r.name)}</span>
        <span style="color:var(--text-muted);font-size:11px;margin-left:auto">${escHtml(r.id)}</span>
      </label>
    </div>
  `).join('');
}

function renderManualEntry(enabledRoleIds) {
  if (!enabledRoleIds.size) return '<p style="color:var(--text-muted)">No roles configured yet. Add role IDs below.</p>';
  return [...enabledRoleIds].map(id => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <code style="flex:1">${escHtml(id)}</code>
      <button class="btn btn-danger" style="padding:4px 10px;font-size:12px" data-remove="${escHtml(id)}">Remove</button>
    </div>
  `).join('');
}
