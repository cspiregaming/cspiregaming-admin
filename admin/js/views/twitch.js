import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderTwitch(container) {
  container.innerHTML = '<div class="loading">Loading Twitch status…</div>';

  let status;
  try {
    status = await api.getTwitchStatus();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load Twitch status: ${escHtml(err.message)}</div>`;
    return;
  }

  render(container, status);
}

function render(container, status) {
  const { secrets, token, live_announce_channel_id, subscriptions, subscriptions_error, total_cost, max_total_cost, streamers } = status;

  // Cross-reference: build lookup maps
  const subById = {};
  for (const sub of subscriptions) subById[sub.id] = sub;

  const streamerByTwitchId = {};
  for (const s of streamers) {
    if (s.twitch?.userId) streamerByTwitchId[s.twitch.userId] = s;
  }

  // Orphaned subs: Twitch has them but no registered streamer owns that broadcaster_id
  const orphanedSubs = subscriptions.filter(sub => {
    const bid = sub.condition?.broadcaster_user_id;
    return !bid || !streamerByTwitchId[bid];
  });

  // Streamers with missing or non-enabled subscriptions
  const streamerIssues = [];
  for (const s of streamers) {
    const ids = s.twitch.eventSubIds || {};
    const onlineSub  = ids.online  ? subById[ids.online]  : null;
    const offlineSub = ids.offline ? subById[ids.offline] : null;
    const onlineOk  = onlineSub  && onlineSub.status  === 'enabled';
    const offlineOk = offlineSub && offlineSub.status === 'enabled';
    if (!onlineOk || !offlineOk) {
      streamerIssues.push({ s, onlineSub, offlineSub, onlineOk, offlineOk });
    }
  }

  const totalIssues = streamerIssues.length + orphanedSubs.length;
  const allSecretsSet = secrets.client_id && secrets.client_secret && secrets.eventsub_secret;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
      <h1 style="margin:0">Twitch</h1>
      <div style="display:flex;gap:8px">
        ${token.ok ? `<button class="btn btn-primary" id="btn-sync">Sync All Subscriptions</button>` : ''}
        <button class="btn btn-outline" id="btn-refresh">Refresh</button>
      </div>
    </div>

    <div id="twitch-feedback" style="margin-bottom:12px"></div>

    <div class="card">
      <h2>Configuration</h2>
      <div style="display:grid;gap:10px">
        ${secretRow('TWITCH_CLIENT_ID', secrets.client_id, 'wrangler secret put TWITCH_CLIENT_ID')}
        ${secretRow('TWITCH_CLIENT_SECRET', secrets.client_secret, 'wrangler secret put TWITCH_CLIENT_SECRET')}
        ${secretRow('TWITCH_EVENTSUB_SECRET', secrets.eventsub_secret, 'wrangler secret put TWITCH_EVENTSUB_SECRET')}
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="min-width:220px;color:var(--text-muted);font-size:13px">App Token</span>
          ${token.ok
            ? '<span class="badge badge-green">✓ Working</span>'
            : `<span class="badge badge-red">✗ Failed</span><span style="color:var(--red);font-size:12px">${escHtml(token.error || 'Unknown error')}</span>`
          }
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="min-width:220px;color:var(--text-muted);font-size:13px"><code>LIVE_ANNOUNCE_CHANNEL_ID</code></span>
          ${live_announce_channel_id
            ? `<span class="badge badge-green">✓ Set</span><code style="color:var(--text-muted);font-size:12px">${escHtml(live_announce_channel_id)}</code>`
            : '<span class="badge badge-red">✗ Not set</span><span style="color:var(--text-muted);font-size:12px">Set in <code>wrangler.toml</code> [vars]</span>'
          }
        </div>
      </div>
      ${!allSecretsSet ? `
        <p style="color:var(--text-muted);font-size:12px;margin-top:12px;margin-bottom:0">
          Run these commands in the <code>worker/</code> directory to configure Twitch credentials.
          The EventSub secret is any random string ≥10 characters.
        </p>` : ''}
    </div>

    ${token.ok ? `
      <div class="card" style="margin-top:0">
        <h2>EventSub Overview</h2>
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div class="stat"><div class="stat__value">${subscriptions.length}</div><div class="stat__label">Subscriptions</div></div>
          <div class="stat"><div class="stat__value">${total_cost ?? '—'}</div><div class="stat__label">Cost used</div></div>
          <div class="stat"><div class="stat__value">${max_total_cost ?? '—'}</div><div class="stat__label">Cost limit</div></div>
          <div class="stat"><div class="stat__value">${streamers.length}</div><div class="stat__label">Registered streamers</div></div>
        </div>
        ${subscriptions_error ? `<div class="alert alert-error" style="margin-top:12px">Subscription fetch error: ${escHtml(subscriptions_error)}</div>` : ''}
      </div>

      ${totalIssues > 0 ? issuesSection(streamerIssues, orphanedSubs) : ''}

      <div class="card" style="margin-top:0">
        <h2>All EventSub Subscriptions</h2>
        ${subscriptions.length === 0
          ? '<p style="color:var(--text-muted)">No active subscriptions found. Use <strong>Sync All</strong> to create them for registered streamers.</p>'
          : subscriptionTable(subscriptions, streamerByTwitchId)
        }
      </div>
    ` : ''}
  `;

  // Bind buttons
  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    container.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const fresh = await api.getTwitchStatus();
      render(container, fresh);
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">Refresh failed: ${escHtml(err.message)}</div>`;
    }
  });

  document.getElementById('btn-sync')?.addEventListener('click', () => onSync(container));

  container.querySelectorAll('[data-delete-sub]').forEach(btn => {
    btn.addEventListener('click', () => onDeleteSub(container, btn.dataset.deleteSub, status));
  });

  container.querySelectorAll('[data-test-announce]').forEach(btn => {
    btn.addEventListener('click', () => onTestAnnounce(btn.dataset.testAnnounce, btn));
  });
}

function secretRow(name, isSet, cmd) {
  return `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="min-width:220px;color:var(--text-muted);font-size:13px"><code>${escHtml(name)}</code></span>
      <span class="badge ${isSet ? 'badge-green' : 'badge-red'}">${isSet ? '✓ Configured' : '✗ Not set'}</span>
      ${!isSet ? `<span style="color:var(--text-muted);font-size:12px"><code>${escHtml(cmd)}</code></span>` : ''}
    </div>
  `;
}

function subStatusBadge(status) {
  if (status === 'enabled') return '<span class="badge badge-green">enabled</span>';
  if (status === 'webhook_callback_verification_pending') return '<span class="badge badge-warn">pending verification</span>';
  if (status === 'webhook_callback_verification_failed') return '<span class="badge badge-red">verification failed</span>';
  if (status === 'notification_failures_exceeded') return '<span class="badge badge-red">failures exceeded</span>';
  if (status === 'revoked' || status === 'user_removed' || status === 'moderator_removed') {
    return `<span class="badge badge-red">${escHtml(status.replace(/_/g, ' '))}</span>`;
  }
  return `<span class="badge badge-muted">${escHtml(status || 'unknown')}</span>`;
}

function subscriptionTable(subscriptions, streamerByTwitchId) {
  return `
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Type</th>
            <th>Streamer</th>
            <th>Broadcaster ID</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${subscriptions.map(sub => {
            const bid = sub.condition?.broadcaster_user_id;
            const owner = bid ? streamerByTwitchId[bid] : null;
            const ownerLabel = owner
              ? `<strong>${escHtml(owner.displayName || owner.twitch?.displayName || '')}</strong>
                 ${owner.isOfficial ? '<span style="margin-left:4px;padding:1px 5px;background:#9146FF;color:#fff;border-radius:3px;font-size:10px;font-weight:600">OFFICIAL</span>' : ''}
                 <div style="color:var(--text-muted);font-size:11px">twitch.tv/${escHtml(owner.twitch?.login || '')}</div>`
              : '<span style="color:var(--text-muted)">orphaned</span>';
            const typeLabel = sub.type === 'stream.online'
              ? '<span style="color:var(--green);font-weight:600">stream.online</span>'
              : '<span style="color:var(--text-muted)">stream.offline</span>';
            const created = sub.created_at
              ? new Date(sub.created_at).toLocaleString(undefined, { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' })
              : '—';
            return `
              <tr>
                <td>${subStatusBadge(sub.status)}</td>
                <td style="font-size:12px;white-space:nowrap">${typeLabel}</td>
                <td>${ownerLabel}</td>
                <td style="color:var(--text-muted);font-size:11px;font-family:monospace">${escHtml(bid || '—')}</td>
                <td style="color:var(--text-muted);font-size:12px;white-space:nowrap">${escHtml(created)}</td>
                <td style="display:flex;gap:4px;flex-wrap:wrap">
                  ${sub.type === 'stream.online' && owner
                    ? `<button class="btn btn-outline" data-test-announce="${escHtml(owner.discordId)}" style="padding:3px 8px;font-size:11px">Test</button>`
                    : ''}
                  <button class="btn btn-danger" data-delete-sub="${escHtml(sub.id)}" style="padding:3px 8px;font-size:11px">Delete</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function issuesSection(streamerIssues, orphanedSubs) {
  const rows = [];

  for (const { s, onlineSub, offlineSub, onlineOk, offlineOk } of streamerIssues) {
    const problems = [];
    if (!onlineOk) {
      problems.push(onlineSub
        ? `stream.online is ${escHtml(onlineSub.status)}`
        : 'stream.online subscription missing');
    }
    if (!offlineOk) {
      problems.push(offlineSub
        ? `stream.offline is ${escHtml(offlineSub.status)}`
        : 'stream.offline subscription missing');
    }
    rows.push(`
      <tr>
        <td><strong>${escHtml(s.displayName || s.twitch?.displayName || s.discordId)}</strong>
          <div style="color:var(--text-muted);font-size:11px">twitch.tv/${escHtml(s.twitch?.login || '')}</div>
        </td>
        <td style="color:var(--red);font-size:12px">${problems.map(escHtml).join('<br>')}</td>
        <td><span class="badge badge-warn">needs sync</span></td>
      </tr>
    `);
  }

  for (const sub of orphanedSubs) {
    rows.push(`
      <tr>
        <td style="color:var(--text-muted);font-size:12px">
          broadcaster_id: <code>${escHtml(sub.condition?.broadcaster_user_id || '—')}</code>
        </td>
        <td style="color:var(--text-muted);font-size:12px">
          ${escHtml(sub.type)} — no matching streamer record
        </td>
        <td>
          <span class="badge badge-muted">orphaned</span>
          <button class="btn btn-danger" data-delete-sub="${escHtml(sub.id)}" style="margin-left:6px;padding:3px 8px;font-size:11px">Delete</button>
        </td>
      </tr>
    `);
  }

  return `
    <div class="card" style="margin-top:0;border-color:rgba(224,82,82,.35)">
      <h2 style="color:var(--red)">Issues Found (${streamerIssues.length + orphanedSubs.length})</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
        Use <strong>Sync All Subscriptions</strong> to automatically recreate any missing subscriptions.
        Orphaned subscriptions can be deleted manually.
      </p>
      <table>
        <thead><tr><th>Streamer / Broadcaster</th><th>Problem</th><th>Action</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>
  `;
}

async function onSync(container) {
  const btn = document.getElementById('btn-sync');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  const feedback = document.getElementById('twitch-feedback');
  if (feedback) feedback.innerHTML = '';

  try {
    const result = await api.syncTwitch();
    const msg = result.synced.length === 0
      ? 'All subscriptions are already up-to-date.'
      : `Synced ${result.synced.length} streamer(s): ${result.synced.map(r => escHtml(r.login)).join(', ')}.`;
    const errMsg = result.errors.length > 0
      ? ` ${result.errors.length} error(s) — check the worker logs.`
      : '';
    if (feedback) feedback.innerHTML = `<div class="alert alert-${result.errors.length ? 'error' : 'success'}">${msg}${escHtml(errMsg)}</div>`;

    // Refresh status
    const fresh = await api.getTwitchStatus();
    render(container, fresh);
    if (result.errors.length === 0 && result.synced.length > 0) {
      const fb2 = document.getElementById('twitch-feedback');
      if (fb2) fb2.innerHTML = `<div class="alert alert-success">${msg}</div>`;
    }
  } catch (err) {
    if (feedback) feedback.innerHTML = `<div class="alert alert-error">Sync failed: ${escHtml(err.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Sync All Subscriptions'; }
  }
}

async function onTestAnnounce(discordId, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Posting…';
  const feedback = document.getElementById('twitch-feedback');
  if (feedback) feedback.innerHTML = '';
  try {
    await api.testTwitchAnnounce(discordId);
    if (feedback) feedback.innerHTML = `<div class="alert alert-success">Test embed posted to the <strong>live announcement channel</strong>. Bot has permission to post there.</div>`;
    btn.textContent = '✓ Posted';
    setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 3000);
  } catch (err) {
    if (feedback) feedback.innerHTML = `<div class="alert alert-error">Test failed: ${escHtml(err.message)} — check that the bot is in the announcement channel and has Send Messages + Embed Links permissions.</div>`;
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function onDeleteSub(container, subId, prevStatus) {
  if (!confirm(`Delete EventSub subscription ${subId}?\n\nThis removes it from Twitch immediately. Re-registering the streamer or running Sync will recreate it.`)) return;
  const feedback = document.getElementById('twitch-feedback');
  if (feedback) feedback.innerHTML = '';
  try {
    await api.deleteTwitchSubscription(subId);
    const fresh = await api.getTwitchStatus();
    render(container, fresh);
    const fb2 = document.getElementById('twitch-feedback');
    if (fb2) fb2.innerHTML = `<div class="alert alert-success">Deleted subscription <code>${escHtml(subId)}</code>.</div>`;
  } catch (err) {
    if (feedback) feedback.innerHTML = `<div class="alert alert-error">Delete failed: ${escHtml(err.message)}</div>`;
  }
}
