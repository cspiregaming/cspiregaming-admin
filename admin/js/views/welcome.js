import { api } from '../api.js';
import { escHtml } from '../app.js';

export async function renderWelcome(container) {
  container.innerHTML = '<div class="loading">Loading…</div>';

  let config;
  try {
    config = await api.getWelcomeConfig();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">Failed to load config: ${escHtml(err.message)}</div>`;
    return;
  }

  function render() {
    container.innerHTML = `
      <div class="card__header">
        <h1>Welcome DM</h1>
      </div>
      <p style="color:var(--text-muted);margin-bottom:20px">
        Automatically sends a DM to every new guild member within one minute of them joining.
        Bots are excluded. Use <code>{displayName}</code> in the message as a name placeholder.
      </p>

      <div class="card" style="margin-bottom:16px">
        <h2 style="margin-top:0">Status</h2>
        <table class="kv-table">
          <tr>
            <th>Enabled</th>
            <td>
              <label class="toggle">
                <input type="checkbox" id="welcome-enabled" ${config.enabled ? 'checked' : ''}>
                <span class="toggle__track"></span>
                <span style="font-size:13px;color:var(--text-muted)">${config.enabled ? 'On — new members will be welcomed' : 'Off — no DMs will be sent'}</span>
              </label>
            </td>
          </tr>
          <tr>
            <th>Member snapshot</th>
            <td>${config.bootstrapped
              ? `<span style="color:var(--text)">${config.snapshotSize} members tracked</span>`
              : `<em style="color:var(--text-muted)">Not bootstrapped yet — will initialize on first cron tick without sending any DMs</em>`
            }</td>
          </tr>
        </table>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h2 style="margin-top:0">Message</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
          Plain text with Discord markdown. <code>{displayName}</code> is replaced with the member's display name.
        </p>
        <textarea id="welcome-message" rows="14" style="width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:13px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);padding:10px;resize:vertical;line-height:1.5">${escHtml(config.message)}</textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button class="btn btn-primary" id="btn-save-message">Save Message</button>
        </div>
      </div>

      <div class="card">
        <h2 style="margin-top:0">Preview <span style="font-weight:400;color:var(--text-muted);font-size:13px">— as "Alex"</span></h2>
        <div id="welcome-preview" style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:var(--text);background:var(--bg);border-radius:var(--radius);padding:14px 16px;border:1px solid var(--border)">${renderPreview(config.message)}</div>
      </div>

      <div id="welcome-feedback" style="margin-top:16px"></div>
    `;

    document.getElementById('welcome-enabled').addEventListener('change', onToggleEnabled);
    document.getElementById('btn-save-message').addEventListener('click', onSaveMessage);
    document.getElementById('welcome-message').addEventListener('input', onMessageInput);
  }

  async function onToggleEnabled(e) {
    const enabled = e.target.checked;
    const label = e.target.nextElementSibling.nextElementSibling;
    e.target.disabled = true;
    try {
      await api.updateWelcomeConfig({ enabled });
      config.enabled = enabled;
      label.textContent = enabled ? 'On — new members will be welcomed' : 'Off — no DMs will be sent';
    } catch (err) {
      e.target.checked = !enabled;
      showFeedback(`Failed to update: ${err.message}`, false);
    } finally {
      e.target.disabled = false;
    }
  }

  async function onSaveMessage() {
    const btn = document.getElementById('btn-save-message');
    const message = document.getElementById('welcome-message').value;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await api.updateWelcomeConfig({ message });
      config.message = message;
      btn.textContent = '✓ Saved';
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 2000);
    } catch (err) {
      showFeedback(`Failed to save: ${err.message}`, false);
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function onMessageInput(e) {
    const preview = document.getElementById('welcome-preview');
    if (preview) preview.innerHTML = renderPreview(e.target.value);
  }

  function showFeedback(msg, ok) {
    const el = document.getElementById('welcome-feedback');
    if (el) el.innerHTML = `<div class="alert ${ok ? 'alert-success' : 'alert-error'}">${escHtml(msg)}</div>`;
  }

  render();
}

function renderPreview(message) {
  const substituted = (message || '').replace(/\{displayName\}/g, 'Alex');
  let v = escHtml(substituted);
  v = v.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  v = v.replace(/\n/g, '<br>');
  return v;
}
