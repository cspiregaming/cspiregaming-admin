import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderOfficers(container) {
  container.innerHTML = '<div class="loading">Loading...</div>';
  let officers = await api.getOfficers();
  let editingId = null;

  function renderList() {
    if (!officers.length) {
      return '<p style="color:var(--text-muted)">No officers yet. Add the first one below.</p>';
    }
    return `
      <table>
        <thead>
          <tr>
            <th>Photo</th>
            <th>Name</th>
            <th>Order</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${officers.sort((a, b) => (a.order || 0) - (b.order || 0)).map(o => `
            <tr>
              <td>
                <img src="${escHtml(o.image || '')}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover"
                  onerror="this.style.display='none'">
              </td>
              <td><strong>${escHtml(o.name || '')}</strong></td>
              <td>${o.order ?? '—'}</td>
              <td style="display:flex;gap:6px">
                <button class="btn btn-outline" data-edit="${escHtml(o.id)}" style="padding:4px 10px;font-size:12px">Edit</button>
                <button class="btn btn-danger" data-delete="${escHtml(o.id)}" style="padding:4px 10px;font-size:12px">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderForm(officer = {}) {
    return `
      <div class="card" style="margin-top:20px">
        <h2>${officer.id ? 'Edit Officer' : 'Add Officer'}</h2>
        <form id="officer-form">
          <input type="hidden" name="id" value="${escHtml(officer.id || '')}">
          <div class="form-row">
            <div class="form-group">
              <label>Display Name</label>
              <input name="name" value="${escHtml(officer.name || '')}" placeholder="Jeana Smith" required>
            </div>
            <div class="form-group">
              <label>Display Order</label>
              <input name="order" type="number" value="${officer.order ?? ''}" placeholder="1">
            </div>
          </div>
          <div class="form-group">
            <label>Photo URL</label>
            <input name="image" value="${escHtml(officer.image || '')}" placeholder="https://cspiregaming.github.io/img/faces/name.png">
          </div>
          <div class="form-group">
            <label>Bio (HTML allowed)</label>
            <textarea name="about">${escHtml(officer.about || '')}</textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button type="submit" class="btn btn-primary">${officer.id ? 'Save Changes' : 'Add Officer'}</button>
            ${officer.id ? '<button type="button" class="btn btn-outline" id="btn-cancel-edit">Cancel</button>' : ''}
          </div>
          <div id="officer-form-feedback" style="margin-top:10px"></div>
        </form>
      </div>
    `;
  }

  function render() {
    const editing = editingId ? officers.find(o => o.id === editingId) : null;
    container.innerHTML = `
      <div class="card__header">
        <h1>Officers</h1>
      </div>
      <div class="card">
        ${renderList()}
      </div>
      ${renderForm(editing || {})}
    `;

    // Edit / delete buttons
    container.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => { editingId = btn.dataset.edit; render(); });
    });

    container.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this officer?')) return;
        await api.deleteOfficer(btn.dataset.delete);
        officers = await api.getOfficers();
        editingId = null;
        render();
      });
    });

    document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
      editingId = null; render();
    });

    document.getElementById('officer-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = {
        name: fd.get('name'),
        image: fd.get('image'),
        about: fd.get('about'),
        order: fd.get('order') ? parseInt(fd.get('order')) : undefined,
      };
      const feedback = document.getElementById('officer-form-feedback');
      try {
        if (editingId) {
          await api.updateOfficer(editingId, data);
        } else {
          await api.createOfficer(data);
        }
        officers = await api.getOfficers();
        editingId = null;
        render();
      } catch (err) {
        feedback.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      }
    });
  }

  render();
}
