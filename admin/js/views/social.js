import { api } from '../api.js';
import { escHtml } from '../app.js';

const SOCIAL_FIELDS = [
  { key: 'discord',   label: 'Discord Invite URL',         placeholder: 'https://discord.gg/...' },
  { key: 'twitch',    label: 'Twitch Channel URL',         placeholder: 'https://www.twitch.tv/cspiregaming' },
  { key: 'facebook',  label: 'Facebook Page URL',          placeholder: 'https://www.facebook.com/cspiregaming' },
  { key: 'instagram', label: 'Instagram Profile URL',      placeholder: 'https://www.instagram.com/cspiregaming/' },
  { key: 'twitter',   label: 'Twitter / X Profile URL',    placeholder: 'https://twitter.com/cspiregaming' },
  { key: 'subscribe', label: 'Email Subscribe URL',        placeholder: 'https://mailchimp.com/...' },
  { key: 'exchange',  label: 'Outlook Group Join URL',     placeholder: 'https://outlook.office365.com/...' },
  { key: 'status',    label: 'Status Page URL',            placeholder: 'https://status.cspiregaming.com/' },
];

export async function renderSocial(container) {
  container.innerHTML = '<div class="loading">Loading...</div>';
  const social = await api.getSocial();

  container.innerHTML = `
    <h1>Social Links</h1>
    <p style="color:var(--text-muted);margin-bottom:24px">
      These URLs are served by the public <code>/api/public/content</code> endpoint
      and will be used by the website once Phase 3 dynamic loading is enabled.
    </p>
    <div class="card">
      <form id="social-form">
        ${SOCIAL_FIELDS.map(f => `
          <div class="form-group">
            <label>${escHtml(f.label)}</label>
            <input name="${escHtml(f.key)}" type="url" value="${escHtml(social[f.key] || '')}" placeholder="${escHtml(f.placeholder)}">
          </div>
        `).join('')}
        <button type="submit" class="btn btn-primary">Save Social Links</button>
        <div id="social-feedback" style="margin-top:12px"></div>
      </form>
    </div>
  `;

  document.getElementById('social-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries([...fd.entries()].filter(([, v]) => v));
    const btn = e.target.querySelector('[type=submit]');
    const feedback = document.getElementById('social-feedback');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await api.putSocial(data);
      feedback.innerHTML = '<div class="alert alert-success">✓ Social links saved.</div>';
    } catch (err) {
      feedback.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Social Links';
    }
  });
}
