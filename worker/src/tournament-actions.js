/**
 * Core tournament action functions shared between slash-command handlers and
 * admin API routes. Each takes (env, platform, tournamentId) and returns
 * { ok, error? } — callers translate to Discord responses or HTTP responses.
 *
 * KV key format: tournament:state:{platform}:{tournamentId}
 */

import { fetchTournamentPayloads, buildStateKey } from './tournament-platform.js';
import { postChannelMessage } from './discord-outbound.js';

/**
 * Post a registration announcement embed to #notifications.
 */
export async function announceTournament(env, platform, tournamentId) {
  const channelId = env.TOURNAMENT_NOTIFICATIONS_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TOURNAMENT_NOTIFICATIONS_CHANNEL_ID not configured.' };

  const payloads = await fetchTournamentPayloads(env, platform, tournamentId);
  if (!payloads) return { ok: false, error: `Couldn't reach ${platform}. Check the API key or try again.` };

  const payload = payloads.buildAnnouncement(payloads.registrationUrl);
  const post = await postChannelMessage(env, channelId, payload);
  if (!post.ok) return { ok: false, error: `Couldn't post announcement (HTTP ${post.status}).` };

  return { ok: true };
}

/**
 * Start live queue + leaderboard updates:
 *   - Validates the tournament isn't already active.
 *   - Fetches data from the platform API.
 *   - Posts initial queue + leaderboard messages to #notifications.
 *   - Saves state to CONFIG KV.
 */
export async function startLiveTournament(env, platform, tournamentId) {
  const channelId = env.TOURNAMENT_NOTIFICATIONS_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TOURNAMENT_NOTIFICATIONS_CHANNEL_ID not configured.' };

  const stateKey = buildStateKey(platform, tournamentId);
  const existing = await env.CONFIG.get(stateKey, 'json').catch(() => null);
  if (existing?.active) {
    return { ok: false, alreadyActive: true, error: `${platform}:${tournamentId} already has live updates running.` };
  }

  const payloads = await fetchTournamentPayloads(env, platform, tournamentId);
  if (!payloads) return { ok: false, error: `Couldn't reach ${platform}. Check the API key or try again.` };

  const queuePost = await postChannelMessage(env, channelId, payloads.queuePayload);
  const lbPost = await postChannelMessage(env, channelId, payloads.buildLeaderboard());

  const state = {
    platform,
    tournamentId,
    registrationUrl: payloads.registrationUrl,
    active: true,
    queueMessageId: queuePost.ok ? (queuePost.json?.id ?? null) : null,
    leaderboardMessageId: lbPost.ok ? (lbPost.json?.id ?? null) : null,
    standingsHash: payloads.standings ? JSON.stringify(payloads.standings) : null,
  };
  await env.CONFIG.put(stateKey, JSON.stringify(state));

  return { ok: true, channelId };
}

/**
 * End live updates for a tournament:
 *   - Fetches final standings from the platform API.
 *   - Posts a "Final Results" embed to #notifications.
 *   - Sets active: false in CONFIG KV.
 */
export async function endTournament(env, platform, tournamentId) {
  const channelId = env.TOURNAMENT_NOTIFICATIONS_CHANNEL_ID;
  const stateKey = buildStateKey(platform, tournamentId);

  const state = await env.CONFIG.get(stateKey, 'json').catch(() => null);
  if (!state?.active) {
    return { ok: false, notRunning: true, error: `${platform}:${tournamentId} doesn't have live updates running.` };
  }

  const payloads = await fetchTournamentPayloads(env, platform, tournamentId);
  if (payloads && channelId) {
    const finalPayload = payloads.buildLeaderboard();
    finalPayload.embeds[0].title = `🏆 Final Results — ${payloads.name}`;
    finalPayload.embeds[0].footer = { text: 'Tournament complete' };
    await postChannelMessage(env, channelId, finalPayload);
  }

  await env.CONFIG.put(stateKey, JSON.stringify({ ...state, active: false }));
  return { ok: true };
}
