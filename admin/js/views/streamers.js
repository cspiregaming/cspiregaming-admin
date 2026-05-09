import { api } from '../api.js';
import { escHtml } from '../app.js';

/**
 * Streamers view — officers' parity with the /streamer-list and
 * /streamer-remove slash commands. Same backend teardown path
 * (unregisterStreamer + audit-log embed in OFFICERS_CHANNEL_ID).
 */
export async function renderStreamers(container) {
  let streamers = [];
  try {
    const data = await api.getStreamers();
    streamers = data.streamers || [];
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load streamers: ${escHtml(err.message)}</div>`;
    return;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      timeZone: 'America/Chicago',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  function renderTable() {
    if (!streamers.length) {
      return '<p style="color:var(--text-muted)">No streamers are currently registered.</p>';
    }
    return `
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Twitch</th>
            <th>YouTube</th>
            <th>Registered</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${streamers.map(s => `
            <tr data-discord-id="${escHtml(s.discordId)}">
              <td>
                <strong>${escHtml(s.displayName || s.discordUsername || s.discordId)}</strong>
                <div style="color:var(--text-muted);font-size:11px">${escHtml(s.discordId)}</div>
              </td>
              <td>${s.twitch ? `<a href="https://twitch.tv/${escHtml(s.twitch.login)}" target="_blank" rel="noopener">${escHtml(s.twitch.displayName || s.twitch.login)}</a>` : '<span style="color:var(--text-muted)">—</span>'}</td>
              <td>${s.youtube ? escHtml(s.youtube.name || '') : '<span style="color:var(--text-muted)">—</span>'}</td>
              <td style="color:var(--text-muted);font-size:12px">${escHtml(fmtDate(s.registeredAt))}</td>
              <td style="display:flex;gap:6px">
                ${s.twitch ? `<button class="btn btn-outline" data-test="${escHtml(s.discordId)}" style="padding:4px 10px;font-size:12px">Test Embed</button>` : ''}
                <button class="btn btn-danger" data-remove="${escHtml(s.discordId)}" style="padding:4px 10px;font-size:12px">Deregister</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function render() {
    container.innerHTML = `
      <div class="card__header">
        <h1>Streamers</h1>
      </div>
      <p style="color:var(--text-muted);margin-bottom:16px">
        Members who registered with <code>/register-stream</code>. Deregistering removes the @streamer role,
        drops the Twitch EventSub subscriptions, and posts an audit-log entry to the officers channel.
      </p>
      <div class="card">
        ${renderTable()}
      </div>
      <div id="streamers-feedback" style="margin-top:12px"></div>
    `;

    container.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => onRemoveClick(btn.dataset.remove));
    });

    container.querySelectorAll('[data-test]').forEach(btn => {
      btn.addEventListener('click', () => onTestClick(btn.dataset.test, btn));
    });
  }

  async function onTestClick(discordId, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Posting…';
    const feedback = document.getElementById('streamers-feedback');
    feedback.innerHTML = '';
    try {
      await api.testStreamerLiveEmbed(discordId);
      feedback.innerHTML = `<div class="alert alert-success">Test embed posted to <strong>#bot-logs</strong>. The streamer was not notified.</div>`;
      btn.textContent = '✓ Posted';
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 2500);
    } catch (err) {
      feedback.innerHTML = `<div class="alert alert-error">Test failed: ${escHtml(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function onRemoveClick(discordId) {
    const target = streamers.find(s => s.discordId === discordId);
    const label = target?.displayName || target?.discordUsername || discordId;
    const reason = prompt(
      `Reason for deregistering ${label} (minimum 10 characters):\n\nThis will be logged in the officers channel.`,
    );
    if (reason == null) return; // cancelled
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      alert('Reason must be at least 10 characters.');
      return;
    }

    const feedback = document.getElementById('streamers-feedback');
    feedback.innerHTML = '';
    try {
      await api.removeStreamer(discordId, trimmed);
      const refreshed = await api.getStreamers();
      streamers = refreshed.streamers || [];
      render();
      const post = document.getElementById('streamers-feedback');
      post.innerHTML = `<div class="alert alert-success">Deregistered ${escHtml(label)}. Audit log posted to the officers channel.</div>`;
    } catch (err) {
      feedback.innerHTML = `<div class="alert alert-error">Failed to deregister: ${escHtml(err.message)}</div>`;
    }
  }

  render();
}
