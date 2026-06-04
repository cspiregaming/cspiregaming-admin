import { api } from '../api.js';
import { escHtml } from '../app.js';

// ─── Organizer management ────────────────────────────────────────────────────

async function loadOrganizers() {
  try {
    const data = await api.getOrganizers();
    return data.ids ?? [];
  } catch {
    return [];
  }
}

function renderOrganizersCard(ids) {
  const rows = ids.length
    ? ids.map(id => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <code style="flex:1">${escHtml(id)}</code>
          <a href="https://app.matchplay.events/organizers/${escHtml(id)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--text-muted)">↗</a>
          <button class="btn btn-ghost" style="font-size:12px;padding:3px 8px" data-remove-organizer="${escHtml(id)}">Remove</button>
        </div>`).join('')
    : '<p style="color:var(--text-muted);font-size:13px;margin:0">No organizers configured. Add one below to enable /tournament register for MatchPlay events.</p>';

  return `
    <div class="card" style="margin-bottom:16px" id="organizers-card">
      <h2 style="margin-top:0">MatchPlay Organizers</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
        Open-registration tournaments are discovered for each organizer listed here.
        The env var <code>MATCHPLAY_ORGANIZER_ID</code> is used as a fallback when this list is empty.
      </p>
      <div id="organizer-list">${rows}</div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
        <input id="organizer-id-input" class="input" placeholder="Organizer ID (e.g. 57756)" style="flex:1;max-width:220px">
        <button class="btn btn-outline" id="btn-add-organizer">Add</button>
      </div>
      <div id="organizer-feedback" style="margin-top:8px"></div>
    </div>
  `;
}

function attachOrganizerListeners(onUpdate) {
  document.getElementById('btn-add-organizer')?.addEventListener('click', async () => {
    const input = document.getElementById('organizer-id-input');
    const id = input?.value?.trim();
    const feedback = document.getElementById('organizer-feedback');
    if (!id) { feedback.innerHTML = '<span style="color:var(--red);font-size:13px">Enter an organizer ID.</span>'; return; }
    const btn = document.getElementById('btn-add-organizer');
    btn.disabled = true; btn.textContent = '…';
    feedback.innerHTML = '';
    try {
      const result = await api.addOrganizer(id);
      if (input) input.value = '';
      onUpdate(result.ids);
    } catch (err) {
      feedback.innerHTML = `<span style="color:var(--red);font-size:13px">Failed: ${escHtml(err.message)}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Add';
    }
  });

  document.querySelectorAll('[data-remove-organizer]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.removeOrganizer;
      btn.disabled = true;
      try {
        const result = await api.removeOrganizer(id);
        onUpdate(result.ids);
      } catch {
        btn.disabled = false;
      }
    });
  });
}

const PLATFORMS = ['matchplay', 'challonge'];
const PLATFORM_LABEL = { matchplay: 'MatchPlay', challonge: 'Challonge' };
const PLATFORM_COLOR = { matchplay: 'var(--blue)', challonge: '#f5a623' };

export async function renderTournament(container) {
  container.innerHTML = '<div class="loading">Loading…</div>';

  let data, organizerIds, discovered;
  try {
    [data, organizerIds, discovered] = await Promise.all([
      api.getTournaments(),
      loadOrganizers(),
      api.discoverTournaments().then(r => r.tournaments ?? []).catch(() => []),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load: ${escHtml(err.message)}</div>`;
    return;
  }

  function render() {
    const { apiKeys, defaults, notificationsChannelId, tournaments } = data;
    const active = tournaments.filter(t => t.active);
    const inactive = tournaments.filter(t => !t.active);

    container.innerHTML = `
      <div class="card__header">
        <h1>Tournament</h1>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Manage tournaments across MatchPlay and Challonge. Staff can also use <strong>/tournament</strong> Discord slash commands.
      </p>

      ${renderConfigCard(apiKeys, defaults, notificationsChannelId)}
      ${renderOrganizersCard(organizerIds)}
      ${renderAddCard(apiKeys, discovered)}

      ${active.length ? `
        <div class="card" style="margin-bottom:16px">
          <h2 style="margin-top:0">Active (${active.length})</h2>
          ${active.map(t => renderTournamentCard(t)).join('')}
        </div>
      ` : ''}

      ${inactive.length ? `
        <div class="card" style="margin-bottom:16px">
          <h2 style="margin-top:0">Past (${inactive.length})</h2>
          ${inactive.map(t => renderTournamentCard(t)).join('')}
        </div>
      ` : ''}

      ${!active.length && !inactive.length ? `
        <div class="alert" style="background:rgba(255,255,255,.05);margin-bottom:16px">
          No tournaments configured yet. Use the form above to announce or start live updates.
        </div>
      ` : ''}

      <div id="tournament-feedback"></div>
    `;

    attachListeners();
  }

  function attachListeners() {
    // Organizer management (re-renders only the organizer card on change)
    attachOrganizerListeners(updatedIds => {
      organizerIds = updatedIds;
      const card = document.getElementById('organizers-card');
      if (card) {
        card.outerHTML = renderOrganizersCard(organizerIds);
        attachOrganizerListeners(ids2 => { organizerIds = ids2; });
      }
    });

    // Swap tournament selector when platform changes
    document.getElementById('add-platform')?.addEventListener('change', e => {
      const wrapper = document.getElementById('add-tournament-wrapper');
      if (wrapper) {
        const label = wrapper.querySelector('label');
        const selector = buildTournamentSelector(e.target.value, discovered);
        wrapper.innerHTML = (label?.outerHTML ?? '<label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Tournament</label>') + selector;
      }
    });

    // Add-tournament form
    document.getElementById('btn-add-announce')?.addEventListener('click', () => runAddAction('announce'));
    document.getElementById('btn-add-live')?.addEventListener('click', () => runAddAction('live'));

    // Per-card actions
    document.querySelectorAll('[data-card-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { cardAction, platform, tournamentId } = btn.dataset;
        if (cardAction === 'delete') {
          if (!confirm(`Remove state for ${PLATFORM_LABEL[platform]} tournament ${tournamentId}?\n\nThis removes it from this list but does not affect Discord messages already posted.`)) return;
          await runCardAction(btn, platform, tournamentId, 'delete');
        } else if (cardAction === 'end') {
          if (!confirm(`End live updates for ${PLATFORM_LABEL[platform]} tournament ${tournamentId} and post final results?`)) return;
          await runCardAction(btn, platform, tournamentId, 'end');
        } else {
          await runCardAction(btn, platform, tournamentId, cardAction);
        }
      });
    });
  }

  async function runAddAction(action) {
    const platform = document.getElementById('add-platform')?.value;
    const id = document.getElementById('add-tournament-id')?.value?.trim();
    if (!id) { showFeedback('Enter a tournament ID.', 'error'); return; }

    const btn = document.getElementById(`btn-add-${action}`);
    await performAction(btn, platform, id, action);
  }

  async function runCardAction(btn, platform, tournamentId, action) {
    await performAction(btn, platform, tournamentId, action);
  }

  async function performAction(btn, platform, tournamentId, action) {
    const original = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    showFeedback('', '');

    const apiCall = {
      announce: () => api.tournamentAnnounce(platform, tournamentId),
      live: () => api.tournamentLive(platform, tournamentId),
      end: () => api.tournamentEnd(platform, tournamentId),
      delete: () => api.tournamentDelete(platform, tournamentId),
    }[action];

    const messages = {
      announce: '✓ Announcement posted to #notifications.',
      live: '✓ Live updates started. Queue and leaderboard posted to #notifications.',
      end: '✓ Live updates stopped. Final results posted to #notifications.',
      delete: '✓ Tournament state removed.',
    };

    try {
      await apiCall();
      showFeedback(messages[action], 'success');
      data = await api.getTournaments();
      render();
    } catch (err) {
      showFeedback(`${action} failed: ${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  function showFeedback(message, type) {
    const el = document.getElementById('tournament-feedback');
    if (!el || !message) { if (el) el.innerHTML = ''; return; }
    el.innerHTML = `<div class="alert alert-${type === 'success' ? 'success' : 'error'}" style="margin-top:12px">${escHtml(message)}</div>`;
  }

  render();
}

// ─── Partials ────────────────────────────────────────────────────────────────

function renderConfigCard(apiKeys, defaults, notificationsChannelId) {
  const rows = [
    ...PLATFORMS.map(p => `<tr><th>${escHtml(PLATFORM_LABEL[p])} API key</th><td>${renderKeyBadge(apiKeys[p], p)}</td></tr>`),
    `<tr><th>MatchPlay default ID</th><td>${defaults.matchplayTournamentId ? `<code>${escHtml(defaults.matchplayTournamentId)}</code>` : '<em style="color:var(--text-muted)">not set</em>'}</td></tr>`,
    `<tr><th>Challonge default ID</th><td>${defaults.challongeTournamentId ? `<code>${escHtml(defaults.challongeTournamentId)}</code>` : '<em style="color:var(--text-muted)">not set</em>'}</td></tr>`,
    `<tr><th>MatchPlay organizer ID</th><td>${defaults.matchplayOrganizerId ? `<code>${escHtml(defaults.matchplayOrganizerId)}</code>` : '<em style="color:var(--text-muted)">not set — needed for /tournament register</em>'}</td></tr>`,
    `<tr><th>Notifications channel</th><td>${notificationsChannelId ? `<code>#${escHtml(notificationsChannelId)}</code>` : '<em style="color:var(--text-muted)">not configured</em>'}</td></tr>`,
  ].join('');

  return `
    <div class="card" style="margin-bottom:16px">
      <h2 style="margin-top:0">Configuration</h2>
      <table class="kv-table">${rows}</table>
    </div>
  `;
}

// Build a tournament selector (dropdown or text input) for a given platform.
// Exported at module scope so attachListeners can call it when the platform changes.
function buildTournamentSelector(platform, discovered) {
  const list = (discovered ?? []).filter(t => t.platform === platform);
  if (!list.length) {
    return `<input id="add-tournament-id" class="input" placeholder="Tournament ID (leave blank for default)" style="width:100%">`;
  }
  const options = list.map(t =>
    `<option value="${escHtml(t.id)}">${escHtml(t.name)} (${escHtml(t.id)})</option>`,
  ).join('');
  return `<select id="add-tournament-id" class="input" style="width:100%">${options}</select>`;
}

function renderAddCard(apiKeys, discovered) {
  const anyKeyConfigured = apiKeys.matchplay || apiKeys.challonge;
  const hasAny = (discovered ?? []).length > 0;
  return `
    <div class="card" style="margin-bottom:16px">
      <h2 style="margin-top:0">Start a Tournament</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px">
        ${hasAny
          ? 'Select a platform and tournament, then announce or start live updates.'
          : 'No open-registration tournaments found right now — enter an ID manually.'}
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Platform</label>
          <select id="add-platform" class="input" style="width:140px">
            ${PLATFORMS.map(p => `<option value="${p}">${escHtml(PLATFORM_LABEL[p])}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:200px" id="add-tournament-wrapper">
          <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Tournament</label>
          ${buildTournamentSelector('matchplay', discovered)}
        </div>
        <button class="btn btn-outline" id="btn-add-announce" ${anyKeyConfigured ? '' : 'disabled'}>📋 Announce</button>
        <button class="btn btn-primary" id="btn-add-live" ${anyKeyConfigured ? '' : 'disabled'}>▶ Start Live</button>
      </div>
    </div>
  `;
}

function renderTournamentCard(t) {
  const platform = t.platform ?? 'matchplay';
  const label = PLATFORM_LABEL[platform] ?? platform;
  const color = PLATFORM_COLOR[platform] ?? 'var(--text-muted)';
  const matchplayUrl = platform === 'matchplay'
    ? `https://app.matchplay.events/tournaments/${escHtml(t.tournamentId)}`
    : (t.registrationUrl ?? `https://challonge.com/${escHtml(t.tournamentId)}`);

  const statusBadge = t.active
    ? '<span class="badge badge-green">live</span>'
    : '<span class="badge" style="background:rgba(255,255,255,.1);color:var(--text-muted)">ended</span>';

  const dataAttrs = `data-platform="${escHtml(platform)}" data-tournament-id="${escHtml(t.tournamentId)}"`;

  return `
    <div style="border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        ${statusBadge}
        <span style="font-size:11px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:.05em">${escHtml(label)}</span>
        <strong>${escHtml(t.tournamentId)}</strong>
        <a href="${escHtml(matchplayUrl)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--text-muted)">↗ View</a>
        <div style="flex:1"></div>
        ${t.active
          ? `<button class="btn btn-danger" style="font-size:12px;padding:4px 10px" data-card-action="end" ${dataAttrs}>■ End</button>`
          : ''}
        <button class="btn btn-ghost" style="font-size:12px;padding:4px 8px" data-card-action="announce" ${dataAttrs}>📋 Re-announce</button>
        <button class="btn btn-ghost" style="font-size:12px;padding:4px 8px" data-card-action="delete" ${dataAttrs} title="Remove state from KV">Remove</button>
      </div>
      <table class="kv-table" style="font-size:13px">
        <tr><th>Registration URL</th><td>${t.registrationUrl
          ? `<a href="${escHtml(t.registrationUrl)}" target="_blank" rel="noopener">${escHtml(t.registrationUrl)}</a>`
          : '<em style="color:var(--text-muted)">none</em>'}</td></tr>
        <tr><th>Queue message</th><td>${t.queueMessageId ? `<code>${escHtml(t.queueMessageId)}</code>` : '<em style="color:var(--text-muted)">not posted yet</em>'}</td></tr>
        <tr><th>Leaderboard message</th><td>${t.leaderboardMessageId ? `<code>${escHtml(t.leaderboardMessageId)}</code>` : '<em style="color:var(--text-muted)">not posted yet</em>'}</td></tr>
      </table>
    </div>
  `;
}

function renderKeyBadge(configured, platform) {
  const secretName = platform === 'challonge' ? 'CHALLONGE_API_KEY' : 'MATCHPLAY_API_KEY';
  return configured
    ? '<span class="badge badge-green">configured</span>'
    : `<span class="badge" style="background:rgba(224,82,82,.2);color:var(--red)">missing — <code>wrangler secret put ${secretName}</code></span>`;
}
