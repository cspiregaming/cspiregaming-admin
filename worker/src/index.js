import { handlePublicMembers, handlePublicContent } from './routes/public.js';
import {
  handleAuthDiscord,
  handleAuthCallback,
  handleAuthLogout,
  handleAdminConfig,
  handleAdminMembers,
  handleAdminOfficers,
  handleAdminEvents,
  handleAdminSocial,
} from './routes/admin.js';

const ALLOWED_ORIGINS = [
  'https://cspiregaming.github.io',
  'https://cspiregaming.csgitpages.cspire.net',
  'https://cspiregaming.com',
  'https://www.cspiregaming.com',
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) || origin.startsWith('http://localhost')
      ? origin
      : ALLOWED_ORIGINS[0];

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    try {
      const response = await route(request, env);
      // Attach CORS headers to every response
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders(corsOrigin))) {
        headers.set(k, v);
      }
      return new Response(response.body, { status: response.status, headers });
    } catch (err) {
      // requireAuth throws a Response directly
      if (err instanceof Response) return err;
      console.error(err);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
      });
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Public routes
  if (path === '/api/public/members') return handlePublicMembers(request, env);
  if (path === '/api/public/content') return handlePublicContent(request, env);

  // Auth routes
  if (path === '/api/auth/discord') return handleAuthDiscord(request, env);
  if (path === '/api/auth/callback') return handleAuthCallback(request, env);
  if (path === '/api/auth/logout') return handleAuthLogout(request, env);

  // Admin routes
  if (path === '/api/admin/config') return handleAdminConfig(request, env);
  if (path === '/api/admin/members') return handleAdminMembers(request, env);
  if (path.startsWith('/api/admin/officers')) return handleAdminOfficers(request, env);
  if (path.startsWith('/api/admin/events')) return handleAdminEvents(request, env);
  if (path === '/api/admin/social') return handleAdminSocial(request, env);

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}
