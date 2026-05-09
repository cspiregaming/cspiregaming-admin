/**
 * Routes that close the streamer-registration loop:
 *   - GET /api/auth/stream-callback   Discord OAuth landing page after the user
 *                                     approves the `connections` scope. Reads
 *                                     their connections, persists the streamer
 *                                     record, assigns @streamer, and creates
 *                                     the Twitch EventSub subscriptions.
 *   - POST /api/twitch/eventsub       Twitch webhook. Handles the one-time
 *                                     callback verification challenge plus
 *                                     stream.online / stream.offline / revocation
 *                                     notifications.
 *
 * The slash-command side (/register-stream, /unregister-stream) lives in
 * routes/interactions.js — it generates the OAuth URL with a signed state
 * token that this callback verifies.
 */

import { verifyJwt, signJwt } from '../auth.js';
import {
  addGuildMemberRole,
  removeGuildMemberRole,
  postChannelMessage,
} from '../discord-outbound.js';
import * as streamers from '../streamers.js';
import {
  getUserById as getTwitchUser,
  getStreamByUserId,
  createSubscription,
  deleteSubscription,
  verifyEventSubSignature,
  liveThumbnailUrl,
} from '../twitch.js';

const STATE_TTL_SECONDS = 15 * 60; // 15 min — matches Discord interaction-token validity

export async function buildStreamAuthState(env, discordId, interactionToken) {
  return signJwt(
    {
      sub: discordId,
      tok: interactionToken || null,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    },
    env.JWT_SECRET,
  );
}

// ─── OAuth callback ──────────────────────────────────────────────────────────

export async function handleStreamAuthCallback(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) return htmlPage('Sign-in canceled', 'You canceled the request. You can run /register-stream again to retry.');
  if (!code || !state) return htmlPage('Missing code or state', 'Try running /register-stream again.', 400);

  const claims = await verifyJwt(state, env.JWT_SECRET);
  if (!claims?.sub) return htmlPage('Link expired', 'That registration link is no longer valid. Run /register-stream to get a fresh one.', 400);

  const discordId = claims.sub;
  const interactionToken = claims.tok;
  const redirectUri = `${url.origin}/api/auth/stream-callback`;

  // Exchange code for an access token + read connections + identify in parallel.
  let accessToken, user, connections;
  try {
    accessToken = await exchangeCode(env, code, redirectUri);
    [user, connections] = await Promise.all([
      fetchSelf(accessToken),
      fetchConnections(accessToken),
    ]);
  } catch (err) {
    console.error('stream-callback: oauth exchange failed', err);
    return htmlPage('Sign-in failed', 'Discord rejected the sign-in. Run /register-stream to try again.', 502);
  }

  if (user.id !== discordId) {
    return htmlPage('User mismatch', 'You signed in as a different Discord user than the one who ran /register-stream. Try again with the same account.', 400);
  }

  const twitchConn = (connections || []).find(c => c.type === 'twitch');
  const youtubeConn = (connections || []).find(c => c.type === 'youtube');

  if (!twitchConn && !youtubeConn) {
    return htmlPage(
      'No streaming connections found',
      'You haven\'t added a Twitch or YouTube connection to your Discord profile yet. ' +
      'Open Discord → User Settings → Connections → Add (Twitch or YouTube), then run /register-stream again.',
      400,
    );
  }

  // Defer the slow path (Twitch API + Discord role + EventSub) so we can return
  // a snappy success page first.
  ctx.waitUntil(finishRegistration(env, {
    discordId,
    discordUsername: user.username,
    displayName: user.global_name || user.username,
    twitchConn,
    youtubeConn,
    interactionToken,
    workerOrigin: url.origin,
  }));

  return htmlPage(
    'Registration submitted',
    'You can close this tab — the bot will message you in Discord once your @streamer role and live notifications are wired up.',
  );
}

async function finishRegistration(env, ctx) {
  const { discordId, discordUsername, displayName, twitchConn, youtubeConn, interactionToken, workerOrigin } = ctx;

  const prior = await streamers.getByDiscordId(env, discordId);
  const priorTwitchSubs = prior?.twitch?.eventSubIds || {};
  const priorTwitchUserId = prior?.twitch?.userId || null;

  // Twitch connection.id is the Twitch user ID; Helix lookup gets the live
  // login + display name (the connection.name can lag rename history).
  const twitchUser = twitchConn ? await getTwitchUser(env, twitchConn.id) : null;
  const newTwitchUserId = twitchUser?.id || null;

  // Reconcile EventSub subscriptions any time the Twitch link changes — that
  // includes losing it (user disconnected Twitch from Discord) or swapping to
  // a different account. Same account: reuse existing subs.
  if (priorTwitchUserId && priorTwitchUserId !== newTwitchUserId) {
    await Promise.allSettled([
      deleteSubscription(env, priorTwitchSubs.online),
      deleteSubscription(env, priorTwitchSubs.offline),
    ]);
  }

  let twitch = null;
  if (twitchUser) {
    const callbackUrl = `${workerOrigin}/api/twitch/eventsub`;
    const reuse = priorTwitchUserId === twitchUser.id;
    const [online, offline] = await Promise.all([
      reuse && priorTwitchSubs.online
        ? priorTwitchSubs.online
        : createSubscription(env, 'stream.online', twitchUser.id, callbackUrl),
      reuse && priorTwitchSubs.offline
        ? priorTwitchSubs.offline
        : createSubscription(env, 'stream.offline', twitchUser.id, callbackUrl),
    ]);
    twitch = {
      userId: twitchUser.id,
      login: twitchUser.login,
      displayName: twitchUser.display_name,
      eventSubIds: { online, offline },
    };
  }

  const youtube = youtubeConn ? { channelId: youtubeConn.id, name: youtubeConn.name } : null;

  await streamers.upsert(env, {
    discordId,
    discordUsername,
    displayName,
    twitch,
    youtube,
  });

  // Assign @streamer
  if (env.STREAMER_ROLE_ID && env.GUILD_ID) {
    const roleRes = await addGuildMemberRole(env, env.GUILD_ID, discordId, env.STREAMER_ROLE_ID);
    if (!roleRes.ok && roleRes.status !== 204) {
      console.error(`stream-callback: role assignment failed for ${discordId} → ${roleRes.status}`, roleRes.json);
    }
  }

  // Followup to the slash-command interaction (if still within the 15-min window).
  if (interactionToken) {
    const lines = ['✓ You\'re registered as a streamer.'];
    if (twitch) lines.push(`• Twitch: **${twitch.displayName}** — we\'ll announce when you go live.`);
    if (youtube) lines.push(`• YouTube: **${youtube.name}** — saved (live announcements for YouTube are coming in a future update).`);
    lines.push('Run `/unregister-stream` any time to opt out.');
    await postInteractionFollowup(env, interactionToken, lines.join('\n'));
  }
}

// ─── Twitch EventSub webhook ─────────────────────────────────────────────────

export async function handleTwitchEventSub(request, env, ctx) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const rawBody = await request.text();
  const verified = await verifyEventSubSignature(env, request.headers, rawBody);
  if (!verified) return new Response('invalid signature', { status: 403 });

  const messageType = request.headers.get('Twitch-Eventsub-Message-Type') || '';
  let body;
  try { body = JSON.parse(rawBody); } catch { return new Response('bad body', { status: 400 }); }

  if (messageType === 'webhook_callback_verification') {
    // Twitch sends a one-time challenge when a subscription is created. Echo it
    // back as plain text within 10 seconds to confirm we own the endpoint.
    return new Response(body.challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (messageType === 'revocation') {
    const sub = body.subscription;
    console.error(`twitch-eventsub: subscription revoked — type=${sub?.type} reason=${sub?.status}`);
    return new Response(null, { status: 204 });
  }

  if (messageType === 'notification') {
    const event = body.event;
    const type = body.subscription?.type;
    if (type === 'stream.online' && event?.broadcaster_user_id) {
      ctx.waitUntil(announceLive(env, event));
    }
    // stream.offline is subscribed-to but unused for v1 (no edit-on-end behavior).
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
}

async function announceLive(env, event) {
  const channelId = env.LIVE_ANNOUNCE_CHANNEL_ID;
  if (!channelId) {
    console.error('twitch-eventsub: LIVE_ANNOUNCE_CHANNEL_ID not set');
    return;
  }

  const record = await streamers.getByTwitchUserId(env, event.broadcaster_user_id);
  if (!record) {
    console.error(`twitch-eventsub: no streamer record for twitch user ${event.broadcaster_user_id}`);
    return;
  }

  const stream = await getStreamByUserId(env, event.broadcaster_user_id);
  const login = event.broadcaster_user_login || record.twitch?.login;
  const displayName = event.broadcaster_user_name || record.twitch?.displayName || login;

  const payload = buildLiveAnnouncementPayload({ record, stream, login, displayName });
  await postChannelMessage(env, channelId, payload);
}

/**
 * Build the live-announcement message payload. Shared by the real EventSub
 * announcer and the admin SPA "Test Embed" preview path. Set
 * `suppressMention: true` to keep the embed identical but skip pinging the
 * streamer (used for previews so we don't notify the user during a test).
 */
function buildLiveAnnouncementPayload({ record, stream, login, displayName, suppressMention = false }) {
  const url = `https://twitch.tv/${login}`;
  const title = stream?.title || `${displayName} is live`;
  const game = stream?.game_name || null;

  const payload = {
    embeds: [{
      title,
      url,
      description: `[Watch on Twitch](${url})`,
      author: { name: displayName, url, icon_url: 'https://static.twitchcdn.net/assets/favicon-32-d6025c14e900565d6177.png' },
      color: 0x9146FF,
      image: { url: liveThumbnailUrl(login) },
      fields: game ? [{ name: 'Playing', value: game, inline: true }] : [],
      footer: { text: 'Twitch' },
      timestamp: stream?.started_at || new Date().toISOString(),
    }],
  };

  if (suppressMention) {
    payload.content = `_Preview — ${displayName} would be live on Twitch_`;
    payload.allowed_mentions = { parse: [] };
  } else {
    payload.content = `<@${record.discordId}> is live on Twitch!`;
    payload.allowed_mentions = { users: [record.discordId] };
  }

  return payload;
}

/**
 * Render the same live-announcement embed used by the EventSub path, but
 * post it to BOT_LOGS_CHANNEL_ID without pinging the streamer. Called from
 * the admin SPA so officers can see what a live announcement will look like.
 *
 * Falls back to placeholder fields when the streamer isn't currently live
 * (Helix /streams returns null for offline channels).
 */
export async function postLiveAnnouncementTest(env, discordId) {
  const channelId = env.BOT_LOGS_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'BOT_LOGS_CHANNEL_ID not configured' };

  const record = await streamers.getByDiscordId(env, discordId);
  if (!record) return { ok: false, error: 'Streamer not found' };
  if (!record.twitch?.login) return { ok: false, error: 'No Twitch link on this streamer' };

  const { userId, login, displayName } = record.twitch;
  const stream = userId ? await getStreamByUserId(env, userId) : null;

  const payload = buildLiveAnnouncementPayload({
    record,
    stream,
    login,
    displayName: displayName || login,
    suppressMention: true,
  });

  const res = await postChannelMessage(env, channelId, payload);
  if (!res.ok) {
    return { ok: false, error: `Discord HTTP ${res.status}${res.json?.message ? ` — ${res.json.message}` : ''}` };
  }
  return { ok: true };
}

// ─── Discord helpers (callback-local) ────────────────────────────────────────

async function exchangeCode(env, code, redirectUri) {
  const res = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

async function fetchSelf(accessToken) {
  const res = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`/users/@me failed: ${res.status}`);
  return res.json();
}

async function fetchConnections(accessToken) {
  const res = await fetch('https://discord.com/api/v10/users/@me/connections', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`/users/@me/connections failed: ${res.status}`);
  return res.json();
}

async function postInteractionFollowup(env, interactionToken, content) {
  const url = `https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${interactionToken}`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, flags: 1 << 6 }),
  });
}

function htmlPage(title, body, status = 200) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #e8eaed; background: #1c1d22; }
  h1 { font-size: 24px; margin-bottom: 12px; }
  p { line-height: 1.55; color: #c0c4cc; }
</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ─── Unregistration helper, called from interactions.js ──────────────────────

export async function unregisterStreamer(env, discordId) {
  const record = await streamers.remove(env, discordId);
  if (!record) return { existed: false };

  const subs = record.twitch?.eventSubIds || {};
  await Promise.allSettled([
    deleteSubscription(env, subs.online),
    deleteSubscription(env, subs.offline),
  ]);

  if (env.STREAMER_ROLE_ID && env.GUILD_ID) {
    await removeGuildMemberRole(env, env.GUILD_ID, discordId, env.STREAMER_ROLE_ID);
  }
  return { existed: true, record };
}

/**
 * Post the "streamer deregistered" audit-log embed in OFFICERS_CHANNEL_ID.
 * Shared by /streamer-remove and the admin-SPA DELETE endpoint so both paths
 * produce identical log entries.
 *
 *   info: { actorId, actorName, targetId, targetName, twitchLogin?, youtubeName?, reason }
 */
export async function postRemovalAuditLog(env, info) {
  const channelId = env.OFFICERS_CHANNEL_ID;
  if (!channelId) {
    console.error('streamer audit: OFFICERS_CHANNEL_ID not set; audit log dropped');
    return { posted: false };
  }
  const platforms = [];
  if (info.twitchLogin) platforms.push({ name: 'Twitch', value: `\`${info.twitchLogin}\``, inline: true });
  if (info.youtubeName) platforms.push({ name: 'YouTube', value: `\`${info.youtubeName}\``, inline: true });

  const ts = formatCentralAudit(new Date().toISOString());

  const res = await postChannelMessage(env, channelId, {
    embeds: [{
      title: 'Streamer deregistered',
      color: 0xE07B00,
      fields: [
        { name: 'Removed', value: `<@${info.targetId}> (${escapeMdAudit(info.targetName)})`, inline: false },
        { name: 'By', value: `<@${info.actorId}> (${escapeMdAudit(info.actorName)})`, inline: false },
        ...platforms,
        { name: 'Reason', value: truncateAudit(info.reason, 1000), inline: false },
      ],
      footer: { text: ts },
    }],
  });
  return { posted: !!res.ok };
}

function formatCentralAudit(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(d);
  const get = type => parts.find(p => p.type === type)?.value || '';
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

function escapeMdAudit(s) {
  return String(s).replace(/[*_`~|\\]/g, ch => '\\' + ch);
}

function truncateAudit(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
