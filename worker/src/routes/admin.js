import { requireAuth, buildOAuthUrl, signJwt } from '../auth.js';
import { discordOAuthExchange, fetchGuildMembers } from '../discord.js';

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
  const adminRoleId = await env.CONFIG.get('admin_role_id');
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
    const [guildId, adminRoleId, roleIds, discordClientId] = await Promise.all([
      env.CONFIG.get('guild_id'),
      env.CONFIG.get('admin_role_id'),
      env.CONFIG.get('role_ids'),
      env.CONFIG.get('discord_oauth_client_id'),
    ]);
    return jsonResponse({
      guild_id: guildId || env.GUILD_ID || '379707231077138442',
      admin_role_id: adminRoleId || '',
      role_ids: roleIds ? JSON.parse(roleIds) : [],
      discord_client_id: discordClientId || '',
      bot_token_set: !!(env.BOT_TOKEN),
      jwt_secret_set: !!(env.JWT_SECRET),
    });
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    const writes = [];

    if (body.guild_id != null) writes.push(env.CONFIG.put('guild_id', body.guild_id));
    if (body.admin_role_id != null) writes.push(env.CONFIG.put('admin_role_id', body.admin_role_id));
    if (body.role_ids != null) writes.push(env.CONFIG.put('role_ids', JSON.stringify(body.role_ids)));
    if (body.discord_client_id != null) writes.push(env.CONFIG.put('discord_oauth_client_id', body.discord_client_id));

    await Promise.all(writes);

    // Invalidate members cache when config changes
    const guildId = body.guild_id || await env.CONFIG.get('guild_id') || env.GUILD_ID;
    await env.CACHE.delete(`members_${guildId}`);

    return jsonResponse({ ok: true });
  }

  return methodNotAllowed();
}

export async function handleAdminRoles(request, env) {
  await requireAuth(request, env);

  const botToken = env.BOT_TOKEN;
  if (!botToken) return jsonResponse({ error: 'BOT_TOKEN not configured' }, 500);

  const guildId = (await env.CONFIG.get('guild_id')) || env.GUILD_ID || '379707231077138442';

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

  const guildId = (await env.CONFIG.get('guild_id')) || env.GUILD_ID || '379707231077138442';
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
