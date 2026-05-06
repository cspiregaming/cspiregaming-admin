import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderRolesConfig(container) {
  container.innerHTML = '<div class="loading">Loading roles from Discord...</div>';

  let config, allRoles;
  try {
    [config, { roles: allRoles }] = await Promise.all([
      api.getConfig(),
      api.getAllRoles(),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">
      Couldn't load guild roles: ${escHtml(err.message)}.
      Check that BOT_TOKEN is set and the bot is in the guild.
    </div>`;
    return;
  }

  const enabledRoleIds = new Set(config.role_ids || []);
  let filter = '';

  function render() {
    const filterLower = filter.trim().toLowerCase();
    const visible = filterLower
      ? allRoles.filter(r => r.name.toLowerCase().includes(filterLower) || r.id.includes(filterLower))
      : allRoles;

    container.innerHTML = `
      <div class="card__header">
        <h1>Roles Config</h1>
        <button class="btn btn-primary" id="btn-save-roles">Save Changes</button>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Toggle which Discord roles appear in the public Members section.
        ${enabledRoleIds.size} of ${allRoles.length} enabled.
      </p>

      <div class="card">
        <div class="form-group" style="margin-bottom:16px">
          <input id="role-filter" type="search" placeholder="Filter roles by name or ID…" value="${escHtml(filter)}">
        </div>
        <div id="roles-list">
          ${visible.length ? visible.map(renderRoleRow).join('') : '<p style="color:var(--text-muted)">No roles match.</p>'}
        </div>
      </div>

      <div id="save-feedback" style="margin-top:16px"></div>
    `;

    document.getElementById('role-filter')?.addEventListener('input', e => {
      filter = e.target.value;
      // Capture current checkbox state into the Set before re-rendering
      syncCheckboxesToSet();
      render();
      document.getElementById('role-filter')?.focus();
    });

    document.getElementById('btn-save-roles')?.addEventListener('click', async () => {
      syncCheckboxesToSet();
      const btn = document.getElementById('btn-save-roles');
      btn.disabled = true;
      btn.textContent = 'Saving…';
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

  function renderRoleRow(r) {
    const checked = enabledRoleIds.has(r.id) ? 'checked' : '';
    return `
      <label class="role-row">
        <input type="checkbox" class="role-toggle" value="${escHtml(r.id)}" ${checked}>
        <span class="toggle__track"></span>
        ${r.color ? `<span class="role-dot" style="background:${escHtml(r.color)}"></span>` : '<span class="role-dot" style="background:var(--border)"></span>'}
        <span class="role-row__name">${escHtml(r.name)}</span>
        ${r.managed ? '<span class="badge badge-muted">managed</span>' : ''}
        <span class="role-row__id">${escHtml(r.id)}</span>
      </label>
    `;
  }

  function syncCheckboxesToSet() {
    document.querySelectorAll('.role-toggle').forEach(cb => {
      if (cb.checked) enabledRoleIds.add(cb.value);
      else enabledRoleIds.delete(cb.value);
    });
  }

  render();
}
