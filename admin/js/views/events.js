import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderEvents(container) {
  container.innerHTML = '<div class="loading">Loading...</div>';

  let manualEvents = [];
  let discordData = { live: [], archived: [], overlays: {} };
  let discordError = null;

  try {
    [manualEvents, discordData] = await Promise.all([
      api.getEvents(),
      api.getDiscordEvents().catch(err => { discordError = err.message; return { live: [], archived: [], overlays: {} }; }),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load: ${escHtml(err.message)}</div>`;
    return;
  }

  let editingId = null;
  // Working copy of overlays — flushed on Save.
  let workingOverlays = JSON.parse(JSON.stringify(discordData.overlays || {}));

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function statusBadge(status) {
    const styles = {
      SCHEDULED: 'badge-blue',
      ACTIVE: 'badge-green',
      COMPLETED: 'badge-muted',
      CANCELED: 'badge-muted',
    };
    return `<span class="badge ${styles[status] || ''}">${escHtml(status || 'SCHEDULED')}</span>`;
  }

  function renderDiscordSection() {
    if (discordError) {
      return `
        <div class="card__header"><h1>Discord Events</h1></div>
        <div class="alert alert-error">Couldn't load Discord events: ${escHtml(discordError)}</div>
      `;
    }

    const all = [...discordData.live, ...discordData.archived];
    if (!all.length) {
      return `
        <div class="card__header"><h1>Discord Events</h1></div>
        <div class="card">
          <p style="color:var(--text-muted)">No Discord events found. Create one in Discord and it will appear here.</p>
        </div>
      `;
    }

    // Sort upcoming first, then past
    all.sort((a, b) => {
      const aPast = a.status === 'COMPLETED' || a.status === 'CANCELED';
      const bPast = b.status === 'COMPLETED' || b.status === 'CANCELED';
      if (aPast !== bPast) return aPast ? 1 : -1;
      const at = new Date(a.startTime).getTime();
      const bt = new Date(b.startTime).getTime();
      return aPast ? bt - at : at - bt;
    });

    return `
      <div class="card__header">
        <h1>Discord Events</h1>
        <button class="btn btn-primary" id="btn-save-discord">Save Changes</button>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Toggle <strong>Publish</strong> to show an event on the public site. By default published
        events show a "View on Discord" button — provide a custom action button below to override.
        Recent past events stay listed for 30 days.
      </p>

      <div class="card">
        <table>
          <thead>
            <tr>
              <th style="width:32%">Event</th>
              <th>Start</th>
              <th>Status</th>
              <th style="width:10%">Publish</th>
              <th>Action button (optional)</th>
            </tr>
          </thead>
          <tbody>
            ${all.map(ev => renderDiscordRow(ev)).join('')}
          </tbody>
        </table>
      </div>

      <div id="discord-feedback" style="margin-top:16px"></div>
    `;
  }

  function renderDiscordRow(ev) {
    const overlay = workingOverlays[ev.id] || {};
    const published = !!overlay.published;
    return `
      <tr data-event-id="${escHtml(ev.id)}">
        <td>
          <strong>${escHtml(ev.title)}</strong>
          ${ev.location ? `<div style="color:var(--text-muted);font-size:12px">${escHtml(ev.location)}</div>` : ''}
        </td>
        <td style="color:var(--text-muted);font-size:12px">${escHtml(fmtDate(ev.startTime))}</td>
        <td>${statusBadge(ev.status)}</td>
        <td>
          <label class="role-row" style="margin:0;padding:0;border:0">
            <input type="checkbox" class="discord-publish" ${published ? 'checked' : ''}>
            <span class="toggle__track"></span>
          </label>
        </td>
        <td>
          <div style="display:flex;gap:6px">
            <input type="text" class="discord-action-text" placeholder="Button text"
                   value="${escHtml(overlay.actionButtonText || '')}" style="flex:1;min-width:0">
            <input type="url" class="discord-action-url" placeholder="https://..."
                   value="${escHtml(overlay.actionButtonUrl || '')}" style="flex:2;min-width:0">
          </div>
        </td>
      </tr>
    `;
  }

  function renderManualList() {
    if (!manualEvents.length) {
      return '<p style="color:var(--text-muted)">No manual events. Add one below for events that aren\'t scheduled in Discord.</p>';
    }
    return `
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Subtitle / Date</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${manualEvents.map(ev => `
            <tr>
              <td><strong>${escHtml(ev.title || '')}</strong></td>
              <td style="color:var(--text-muted);font-size:12px">${escHtml(ev.subtitle || '—')}</td>
              <td style="display:flex;gap:6px">
                <button class="btn btn-outline" data-edit="${escHtml(ev.id)}" style="padding:4px 10px;font-size:12px">Edit</button>
                <button class="btn btn-danger" data-delete="${escHtml(ev.id)}" style="padding:4px 10px;font-size:12px">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderManualForm(ev = {}) {
    return `
      <div class="card" style="margin-top:20px">
        <h2>${ev.id ? 'Edit Manual Event' : 'Add Manual Event'}</h2>
        <form id="event-form">
          <input type="hidden" name="id" value="${escHtml(ev.id || '')}">
          <div class="form-group">
            <label>Title</label>
            <input name="title" value="${escHtml(ev.title || '')}" placeholder="May Meetup" required>
          </div>
          <div class="form-group">
            <label>Subtitle / Date & Location</label>
            <input name="subtitle" value="${escHtml(ev.subtitle || '')}" placeholder="May 18, 2026 | 12–6 pm | C Spire HQ">
          </div>
          <div class="form-group">
            <label>Description (HTML allowed)</label>
            <textarea name="description">${escHtml(ev.description || '')}</textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Action Button Text</label>
              <input name="actionButtonText" value="${escHtml(ev.actionButtonText || '')}" placeholder="Get your ticket now!">
            </div>
            <div class="form-group">
              <label>Action Button URL</label>
              <input name="actionButtonUrl" value="${escHtml(ev.actionButtonUrl || '')}" placeholder="https://rsvp.cspiregaming.com">
            </div>
          </div>
          <div class="form-group">
            <label>Google Maps Embed URL (optional)</label>
            <input name="googleMapsUrl" value="${escHtml(ev.googleMapsUrl || '')}" placeholder="https://www.google.com/maps/embed?...">
          </div>
          <div class="form-group">
            <label>Cover Image URL (optional)</label>
            <input name="imagePath" value="${escHtml(ev.imagePath || '')}" placeholder="https://...">
          </div>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button type="submit" class="btn btn-primary">${ev.id ? 'Save Changes' : 'Add Event'}</button>
            ${ev.id ? '<button type="button" class="btn btn-outline" id="btn-cancel-edit">Cancel</button>' : ''}
          </div>
          <div id="event-form-feedback" style="margin-top:10px"></div>
        </form>
      </div>
    `;
  }

  function render() {
    const editing = editingId ? manualEvents.find(ev => ev.id === editingId) : null;
    container.innerHTML = `
      ${renderDiscordSection()}

      <hr style="margin:32px 0;border:0;border-top:1px solid var(--border)">

      <div class="card__header">
        <h1>Manual Events</h1>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Use this for events that aren't in Discord — old-style events with custom Maps embeds, etc.
      </p>
      <div class="card">
        ${renderManualList()}
      </div>
      ${renderManualForm(editing || {})}
    `;

    wireDiscordHandlers();
    wireManualHandlers();
  }

  function wireDiscordHandlers() {
    const saveBtn = document.getElementById('btn-save-discord');
    if (!saveBtn) return;

    // Capture row edits into workingOverlays as they happen so a re-render
    // doesn't drop unsaved input.
    container.querySelectorAll('tr[data-event-id]').forEach(row => {
      const eventId = row.dataset.eventId;
      const sync = () => {
        const published = row.querySelector('.discord-publish').checked;
        const actionButtonText = row.querySelector('.discord-action-text').value.trim();
        const actionButtonUrl = row.querySelector('.discord-action-url').value.trim();
        if (!published && !actionButtonText && !actionButtonUrl) {
          delete workingOverlays[eventId];
        } else {
          workingOverlays[eventId] = { published, actionButtonText, actionButtonUrl };
        }
      };
      row.querySelector('.discord-publish').addEventListener('change', sync);
      row.querySelector('.discord-action-text').addEventListener('input', sync);
      row.querySelector('.discord-action-url').addEventListener('input', sync);
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const feedback = document.getElementById('discord-feedback');
      try {
        // Diff workingOverlays vs discordData.overlays and PUT only changed entries
        const all = [...discordData.live, ...discordData.archived];
        const ids = new Set(all.map(ev => ev.id));
        const previous = discordData.overlays || {};
        const writes = [];
        for (const id of ids) {
          const prev = previous[id] || {};
          const next = workingOverlays[id] || {};
          if (
            (prev.published || false) !== (next.published || false) ||
            (prev.actionButtonText || null) !== (next.actionButtonText || null) ||
            (prev.actionButtonUrl || null) !== (next.actionButtonUrl || null)
          ) {
            writes.push(api.putDiscordEventOverlay(id, next));
          }
        }
        await Promise.all(writes);
        discordData.overlays = JSON.parse(JSON.stringify(workingOverlays));
        feedback.innerHTML = `<div class="alert alert-success">✓ Saved${writes.length ? ` (${writes.length} event${writes.length === 1 ? '' : 's'})` : ' — no changes'}.</div>`;
      } catch (err) {
        feedback.innerHTML = `<div class="alert alert-error">Save failed: ${escHtml(err.message)}</div>`;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    });
  }

  function wireManualHandlers() {
    container.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => { editingId = btn.dataset.edit; render(); });
    });

    container.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this event?')) return;
        await api.deleteEvent(btn.dataset.delete);
        manualEvents = await api.getEvents();
        editingId = null;
        render();
      });
    });

    document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
      editingId = null; render();
    });

    document.getElementById('event-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(
        [...fd.entries()].filter(([k]) => k !== 'id' && fd.get(k))
      );
      const feedback = document.getElementById('event-form-feedback');
      try {
        if (editingId) {
          await api.updateEvent(editingId, data);
        } else {
          await api.createEvent(data);
        }
        manualEvents = await api.getEvents();
        editingId = null;
        render();
      } catch (err) {
        feedback.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      }
    });
  }

  render();
}
