import { handlePublicMembers, handlePublicContent } from './routes/public.js';
import {
  handleAuthDiscord,
  handleAuthCallback,
  handleAuthLogout,
  handleAdminConfig,
  handleAdminRoles,
  handleAdminMembers,
  handleAdminMemberOptOuts,
  handleAdminOfficers,
  handleAdminEvents,
  handleAdminDiscordEvents,
  handleAdminSocial,
  handleAdminStreamers,
  handleAdminGrader,
  handleAdminEmojis,
} from './routes/admin.js';
import { handleInteractions } from './routes/interactions.js';
import {
  handleStreamAuthCallback,
  handleTwitchEventSub,
} from './routes/streamers.js';
import { runDailyGamesGrader } from './games-grader-scheduler.js';

const ALLOWED_ORIGINS = [
  'https://cspiregaming.github.io',
  'http://cspiregaming.csgitpages.cspire.net',
  'https://cspiregaming.csgitpages.cspire.net',
  'https://cspiregaming.com',
  'https://www.cspiregaming.com',
];

export default {
  async scheduled(event, env, ctx) {
    // Currently a single cron — `*/1 * * * *` — drives the #daily-games
    // grader. Add a switch on event.cron when more crons are added.
    ctx.waitUntil(runDailyGamesGrader(env));
  },

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
      const response = await route(request, env, ctx);
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

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Public routes
  if (path === '/api/public/members') return handlePublicMembers(request, env);
  if (path === '/api/public/content') return handlePublicContent(request, env);

  // Discord interactions (signature-verified)
  if (path === '/api/interactions') return handleInteractions(request, env, ctx);

  // Auth routes
  if (path === '/api/auth/discord') return handleAuthDiscord(request, env);
  if (path === '/api/auth/callback') return handleAuthCallback(request, env);
  if (path === '/api/auth/logout') return handleAuthLogout(request, env);
  if (path === '/api/auth/stream-callback') return handleStreamAuthCallback(request, env, ctx);

  // Twitch EventSub webhook
  if (path === '/api/twitch/eventsub') return handleTwitchEventSub(request, env, ctx);

  // Admin routes
  if (path === '/api/admin/config') return handleAdminConfig(request, env);
  if (path === '/api/admin/roles') return handleAdminRoles(request, env);
  if (path === '/api/admin/members/opt-outs' || path.startsWith('/api/admin/members/opt-outs/')) {
    return handleAdminMemberOptOuts(request, env);
  }
  if (path === '/api/admin/members') return handleAdminMembers(request, env);
  if (path.startsWith('/api/admin/officers')) return handleAdminOfficers(request, env);
  if (path.startsWith('/api/admin/discord-events')) return handleAdminDiscordEvents(request, env);
  if (path.startsWith('/api/admin/events')) return handleAdminEvents(request, env);
  if (path === '/api/admin/social') return handleAdminSocial(request, env);
  if (path.startsWith('/api/admin/streamers')) return handleAdminStreamers(request, env);
  if (path.startsWith('/api/admin/grader')) return handleAdminGrader(request, env);
  if (path === '/api/admin/emojis') return handleAdminEmojis(request, env);

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
