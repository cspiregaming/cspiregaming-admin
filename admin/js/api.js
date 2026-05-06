// Reads WORKER_BASE from the page's <meta name="worker-base"> tag,
// falling back to localhost for local dev.
const meta = document.querySelector('meta[name="worker-base"]');
export const WORKER_BASE = meta ? meta.content : 'http://localhost:8787';

function getToken() {
  return localStorage.getItem('admin_token') || '';
}

export function saveToken(token) {
  localStorage.setItem('admin_token', token);
}

export function clearToken() {
  localStorage.removeItem('admin_token');
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(WORKER_BASE + path, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('auth:expired'));
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('text/csv')) return res.blob();
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // Auth
  loginUrl: () => `${WORKER_BASE}/api/auth/discord`,
  logout: () => apiFetch('/api/auth/logout', { method: 'POST' }),

  // Config
  getConfig: () => apiFetch('/api/admin/config'),
  putConfig: data => apiFetch('/api/admin/config', { method: 'PUT', body: JSON.stringify(data) }),

  // Roles
  getAllRoles: () => apiFetch('/api/admin/roles'),

  // Members
  getMembers: () => apiFetch('/api/admin/members'),
  exportMembersCsv: () => apiFetch('/api/admin/members?format=csv'),

  // Officers
  getOfficers: () => apiFetch('/api/admin/officers'),
  createOfficer: data => apiFetch('/api/admin/officers', { method: 'POST', body: JSON.stringify(data) }),
  updateOfficer: (id, data) => apiFetch(`/api/admin/officers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteOfficer: id => apiFetch(`/api/admin/officers/${id}`, { method: 'DELETE' }),

  // Events
  getEvents: () => apiFetch('/api/admin/events'),
  createEvent: data => apiFetch('/api/admin/events', { method: 'POST', body: JSON.stringify(data) }),
  updateEvent: (id, data) => apiFetch(`/api/admin/events/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEvent: id => apiFetch(`/api/admin/events/${id}`, { method: 'DELETE' }),

  // Social
  getSocial: () => apiFetch('/api/admin/social'),
  putSocial: data => apiFetch('/api/admin/social', { method: 'PUT', body: JSON.stringify(data) }),
};
