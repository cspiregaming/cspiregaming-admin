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
  setMemberOptOut: (discordId, optedOut) =>
    apiFetch(`/api/admin/members/opt-outs/${encodeURIComponent(discordId)}`, {
      method: 'PUT',
      body: JSON.stringify({ optedOut }),
    }),

  // Officers
  getOfficers: () => apiFetch('/api/admin/officers'),
  createOfficer: data => apiFetch('/api/admin/officers', { method: 'POST', body: JSON.stringify(data) }),
  updateOfficer: (id, data) => apiFetch(`/api/admin/officers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteOfficer: id => apiFetch(`/api/admin/officers/${id}`, { method: 'DELETE' }),

  // Events (manual)
  getEvents: () => apiFetch('/api/admin/events'),
  createEvent: data => apiFetch('/api/admin/events', { method: 'POST', body: JSON.stringify(data) }),
  updateEvent: (id, data) => apiFetch(`/api/admin/events/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEvent: id => apiFetch(`/api/admin/events/${id}`, { method: 'DELETE' }),

  // Events (Discord)
  getDiscordEvents: () => apiFetch('/api/admin/discord-events'),
  putDiscordEventOverlay: (id, data) =>
    apiFetch(`/api/admin/discord-events/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  putDiscordEventOverlaysBatch: overlays =>
    apiFetch('/api/admin/discord-events', { method: 'PUT', body: JSON.stringify({ overlays }) }),

  // Social
  getSocial: () => apiFetch('/api/admin/social'),
  putSocial: data => apiFetch('/api/admin/social', { method: 'PUT', body: JSON.stringify(data) }),

  // Streamers
  getStreamers: () => apiFetch('/api/admin/streamers'),
  removeStreamer: (discordId, reason) =>
    apiFetch(`/api/admin/streamers/${encodeURIComponent(discordId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),
  testStreamerLiveEmbed: discordId =>
    apiFetch(`/api/admin/streamers/${encodeURIComponent(discordId)}/test-live`, {
      method: 'POST',
    }),
  registerOfficialStreamer: twitchLogin =>
    apiFetch('/api/admin/streamers/official', {
      method: 'POST',
      body: JSON.stringify({ twitchLogin }),
    }),

  // Daily-games grader
  getGrader: () => apiFetch('/api/admin/grader'),
  putGrader: config => apiFetch('/api/admin/grader', { method: 'PUT', body: JSON.stringify(config) }),
  testGrader: (content, config) => apiFetch('/api/admin/grader/test', {
    method: 'POST',
    body: JSON.stringify(config ? { content, config } : { content }),
  }),

  // Bot guild emoji catalog (read-only)
  getEmojis: () => apiFetch('/api/admin/emojis'),

  // Statbot daily report
  getStatbotStatus: () => apiFetch('/api/admin/statbot/status'),
  previewStatbot: () => apiFetch('/api/admin/statbot/preview'),
  runStatbot: () => apiFetch('/api/admin/statbot/run', { method: 'POST' }),
  updateStatbotChannels: enabledChannelIds =>
    apiFetch('/api/admin/statbot/channels', { method: 'PUT', body: JSON.stringify({ enabledChannelIds }) }),

  // Welcome DM
  getWelcomeConfig: () => apiFetch('/api/admin/welcome'),
  updateWelcomeConfig: data => apiFetch('/api/admin/welcome', { method: 'PUT', body: JSON.stringify(data) }),

  // Tournament (MatchPlay + Challonge)
  getTournaments: () => apiFetch('/api/admin/tournament'),
  tournamentAnnounce: (platform, id) => apiFetch(`/api/admin/tournament/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/announce`, { method: 'POST' }),
  tournamentLive: (platform, id) => apiFetch(`/api/admin/tournament/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/live`, { method: 'POST' }),
  tournamentEnd: (platform, id) => apiFetch(`/api/admin/tournament/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/end`, { method: 'POST' }),
  tournamentDelete: (platform, id) => apiFetch(`/api/admin/tournament/${encodeURIComponent(platform)}/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Event check-ins
  getActiveEvent: () => apiFetch('/api/admin/checkins/active-event'),
  setActiveEvent: data =>
    apiFetch('/api/admin/checkins/active-event', { method: 'PUT', body: JSON.stringify(data) }),
  clearActiveEvent: () =>
    apiFetch('/api/admin/checkins/active-event', { method: 'DELETE' }),
  getCheckinEventCandidates: () => apiFetch('/api/admin/checkins/event-candidates'),
  getCheckins: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/api/admin/checkins${qs ? `?${qs}` : ''}`);
  },
  exportCheckinsCsv: (params = {}) => {
    const qs = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
      format: 'csv',
    }).toString();
    return apiFetch(`/api/admin/checkins?${qs}`);
  },
};
