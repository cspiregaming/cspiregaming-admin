/**
 * Minimal JWT implementation using the Web Crypto API available in Cloudflare Workers.
 * Signs/verifies HS256 JWTs for admin session cookies.
 */

export async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const data = `${encode(header)}.${encode(payload)}`;
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${data}.${sigB64}`;
}

export async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  const key = await importHmacKey(secret);
  const sig = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

  const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
  if (!valid) return null;

  try {
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Middleware: extract and verify the Bearer JWT from the Authorization header.
 * Returns the decoded payload or throws a 401 Response.
 */
export async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Also accept token from cookie (for browser-based admin page)
  const cookieToken = getCookieValue(request.headers.get('Cookie') || '', 'admin_token');
  const jwt = token || cookieToken;

  if (!jwt) throw unauthorizedResponse();

  const secret = env.JWT_SECRET;
  if (!secret) throw new Response('JWT_SECRET not configured', { status: 500 });

  const payload = await verifyJwt(jwt, secret);
  if (!payload) throw unauthorizedResponse();

  return payload;
}

/**
 * Compute the access tier of a signed-in user from their JWT payload.
 *  - 'officer'          → has ADMIN_ROLE_ID
 *  - 'mod'              → holds any role listed in MOD_ROLE_IDS (but not ADMIN_ROLE_ID)
 *  - 'tournament-admin' → holds TOURNAMENT_ADMIN_ROLE_ID only (tournament + check-ins + events)
 *  - 'tournament-staff' → holds TOURNAMENT_STAFF_ROLE_ID only (tournament + check-ins)
 *  - null               → none of the above (shouldn't normally happen — sign-in gate rejects)
 *
 * Legacy tokens (issued before we started embedding `roles` in the JWT) were
 * only handed out to ADMIN_ROLE_ID holders, so treat a missing `roles` array
 * as 'officer'.
 */
export function getTier(payload, env) {
  if (!payload?.roles) return 'officer';
  const adminRoleId = env.ADMIN_ROLE_ID;
  if (adminRoleId && payload.roles.includes(adminRoleId)) return 'officer';
  const modRoleIds = parseRoleList(env.MOD_ROLE_IDS);
  if (modRoleIds.some(r => r !== adminRoleId && payload.roles.includes(r))) return 'mod';
  if (env.TOURNAMENT_ADMIN_ROLE_ID && payload.roles.includes(env.TOURNAMENT_ADMIN_ROLE_ID)) return 'tournament-admin';
  if (env.TOURNAMENT_STAFF_ROLE_ID && payload.roles.includes(env.TOURNAMENT_STAFF_ROLE_ID)) return 'tournament-staff';
  return null;
}

export async function requireOfficer(request, env) {
  const payload = await requireAuth(request, env);
  if (getTier(payload, env) === 'officer') return payload;
  throw forbiddenResponse('Officer access required.');
}

export async function requireMod(request, env) {
  const payload = await requireAuth(request, env);
  const tier = getTier(payload, env);
  if (tier === 'officer' || tier === 'mod') return payload;
  throw forbiddenResponse('Officer or mod access required.');
}

// Grants access to tournament management and check-ins (all tournament roles).
export async function requireTournamentStaff(request, env) {
  const payload = await requireAuth(request, env);
  const tier = getTier(payload, env);
  if (tier === 'officer' || tier === 'tournament-admin' || tier === 'tournament-staff') return payload;
  throw forbiddenResponse('Tournament staff access required.');
}

// Grants access to tournament events (tournament admin and above only).
export async function requireTournamentAdmin(request, env) {
  const payload = await requireAuth(request, env);
  const tier = getTier(payload, env);
  if (tier === 'officer' || tier === 'tournament-admin') return payload;
  throw forbiddenResponse('Tournament admin access required.');
}

export function parseRoleList(commaList) {
  return (commaList || '').split(',').map(s => s.trim()).filter(Boolean);
}

function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function forbiddenResponse(message) {
  return new Response(JSON.stringify({ error: message || 'Forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getCookieValue(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function buildOAuthUrl(env, redirectUri, { scope, state, prompt } = {}) {
  const clientId = env.DISCORD_CLIENT_ID;
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scope || 'identify guilds.members.read',
  });
  if (state) params.set('state', state);
  if (prompt) params.set('prompt', prompt);

  return `https://discord.com/api/oauth2/authorize?${params}`;
}
