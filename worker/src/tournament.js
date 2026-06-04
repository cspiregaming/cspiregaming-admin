/**
 * Tournament Discord integration — permission checks and Discord embed builders.
 */

// ─── Permissions ─────────────────────────────────────────────────────────────

export function isTournamentStaff(interaction, env) {
  const roles = interaction.member?.roles || [];
  if (env.TOURNAMENT_ADMIN_ROLE_ID && roles.includes(env.TOURNAMENT_ADMIN_ROLE_ID)) return true;
  if (env.TOURNAMENT_STAFF_ROLE_ID && roles.includes(env.TOURNAMENT_STAFF_ROLE_ID)) return true;
  return false;
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

// MatchPlay returns player/arena IDs everywhere for performance; build lookup
// maps from the tournament response fetched with includePlayers+includeArenas.
export function buildMaps(tournament) {
  const data = tournament?.data ?? tournament;
  const playerMap = {};
  const arenaMap = {};
  for (const p of data?.players ?? []) {
    if (p.playerId != null) playerMap[p.playerId] = p.name || `Player ${p.playerId}`;
  }
  for (const a of data?.arenas ?? []) {
    if (a.arenaId != null) arenaMap[a.arenaId] = a.name || `Arena ${a.arenaId}`;
  }
  return { playerMap, arenaMap };
}

export function tournamentName(tournament) {
  return (tournament?.data ?? tournament)?.name ?? 'Tournament';
}

// ─── Embed builders ──────────────────────────────────────────────────────────

export function buildAnnouncementEmbed(tournament, registrationUrl) {
  const name = tournamentName(tournament);
  return {
    embeds: [{
      title: `📋 ${name}`,
      description: 'Registration is now open for our upcoming tournament! Click the button below to sign up.',
      color: 0x5865f2,
      footer: { text: 'C Spire Gaming' },
    }],
    components: [{
      type: 1, // Action Row
      components: [{
        type: 2,  // Button
        style: 5, // Link
        label: 'Register Now',
        url: registrationUrl,
      }],
    }],
  };
}

export function buildQueueEmbed(games, playerMap, arenaMap) {
  const gamesData = games?.data ?? (Array.isArray(games) ? games : []);
  const active = gamesData.filter(g => g.status === 'started' || !g.status);

  // Determine round number from the first game's round info (varies by API shape)
  const firstRound = active[0]?.round;
  const roundNum = firstRound?.roundNumber ?? firstRound?.number ?? active[0]?.roundNumber ?? '?';

  const fields = active.slice(0, 25).map(game => {
    const arenaName = arenaMap[game.arenaId] ?? `Arena ${game.arenaId ?? '?'}`;
    const gamePlayers = (game.players ?? []).map(p => {
      const id = typeof p === 'object' ? (p.playerId ?? p.id) : p;
      return playerMap[id] ?? `Player ${id}`;
    });
    return {
      name: arenaName,
      value: gamePlayers.join('\n') || '—',
      inline: true,
    };
  });

  const timeStr = ctTime();
  return {
    embeds: [{
      title: active.length > 0 ? `⚙️ Now Playing — Round ${roundNum}` : '⏸️ Between Rounds',
      color: active.length > 0 ? 0x57f287 : 0x4f545c,
      fields: fields.length > 0 ? fields : [{ name: 'Waiting', value: 'Next round hasn\'t started yet…', inline: false }],
      footer: { text: `Updated ${timeStr} CT` },
    }],
  };
}

export function buildLeaderboardEmbed(standings, playerMap, name) {
  const data = standings?.data ?? (Array.isArray(standings) ? standings : []);

  const rows = data.slice(0, 20).map(entry => {
    const playerName = playerMap[entry.playerId] ?? `Player ${entry.playerId}`;
    const pts = entry.points != null ? ` — ${entry.points} pts` : '';
    const record = (entry.wins != null && entry.losses != null)
      ? ` (${entry.wins}W-${entry.losses}L)`
      : '';
    return `**${entry.position}.** ${playerName}${pts}${record}`;
  });

  const timeStr = ctTime();
  return {
    embeds: [{
      title: `🏆 Standings — ${name ?? 'Tournament'}`,
      color: 0xfee75c,
      description: rows.length > 0 ? rows.join('\n') : 'No standings available yet.',
      footer: { text: `Updated ${timeStr} CT` },
    }],
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function ctTime() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
  });
}
