/**
 * MatchPlay Events API client.
 * All endpoints require `Authorization: Bearer {MATCHPLAY_API_KEY}`.
 * All functions return parsed JSON or null on any failure — they never throw.
 */

const MATCHPLAY_API = 'https://app.matchplay.events/api';

async function matchplayRequest(env, path) {
  const key = env.MATCHPLAY_API_KEY;
  if (!key) {
    console.error('matchplay: MATCHPLAY_API_KEY missing');
    return null;
  }
  let res;
  try {
    res = await fetch(`${MATCHPLAY_API}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    console.error(`matchplay: GET ${path} fetch failed`, err);
    return null;
  }
  if (!res.ok) {
    console.error(`matchplay: GET ${path} → ${res.status}`);
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    console.error(`matchplay: GET ${path} JSON parse failed`, err);
    return null;
  }
}

export function getTournament(env, tournamentId) {
  return matchplayRequest(env, `/tournaments/${tournamentId}?includePlayers=true&includeArenas=true`);
}

// Returns planned (registration-open) tournaments for a single organizer ID.
// The platform layer is responsible for fanning out across multiple organizers.
export function getOrganizerTournaments(env, organizerId) {
  return matchplayRequest(env, `/tournaments?status=planned&owner=${organizerId}`);
}

export function getStandings(env, tournamentId) {
  return matchplayRequest(env, `/tournaments/${tournamentId}/standings`);
}

export function getActiveGames(env, tournamentId) {
  return matchplayRequest(env, `/games?tournaments=${tournamentId}&status=started`);
}
