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
  let defaultRoleId = config.default_role_id || 'all';
  let filter = '';

  function render() {
    // If the default selection is no longer enabled, fall back to "All Members".
    if (defaultRoleId !== 'all' && !enabledRoleIds.has(defaultRoleId)) {
      defaultRoleId = 'all';
    }

    const filterLower = filter.trim().toLowerCase();
    const visible = filterLower
      ? allRoles.filter(r => r.name.toLowerCase().includes(filterLower) || r.id.includes(filterLower))
      : allRoles;

    const defaultOptions = allRoles
      .filter(r => enabledRoleIds.has(r.id))
      .map(r => `<option value="${escHtml(r.id)}" ${r.id === defaultRoleId ? 'selected' : ''}>${escHtml(r.name)}</option>`)
      .join('');

    container.innerHTML = `
      <div class="card__header">
        <h1>Roles Config</h1>
        <button class="btn btn-primary" id="btn-save-roles">Save Changes</button>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Toggle which Discord roles appear in the public Members section.
        ${enabledRoleIds.size} of ${allRoles.length} enabled.
      </p>

      <div class="card" style="margin-bottom:16px">
        <div class="form-group" style="margin-bottom:0">
          <label for="default-role">Default selection on the public site</label>
          <select id="default-role">
            <option value="all" ${defaultRoleId === 'all' ? 'selected' : ''}>All Members</option>
            ${defaultOptions}
          </select>
          <p style="color:var(--text-muted);font-size:13px;margin-top:8px">
            Which filter chip is active when a visitor first lands on the Members section.
            Choices are limited to roles enabled above.
          </p>
        </div>
      </div>

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

    document.getElementById('default-role')?.addEventListener('change', e => {
      defaultRoleId = e.target.value;
    });

    document.getElementById('role-filter')?.addEventListener('input', e => {
      filter = e.target.value;
      // Capture current checkbox state into the Set before re-rendering
      syncCheckboxesToSet();
      render();
      document.getElementById('role-filter')?.focus();
    });

    // Keep the default-role dropdown in sync with toggles without a full
    // re-render (preserves scroll position and filter focus).
    document.querySelectorAll('.role-toggle').forEach(cb => {
      cb.addEventListener('change', () => {
        syncCheckboxesToSet();
        refreshDefaultRoleDropdown();
      });
    });

    document.getElementById('btn-save-roles')?.addEventListener('click', async () => {
      syncCheckboxesToSet();
      const btn = document.getElementById('btn-save-roles');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await api.putConfig({
          role_ids: [...enabledRoleIds],
          default_role_id: defaultRoleId === 'all' ? null : defaultRoleId,
        });
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

  function refreshDefaultRoleDropdown() {
    if (defaultRoleId !== 'all' && !enabledRoleIds.has(defaultRoleId)) {
      defaultRoleId = 'all';
    }
    const select = document.getElementById('default-role');
    if (!select) return;
    const opts = ['<option value="all">All Members</option>'].concat(
      allRoles
        .filter(r => enabledRoleIds.has(r.id))
        .map(r => `<option value="${escHtml(r.id)}">${escHtml(r.name)}</option>`)
    );
    select.innerHTML = opts.join('');
    select.value = defaultRoleId;
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
