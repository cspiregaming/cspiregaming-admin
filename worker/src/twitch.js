/**
 * Twitch Helix + EventSub helpers. Uses an app access token (client_credentials
 * grant) cached in CACHE KV. The token is good for ~60 days; we ask Twitch's
 * response how long it's actually valid and cache for that minus a 5-minute
 * safety margin.
 *
 * EventSub subscriptions are created with webhook transport. The shared secret
 * is reused across all subscriptions (env.TWITCH_EVENTSUB_SECRET) so the
 * webhook handler can verify any notification with one secret.
 */

const HELIX = 'https://api.twitch.tv/helix';
const ID = 'https://id.twitch.tv';
const TOKEN_CACHE_KEY = 'twitch_app_token';

async function getAppToken(env) {
  const cached = await env.CACHE.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const res = await fetch(`${ID}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twitch token: ${res.status} ${text}`);
  }
  const json = await res.json();
  const ttl = Math.max(60, (json.expires_in || 3600) - 300);
  await env.CACHE.put(TOKEN_CACHE_KEY, json.access_token, { expirationTtl: ttl });
  return json.access_token;
}

async function helix(env, method, path, { body, query } = {}) {
  const token = await getAppToken(env);
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${HELIX}${path}${qs}`, {
    method,
    headers: {
      'Client-Id': env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  if (res.status !== 204) {
    try { json = await res.json(); } catch { /* ignore */ }
  }
  return { ok: res.ok, status: res.status, json };
}

export async function getUserById(env, userId) {
  const r = await helix(env, 'GET', '/users', { query: { id: userId } });
  if (!r.ok) return null;
  return r.json?.data?.[0] || null;
}

export async function getStreamByUserId(env, userId) {
  const r = await helix(env, 'GET', '/streams', { query: { user_id: userId } });
  if (!r.ok) return null;
  return r.json?.data?.[0] || null;
}

/**
 * Create an EventSub subscription for `stream.online` or `stream.offline`.
 * Returns the new subscription ID, or null on failure.
 *
 * Note: Twitch returns 409 if a duplicate subscription (same type+condition+
 * callback) already exists; treat that as success and return the existing ID
 * if the response includes one, or null otherwise — caller can recover by
 * listing subscriptions.
 */
export async function createSubscription(env, type, broadcasterUserId, callbackUrl) {
  const r = await helix(env, 'POST', '/eventsub/subscriptions', {
    body: {
      type,
      version: '1',
      condition: { broadcaster_user_id: String(broadcasterUserId) },
      transport: {
        method: 'webhook',
        callback: callbackUrl,
        secret: env.TWITCH_EVENTSUB_SECRET,
      },
    },
  });
  if (r.ok) return r.json?.data?.[0]?.id || null;
  if (r.status === 409) {
    // Already exists. Find the existing one.
    const existing = await listSubscriptions(env, { type, broadcasterUserId });
    return existing.find(s => s.transport?.callback === callbackUrl)?.id || null;
  }
  console.error(`twitch: createSubscription ${type} for ${broadcasterUserId} → ${r.status}`, r.json);
  return null;
}

export async function deleteSubscription(env, subscriptionId) {
  if (!subscriptionId) return true;
  const r = await helix(env, 'DELETE', '/eventsub/subscriptions', {
    query: { id: subscriptionId },
  });
  if (r.ok || r.status === 404) return true;
  console.error(`twitch: deleteSubscription ${subscriptionId} → ${r.status}`, r.json);
  return false;
}

async function listSubscriptions(env, { type, broadcasterUserId } = {}) {
  const query = {};
  if (type) query.type = type;
  if (broadcasterUserId) query.user_id = String(broadcasterUserId);
  const r = await helix(env, 'GET', '/eventsub/subscriptions', { query });
  if (!r.ok) return [];
  return r.json?.data || [];
}

/**
 * Verify the HMAC signature on an incoming EventSub webhook request.
 * Twitch signs sha256(message_id + timestamp + body) with the per-subscription
 * secret and sends the hex digest as `Twitch-Eventsub-Message-Signature`
 * prefixed with `sha256=`.
 */
export async function verifyEventSubSignature(env, headers, rawBody) {
  const messageId = headers.get('Twitch-Eventsub-Message-Id');
  const timestamp = headers.get('Twitch-Eventsub-Message-Timestamp');
  const signature = headers.get('Twitch-Eventsub-Message-Signature');
  if (!messageId || !timestamp || !signature) return false;
  if (!signature.startsWith('sha256=')) return false;

  const message = messageId + timestamp + rawBody;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TWITCH_EVENTSUB_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const expected = 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build the live thumbnail URL for a stream. Twitch keeps the same path while
 * the user is live; cache-bust with a short timestamp so Discord refreshes its
 * preview when we re-post.
 */
export function liveThumbnailUrl(login, width = 1280, height = 720) {
  const bust = Math.floor(Date.now() / 60000); // changes once a minute
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login.toLowerCase()}-${width}x${height}.jpg?cb=${bust}`;
}
