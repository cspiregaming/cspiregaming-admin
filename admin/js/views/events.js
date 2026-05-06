import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderEvents(container) {
  container.innerHTML = '<div class="loading">Loading...</div>';
  let events = await api.getEvents();
  let editingId = null;

  function renderList() {
    if (!events.length) {
      return '<p style="color:var(--text-muted)">No events scheduled. Add one below.</p>';
    }
    return `
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Subtitle / Date</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${events.map(ev => `
            <tr>
              <td><strong>${escHtml(ev.title || '')}</strong></td>
              <td style="color:var(--text-muted);font-size:12px">${escHtml(ev.subtitle || '—')}</td>
              <td><span class="badge badge-green">Active</span></td>
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

  function renderForm(ev = {}) {
    return `
      <div class="card" style="margin-top:20px">
        <h2>${ev.id ? 'Edit Event' : 'Add Event'}</h2>
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
    const editing = editingId ? events.find(ev => ev.id === editingId) : null;
    container.innerHTML = `
      <div class="card__header">
        <h1>Events</h1>
      </div>
      <div class="card">
        ${renderList()}
      </div>
      ${renderForm(editing || {})}
    `;

    container.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => { editingId = btn.dataset.edit; render(); });
    });

    container.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this event?')) return;
        await api.deleteEvent(btn.dataset.delete);
        events = await api.getEvents();
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
        events = await api.getEvents();
        editingId = null;
        render();
      } catch (err) {
        feedback.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      }
    });
  }

  render();
}
