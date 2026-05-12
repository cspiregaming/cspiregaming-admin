import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderMembers(container) {
  container.innerHTML = '<div class="loading">Loading members...</div>';

  const { members, roles, totalMembers, fetchedAt } = await api.getMembers();

  const rolesById = Object.fromEntries(roles.map(r => [r.id, r]));
  let filtered = members;
  let selectedRole = 'all';

  function applyFilter() {
    if (selectedRole === 'all') filtered = members;
    else if (selectedRole === 'opted-out') filtered = members.filter(m => m.optedOut);
    else filtered = members.filter(m => m.roles.includes(selectedRole));
  }

  function render() {
    const optedOutCount = members.filter(m => m.optedOut).length;
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
        <button class="chip ${selectedRole === 'opted-out' ? 'is-active' : ''}" data-role="opted-out" title="Members hidden from the public site">
          🚫 Hidden from public <span class="chip__count">${optedOutCount}</span>
        </button>
      </div>
    `;

    const gridHtml = `
      <ul class="members-grid">
        ${filtered.map(m => {
          const visibleRoles = m.roles.map(id => rolesById[id]).filter(Boolean)
            .sort((a, b) => b.position - a.position);
          const optedOut = !!m.optedOut;
          return `
            <li class="member-card ${optedOut ? 'is-opted-out' : ''}" data-member-id="${escHtml(m.id)}">
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
              ${optedOut ? '<span class="member-card__optout-badge" title="Hidden from public site">🚫 Hidden</span>' : ''}
              <button
                class="btn btn-sm member-card__optout-btn ${optedOut ? 'btn-outline' : 'btn-ghost'}"
                data-action="toggle-optout"
                data-member-id="${escHtml(m.id)}"
                data-current="${optedOut ? '1' : '0'}"
                title="${optedOut ? 'Restore this member on the public site' : 'Hide this member from the public site'}"
              >${optedOut ? 'Show on public site' : 'Hide from public'}</button>
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
      <p style="color:var(--text-muted);font-size:12px;margin:0 0 12px">
        Listing is opt-in by role. Members with a configured role appear on the public site by default —
        click <strong>Hide from public</strong> on a card to opt them out (they can re-opt in themselves
        via <code>/toggle-public-membership</code> in Discord).
      </p>
      ${toolbarHtml}
      ${filtered.length ? gridHtml : '<p style="color:var(--text-muted)">No members match this filter.</p>'}
      ${fetchedAt ? `<p style="color:var(--text-muted);font-size:12px;margin-top:16px">Last synced: ${new Date(fetchedAt).toLocaleString()}</p>` : ''}
    `;

    container.querySelector('#members-toolbar')?.addEventListener('click', e => {
      const chip = e.target.closest('.chip[data-role]');
      if (!chip) return;
      selectedRole = chip.dataset.role;
      applyFilter();
      render();
    });

    container.querySelector('#btn-export')?.addEventListener('click', async () => {
      const blob = await api.exportMembersCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'members.csv'; a.click();
      URL.revokeObjectURL(url);
    });

    container.querySelectorAll('[data-action="toggle-optout"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.memberId;
        const current = btn.dataset.current === '1';
        const next = !current;
        btn.disabled = true;
        btn.textContent = next ? 'Hiding…' : 'Restoring…';
        try {
          await api.setMemberOptOut(id, next);
          const member = members.find(m => m.id === id);
          if (member) member.optedOut = next;
          applyFilter();
          render();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = current ? 'Show on public site' : 'Hide from public';
          alert(`Failed to update opt-out: ${err.message}`);
        }
      });
    });
  }

  render();
}
