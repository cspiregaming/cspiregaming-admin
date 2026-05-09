import { requireAuth, buildOAuthUrl, signJwt } from '../auth.js';
import { discordOAuthExchange, fetchGuildMembers } from '../discord.js';
import { getDiscordEventsWithArchive, getOverlays, setOverlay, setOverlaysBatch } from '../discord-events.js';
import * as eventPublishRequests from '../event-publish-requests.js';
import * as streamerRegistry from '../streamers.js';
import { unregisterStreamer, postRemovalAuditLog } from './streamers.js';

// ─── Auth endpoints (no requireAuth) ────────────────────────────────────────

export async function handleAuthDiscord(request, env) {
  const origin = getOrigin(request);
  const redirectUri = `${origin}/api/auth/callback`;
  const url = buildOAuthUrl(env, redirectUri);
  if (!url) return new Response('DISCORD_CLIENT_ID not configured', { status: 500 });
  return Response.redirect(url, 302);
}

export async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  const workerOrigin = getOrigin(request);
  const redirectUri = `${workerOrigin}/api/auth/callback`;
  const adminUrl = (env.ADMIN_URL || '').replace(/\/$/, '');

  if (error || !code) {
    return Response.redirect(`${adminUrl}/?error=oauth_denied`, 302);
  }

  const { user, member } = await discordOAuthExchange(env, code, redirectUri);

  // Verify user has the configured admin role
  const adminRoleId = env.ADMIN_ROLE_ID;
  if (adminRoleId && !member.roles.includes(adminRoleId)) {
    return Response.redirect(`${adminUrl}/?error=not_authorized`, 302);
  }

  const secret = env.JWT_SECRET;
  if (!secret) return new Response('JWT_SECRET not configured', { status: 500 });

  const payload = {
    sub: user.id,
    username: user.username,
    displayName: user.global_name || user.username,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days
  };

  const token = await signJwt(payload, secret);

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${adminUrl}/`,
      'Set-Cookie': `admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${86400 * 7}`,
    },
  });
}

export async function handleAuthLogout(request, env) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'admin_token=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0',
    },
  });
}

// ─── Admin endpoints (all require auth) ─────────────────────────────────────

export async function handleAdminConfig(request, env) {
  const session = await requireAuth(request, env);

  if (request.method === 'GET') {
    const [roleIdsRaw, defaultRoleId] = await Promise.all([
      env.CONFIG.get('role_ids'),
      env.CONFIG.get('default_role_id'),
    ]);
    return jsonResponse({
      guild_id: env.GUILD_ID,
      role_ids: roleIdsRaw ? JSON.parse(roleIdsRaw) : [],
      default_role_id: defaultRoleId || null,
      bot_token_set: !!(env.BOT_TOKEN),
      jwt_secret_set: !!(env.JWT_SECRET),
    });
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    let cacheDirty = false;

    if (body.role_ids != null) {
      await env.CONFIG.put('role_ids', JSON.stringify(body.role_ids));
      cacheDirty = true;
    }

    if ('default_role_id' in body) {
      // Normalize: enabled role IDs win; "all" / null / unknown role → cleared.
      const roleIdsRaw = body.role_ids != null
        ? body.role_ids
        : JSON.parse((await env.CONFIG.get('role_ids')) || '[]');
      const enabled = new Set(roleIdsRaw);
      const next = body.default_role_id;
      if (next && next !== 'all' && enabled.has(next)) {
        await env.CONFIG.put('default_role_id', next);
      } else {
        await env.CONFIG.delete('default_role_id');
      }
      cacheDirty = true;
    }

    if (cacheDirty) await env.CACHE.delete(`members_${env.GUILD_ID}`);
    return jsonResponse({ ok: true });
  }

  return methodNotAllowed();
}

export async function handleAdminRoles(request, env) {
  await requireAuth(request, env);

  const botToken = env.BOT_TOKEN;
  if (!botToken) return jsonResponse({ error: 'BOT_TOKEN not configured' }, 500);

  const guildId = env.GUILD_ID;

  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok) {
    return jsonResponse({ error: `Discord roles fetch failed: ${res.status}` }, 502);
  }
  const all = await res.json();

  // Exclude @everyone (whose role id equals the guild id)
  const roles = all
    .filter(r => r.id !== guildId)
    .map(r => ({
      id: r.id,
      name: r.name,
      position: r.position,
      managed: !!r.managed,
      color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null,
    }))
    .sort((a, b) => b.position - a.position);

  return jsonResponse({ roles });
}

export async function handleAdminMembers(request, env) {
  const session = await requireAuth(request, env);
  const url = new URL(request.url);

  const guildId = env.GUILD_ID;
  const roleIdsRaw = await env.CONFIG.get('role_ids');
  const roleIds = roleIdsRaw ? JSON.parse(roleIdsRaw) : [];

  const { members, roles, totalMembers, fetchedAt } = roleIds.length
    ? await fetchGuildMembers(env, guildId, roleIds)
    : { members: [], roles: [], totalMembers: 0, fetchedAt: new Date().toISOString() };

  // CSV export
  if (url.searchParams.get('format') === 'csv') {
    const lines = ['displayName,username,roles'];
    members.forEach(m => {
      const roleNames = m.roles
        .map(id => roles.find(r => r.id === id)?.name || id)
        .join('; ');
      lines.push(`"${m.displayName}","${m.username}","${roleNames}"`);
    });
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="members-${guildId}.csv"`,
      },
    });
  }

  return jsonResponse({ members, roles, totalMembers, fetchedAt });
}

export async function handleAdminOfficers(request, env) {
  const session = await requireAuth(request, env);
  return handleCrudCollection(request, env, 'officers');
}

export async function handleAdminEvents(request, env) {
  const session = await requireAuth(request, env);
  return handleCrudCollection(request, env, 'events');
}

export async function handleAdminDiscordEvents(request, env) {
  const session = await requireAuth(request, env);
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  // /api/admin/discord-events            → pathParts[2] === 'discord-events', no id
  // /api/admin/discord-events/{eventId}  → pathParts[3] === eventId
  const eventId = pathParts[3] || null;

  if (request.method === 'GET' && !eventId) {
    try {
      const [{ live, archived }, overlays] = await Promise.all([
        getDiscordEventsWithArchive(env),
        getOverlays(env),
      ]);
      return jsonResponse({ live, archived, overlays });
    } catch (err) {
      return jsonResponse({ error: err.message }, 502);
    }
  }

  if (request.method === 'PUT' && eventId) {
    const body = await request.json();
    const overlays = await setOverlay(env, eventId, body);
    return jsonResponse({ ok: true, overlay: overlays[eventId] || null });
  }

  // Batch PUT — body: { overlays: { <eventId>: {published, actionButtonText?, actionButtonUrl?} } }
  if (request.method === 'PUT' && !eventId) {
    const body = await request.json();
    if (!body.overlays || typeof body.overlays !== 'object') {
      return jsonResponse({ error: 'Body must be { overlays: { ... } }' }, 400);
    }
    const overlays = await setOverlaysBatch(env, body.overlays);

    // Reconcile any pending publish requests for events that just flipped to
    // published. Best-effort — overlay write already succeeded, so we don't
    // surface failures here as the request status.
    const decidedBy = { id: session.sub, displayName: session.displayName || session.username };
    for (const [evId, overlay] of Object.entries(body.overlays)) {
      if (!overlay?.published) continue;
      try {
        const pending = await eventPublishRequests.getPendingByEventId(env, evId);
        if (pending) {
          await eventPublishRequests.applyDecision(env, pending.id, 'approved', decidedBy);
        }
      } catch (err) {
        console.error('reconcile publish request failed', evId, err);
      }
    }

    return jsonResponse({ ok: true, overlays });
  }

  return methodNotAllowed();
}

export async function handleAdminSocial(request, env) {
  const session = await requireAuth(request, env);

  if (request.method === 'GET') {
    const raw = await env.CONTENT.get('social');
    return jsonResponse(raw ? JSON.parse(raw) : {});
  }
  if (request.method === 'PUT') {
    const body = await request.json();
    await env.CONTENT.put('social', JSON.stringify(body));
    return jsonResponse({ ok: true });
  }
  return methodNotAllowed();
}

// ─── Shared CRUD helper ──────────────────────────────────────────────────────

async function handleCrudCollection(request, env, key) {
  const url = new URL(request.url);
  // Extract optional item ID from path: /api/admin/officers/123
  const pathParts = url.pathname.split('/').filter(Boolean);
  const itemId = pathParts[pathParts.length - 1] !== key.replace('admin/', '') ? pathParts[pathParts.length - 1] : null;

  const getAll = async () => {
    const raw = await env.CONTENT.get(key);
    return raw ? JSON.parse(raw) : [];
  };
  const putAll = items => env.CONTENT.put(key, JSON.stringify(items));

  if (request.method === 'GET') {
    const items = await getAll();
    return jsonResponse(itemId ? (items.find(i => i.id === itemId) || null) : items);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const items = await getAll();
    const newItem = { ...body, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    items.push(newItem);
    await putAll(items);
    return jsonResponse(newItem, 201);
  }

  if (request.method === 'PUT' && itemId) {
    const body = await request.json();
    const items = await getAll();
    const idx = items.findIndex(i => i.id === itemId);
    if (idx === -1) return jsonResponse({ error: 'Not found' }, 404);
    items[idx] = { ...items[idx], ...body, id: itemId, updatedAt: new Date().toISOString() };
    await putAll(items);
    return jsonResponse(items[idx]);
  }

  if (request.method === 'DELETE' && itemId) {
    const items = await getAll();
    const filtered = items.filter(i => i.id !== itemId);
    await putAll(filtered);
    return jsonResponse({ ok: true });
  }

  return methodNotAllowed();
}

// ─── Streamers ───────────────────────────────────────────────────────────────

/**
 * Mirrors the slash-command admin tools (/streamer-list, /streamer-remove).
 * GET    /api/admin/streamers              → all registered streamers
 * DELETE /api/admin/streamers/{discordId}  → body {reason} (≥10 chars). Drops
 *                                            the record + EventSub subs +
 *                                            @streamer role and posts the
 *                                            same audit-log embed in the
 *                                            officers channel.
 */
export async function handleAdminStreamers(request, env) {
  const session = await requireAuth(request, env);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin','streamers', maybe id]
  const targetId = parts[3] || null;

  if (request.method === 'GET' && !targetId) {
    const map = await streamerRegistry.getAll(env);
    const records = Object.values(map).sort(
      (a, b) => (a.displayName || '').localeCompare(b.displayName || ''),
    );
    return jsonResponse({ streamers: records });
  }

  if (request.method === 'DELETE' && targetId) {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const reason = (body?.reason || '').trim();
    if (reason.length < 10) {
      return jsonResponse({ error: 'Reason must be at least 10 characters' }, 400);
    }

    const existing = await streamerRegistry.getByDiscordId(env, targetId);
    if (!existing) return jsonResponse({ error: 'Not found' }, 404);

    await unregisterStreamer(env, targetId);
    await postRemovalAuditLog(env, {
      actorId: session.sub,
      actorName: session.displayName || session.username || session.sub,
      targetId,
      targetName: existing.displayName || existing.discordUsername || targetId,
      twitchLogin: existing.twitch?.login || null,
      youtubeName: existing.youtube?.name || null,
      reason,
    });
    return jsonResponse({ ok: true });
  }

  return methodNotAllowed();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function methodNotAllowed() {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
