/**
 * Discord interactions endpoint. Verifies Ed25519 signatures, then dispatches
 * by interaction type. All slow paths defer (type 5/6) and finish in
 * ctx.waitUntil so we hit Discord's 3-second response deadline.
 */

import {
  verifyDiscordRequest,
  jsonResponse,
  INTERACTION_TYPE,
  RESPONSE_TYPE,
  FLAGS,
} from '../discord-interactions.js';
import { getDiscordEventsWithArchive, getOverlays } from '../discord-events.js';
import {
  postChannelMessage,
  editOriginalInteractionResponse,
} from '../discord-outbound.js';
import * as requests from '../event-publish-requests.js';
import { buildOAuthUrl } from '../auth.js';
import {
  buildStreamAuthState,
  unregisterStreamer,
  postRemovalAuditLog,
} from './streamers.js';
import * as streamerRegistry from '../streamers.js';
import * as memberOptOuts from '../member-opt-outs.js';
import { buildBombPayload } from '../parrotbomb.js';

export async function handleInteractions(request, env, ctx) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const verified = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!verified.ok) {
    return new Response('invalid request signature', { status: 401 });
  }

  const interaction = verified.json;

  switch (interaction.type) {
    case INTERACTION_TYPE.PING:
      return jsonResponse({ type: RESPONSE_TYPE.PONG });

    case INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE:
      return handleAutocomplete(interaction, env);

    case INTERACTION_TYPE.APPLICATION_COMMAND:
      return handleCommand(interaction, env, ctx);

    case INTERACTION_TYPE.MESSAGE_COMPONENT:
      return handleComponent(interaction, env, ctx);

    default:
      return jsonResponse({ error: 'unknown interaction type' }, 400);
  }
}

// ─── Autocomplete ────────────────────────────────────────────────────────────

async function handleAutocomplete(interaction, env) {
  if (interaction.data?.name === 'request-event-publish') {
    return autocompleteRequestEventPublish(interaction, env);
  }
  return jsonResponse({ type: RESPONSE_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } });
}

async function autocompleteRequestEventPublish(interaction, env) {
  const focused = (interaction.data.options || []).find(o => o.focused);
  const query = (focused?.value || '').toLowerCase();

  let events = [];
  try {
    const { live } = await getDiscordEventsWithArchive(env);
    events = live;
  } catch {
    events = [];
  }
  const overlays = await getOverlays(env).catch(() => ({}));
  const pending = await requests.getPending(env).catch(() => []);
  const pendingEventIds = new Set(pending.map(r => r.eventId));

  const choices = events
    .filter(e => e.status === 'SCHEDULED' || e.status === 'ACTIVE')
    .filter(e => !overlays[e.id]?.published)
    .filter(e => !pendingEventIds.has(e.id))
    .filter(e => !query || e.title.toLowerCase().includes(query))
    .slice(0, 25)
    .map(e => ({
      name: truncate(`${e.title} · ${formatDate(e.startTime)}`, 100),
      value: e.id,
    }));

  return jsonResponse({
    type: RESPONSE_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  });
}

// ─── Slash command ───────────────────────────────────────────────────────────

async function handleCommand(interaction, env, ctx) {
  switch (interaction.data?.name) {
    case 'request-event-publish':
      return commandRequestEventPublish(interaction, env, ctx);
    case 'register-stream':
      return commandRegisterStream(interaction, env, ctx);
    case 'unregister-stream':
      return commandUnregisterStream(interaction, env, ctx);
    case 'parrotbomb':
      return commandParrotBomb(interaction, env, ctx);
    case 'streamer-list':
      return commandStreamerList(interaction, env, ctx);
    case 'streamer-remove':
      return commandStreamerRemove(interaction, env, ctx);
    case 'toggle-public-membership':
      return commandTogglePublicMembership(interaction, env);
    default:
      return ephemeralReply('Unknown command.');
  }
}

/**
 * Mod-tier permission check used by /streamer-list and /streamer-remove.
 * Passes if the actor holds any role in MOD_ROLE_IDS or holds ADMIN_ROLE_ID
 * (officers always qualify — no need to duplicate them in MOD_ROLE_IDS).
 */
function actorIsMod(interaction, env) {
  const memberRoles = interaction.member?.roles || [];
  const modRoles = parseRoleList(env.MOD_ROLE_IDS);
  if (env.ADMIN_ROLE_ID && memberRoles.includes(env.ADMIN_ROLE_ID)) return true;
  return memberRoles.some(r => modRoles.includes(r));
}

async function commandRequestEventPublish(interaction, env, ctx) {
  const memberRoles = interaction.member?.roles || [];
  const allowedRoles = parseRoleList(env.REQUESTER_ROLE_IDS);
  if (!allowedRoles.length) {
    return ephemeralReply('Event publishing is not configured. Ping a developer.');
  }
  if (!memberRoles.some(r => allowedRoles.includes(r))) {
    return ephemeralReply('You don\'t have permission to request event publishing.');
  }

  const eventId = (interaction.data.options || []).find(o => o.name === 'event')?.value;
  if (!eventId) return ephemeralReply('Pick an event from the autocomplete options.');

  // Validate up front (fast path) — defer slow work.
  let event;
  try {
    const { live } = await getDiscordEventsWithArchive(env);
    event = live.find(e => e.id === eventId);
  } catch {
    return ephemeralReply('Couldn\'t reach Discord. Try again in a moment.');
  }
  if (!event) return ephemeralReply('That event no longer exists.');
  if (event.status !== 'SCHEDULED' && event.status !== 'ACTIVE') {
    return ephemeralReply('That event isn\'t schedulable for publishing.');
  }
  const overlays = await getOverlays(env);
  if (overlays[eventId]?.published) {
    return ephemeralReply('That event is already on the website.');
  }
  const existingPending = await requests.getPendingByEventId(env, eventId);
  if (existingPending) {
    return ephemeralReply('A request for that event is already pending — an officer will review it.');
  }

  // Defer and finish the work in waitUntil.
  ctx.waitUntil(submitRequestPipeline(interaction, env, event));

  return jsonResponse({
    type: RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE,
    data: { flags: FLAGS.EPHEMERAL },
  });
}

async function submitRequestPipeline(interaction, env, event) {
  const requesterUser = interaction.member?.user || interaction.user;
  const requestedBy = {
    id: requesterUser?.id,
    username: requesterUser?.username,
    displayName: interaction.member?.nick || requesterUser?.global_name || requesterUser?.username,
  };

  const channelId = env.OFFICERS_CHANNEL_ID;
  if (!channelId) {
    return editOriginal(interaction, env, '⚠️ Officers channel not configured. Ping a developer.');
  }

  // Channel post is load-bearing — if it fails, don't persist the request.
  const reqId = interaction.id;
  const messagePayload = buildOfficersMessage(reqId, event, requestedBy);
  const post = await postChannelMessage(env, channelId, messagePayload);

  if (!post.ok || !post.json?.id) {
    const detail = post.status
      ? `HTTP ${post.status}${post.json?.message ? ` — ${post.json.message}` : ''}`
      : 'no response';
    return editOriginal(
      interaction,
      env,
      `⚠️ Couldn't notify officers (${detail}). Check that the bot has View Channel + Send Messages + Embed Links in <#${channelId}>.`,
    );
  }

  try {
    await requests.create(env, {
      id: reqId,
      eventId: event.id,
      requestedBy,
      channelId,
      channelMessageId: post.json.id,
    });
  } catch (err) {
    console.error('event-publish-requests: create failed', err);
    return editOriginal(interaction, env, '⚠️ Request couldn\'t be saved — ping a developer.');
  }

  return editOriginal(interaction, env, '✓ Request submitted. An officer will review it.');
}

function buildOfficersMessage(reqId, event, requestedBy) {
  const start = event.startTime ? `<t:${Math.floor(new Date(event.startTime).getTime() / 1000)}:F>` : 'TBD';
  return {
    content: 'Event publish request',
    embeds: [{
      title: event.title,
      url: event.discordUrl,
      description: event.description ? truncate(event.description, 600) : undefined,
      fields: [
        { name: 'Start', value: start, inline: true },
        { name: 'Status', value: event.status, inline: true },
        { name: 'Requested by', value: requestedBy.displayName || requestedBy.username || requestedBy.id, inline: false },
      ].filter(f => f.value),
    }],
    components: [{
      type: 1, // action row
      components: [
        { type: 2, style: 3, label: 'Approve', custom_id: `evpub:approve:${reqId}:${event.id}` },
        { type: 2, style: 4, label: 'Deny', custom_id: `evpub:deny:${reqId}:${event.id}` },
      ],
    }],
  };
}

// ─── /register-stream ────────────────────────────────────────────────────────

async function commandRegisterStream(interaction, env) {
  const userId = (interaction.member?.user || interaction.user)?.id;
  if (!userId) return ephemeralReply('Couldn\'t identify you. Try again.');
  if (!env.DISCORD_CLIENT_ID || !env.JWT_SECRET) {
    return ephemeralReply('Streamer registration isn\'t configured. Ping a developer.');
  }

  // OAuth redirect URI must exactly match one registered in the Discord app
  // settings. Use the worker's stable custom domain — fall back to env override
  // if a future deployment moves origins.
  const origin = env.WORKER_ORIGIN || 'https://api.cspiregaming.com';
  const state = await buildStreamAuthState(env, userId, interaction.token);
  const authUrl = buildOAuthUrl(env, `${origin}/api/auth/stream-callback`, {
    scope: 'identify connections',
    state,
    prompt: 'consent',
  });

  const help = [
    '**Register as a streamer**',
    '',
    '1. In Discord: open **User Settings → Connections → Add** and connect your **Twitch** account (YouTube optional — saved now, live alerts coming later).',
    '2. Click the link below to authorize the bot to read your connections.',
    '3. The bot will give you the **@streamer** role and start watching for your channel to go live.',
    '',
    `🔗 **[Authorize bot](${authUrl})**  (link expires in 15 minutes)`,
    '',
    'Run `/unregister-stream` any time to opt back out.',
  ].join('\n');

  return ephemeralReply(help);
}

async function commandUnregisterStream(interaction, env, ctx) {
  const userId = (interaction.member?.user || interaction.user)?.id;
  if (!userId) return ephemeralReply('Couldn\'t identify you. Try again.');

  const existing = await streamerRegistry.getByDiscordId(env, userId);
  if (!existing) return ephemeralReply('You\'re not currently registered as a streamer.');

  ctx.waitUntil((async () => {
    await unregisterStreamer(env, userId);
    await editOriginal(interaction, env, '✓ Unregistered. The @streamer role and live alerts have been removed.');
  })());

  return jsonResponse({
    type: RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE,
    data: { flags: FLAGS.EPHEMERAL },
  });
}

// ─── /streamer-list (mod+) ───────────────────────────────────────────────────

async function commandStreamerList(interaction, env) {
  if (!actorIsMod(interaction, env)) {
    return ephemeralReply('Only mods and officers can run this command.');
  }
  const all = await streamerRegistry.getAll(env);
  const records = Object.values(all).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  if (!records.length) {
    return ephemeralReply('No streamers are currently registered.');
  }
  const cap = 25;
  const visible = records.slice(0, cap);
  const lines = visible.map(r => {
    const tw = r.twitch ? `Twitch: \`${r.twitch.login}\`` : null;
    const yt = r.youtube ? `YouTube: \`${r.youtube.name}\`` : null;
    const platforms = [tw, yt].filter(Boolean).join(' · ') || 'no platforms';
    const subject = r.isOfficial
      ? `**${r.displayName || r.discordUsername}** *(official)*`
      : `<@${r.discordId}>`;
    return `• ${subject} — ${platforms}`;
  });
  if (records.length > cap) {
    lines.push(`…and ${records.length - cap} more.`);
  }
  return ephemeralReply(`**Registered streamers (${records.length})**\n\n${lines.join('\n')}`);
}

// ─── /streamer-remove (mod+) ─────────────────────────────────────────────────

async function commandStreamerRemove(interaction, env, ctx) {
  if (!actorIsMod(interaction, env)) {
    return ephemeralReply('Only mods and officers can run this command.');
  }

  const opts = interaction.data.options || [];
  const targetId = opts.find(o => o.name === 'user')?.value;
  const reason = (opts.find(o => o.name === 'reason')?.value || '').trim();

  if (!targetId) return ephemeralReply('Pick a user to deregister.');
  if (reason.length < 10) return ephemeralReply('Provide a reason (at least 10 characters).');

  const existing = await streamerRegistry.getByDiscordId(env, targetId);
  if (!existing) {
    return ephemeralReply(`<@${targetId}> isn't currently registered as a streamer.`);
  }

  const actor = interaction.member?.user || interaction.user;
  const actorName = interaction.member?.nick || actor?.global_name || actor?.username || actor?.id;

  // Capture the platform info before unregistering — the helper drops the KV
  // record before returning, so we'd lose it for the audit log.
  const removed = {
    twitchLogin: existing.twitch?.login || null,
    youtubeName: existing.youtube?.name || null,
    targetName: existing.displayName || existing.discordUsername || targetId,
  };

  ctx.waitUntil((async () => {
    await unregisterStreamer(env, targetId);
    await postRemovalAuditLog(env, {
      actorId: actor?.id,
      actorName,
      targetId,
      targetName: removed.targetName,
      twitchLogin: removed.twitchLogin,
      youtubeName: removed.youtubeName,
      reason,
    });
    await editOriginal(
      interaction,
      env,
      `✓ Deregistered <@${targetId}>. The audit log has been posted to the officers channel.`,
    );
  })());

  return jsonResponse({
    type: RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE,
    data: { flags: FLAGS.EPHEMERAL },
  });
}

// ─── /toggle-public-membership ───────────────────────────────────────────────

async function commandTogglePublicMembership(interaction, env) {
  const user = interaction.member?.user || interaction.user;
  const userId = user?.id;
  if (!userId) return ephemeralReply('Couldn\'t identify you. Try again.');

  const { optedOut } = await memberOptOuts.toggle(env, userId, {
    source: 'self',
    actorId: userId,
    actorName: interaction.member?.nick || user?.global_name || user?.username || userId,
  });

  const lines = [
    'The public C Spire Gaming member list is **opt-in by role**: if any of your Discord roles are configured to show on the site, you appear there by default. This command lets you opt yourself out (or back in).',
    '',
    optedOut
      ? '🚫 **You\'re now opted out.** Your card will disappear from https://cspiregaming.com within ~5 minutes (whenever the member cache refreshes).'
      : '✅ **You\'re now opted back in** (the default). Your card will reappear on https://cspiregaming.com within ~5 minutes.',
    '',
    'Run `/toggle-public-membership` again any time to flip back.',
  ];
  return ephemeralReply(lines.join('\n'));
}

// ─── /parrotbomb ─────────────────────────────────────────────────────────────

async function commandParrotBomb(interaction, env, ctx) {
  const user = interaction.member?.user || interaction.user;
  const displayName = interaction.member?.nick || user?.global_name || user?.username || 'someone';

  // Defer publicly, then fetch the parrot pool and replace the deferred reply
  // with the bomb payload (lead text as content, grid as an embed description
  // so the whole 9×9 fits in a single message).
  ctx.waitUntil((async () => {
    const payload = await buildBombPayload(env, displayName);
    await editOriginalInteractionResponse(env, interaction.application_id, interaction.token, payload);
  })());

  return jsonResponse({ type: RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE });
}

// ─── Button click ────────────────────────────────────────────────────────────

async function handleComponent(interaction, env, ctx) {
  const customId = interaction.data?.custom_id || '';
  if (!customId.startsWith('evpub:')) {
    return jsonResponse({ type: RESPONSE_TYPE.DEFERRED_UPDATE_MESSAGE });
  }

  const [, action, reqId, eventId] = customId.split(':');
  if (!action || !reqId || !eventId) {
    return ephemeralReply('Malformed button.');
  }

  const memberRoles = interaction.member?.roles || [];
  if (env.ADMIN_ROLE_ID && !memberRoles.includes(env.ADMIN_ROLE_ID)) {
    return ephemeralReply('Only officers can approve or deny.');
  }

  const decider = interaction.member?.user || interaction.user;
  const decidedBy = {
    id: decider?.id,
    displayName: interaction.member?.nick || decider?.global_name || decider?.username,
  };

  ctx.waitUntil(decidePipeline(interaction, env, reqId, action, decidedBy));

  return jsonResponse({ type: RESPONSE_TYPE.DEFERRED_UPDATE_MESSAGE });
}

async function decidePipeline(interaction, env, reqId, action, decidedBy) {
  const status = action === 'approve' ? 'approved' : 'denied';
  try {
    const result = await requests.applyDecision(env, reqId, status, decidedBy);
    if (result.error === 'not_found') {
      return editOriginalUpdate(interaction, env, '⚠️ Request not found.');
    }
    if (result.alreadyDecided) {
      const who = result.prior.decidedBy?.displayName || 'someone';
      return editOriginalUpdate(interaction, env, `Already ${result.prior.status} by ${who}.`);
    }
    // applyDecision already edited the channel message; nothing more to do.
  } catch (err) {
    console.error('decidePipeline error', err);
    return editOriginalUpdate(interaction, env, '⚠️ Decision failed — ping a developer.');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ephemeralReply(content) {
  return jsonResponse({
    type: RESPONSE_TYPE.CHANNEL_MESSAGE,
    data: { content, flags: FLAGS.EPHEMERAL },
  });
}

function editOriginal(interaction, env, content) {
  return editOriginalInteractionResponse(env, interaction.application_id, interaction.token, { content });
}

function editOriginalUpdate(interaction, env, content) {
  // For DEFERRED_UPDATE_MESSAGE follow-ups, editing @original updates the
  // message we deferred against (the channel post). Use a fresh ephemeral
  // followup instead so we don't clobber applyDecision's footer edit.
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, flags: FLAGS.EPHEMERAL }),
  });
}

function parseRoleList(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function formatDate(iso) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
  });
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
