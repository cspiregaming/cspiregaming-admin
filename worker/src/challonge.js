/**
 * Challonge API v1 client.
 * Auth: ?api_key={CHALLONGE_API_KEY} query param on every request.
 * All functions return parsed JSON or null on failure — never throw.
 */

const CHALLONGE_API = 'https://api.challonge.com/v1';

async function challongeRequest(env, path, params = {}) {
  const key = env.CHALLONGE_API_KEY;
  if (!key) {
    console.error('challonge: CHALLONGE_API_KEY missing');
    return null;
  }
  const url = new URL(`${CHALLONGE_API}${path}.json`);
  url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    console.error(`challonge: GET ${path} fetch failed`, err);
    return null;
  }
  if (!res.ok) {
    console.error(`challonge: GET ${path} → ${res.status}`);
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    console.error(`challonge: GET ${path} JSON parse failed`, err);
    return null;
  }
}

// List tournaments owned by the API key holder. state: pending|underway|complete|etc.
export function getOpenTournaments(env) {
  return challongeRequest(env, '/tournaments', { state: 'pending' });
}

export function getTournament(env, tournamentId) {
  return challongeRequest(env, `/tournaments/${tournamentId}`);
}

export function getParticipants(env, tournamentId) {
  return challongeRequest(env, `/tournaments/${tournamentId}/participants`);
}

// Returns all matches — caller filters by state as needed.
export function getMatches(env, tournamentId) {
  return challongeRequest(env, `/tournaments/${tournamentId}/matches`);
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

// Challonge wraps every resource: { tournament: {...} } for single,
// [{ tournament: {...} }, ...] for lists. Unwrap to the raw object.
export function normalizeTournament(raw) {
  const t = raw?.tournament ?? raw;
  return {
    id: String(t.id),
    name: t.name ?? `Tournament ${t.id}`,
    state: t.state,
    registrationOpen: t.state === 'pending' || t.state === 'checking_in',
    url: t.full_challonge_url ?? `https://challonge.com/${t.url ?? t.id}`,
  };
}

// Build { playerMap: { [participantId]: name } }
export function buildPlayerMap(participantsData) {
  const playerMap = {};
  for (const item of participantsData ?? []) {
    const p = item.participant ?? item;
    if (p.id != null) playerMap[p.id] = p.name || p.username || `Player ${p.id}`;
  }
  return { playerMap };
}

// Compute standings from match win/loss records. Uses final_rank when available
// (set after tournament completes), otherwise counts wins from completed matches.
export function computeStandings(participantsData, matchesData) {
  const participants = (participantsData ?? []).map(item => item.participant ?? item);
  const matches = (matchesData ?? []).map(item => item.match ?? item);

  const record = {};
  for (const p of participants) {
    record[p.id] = { playerId: p.id, wins: 0, losses: 0, finalRank: p.final_rank ?? null };
  }
  for (const m of matches) {
    if (m.state !== 'complete' || !m.winner_id) continue;
    if (record[m.winner_id]) record[m.winner_id].wins++;
    const loserId = m.winner_id === m.player1_id ? m.player2_id : m.player1_id;
    if (loserId && record[loserId]) record[loserId].losses++;
  }

  return Object.values(record)
    .sort((a, b) => {
      if (a.finalRank != null && b.finalRank != null) return a.finalRank - b.finalRank;
      return b.wins - a.wins || a.losses - b.losses;
    })
    .map((entry, idx) => ({
      playerId: entry.playerId,
      position: entry.finalRank ?? idx + 1,
      wins: entry.wins,
      losses: entry.losses,
      points: null,
    }));
}

// Normalize open/underway Challonge matches into the shape buildQueueEmbed expects.
export function normalizeActiveMatches(matchesData, playerMap) {
  const matches = (matchesData ?? []).map(item => item.match ?? item);
  return matches
    .filter(m => m.state === 'open' || m.state === 'underway')
    .map(m => ({
      arenaId: m.id,
      arenaName: m.identifier ? `Match ${m.identifier}` : `Match ${m.id}`,
      players: [m.player1_id, m.player2_id].filter(Boolean),
      status: 'started',
      round: { roundNumber: m.round ?? '?' },
    }));
}
