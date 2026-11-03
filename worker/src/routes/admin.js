import { requireAuth, requireOfficer, requireMod, requireTournamentStaff, requireTournamentAdmin, getTier, parseRoleList, buildOAuthUrl, signJwt } from '../auth.js';
import { getAppToken, listAllSubscriptions, createSubscription, deleteSubscription } from '../twitch.js';
import { discordOAuthExchange, fetchGuildEmojis, fetchGuildMembers } from '../discord.js';
import { getDiscordEventsWithArchive, getOverlays, setOverlay, setOverlaysBatch } from '../discord-events.js';
import * as eventPublishRequests from '../event-publish-requests.js';
import * as streamerRegistry from '../streamers.js';
import * as memberOptOuts from '../member-opt-outs.js';
import { unregisterStreamer, postRemovalAuditLog, postLiveAnnouncementTest, postLiveAnnouncementChannelTest, registerOfficialStreamer } from './streamers.js';
import { loadGraderConfig, saveGraderConfig, validateGraderConfig, DEFAULT_GRADER_CONFIG, PARSER_TYPES, LEGEND_KEYS, EXTRACTOR_KINDS, RULE_OPS, BOARD_PRESETS } from '../grader-config.js';
import { gradeMessage } from '../games-grader.js';
import { runDailyStatbotReport, buildDailyReport } from '../statbot-daily.js';
import { DEFAULT_WELCOME_MESSAGE } from '../welcome.js';
import { announceTournament, startLiveTournament, endTournament } from '../tournament-actions.js';
import { buildStateKey, VALID_PLATFORMS, getMatchPlayOrganizerIds, MATCHPLAY_ORGANIZERS_KEY, getOpenTournaments, pruneStaleTournaments } from '../tournament-platform.js';

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

  // Sign-in gate: officers (ADMIN_ROLE_ID), mods (MOD_ROLE_IDS), and tournament
  // staff (TOURNAMENT_ADMIN_ROLE_ID / TOURNAMENT_STAFF_ROLE_ID) may sign in.
  // Each group gets a narrower set of actions enforced per-endpoint.
  const adminRoleId = env.ADMIN_ROLE_ID;
  const modRoleIds = parseRoleList(env.MOD_ROLE_IDS);
  const tournamentRoleIds = [env.TOURNAMENT_ADMIN_ROLE_ID, env.TOURNAMENT_STAFF_ROLE_ID].filter(Boolean);
  const memberRoles = member.roles || [];
  const isOfficer = adminRoleId && memberRoles.includes(adminRoleId);
  const isMod = modRoleIds.some(r => memberRoles.includes(r));
  const isTournamentStaff = tournamentRoleIds.some(r => memberRoles.includes(r));
  if (adminRoleId && !isOfficer && !isMod && !isTournamentStaff) {
    return Response.redirect(`${adminUrl}/?error=not_authorized`, 302);
  }

  const secret = env.JWT_SECRET;
  if (!secret) return new Response('JWT_SECRET not configured', { status: 500 });

  const payload = {
    sub: user.id,
    username: user.username,
    displayName: user.global_name || user.username,
    roles: memberRoles,
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
  if (request.method === 'GET') {
    const session = await requireAuth(request, env);
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
      session: {
        userId: session.sub,
        displayName: session.displayName || session.username,
        tier: getTier(session, env),
      },
    });
  }

  if (request.method === 'PUT') {
    await requireOfficer(request, env);
    const body = await request.json();
    let cacheDirty = false;

    if (body.role_ids != null) {
      await env.CONFIG.put('role_ids', JSON.stringify(body.role_ids));
      cacheDirty = true;
    }

    if ('default_role_id' in body) {
      // Normalize: enabled role IDs or the "random" sentinel win;
      // "all" / null / unknown role → cleared.
      const next = body.default_role_id;
      if (next === 'random') {
        await env.CONFIG.put('default_role_id', 'random');
      } else {
        const roleIdsRaw = body.role_ids != null
          ? body.role_ids
          : JSON.parse((await env.CONFIG.get('role_ids')) || '[]');
        const enabled = new Set(roleIdsRaw);
        if (next && next !== 'all' && enabled.has(next)) {
          await env.CONFIG.put('default_role_id', next);
        } else {
          await env.CONFIG.delete('default_role_id');
        }
      }
      cacheDirty = true;
    }

    if (cacheDirty) await env.CACHE.delete(`members_${env.GUILD_ID}`);
    return jsonResponse({ ok: true });
  }

  return methodNotAllowed();
}

export async function handleAdminRoles(request, env) {
  await requireOfficer(request, env);

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
  const session = await requireOfficer(request, env);
  const url = new URL(request.url);

  const guildId = env.GUILD_ID;
  const roleIdsRaw = await env.CONFIG.get('role_ids');
  const roleIds = roleIdsRaw ? JSON.parse(roleIdsRaw) : [];

  const [{ members, roles, totalMembers, fetchedAt }, optedOutMap] = await Promise.all([
    roleIds.length
      ? fetchGuildMembers(env, guildId, roleIds)
      : Promise.resolve({ members: [], roles: [], totalMembers: 0, fetchedAt: new Date().toISOString() }),
    memberOptOuts.getAll(env),
  ]);

  const enriched = members.map(m => ({ ...m, optedOut: !!optedOutMap[m.id] }));

  // CSV export
  if (url.searchParams.get('format') === 'csv') {
    const lines = ['displayName,username,roles,optedOut'];
    enriched.forEach(m => {
      const roleNames = m.roles
        .map(id => roles.find(r => r.id === id)?.name || id)
        .join('; ');
      lines.push(`"${m.displayName}","${m.username}","${roleNames}","${m.optedOut ? 'yes' : ''}"`);
    });
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="members-${guildId}.csv"`,
      },
    });
  }

  return jsonResponse({ members: enriched, roles, totalMembers, fetchedAt });
}

/**
 * Opt-outs from the public Members section.
 *   GET /api/admin/members/opt-outs                → { optOuts: { id: {...} } }
 *   PUT /api/admin/members/opt-outs/{discordId}    body { optedOut: bool }
 *
 * The public site lists every member with a configured role by default; this
 * map carves out individuals who've asked to be hidden (officer-toggled here
 * or self-toggled via /toggle-public-membership). Officer-gated.
 */
export async function handleAdminMemberOptOuts(request, env) {
  const session = await requireOfficer(request, env);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // /api/admin/members/opt-outs              → no targetId
  // /api/admin/members/opt-outs/{discordId}  → parts[4]
  const targetId = parts[4] ? safeDecode(parts[4]) : null;

  if (request.method === 'GET' && !targetId) {
    return jsonResponse({ optOuts: await memberOptOuts.getAll(env) });
  }

  if (request.method === 'PUT' && targetId) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    if (typeof body?.optedOut !== 'boolean') {
      return jsonResponse({ error: 'Body must be { optedOut: boolean }' }, 400);
    }
    if (body.optedOut) {
      const record = await memberOptOuts.setOptedOut(env, targetId, {
        source: 'officer',
        actorId: session.sub,
        actorName: session.displayName || session.username || session.sub,
      });
      return jsonResponse({ ok: true, optedOut: true, record });
    }
    await memberOptOuts.clearOptedOut(env, targetId);
    return jsonResponse({ ok: true, optedOut: false });
  }

  return methodNotAllowed();
}

export async function handleAdminOfficers(request, env) {
  const session = await requireOfficer(request, env);
  return handleCrudCollection(request, env, 'officers');
}

export async function handleAdminEvents(request, env) {
  const session = await requireTournamentAdmin(request, env);
  return handleCrudCollection(request, env, 'events');
}

export async function handleAdminDiscordEvents(request, env) {
  const session = await requireTournamentAdmin(request, env);
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
  const session = await requireOfficer(request, env);

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

// ─── Daily-games grader ─────────────────────────────────────────────────────

/**
 * GET  /api/admin/grader        → { config, defaults, parserTypes, legendKeys,
 *                                 extractorKinds, ruleOps, presets }
 * PUT  /api/admin/grader        → body: { legend, boards }; full replace
 * POST /api/admin/grader/test   → body: { content }; runs current config
 *                                 against the content and returns the grade
 *                                 (or null if nothing matches).
 *
 * Mod-or-officer gated — the user explicitly asked for mods to be able to
 * manage boards + legend.
 */
export async function handleAdminGrader(request, env) {
  await requireMod(request, env);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin','grader', maybe 'test']
  const action = parts[3] || null;

  if (request.method === 'GET' && !action) {
    const config = await loadGraderConfig(env);
    return jsonResponse({
      config,
      defaults: DEFAULT_GRADER_CONFIG,
      parserTypes: PARSER_TYPES,
      legendKeys: LEGEND_KEYS,
      extractorKinds: EXTRACTOR_KINDS,
      ruleOps: RULE_OPS,
      presets: BOARD_PRESETS,
    });
  }

  if (request.method === 'PUT' && !action) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const result = validateGraderConfig(body);
    if (!result.ok) return jsonResponse({ error: result.error }, 400);
    await saveGraderConfig(env, result.config);
    return jsonResponse({ ok: true, config: result.config });
  }

  if (request.method === 'POST' && action === 'test') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const content = typeof body?.content === 'string' ? body.content : '';
    // If the caller sent a draft config along with the test, use it; otherwise
    // run against the saved config. Lets the SPA preview edits before saving.
    let config;
    if (body?.config) {
      const result = validateGraderConfig(body.config);
      if (!result.ok) return jsonResponse({ error: result.error }, 400);
      config = result.config;
    } else {
      config = await loadGraderConfig(env);
    }
    const grade = gradeMessage(content, config);
    return jsonResponse({ grade });
  }

  return methodNotAllowed();
}

/**
 * GET /api/admin/emojis → { emojis: [{id, name, animated, available, url}] }
 *
 * Read-only view of the guild's custom emojis as the bot sees them. Useful
 * when editing the grader legend, since reaction strings for custom emoji
 * are `name:id` and aren't otherwise obvious. Mod-or-officer gated.
 */
export async function handleAdminEmojis(request, env) {
  await requireMod(request, env);
  if (request.method !== 'GET') return methodNotAllowed();

  const guildId = env.GUILD_ID;
  if (!guildId) return jsonResponse({ error: 'GUILD_ID not configured' }, 500);

  let emojis;
  try {
    emojis = await fetchGuildEmojis(env, guildId);
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }

  const out = emojis
    .filter(e => e.id)
    .map(e => ({
      id: e.id,
      name: e.name,
      animated: !!e.animated,
      available: e.available !== false,
      reaction: `${e.name}:${e.id}`,
      url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=48&quality=lossless`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return jsonResponse({ emojis: out });
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
  const session = await requireOfficer(request, env);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin','streamers', maybe id, maybe action]
  // url.pathname doesn't decode percent-escapes — synthetic IDs like
  // `official:<twitchUserId>` arrive as `official%3A<id>`, so decode here
  // before using as a KV key.
  const targetId = parts[3] ? safeDecode(parts[3]) : null;
  const action = parts[4] || null;

  if (request.method === 'GET' && !targetId) {
    const map = await streamerRegistry.getAll(env);
    const records = Object.values(map).sort(
      (a, b) => (a.displayName || '').localeCompare(b.displayName || ''),
    );
    return jsonResponse({ streamers: records });
  }

  // POST /api/admin/streamers/official  body { twitchLogin }
  if (request.method === 'POST' && targetId === 'official' && !action) {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const twitchLogin = (body?.twitchLogin || '').trim();
    if (!twitchLogin) return jsonResponse({ error: 'twitchLogin is required' }, 400);
    const workerOrigin = `${url.protocol}//${url.host}`;
    const result = await registerOfficialStreamer(env, { twitchLogin, workerOrigin });
    if (!result.ok) return jsonResponse({ error: result.error }, 400);
    return jsonResponse({ ok: true, streamer: result.record });
  }

  if (request.method === 'POST' && targetId && action === 'test-live') {
    const result = await postLiveAnnouncementTest(env, targetId);
    if (!result.ok) return jsonResponse({ error: result.error }, 400);
    return jsonResponse({ ok: true });
  }

  if (request.method === 'DELETE' && targetId && !action) {
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

/**
 * GET  /api/admin/statbot/status  → status panel data (API key set? last/next
 *   run? target channels?). Cheap; does NOT hit the Statbot API.
 * GET  /api/admin/statbot/preview → fetches the three Statbot datasets for the
 *   current windows and returns raw JSON without posting. Useful for inspecting
 *   the live response shapes before tuning the embed, and to drive the SPA's
 *   in-page embed preview.
 * POST /api/admin/statbot/run     → fires the daily report immediately (ignores
 *   the 18:00-Central gate and the last-run guard) and posts to both channels.
 *   The KV last-run-date is NOT updated, so the scheduled run still happens
 *   today at 18:00 Central if you preview-test in the morning.
 */
export async function handleAdminStatbot(request, env) {
  await requireOfficer(request, env);
  const url = new URL(request.url);
  const action = url.pathname.split('/').filter(Boolean)[3] || null;

  if (request.method === 'GET' && action === 'status') {
    const [lastRunDate, savedTargets] = await Promise.all([
      env.CONFIG.get('statbot_last_run_date'),
      env.CONFIG.get('statbot_channel_targets'),
    ]);
    const allConfigured = [env.BOT_LOGS_CHANNEL_ID, env.BOT_COMMANDS_CHANNEL_ID].filter(Boolean);
    const enabledChannelIds = savedTargets
      ? JSON.parse(savedTargets).filter(id => allConfigured.includes(id))
      : allConfigured;
    return jsonResponse({
      apiKeyConfigured: !!env.STATBOT_API_KEY,
      lastRunDate: lastRunDate || null,
      nextRunLabel: nextRunLabelCentral(lastRunDate),
      centralNow: formatCentralNow(),
      logsChannelId: env.BOT_LOGS_CHANNEL_ID || null,
      commandsChannelId: env.BOT_COMMANDS_CHANNEL_ID || null,
      enabledChannelIds,
    });
  }

  if (request.method === 'PUT' && action === 'channels') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const allConfigured = [env.BOT_LOGS_CHANNEL_ID, env.BOT_COMMANDS_CHANNEL_ID].filter(Boolean);
    const enabled = (body.enabledChannelIds || []).filter(id => allConfigured.includes(id));
    await env.CONFIG.put('statbot_channel_targets', JSON.stringify(enabled));
    return jsonResponse({ ok: true, enabledChannelIds: enabled });
  }

  if (!env.STATBOT_API_KEY) {
    return jsonResponse({ error: 'STATBOT_API_KEY not configured (set via `wrangler secret put STATBOT_API_KEY`)' }, 500);
  }

  if (request.method === 'GET' && action === 'preview') {
    const { embed, repPromptEmbed, raw } = await buildDailyReport(env);
    return jsonResponse({ embed, repPromptEmbed, ...raw });
  }

  if (request.method === 'POST' && action === 'run') {
    const result = await runDailyStatbotReport(env);
    return jsonResponse(result);
  }

  return methodNotAllowed();
}

// ─── Welcome DM ─────────────────────────────────────────────────────────────

/**
 * GET  /api/admin/welcome  → { enabled, message, snapshotSize, bootstrapped }
 * PUT  /api/admin/welcome  → body: { enabled?, message? }  (partial update)
 */
export async function handleAdminWelcome(request, env) {
  await requireOfficer(request, env);

  if (request.method === 'GET') {
    const [rawConfig, rawSnapshot] = await Promise.all([
      env.CONFIG.get('welcome_config'),
      env.CONFIG.get('welcome_member_snapshot'),
    ]);
    const config = rawConfig ? JSON.parse(rawConfig) : {};
    return jsonResponse({
      enabled: config.enabled !== false,
      message: config.message || DEFAULT_WELCOME_MESSAGE,
      snapshotSize: rawSnapshot ? JSON.parse(rawSnapshot).length : null,
      bootstrapped: rawSnapshot !== null,
    });
  }

  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const rawConfig = await env.CONFIG.get('welcome_config');
    const existing = rawConfig ? JSON.parse(rawConfig) : {};
    const updated = {
      ...existing,
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.message === 'string' && body.message.trim() ? { message: body.message } : {}),
    };
    await env.CONFIG.put('welcome_config', JSON.stringify(updated));
    return jsonResponse({ ok: true, ...updated });
  }

  return methodNotAllowed();
}

// ─── Central-time helpers (status endpoint) ────────────────────────────────
//
// Kept local to admin.js — the daily scheduler has its own copies. Duplication
// is cheap; sharing across worker modules would require a new utility file
// without much payoff.

function centralPartsCentral(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return parts;
}

function addCentralDay(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y2 = dt.getUTCFullYear();
  const m2 = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d2 = String(dt.getUTCDate()).padStart(2, '0');
  return `${y2}-${m2}-${d2}`;
}

function formatCentralLong(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function nextRunLabelCentral(lastRunDate) {
  const p = centralPartsCentral();
  const today = `${p.year}-${p.month}-${p.day}`;
  const hour = parseInt(p.hour, 10);
  if (lastRunDate === today) {
    return `Tomorrow (${formatCentralLong(addCentralDay(today, 1))}) at 6:00 PM Central`;
  }
  if (hour < 18) {
    return `Today (${formatCentralLong(today)}) at 6:00 PM Central`;
  }
  return `Pending — will fire on the next cron tick (within 1 minute)`;
}

function formatCentralNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return fmt.format(new Date());
}

// ─── Tournament ──────────────────────────────────────────────────────────────

/**
 * GET  /api/admin/tournament                      → { tournaments, apiKeys, channels }
 * POST /api/admin/tournament/:platform/:id/announce → post announcement
 * POST /api/admin/tournament/:platform/:id/live     → start live updates
 * POST /api/admin/tournament/:platform/:id/end      → end live updates
 * DELETE /api/admin/tournament/:platform/:id        → remove KV state
 */
export async function handleAdminTournament(request, env) {
  await requireTournamentStaff(request, env);

  const url = new URL(request.url);
  // path: /api/admin/tournament[/:platform[/:id[/action]]]
  const parts = url.pathname.split('/').filter(Boolean);
  // parts: ['api','admin','tournament', platform?, id?, action?]
  const platform = parts[3] || null;
  const tournamentId = parts[4] || null;
  const action = parts[5] || null;

  if (request.method === 'GET' && !platform) {
    const list = await env.CONFIG.list({ prefix: 'tournament:state:' }).catch(() => ({ keys: [] }));
    let tournaments = await Promise.all(
      list.keys.map(k => env.CONFIG.get(k.name, 'json').catch(() => null)),
    ).then(states => states.filter(Boolean));

    const staleKeys = await pruneStaleTournaments(env, tournaments);
    if (staleKeys.length) {
      await Promise.all(staleKeys.map(k => env.CONFIG.delete(k).catch(() => {})));
      const pruned = new Set(staleKeys);
      tournaments = tournaments.filter(t => !pruned.has(buildStateKey(t.platform, t.tournamentId)));
    }

    return jsonResponse({
      apiKeys: {
        matchplay: !!env.MATCHPLAY_API_KEY,
        challonge: !!env.CHALLONGE_API_KEY,
      },
      defaults: {
        matchplayTournamentId: env.MATCHPLAY_TOURNAMENT_ID || null,
        challongeTournamentId: env.CHALLONGE_TOURNAMENT_ID || null,
        matchplayOrganizerId: env.MATCHPLAY_ORGANIZER_ID || null,
      },
      notificationsChannelId: env.TOURNAMENT_NOTIFICATIONS_CHANNEL_ID || null,
      tournaments,
    });
  }

  // Discover open tournaments across all configured platforms.
  if (platform === 'discover') {
    if (request.method !== 'GET') return methodNotAllowed();
    const tournaments = await getOpenTournaments(env).catch(() => []);
    return jsonResponse({ tournaments });
  }

  // Organizer management — separate sub-resource, not a platform action.
  // Routes: /api/admin/tournament/organizers/matchplay[/:id]
  if (platform === 'organizers') {
    return handleAdminTournamentOrganizers(request, env, parts);
  }

  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return jsonResponse({ error: 'Invalid or missing platform. Use matchplay or challonge.' }, 400);
  }
  if (!tournamentId) return jsonResponse({ error: 'Missing tournament ID.' }, 400);

  if (request.method === 'POST' && action === 'announce') {
    const result = await announceTournament(env, platform, tournamentId);
    return result.ok
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: false, error: result.error }, 500);
  }

  if (request.method === 'POST' && action === 'live') {
    const result = await startLiveTournament(env, platform, tournamentId);
    return result.ok
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: false, error: result.error, alreadyActive: result.alreadyActive ?? false }, result.alreadyActive ? 409 : 500);
  }

  if (request.method === 'POST' && action === 'end') {
    const result = await endTournament(env, platform, tournamentId);
    return result.ok
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: false, error: result.error, notRunning: result.notRunning ?? false }, result.notRunning ? 409 : 500);
  }

  if (request.method === 'DELETE' && !action) {
    await env.CONFIG.delete(buildStateKey(platform, tournamentId));
    return jsonResponse({ ok: true });
  }

  return methodNotAllowed();
}

// ─── Tournament organizers ────────────────────────────────────────────────────

/**
 * GET    /api/admin/tournament/organizers/matchplay         → { ids: string[] }
 * POST   /api/admin/tournament/organizers/matchplay         → body: { id } → { ids }
 * DELETE /api/admin/tournament/organizers/matchplay/:id     → { ids }
 *
 * The stored list is the source of truth. The MATCHPLAY_ORGANIZER_ID env var
 * is only used as a fallback when the KV list is empty (bootstrap seed).
 */
async function handleAdminTournamentOrganizers(request, env, parts) {
  // parts: ['api','admin','tournament','organizers', platform?, organizerId?]
  const subPlatform = parts[4] || null;
  const organizerId = parts[5] ? safeDecode(parts[5]) : null;

  if (subPlatform !== 'matchplay') {
    return jsonResponse({ error: 'Only matchplay organizers are supported.' }, 400);
  }

  const ids = await getMatchPlayOrganizerIds(env);

  if (request.method === 'GET') {
    return jsonResponse({ ids });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const newId = String(body.id || '').trim();
    if (!newId) return jsonResponse({ error: 'id is required' }, 400);
    if (ids.includes(newId)) return jsonResponse({ ids }); // already present — idempotent
    const updated = [...ids, newId];
    await env.CONFIG.put(MATCHPLAY_ORGANIZERS_KEY, JSON.stringify(updated));
    return jsonResponse({ ids: updated });
  }

  if (request.method === 'DELETE' && organizerId) {
    const updated = ids.filter(id => id !== organizerId);
    await env.CONFIG.put(MATCHPLAY_ORGANIZERS_KEY, JSON.stringify(updated));
    return jsonResponse({ ids: updated });
  }

  return methodNotAllowed();
}

// ─── Twitch management ───────────────────────────────────────────────────────

/**
 * GET  /api/admin/twitch/status               → secrets, token health, all EventSub subs, streamers
 * POST /api/admin/twitch/sync                 → re-create missing/broken EventSub subs for all streamers
 * DELETE /api/admin/twitch/subscriptions/:id  → delete a specific EventSub subscription
 */
export async function handleAdminTwitch(request, env) {
  await requireOfficer(request, env);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const action = parts[3] || null;     // 'status' | 'sync' | 'subscriptions' | 'test-announce'
  const subId   = parts[4] ? safeDecode(parts[4]) : null;

  // GET /api/admin/twitch/status
  if (request.method === 'GET' && action === 'status') {
    const secrets = {
      client_id:      !!(env.TWITCH_CLIENT_ID),
      client_secret:  !!(env.TWITCH_CLIENT_SECRET),
      eventsub_secret: !!(env.TWITCH_EVENTSUB_SECRET),
    };

    let token = { ok: false, error: null };
    let subsResult = { ok: false, error: null, subs: [], total_cost: null, max_total_cost: null };

    if (secrets.client_id && secrets.client_secret) {
      try {
        await getAppToken(env);
        token = { ok: true, error: null };
        subsResult = await listAllSubscriptions(env);
      } catch (err) {
        token = { ok: false, error: err.message };
      }
    } else {
      token = { ok: false, error: 'TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET not configured' };
    }

    const allStreamers = await streamerRegistry.getAll(env);
    const twitchStreamers = Object.values(allStreamers).filter(s => s.twitch?.userId);

    return jsonResponse({
      secrets,
      token,
      live_announce_channel_id: env.LIVE_ANNOUNCE_CHANNEL_ID || null,
      subscriptions: subsResult.subs || [],
      subscriptions_error: subsResult.error || null,
      total_cost: subsResult.total_cost ?? null,
      max_total_cost: subsResult.max_total_cost ?? null,
      streamers: twitchStreamers,
    });
  }

  // POST /api/admin/twitch/sync
  if (request.method === 'POST' && action === 'sync') {
    const workerOrigin = getOrigin(request);
    const callbackUrl = `${workerOrigin}/api/twitch/eventsub`;

    let activeSubs = [];
    try {
      const result = await listAllSubscriptions(env);
      if (result.ok) activeSubs = result.subs;
    } catch (err) {
      return jsonResponse({ ok: false, error: `Failed to list subscriptions: ${err.message}` }, 502);
    }
    const activeSubIds = new Set(activeSubs.map(s => s.id));

    const allStreamers = await streamerRegistry.getAll(env);
    const twitchStreamers = Object.values(allStreamers).filter(s => s.twitch?.userId);

    const synced = [];
    const errors = [];

    for (const streamer of twitchStreamers) {
      const { userId } = streamer.twitch;
      const current = streamer.twitch.eventSubIds || {};
      let online  = current.online;
      let offline = current.offline;
      let changed = false;

      if (!online || !activeSubIds.has(online)) {
        const newId = await createSubscription(env, 'stream.online', userId, callbackUrl);
        if (newId) { online = newId; changed = true; }
        else errors.push({ discordId: streamer.discordId, type: 'stream.online', error: 'createSubscription returned null' });
      }

      if (!offline || !activeSubIds.has(offline)) {
        const newId = await createSubscription(env, 'stream.offline', userId, callbackUrl);
        if (newId) { offline = newId; changed = true; }
        else errors.push({ discordId: streamer.discordId, type: 'stream.offline', error: 'createSubscription returned null' });
      }

      if (changed) {
        await streamerRegistry.upsert(env, {
          ...streamer,
          twitch: { ...streamer.twitch, eventSubIds: { online, offline } },
        });
        synced.push({ discordId: streamer.discordId, login: streamer.twitch.login, online, offline });
      }
    }

    return jsonResponse({ ok: true, synced, errors });
  }

  // DELETE /api/admin/twitch/subscriptions/:id
  if (request.method === 'DELETE' && action === 'subscriptions' && subId) {
    const ok = await deleteSubscription(env, subId);
    if (!ok) return jsonResponse({ ok: false, error: `Failed to delete subscription ${subId}` }, 502);
    return jsonResponse({ ok: true });
  }

  // POST /api/admin/twitch/test-announce — test-post a suppressed embed to LIVE_ANNOUNCE_CHANNEL_ID
  if (request.method === 'POST' && action === 'test-announce') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const discordId = body?.discordId;
    if (!discordId) return jsonResponse({ error: 'discordId is required' }, 400);
    const result = await postLiveAnnouncementChannelTest(env, discordId);
    return jsonResponse(result, result.ok ? 200 : 502);
  }

  return methodNotAllowed();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

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
