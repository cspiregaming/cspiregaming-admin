/**
 * Tournament cron job — polls MatchPlay every minute while a tournament is
 * active and live-edits the queue and leaderboard messages in #notifications.
 * Supports multiple simultaneous active tournaments via per-tournament KV keys.
 */

import { getTournament, getStandings, getActiveGames } from './matchplay.js';
import { buildMaps, buildQueueEmbed, buildLeaderboardEmbed, tournamentName } from './tournament.js';
import { postChannelMessage, editChannelMessage } from './discord-outbound.js';

export async function runTournamentCron(env) {
  const channelId = env.TOURNAMENT_NOTIFICATIONS_CHANNEL_ID;
  if (!channelId) return;

  let list;
  try {
    list = await env.CONFIG.list({ prefix: 'tournament:state:' });
  } catch (err) {
    console.error('tournament-cron: CONFIG.list failed', err);
    return;
  }

  if (!list.keys.length) return;

  await Promise.all(list.keys.map(key => updateTournament(env, key.name, channelId)));
}

async function updateTournament(env, stateKey, channelId) {
  let state;
  try {
    state = await env.CONFIG.get(stateKey, 'json');
  } catch (err) {
    console.error(`tournament-cron: read ${stateKey} failed`, err);
    return;
  }
  if (!state?.active) return;

  const { tournamentId } = state;

  const [tournament, standings, games] = await Promise.all([
    getTournament(env, tournamentId),
    getStandings(env, tournamentId),
    getActiveGames(env, tournamentId),
  ]);

  if (!tournament) {
    console.error(`tournament-cron: failed to fetch tournament ${tournamentId}`);
    return;
  }

  const { playerMap, arenaMap } = buildMaps(tournament);
  const name = tournamentName(tournament);
  let newState = { ...state };

  // Queue message (always update — active games change frequently)
  const queuePayload = buildQueueEmbed(games, playerMap, arenaMap);
  if (state.queueMessageId) {
    await editChannelMessage(env, channelId, state.queueMessageId, queuePayload);
  } else {
    const posted = await postChannelMessage(env, channelId, queuePayload);
    if (posted.ok && posted.json?.id) newState.queueMessageId = posted.json.id;
  }

  // Leaderboard (skip edit if standings unchanged to avoid rate-limit churn)
  if (standings) {
    const standingsHash = JSON.stringify(standings);
    if (standingsHash !== state.standingsHash) {
      const lbPayload = buildLeaderboardEmbed(standings, playerMap, name);
      if (state.leaderboardMessageId) {
        await editChannelMessage(env, channelId, state.leaderboardMessageId, lbPayload);
      } else {
        const posted = await postChannelMessage(env, channelId, lbPayload);
        if (posted.ok && posted.json?.id) newState.leaderboardMessageId = posted.json.id;
      }
      newState.standingsHash = standingsHash;
    }
  }

  // Persist only if something changed
  if (JSON.stringify(newState) !== JSON.stringify(state)) {
    await env.CONFIG.put(stateKey, JSON.stringify(newState));
  }
}
