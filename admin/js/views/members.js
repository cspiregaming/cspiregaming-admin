import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderMembers(container) {
  container.innerHTML = '<div class="loading">Loading members...</div>';

  const { members, roles, totalMembers, fetchedAt } = await api.getMembers();

  const rolesById = Object.fromEntries(roles.map(r => [r.id, r]));
  let filtered = members;
  let selectedRole = 'all';

  function render() {
    const toolbarHtml = `
      <div class="toolbar" id="members-toolbar">
        <button class="chip ${selectedRole === 'all' ? 'is-active' : ''}" data-role="all">
          All <span class="chip__count">${members.length}</span>
        </button>
        ${roles.map(r => {
          const count = members.filter(m => m.roles.includes(r.id)).length;
          return `
            <button class="chip ${selectedRole === r.id ? 'is-active' : ''}" data-role="${escHtml(r.id)}">
              ${r.color ? `<span class="role-dot" style="background:${escHtml(r.color)}"></span>` : ''}
              ${escHtml(r.name)} <span class="chip__count">${count}</span>
            </button>
          `;
        }).join('')}
      </div>
    `;

    const gridHtml = `
      <ul class="members-grid">
        ${filtered.map(m => {
          const visibleRoles = m.roles.map(id => rolesById[id]).filter(Boolean)
            .sort((a, b) => b.position - a.position);
          return `
            <li class="member-card">
              <img src="${escHtml(m.avatar)}" alt="" loading="lazy" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
              <p class="member-card__name">${escHtml(m.displayName)}</p>
              <p class="member-card__handle">@${escHtml(m.username)}</p>
              <ul class="member-card__roles">
                ${visibleRoles.map(r => `
                  <li class="role-badge">
                    ${r.color ? `<span class="role-dot" style="background:${escHtml(r.color)}"></span>` : ''}
                    ${escHtml(r.name)}
                  </li>
                `).join('')}
              </ul>
            </li>
          `;
        }).join('')}
      </ul>
    `;

    container.innerHTML = `
      <div class="card__header">
        <h1>Members <span style="font-size:1rem;color:var(--text-muted);font-weight:400">(${totalMembers} total)</span></h1>
        <button class="btn btn-outline" id="btn-export">⬇ Export CSV</button>
      </div>
      ${toolbarHtml}
      ${filtered.length ? gridHtml : '<p style="color:var(--text-muted)">No members match this filter.</p>'}
      ${fetchedAt ? `<p style="color:var(--text-muted);font-size:12px;margin-top:16px">Last synced: ${new Date(fetchedAt).toLocaleString()}</p>` : ''}
    `;

    container.querySelector('#members-toolbar')?.addEventListener('click', e => {
      const chip = e.target.closest('.chip[data-role]');
      if (!chip) return;
      selectedRole = chip.dataset.role;
      filtered = selectedRole === 'all'
        ? members
        : members.filter(m => m.roles.includes(selectedRole));
      render();
    });

    container.querySelector('#btn-export')?.addEventListener('click', async () => {
      const blob = await api.exportMembersCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'members.csv'; a.click();
      URL.revokeObjectURL(url);
    });
  }

  render();
}
