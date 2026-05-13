import { api } from '../api.js';
import { escHtml } from '../app.js';

/**
 * Check-Ins admin view.
 *
 *   1. Active event card — pick from Discord / manual events, or clear.
 *      Kiosk stamps every check-in with this snapshot.
 *   2. Recent check-ins table — filterable by event (defaults to active).
 *   3. Export panel — date range + CSV download.
 */
export async function renderCheckins(container) {
  container.innerHTML = '<div class="loading">Loading check-ins…</div>';

  let activeEvent = null;
  let candidates = { discord: { live: [], archived: [] }, manual: [] };

  try {
    [{ activeEvent }, candidates] = await Promise.all([
      api.getActiveEvent(),
      api.getCheckinEventCandidates(),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load: ${escHtml(err.message)}</div>`;
    return;
  }

  // View state
  let filterEventId = activeEvent ? activeEvent.eventId : 'all';
  let exportEventId = activeEvent ? activeEvent.eventId : 'all';
  let exportFrom = '';
  let exportTo = '';
  let checkinsLoading = false;
  let checkinsError = null;
  let checkins = [];

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function eventLabel(c, source) {
    if (source === 'manual') {
      return c.subtitle ? `${c.title} — ${c.subtitle}` : c.title;
    }
    const when = c.startTime ? new Date(c.startTime).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
    return when ? `${c.title} — ${when}` : c.title;
  }

  function renderCandidateOptions(selectedId) {
    const opt = (val, label, selected) =>
      `<option value="${escHtml(val)}" ${selected ? 'selected' : ''}>${escHtml(label)}</option>`;
    const groups = [];
    if (candidates.discord.live.length) {
      groups.push(`<optgroup label="Discord — upcoming/active">${
        candidates.discord.live.map(c => opt(`discord:${c.id}`, eventLabel(c, 'discord'), false)).join('')
      }</optgroup>`);
    }
    if (candidates.discord.archived.length) {
      groups.push(`<optgroup label="Discord — recently past">${
        candidates.discord.archived.map(c => opt(`discord:${c.id}`, eventLabel(c, 'discord'), false)).join('')
      }</optgroup>`);
    }
    if (candidates.manual.length) {
      groups.push(`<optgroup label="Manual events">${
        candidates.manual.map(c => opt(`manual:${c.id}`, eventLabel(c, 'manual'), false)).join('')
      }</optgroup>`);
    }
    return `
      <option value="">— Pick an event —</option>
      ${groups.join('')}
    `;
  }

  function renderFilterOptions(selectedId) {
    const opt = (val, label) =>
      `<option value="${escHtml(val)}" ${val === selectedId ? 'selected' : ''}>${escHtml(label)}</option>`;
    const live = candidates.discord.live.map(c => opt(c.id, `📅 ${eventLabel(c, 'discord')}`));
    const archived = candidates.discord.archived.map(c => opt(c.id, `🗄 ${eventLabel(c, 'discord')}`));
    const manual = candidates.manual.map(c => opt(c.id, `📌 ${eventLabel(c, 'manual')}`));
    return `
      ${opt('all', '— All check-ins —')}
      ${opt('none', '— No event (unaffiliated) —')}
      ${live.join('')}
      ${archived.join('')}
      ${manual.join('')}
    `;
  }

  function activeEventCard() {
    if (!activeEvent) {
      return `
        <div class="card">
          <p style="margin:0 0 12px;color:var(--text-muted)">
            <strong>No active event.</strong> Kiosk check-ins will be recorded as "unaffiliated."
          </p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="active-event-picker" style="flex:1;min-width:220px"></select>
            <button class="btn btn-primary" id="btn-set-active" disabled>Set Active Event</button>
          </div>
          <div id="active-event-feedback" style="margin-top:10px"></div>
        </div>
      `;
    }

    const when = activeEvent.startTime
      ? new Date(activeEvent.startTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : (activeEvent.subtitle || '—');
    const activatedAt = activeEvent.activatedAt
      ? new Date(activeEvent.activatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : '—';
    const by = activeEvent.activatedBy?.displayName || activeEvent.activatedBy?.id || '—';

    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div>
            <p style="margin:0;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px">Currently checking in to</p>
            <h2 style="margin:4px 0 0">${escHtml(activeEvent.title || '(untitled)')}</h2>
            <p style="margin:4px 0 0;color:var(--text-muted)">
              <span class="badge ${activeEvent.source === 'discord' ? 'badge-blue' : 'badge-muted'}">
                ${activeEvent.source === 'discord' ? 'Discord' : 'Manual'}
              </span>
              · ${escHtml(when)}
            </p>
            <p style="margin:8px 0 0;color:var(--text-muted);font-size:12px">
              Activated ${escHtml(activatedAt)} by ${escHtml(by)}.
            </p>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            <button class="btn btn-outline" id="btn-change-active">Change…</button>
            <button class="btn btn-danger" id="btn-clear-active" style="padding:4px 10px;font-size:12px">Clear</button>
          </div>
        </div>
        <div id="active-event-picker-row" hidden style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="active-event-picker" style="flex:1;min-width:220px"></select>
          <button class="btn btn-primary" id="btn-set-active" disabled>Save</button>
          <button class="btn btn-outline" id="btn-cancel-change">Cancel</button>
        </div>
        <div id="active-event-feedback" style="margin-top:10px"></div>
      </div>
    `;
  }

  function checkinsTable() {
    if (checkinsLoading) return '<div class="loading">Loading check-ins…</div>';
    if (checkinsError) return `<div class="alert alert-error">${escHtml(checkinsError)}</div>`;
    if (!checkins.length) {
      return '<p style="color:var(--text-muted);margin:0">No check-ins for this filter.</p>';
    }
    const sorted = [...checkins].sort((a, b) =>
      (b.checkedInAt || '').localeCompare(a.checkedInAt || ''),
    );
    return `
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Gamertag</th>
              <th>Name</th>
              <th>Email</th>
              <th>Employee</th>
              <th>Outreach</th>
              <th>Event</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map(r => `
              <tr>
                <td style="white-space:nowrap;font-size:12px;color:var(--text-muted)">${escHtml(fmtDate(r.checkedInAt))}</td>
                <td><strong>${escHtml(r.gamertag || '')}</strong></td>
                <td>${escHtml(r.fullName || '')}</td>
                <td style="font-size:12px">${escHtml(r.email || '')}</td>
                <td>${r.employeeFlag ? '✅' : ''}</td>
                <td>${r.outreachFlag ? '✅' : ''}</td>
                <td style="font-size:12px;color:var(--text-muted)">${escHtml(r.eventTitle || '— unaffiliated —')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:10px">${sorted.length} record${sorted.length === 1 ? '' : 's'}.</p>
    `;
  }

  async function reloadCheckins() {
    checkinsLoading = true;
    checkinsError = null;
    render();
    try {
      const params = filterEventId === 'all' ? {} : { eventId: filterEventId };
      const { checkins: list } = await api.getCheckins(params);
      checkins = list || [];
    } catch (err) {
      checkinsError = err.message;
    } finally {
      checkinsLoading = false;
      render();
    }
  }

  function render() {
    container.innerHTML = `
      <div class="card__header">
        <h1>Check-Ins</h1>
      </div>
      <p style="color:var(--text-muted);margin:0 0 20px">
        The kiosk at <code>event-check-in-app</code> stamps every visit with the event below. Officers can
        switch events, browse recent visits, and export the roster to CSV.
      </p>

      ${activeEventCard()}

      <div class="card__header" style="margin-top:32px">
        <h1 style="font-size:1.25rem">Recent check-ins</h1>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="checkins-filter" style="min-width:240px"></select>
          <button class="btn btn-outline" id="btn-refresh-checkins" ${checkinsLoading ? 'disabled' : ''}>
            ${checkinsLoading ? '⟳ Refreshing…' : '⟳ Refresh'}
          </button>
        </div>
      </div>
      <div class="card">
        ${checkinsTable()}
      </div>

      <div class="card__header" style="margin-top:32px">
        <h1 style="font-size:1.25rem">Export</h1>
      </div>
      <div class="card">
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
          <div class="form-group" style="flex:1;min-width:220px">
            <label>Event</label>
            <select id="export-event"></select>
          </div>
          <div class="form-group" style="min-width:160px">
            <label>From</label>
            <input type="date" id="export-from" value="${escHtml(exportFrom)}">
          </div>
          <div class="form-group" style="min-width:160px">
            <label>To</label>
            <input type="date" id="export-to" value="${escHtml(exportTo)}">
          </div>
          <button class="btn btn-primary" id="btn-export">⬇ Download CSV</button>
        </div>
        <div id="export-feedback" style="margin-top:10px"></div>
      </div>
    `;

    document.getElementById('checkins-filter').innerHTML = renderFilterOptions(filterEventId);
    document.getElementById('export-event').innerHTML = renderFilterOptions(exportEventId);
    const picker = document.getElementById('active-event-picker');
    if (picker) picker.innerHTML = renderCandidateOptions('');

    wire();
  }

  function wire() {
    // Filter dropdown for the recent-checkins table
    document.getElementById('checkins-filter').addEventListener('change', e => {
      filterEventId = e.target.value;
      reloadCheckins();
    });

    document.getElementById('btn-refresh-checkins')?.addEventListener('click', () => {
      reloadCheckins();
    });

    // Active-event picker: visibility + selection enables Save
    const picker = document.getElementById('active-event-picker');
    const setBtn = document.getElementById('btn-set-active');
    if (picker && setBtn) {
      picker.addEventListener('change', () => {
        setBtn.disabled = !picker.value;
      });
    }

    document.getElementById('btn-change-active')?.addEventListener('click', () => {
      document.getElementById('active-event-picker-row').hidden = false;
    });
    document.getElementById('btn-cancel-change')?.addEventListener('click', () => {
      document.getElementById('active-event-picker-row').hidden = true;
    });

    document.getElementById('btn-set-active')?.addEventListener('click', async () => {
      const raw = picker?.value || '';
      if (!raw) return;
      const [source, ...rest] = raw.split(':');
      const eventId = rest.join(':');
      const feedback = document.getElementById('active-event-feedback');
      setBtn.disabled = true;
      setBtn.textContent = 'Saving…';
      try {
        const { activeEvent: next } = await api.setActiveEvent({ eventId, source });
        activeEvent = next;
        filterEventId = next.eventId;
        exportEventId = next.eventId;
        feedback.innerHTML = `<div class="alert alert-success">✓ Active event set to "${escHtml(next.title)}".</div>`;
        render();
        reloadCheckins();
      } catch (err) {
        feedback.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
        setBtn.disabled = false;
        setBtn.textContent = 'Save';
      }
    });

    document.getElementById('btn-clear-active')?.addEventListener('click', async () => {
      if (!confirm('Clear the active event? New check-ins will be recorded as unaffiliated until you set another.')) return;
      try {
        await api.clearActiveEvent();
        activeEvent = null;
        filterEventId = 'all';
        exportEventId = 'all';
        render();
        reloadCheckins();
      } catch (err) {
        document.getElementById('active-event-feedback').innerHTML =
          `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      }
    });

    // Export controls
    const exportSel = document.getElementById('export-event');
    exportSel.addEventListener('change', e => { exportEventId = e.target.value; });
    document.getElementById('export-from').addEventListener('change', e => { exportFrom = e.target.value; });
    document.getElementById('export-to').addEventListener('change', e => { exportTo = e.target.value; });

    document.getElementById('btn-export').addEventListener('click', async () => {
      const feedback = document.getElementById('export-feedback');
      feedback.innerHTML = '';
      try {
        const params = { eventId: exportEventId };
        if (exportFrom) params.from = `${exportFrom}T00:00:00.000Z`;
        if (exportTo) params.to = `${exportTo}T23:59:59.999Z`;
        const blob = await api.exportCheckinsCsv(params);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filenameFor(exportEventId);
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        feedback.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      }
    });
  }

  function filenameFor(eventId) {
    const stamp = new Date().toISOString().slice(0, 10);
    if (!eventId || eventId === 'all') return `checkins-all-${stamp}.csv`;
    if (eventId === 'none') return `checkins-unaffiliated-${stamp}.csv`;
    return `checkins-${eventId}-${stamp}.csv`;
  }

  render();
  reloadCheckins();
}
