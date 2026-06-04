/**
 * Platform abstraction layer for tournament integrations.
 *
 * Supported platforms: 'matchplay' | 'challonge'
 *
 * Exposes two surfaces:
 *   fetchTournamentPayloads(env, platform, id) → { name, queuePayload, standings,
 *                                                   buildLeaderboard, buildAnnouncement,
 *                                                   registrationUrl } | null
 *   getOpenTournaments(env) → [{ platform, id, name, registrationUrl }]
 */

import * as matchplay from './matchplay.js';

export const MATCHPLAY_ORGANIZERS_KEY = 'tournament:matchplay:organizers';
import * as challonge from './challonge.js';
import {
  buildMaps as mpBuildMaps,
  tournamentName as mpTournamentName,
  buildQueueEmbed,
  buildLeaderboardEmbed,
  buildAnnouncementEmbed,
} from './tournament.js';

export const VALID_PLATFORMS = ['matchplay', 'challonge'];

/**
 * Fetch all needed data for a tournament and return normalized Discord payloads.
 * Returns null if the primary tournament fetch fails.
 */
export async function fetchTournamentPayloads(env, platform, tournamentId) {
  if (platform === 'challonge') {
    return fetchChallongePayloads(env, tournamentId);
  }
  return fetchMatchPlayPayloads(env, tournamentId);
}

async function fetchMatchPlayPayloads(env, tournamentId) {
  const [tournament, standings, games] = await Promise.all([
    matchplay.getTournament(env, tournamentId),
    matchplay.getStandings(env, tournamentId),
    matchplay.getActiveGames(env, tournamentId),
  ]);
  if (!tournament) return null;

  const { playerMap, arenaMap } = mpBuildMaps(tournament);
  const name = mpTournamentName(tournament);
  const registrationUrl = `https://app.matchplay.events/tournaments/${tournamentId}`;

  const mpData = tournament?.data ?? tournament;
  const startTime = mpData?.startTime ?? mpData?.start_time ?? null;

  return {
    name,
    registrationUrl,
    queuePayload: buildQueueEmbed(games, playerMap, arenaMap),
    standings,
    buildLeaderboard: () => buildLeaderboardEmbed(standings, playerMap, name),
    buildAnnouncement: url => buildAnnouncementEmbed(tournament, url, {
      platform: 'MatchPlay',
      game: 'Pinball',
      startTime,
    }),
  };
}

async function fetchChallongePayloads(env, tournamentId) {
  const [rawTournament, participantsData, matchesData] = await Promise.all([
    challonge.getTournament(env, tournamentId),
    challonge.getParticipants(env, tournamentId),
    challonge.getMatches(env, tournamentId),
  ]);
  if (!rawTournament) return null;

  const t = challonge.normalizeTournament(rawTournament);
  const { playerMap } = challonge.buildPlayerMap(participantsData);
  const standings = challonge.computeStandings(participantsData, matchesData);
  const activeMatches = challonge.normalizeActiveMatches(matchesData, playerMap);

  return {
    name: t.name,
    registrationUrl: t.url,
    // Challonge matches use their identifier as "arena" name — arenaMap is baked in.
    queuePayload: buildQueueEmbed(activeMatches, playerMap, {}),
    standings,
    buildLeaderboard: () => buildLeaderboardEmbed(standings, playerMap, t.name),
    buildAnnouncement: url => buildAnnouncementEmbed({ name: t.name }, url, {
      platform: 'Challonge',
      game: t.game ?? null,
      startTime: t.startTime ?? null,
    }),
  };
}

/**
 * Query both platforms for tournaments with open registration.
 *
 * MatchPlay: fans out one request per organizer stored in KV
 *   (key: tournament:matchplay:organizers → string[]).
 *   Falls back to MATCHPLAY_ORGANIZER_ID env var when the KV list is empty.
 *
 * Challonge: single request, scoped to CHALLONGE_SUBDOMAIN when set.
 *
 * Silently skips a platform if its API key is missing.
 */
export async function getOpenTournaments(env) {
  const organizerIds = await getMatchPlayOrganizerIds(env);

  const [mpResults, chResult] = await Promise.all([
    Promise.allSettled(organizerIds.map(id => matchplay.getOrganizerTournaments(env, id))),
    Promise.allSettled([challonge.getOpenTournaments(env)]),
  ]);

  const open = [];
  const seen = new Set();

  // MatchPlay — merge results across all organizers, deduplicate by tournamentId.
  for (const r of mpResults) {
    const list = r.status === 'fulfilled' ? (r.value?.data ?? []) : [];
    for (const t of Array.isArray(list) ? list : []) {
      if (t.status === 'planned' && !seen.has(String(t.tournamentId))) {
        seen.add(String(t.tournamentId));
        open.push({
          platform: 'matchplay',
          id: String(t.tournamentId),
          name: t.name,
          registrationUrl: `https://app.matchplay.events/tournaments/${t.tournamentId}`,
        });
      }
    }
  }

  // Challonge — response: [{ tournament: {...} }, ...]
  const chList = chResult[0]?.status === 'fulfilled' ? chResult[0].value : null;
  for (const item of Array.isArray(chList) ? chList : []) {
    const t = challonge.normalizeTournament(item);
    if (t.registrationOpen) {
      open.push({ platform: 'challonge', id: t.id, name: t.name, registrationUrl: t.url });
    }
  }

  return open;
}

/**
 * Load MatchPlay organizer IDs from KV.
 * Falls back to MATCHPLAY_ORGANIZER_ID env var (the bootstrap seed) when KV is empty.
 */
export async function getMatchPlayOrganizerIds(env) {
  const stored = await env.CONFIG.get(MATCHPLAY_ORGANIZERS_KEY, 'json').catch(() => null);
  if (Array.isArray(stored) && stored.length) return stored;
  return env.MATCHPLAY_ORGANIZER_ID ? [env.MATCHPLAY_ORGANIZER_ID] : [];
}

/** Parse platform and tournamentId from a KV state key. */
export function parseStateKey(key) {
  // Format: tournament:state:{platform}:{id}
  const parts = key.split(':');
  // parts[0]='tournament', parts[1]='state', parts[2]=platform, parts[3..]=id
  if (parts.length < 4) return null;
  return { platform: parts[2], tournamentId: parts.slice(3).join(':') };
}

export function buildStateKey(platform, tournamentId) {
  return `tournament:state:${platform}:${tournamentId}`;
}
