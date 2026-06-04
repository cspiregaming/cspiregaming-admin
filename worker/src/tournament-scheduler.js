/**
 * Tournament cron job — polls active tournaments every minute and live-edits
 * the queue and leaderboard messages in #notifications.
 * Supports multiple simultaneous tournaments across multiple platforms.
 */

import { fetchTournamentPayloads, parseStateKey } from './tournament-platform.js';
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

  // Derive platform from KV key (tournament:state:{platform}:{id}); fall back
  // to state.platform for keys written by the current version.
  const parsed = parseStateKey(stateKey);
  const platform = state.platform ?? parsed?.platform ?? 'matchplay';
  const { tournamentId } = state;

  const payloads = await fetchTournamentPayloads(env, platform, tournamentId);
  if (!payloads) {
    console.error(`tournament-cron: failed to fetch ${platform}:${tournamentId}`);
    return;
  }

  let newState = { ...state };

  // Queue message — always update, active games change every round.
  if (state.queueMessageId) {
    await editChannelMessage(env, channelId, state.queueMessageId, payloads.queuePayload);
  } else {
    const posted = await postChannelMessage(env, channelId, payloads.queuePayload);
    if (posted.ok && posted.json?.id) newState.queueMessageId = posted.json.id;
  }

  // Leaderboard — skip edit if standings are unchanged to avoid rate-limit churn.
  if (payloads.standings) {
    const standingsHash = JSON.stringify(payloads.standings);
    if (standingsHash !== state.standingsHash) {
      const lbPayload = payloads.buildLeaderboard();
      if (state.leaderboardMessageId) {
        await editChannelMessage(env, channelId, state.leaderboardMessageId, lbPayload);
      } else {
        const posted = await postChannelMessage(env, channelId, lbPayload);
        if (posted.ok && posted.json?.id) newState.leaderboardMessageId = posted.json.id;
      }
      newState.standingsHash = standingsHash;
    }
  }

  if (JSON.stringify(newState) !== JSON.stringify(state)) {
    await env.CONFIG.put(stateKey, JSON.stringify(newState));
  }
}
