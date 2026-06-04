/**
 * Core tournament action functions shared between the slash-command interaction
 * handlers and the admin API routes. Each returns { ok, error? } plus any
 * relevant output — callers translate to Discord responses or HTTP responses.
 */

import { getTournament, getStandings, getActiveGames } from './matchplay.js';
import {
  buildMaps,
  buildAnnouncementEmbed,
  buildQueueEmbed,
  buildLeaderboardEmbed,
  tournamentName,
} from './tournament.js';
import { postChannelMessage } from './discord-outbound.js';

export function resolveRegistrationUrl(env, tournamentId) {
  if (tournamentId === env.MATCHPLAY_TOURNAMENT_ID && env.MATCHPLAY_REGISTRATION_URL) {
    return env.MATCHPLAY_REGISTRATION_URL;
  }
  return `https://app.matchplay.events/tournaments/${tournamentId}`;
}

/**
 * Post a registration announcement embed to #notifications.
 * Returns { ok, error? }
 */
export async function announceTournament(env, tournamentId) {
  const channelId = env.TOURNAMENT_NOTIFICATIONS_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TOURNAMENT_NOTIFICATIONS_CHANNEL_ID not configured.' };

  const tournament = await getTournament(env, tournamentId);
  if (!tournament) return { ok: false, error: 'Couldn\'t reach MatchPlay. Check MATCHPLAY_API_KEY or try again.' };

  const registrationUrl = resolveRegistrationUrl(env, tournamentId);
  const payload = buildAnnouncementEmbed(tournament, registrationUrl);
  const post = await postChannelMessage(env, channelId, payload);
  if (!post.ok) return { ok: false, error: `Couldn't post announcement (HTTP ${post.status}).` };

  return { ok: true };
}

/**
 * Start live queue + leaderboard updates for a tournament:
 *   - Validates the tournament isn't already active.
 *   - Fetches data from MatchPlay.
 *   - Posts initial queue + leaderboard messages to #notifications.
 *   - Saves state to CONFIG KV at key `tournament:state:{tournamentId}`.
 *
 * Returns { ok, error?, alreadyActive? }
 */
export async function startLiveTournament(env, tournamentId) {
  const channelId = env.TOURNAMENT_NOTIFICATIONS_CHANNEL_ID;
  if (!channelId) return { ok: false, error: 'TOURNAMENT_NOTIFICATIONS_CHANNEL_ID not configured.' };

  const stateKey = `tournament:state:${tournamentId}`;
  const existing = await env.CONFIG.get(stateKey, 'json').catch(() => null);
  if (existing?.active) return { ok: false, alreadyActive: true, error: `Tournament ${tournamentId} already has live updates running.` };

  const [tournament, standings, games] = await Promise.all([
    getTournament(env, tournamentId),
    getStandings(env, tournamentId),
    getActiveGames(env, tournamentId),
  ]);
  if (!tournament) return { ok: false, error: 'Couldn\'t reach MatchPlay. Check MATCHPLAY_API_KEY or try again.' };

  const { playerMap, arenaMap } = buildMaps(tournament);
  const name = tournamentName(tournament);

  const queuePost = await postChannelMessage(env, channelId, buildQueueEmbed(games, playerMap, arenaMap));
  const lbPost = await postChannelMessage(env, channelId, buildLeaderboardEmbed(standings, playerMap, name));

  const state = {
    tournamentId,
    registrationUrl: resolveRegistrationUrl(env, tournamentId),
    active: true,
    queueMessageId: queuePost.ok ? (queuePost.json?.id ?? null) : null,
    leaderboardMessageId: lbPost.ok ? (lbPost.json?.id ?? null) : null,
    standingsHash: standings ? JSON.stringify(standings) : null,
  };
  await env.CONFIG.put(stateKey, JSON.stringify(state));

  return { ok: true, channelId };
}

/**
 * End live updates for a tournament:
 *   - Fetches final standings from MatchPlay.
 *   - Posts a "Final Results" embed to #notifications.
 *   - Sets active: false in CONFIG KV.
 *
 * Returns { ok, error?, notRunning? }
 */
export async function endTournament(env, tournamentId) {
  const channelId = env.TOURNAMENT_NOTIFICATIONS_CHANNEL_ID;
  const stateKey = `tournament:state:${tournamentId}`;

  const state = await env.CONFIG.get(stateKey, 'json').catch(() => null);
  if (!state?.active) return { ok: false, notRunning: true, error: `Tournament ${tournamentId} doesn't have live updates running.` };

  const [tournament, standings] = await Promise.all([
    getTournament(env, tournamentId),
    getStandings(env, tournamentId),
  ]);

  if (standings && channelId) {
    const { playerMap } = tournament ? buildMaps(tournament) : { playerMap: {} };
    const name = tournament ? tournamentName(tournament) : `Tournament ${tournamentId}`;
    const finalPayload = buildLeaderboardEmbed(standings, playerMap, name);
    finalPayload.embeds[0].title = `🏆 Final Results — ${name}`;
    finalPayload.embeds[0].footer = { text: 'Tournament complete' };
    await postChannelMessage(env, channelId, finalPayload);
  }

  await env.CONFIG.put(stateKey, JSON.stringify({ ...state, active: false }));
  return { ok: true };
}
