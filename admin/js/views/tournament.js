import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderTournament(container) {
  container.innerHTML = '<div class="loading">Loading…</div>';

  let data;
  try {
    data = await api.getTournaments();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load: ${escHtml(err.message)}</div>`;
    return;
  }

  function render() {
    const { defaultTournamentId, defaultRegistrationUrl, apiKeyConfigured, notificationsChannelId, tournaments } = data;

    const activeTournaments = tournaments.filter(t => t.active);
    const inactiveTournaments = tournaments.filter(t => !t.active);

    container.innerHTML = `
      <div class="card__header">
        <h1>Tournament</h1>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Manage MatchPlay Events tournaments. Use <strong>/tournament</strong> Discord slash commands or the controls below to announce, start live updates, and post final results.
      </p>

      ${!apiKeyConfigured ? `
        <div class="alert alert-error" style="margin-bottom:16px">
          MatchPlay API key is not configured. Run <code>wrangler secret put MATCHPLAY_API_KEY</code> and redeploy.
        </div>
      ` : ''}

      <div class="card" style="margin-bottom:16px">
        <h2 style="margin-top:0">Configuration</h2>
        <table class="kv-table">
          <tr><th>API key</th><td>${renderKeyBadge(apiKeyConfigured)}</td></tr>
          <tr><th>Default tournament</th><td>${defaultTournamentId
            ? `<a href="https://app.matchplay.events/tournaments/${escHtml(defaultTournamentId)}" target="_blank" rel="noopener">${escHtml(defaultTournamentId)}</a>`
            : '<em style="color:var(--text-muted)">not set — MATCHPLAY_TOURNAMENT_ID missing</em>'}</td></tr>
          <tr><th>Registration URL</th><td>${defaultRegistrationUrl
            ? `<a href="${escHtml(defaultRegistrationUrl)}" target="_blank" rel="noopener">${escHtml(defaultRegistrationUrl)}</a>`
            : '<em style="color:var(--text-muted)">not set</em>'}</td></tr>
          <tr><th>Notifications channel</th><td>${notificationsChannelId
            ? `<code>#${escHtml(notificationsChannelId)}</code>`
            : '<em style="color:var(--text-muted)">TOURNAMENT_NOTIFICATIONS_CHANNEL_ID missing</em>'}</td></tr>
        </table>
      </div>

      ${defaultTournamentId ? `
        <div class="card" style="margin-bottom:16px">
          <h2 style="margin-top:0">Quick Actions — Default Tournament <code>${escHtml(defaultTournamentId)}</code></h2>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
            These actions target the currently configured default tournament. To manage a different tournament, use the slash command with a <code>tournament-id</code> argument.
          </p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-outline" id="btn-announce" ${apiKeyConfigured ? '' : 'disabled'}>📋 Announce</button>
            <button class="btn btn-primary" id="btn-live" ${apiKeyConfigured ? '' : 'disabled'}>▶ Start Live</button>
            <button class="btn btn-danger" id="btn-end" ${apiKeyConfigured ? '' : 'disabled'}>■ End Tournament</button>
          </div>
          <div id="action-feedback" style="margin-top:12px"></div>
        </div>
      ` : ''}

      ${activeTournaments.length > 0 ? `
        <div class="card" style="margin-bottom:16px">
          <h2 style="margin-top:0">Active Tournaments</h2>
          ${activeTournaments.map(t => renderTournamentCard(t, true)).join('')}
        </div>
      ` : ''}

      ${inactiveTournaments.length > 0 ? `
        <div class="card" style="margin-bottom:16px">
          <h2 style="margin-top:0">Inactive Tournaments</h2>
          ${inactiveTournaments.map(t => renderTournamentCard(t, false)).join('')}
        </div>
      ` : ''}

      ${tournaments.length === 0 ? `
        <div class="alert" style="background:rgba(255,255,255,.05);margin-bottom:16px">
          No tournaments configured yet. Use <strong>/tournament live</strong> in Discord or click <strong>Start Live</strong> above.
        </div>
      ` : ''}
    `;

    if (defaultTournamentId) {
      document.getElementById('btn-announce')?.addEventListener('click', () =>
        runAction('announce', defaultTournamentId, '📋 Announcing…'));
      document.getElementById('btn-live')?.addEventListener('click', () =>
        runAction('live', defaultTournamentId, '▶ Starting…'));
      document.getElementById('btn-end')?.addEventListener('click', () => {
        if (!confirm(`End live updates for tournament ${defaultTournamentId} and post final results?\n\nThis will stop the cron from editing the queue and leaderboard messages.`)) return;
        runAction('end', defaultTournamentId, '■ Ending…');
      });
    }

    document.querySelectorAll('[data-delete-tournament]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deleteTournament;
        if (!confirm(`Remove the saved state for tournament ${id}?\n\nThis deletes it from the list but does NOT affect any Discord messages already posted.`)) return;
        btn.disabled = true;
        try {
          await api.tournamentDelete(id);
          data.tournaments = data.tournaments.filter(t => t.tournamentId !== id);
          render();
        } catch (err) {
          btn.disabled = false;
          showFeedback(`Delete failed: ${err.message}`, 'error');
        }
      });
    });
  }

  async function runAction(action, tournamentId, loadingLabel) {
    const btn = document.getElementById(`btn-${action}`);
    const original = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = loadingLabel; }
    clearFeedback();

    const apiCall = {
      announce: () => api.tournamentAnnounce(tournamentId),
      live: () => api.tournamentLive(tournamentId),
      end: () => api.tournamentEnd(tournamentId),
    }[action];

    try {
      await apiCall();
      const messages = {
        announce: '✓ Announcement posted to #notifications.',
        live: '✓ Live updates started. Queue and leaderboard posted to #notifications.',
        end: '✓ Live updates stopped. Final results posted to #notifications.',
      };
      showFeedback(messages[action], 'success');
      // Refresh state
      data = await api.getTournaments();
      render();
    } catch (err) {
      showFeedback(`Failed: ${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  function showFeedback(message, type) {
    const el = document.getElementById('action-feedback');
    if (el) el.innerHTML = `<div class="alert alert-${type === 'success' ? 'success' : 'error'}">${escHtml(message)}</div>`;
  }

  function clearFeedback() {
    const el = document.getElementById('action-feedback');
    if (el) el.innerHTML = '';
  }

  render();
}

function renderTournamentCard(t, active) {
  const statusBadge = active
    ? '<span class="badge badge-green">live</span>'
    : '<span class="badge" style="background:rgba(255,255,255,.1);color:var(--text-muted)">ended</span>';

  const matchplayUrl = `https://app.matchplay.events/tournaments/${escHtml(t.tournamentId)}`;

  return `
    <div style="border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        ${statusBadge}
        <strong>Tournament ${escHtml(t.tournamentId)}</strong>
        <a href="${matchplayUrl}" target="_blank" rel="noopener" style="font-size:12px;color:var(--text-muted)">↗ MatchPlay</a>
        <div style="flex:1"></div>
        <button class="btn btn-ghost" style="font-size:12px;padding:4px 8px" data-delete-tournament="${escHtml(t.tournamentId)}" title="Remove state from KV">Remove</button>
      </div>
      <table class="kv-table" style="font-size:13px">
        <tr><th>Registration URL</th><td>${t.registrationUrl
          ? `<a href="${escHtml(t.registrationUrl)}" target="_blank" rel="noopener">${escHtml(t.registrationUrl)}</a>`
          : '<em style="color:var(--text-muted)">none</em>'}</td></tr>
        <tr><th>Queue message ID</th><td>${t.queueMessageId
          ? `<code>${escHtml(t.queueMessageId)}</code>`
          : '<em style="color:var(--text-muted)">not posted yet</em>'}</td></tr>
        <tr><th>Leaderboard message ID</th><td>${t.leaderboardMessageId
          ? `<code>${escHtml(t.leaderboardMessageId)}</code>`
          : '<em style="color:var(--text-muted)">not posted yet</em>'}</td></tr>
      </table>
    </div>
  `;
}

function renderKeyBadge(configured) {
  return configured
    ? '<span class="badge badge-green">configured</span>'
    : '<span class="badge" style="background:rgba(224,82,82,.2);color:var(--red)">missing — run <code>wrangler secret put MATCHPLAY_API_KEY</code></span>';
}
