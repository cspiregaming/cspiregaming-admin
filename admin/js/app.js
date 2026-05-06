import { api, WORKER_BASE, clearToken } from './api.js';
import { renderDashboard } from './views/dashboard.js';
import { renderMembers } from './views/members.js';
import { renderRolesConfig } from './views/roles.js';
import { renderOfficers } from './views/officers.js';
import { renderEvents } from './views/events.js';
import { renderSocial } from './views/social.js';
import { renderSettings } from './views/settings.js';

// ─── State ──────────────────────────────────────────────────────
let currentSection = 'dashboard';
let sessionUser = null;

// ─── Bootstrap ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Handle OAuth callback: token passed as ?token= query param
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  if (error) showLoginError(error);

  // DEV_PREVIEW=true bypasses Worker auth check for local UI preview
  const DEV_PREVIEW = false;
  if (DEV_PREVIEW) { renderApp(); return; }

  // Check for existing session via cookie (Worker sets HttpOnly cookie)
  // We validate by calling a lightweight admin endpoint
  try {
    const config = await api.getConfig();
    // If we get here, we're authenticated
    renderApp();
  } catch {
    renderLogin();
  }

  window.addEventListener('auth:expired', renderLogin);
});

// ─── Login screen ────────────────────────────────────────────────
function renderLogin() {
  sessionUser = null;
  document.body.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <img src="https://cspiregaming.github.io/img/c-spire-vector-logo-2021.svg" alt="C Spire Gaming" onerror="this.style.display='none'">
        <h1>Admin Login</h1>
        <p>Sign in with your C Spire Gaming Discord account to manage site content.</p>
        <div id="login-error"></div>
        <a href="${api.loginUrl()}" class="btn btn-discord">
          <svg width="20" height="20" viewBox="0 0 127.14 96.36" fill="currentColor">
            <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15zM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.1 12.69-11.44 12.69zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.12 12.69-11.43 12.69z"/>
          </svg>
          Sign in with Discord
        </a>
      </div>
    </div>
  `;
}

function showLoginError(error) {
  const el = document.getElementById('login-error');
  if (!el) return;
  const messages = {
    oauth_denied: 'You cancelled the Discord login.',
    not_authorized: 'Your Discord account does not have officer access to this server.',
  };
  el.innerHTML = `<div class="alert alert-error">${messages[error] || 'Login failed. Please try again.'}</div>`;
}

// ─── Main app shell ──────────────────────────────────────────────
function renderApp() {
  document.body.innerHTML = `
    <div class="app">
      <nav class="sidebar">
        <div class="sidebar__logo">
          <img src="https://cspiregaming.github.io/img/c-spire-vector-logo-2021.svg" alt="" onerror="this.style.display='none'">
          <span>CSG Admin</span>
        </div>

        <div class="nav-item is-active" data-section="dashboard">
          <span class="nav-item__icon">📊</span>
          <span>Dashboard</span>
        </div>
        <div class="nav-item" data-section="members">
          <span class="nav-item__icon">👥</span>
          <span>Members</span>
        </div>
        <div class="nav-item" data-section="roles">
          <span class="nav-item__icon">🏷️</span>
          <span>Roles Config</span>
        </div>
        <div class="nav-item" data-section="officers">
          <span class="nav-item__icon">⭐</span>
          <span>Officers</span>
        </div>
        <div class="nav-item" data-section="events">
          <span class="nav-item__icon">📅</span>
          <span>Events</span>
        </div>
        <div class="nav-item" data-section="social">
          <span class="nav-item__icon">🔗</span>
          <span>Social Links</span>
        </div>
        <div class="nav-item" data-section="settings">
          <span class="nav-item__icon">⚙️</span>
          <span>Settings</span>
        </div>

        <div class="sidebar__spacer"></div>

        <div class="sidebar__user" id="sidebar-user">
          <span style="color:var(--text-muted);font-size:12px">Logged in</span>
        </div>
      </nav>

      <main class="main" id="main-content">
        <div class="loading">Loading...</div>
      </main>
    </div>
  `;

  // Wire nav clicks
  document.querySelectorAll('.nav-item[data-section]').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.section));
  });

  navigateTo('dashboard');
}

export function navigateTo(section) {
  currentSection = section;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('is-active', el.dataset.section === section);
  });

  const content = document.getElementById('main-content');
  content.innerHTML = '<div class="loading">Loading...</div>';

  const views = {
    dashboard: renderDashboard,
    members: renderMembers,
    roles: renderRolesConfig,
    officers: renderOfficers,
    events: renderEvents,
    social: renderSocial,
    settings: renderSettings,
  };

  const fn = views[section];
  if (fn) fn(content).catch(err => {
    content.innerHTML = `<div class="alert alert-error">Failed to load: ${escHtml(err.message)}</div>`;
  });
}

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
