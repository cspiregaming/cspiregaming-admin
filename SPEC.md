# SPEC

Combined spec for **cspiregaming-workers** (Cloudflare Worker + admin SPA) & **cspiregaming.github.io**
(Jekyll static site). Two repos, one system — worker is backend-of-record, site is sole consumer.
Distilled from code 2026-07-27.

## §G GOAL
Backend API + admin console + Discord bot for C Spire Gaming community (Cloudflare Worker) ∴ serves
public read API to static site, gates admin ops by role, runs Discord bot (slash cmds, interactions,
DMs, reactions) + scheduled jobs (grading, stats, welcome, tournament). Site = single-page community
hub (officers, live member roster, events, social links) consuming that API client-side.

## §C CONSTRAINTS
- worker: Cloudflare Workers runtime, `compatibility_date=2024-09-23`, `nodejs_compat` flag
- worker: zero runtime npm deps — JWT/Ed25519 hand-rolled on Web Crypto (`auth.js`, `discord-interactions.js`)
- worker: only devDep `wrangler ^4.87.0`; needs Node ≥22 (CI uses `node:22-alpine`)
- worker: plain ES modules, no bundler/framework
- admin SPA: vanilla JS, no build step, single `index.html`
- site: Jekyll `~>4.3` (locked 4.4.1) for local serve only — GitHub Pages Jekyll disabled via `.nojekyll`, prod serves raw files
- site: Ruby pinned via `.ruby-version` (3.2.0)
- site: dual JS tooling — Bower (`bower_components/` checked in) → AngularJS 1.4.x; npm → test tooling only (karma/jasmine), no npm build script
- site: plain ES5 AngularJS + jQuery + Bootstrap + "gaia" theme, static `<script>` tags, no transpiler

## §I INTERFACES

### worker: Discord slash cmds (`register-commands.js`, dispatched `routes/interactions.js`)
`/request-event-publish`, `/register-stream`, `/unregister-stream`, `/parrotbomb`,
`/toggle-public-membership`, `/streamer-list` (mod+), `/streamer-remove` (mod+),
`/tournament register|announce(staff)|live(staff)|end(staff)`

### worker: HTTP routes (`src/index.js` + `src/routes/{public,admin,interactions,streamers,checkins}.js`)
- public (no auth): `GET /api/public/members`, `GET /api/public/content`, `POST /api/checkin`
- discord/twitch: `POST /api/interactions` (Ed25519), `POST /api/twitch/eventsub` (HMAC)
- auth: `GET /api/auth/discord`, `GET /api/auth/callback`, `POST /api/auth/logout`, `GET /api/auth/stream-callback`
- admin (JWT, tiered): `/api/admin/{config,roles,members,members/opt-outs[/{id}],officers[/{id}],events[/{id}],discord-events[/{id}],social,twitch/*,streamers[/{id}][/test-live|/official],grader[/test],emojis,statbot/{status,channels,preview,run},welcome,tournament/*(+organizers),checkins/active-event,checkins/event-candidates,checkins}`
- ? README API table stops @ Twitch — statbot/welcome/tournament/checkins routes real & shipped but undocumented there. use code as truth

### worker: KV namespaces (`wrangler.toml`)
- `CONFIG`: `role_ids`, `default_role_id`, `grader_config`, `welcome_config`, `welcome_member_snapshot`,
  `statbot_last_run_date`, `active_event`, `tournament:matchplay:organizers`, `tournament:state:{platform}:{id}`
- `CONTENT`: `officers`, `events`, `discord_event_overlays`, `past_discord_events`, `event_publish_requests`,
  `public_member_opt_outs`, `streamers`, `streamers_by_twitch`, `daily_games_last_seen`, `social`
- `CACHE`: `members_<guildId>` (TTL 300s), `discord_events_live`/`discord_events_seen`, `twitch_app_token`
- `CHECKINS`: `checkin:<uuid>`, `event:<eventId>:checkins`, `event:none:checkins`, `index:email:<lower>`,
  `index:gamertag:<lower>` — ? not in README's KV table at all, `checkins.js` header is ground truth

### worker: cron
`*/1 * * * *` → `runDailyGamesGrader`, `maybeRunDailyStatbotReport`, `maybeWelcomeNewMembers`, `runTournamentCron`

### worker: env/secrets (`wrangler.toml`)
vars: `GUILD_ID=379707231077138442`, `DISCORD_APP_ID=1002285255249625138`, `ADMIN_ROLE_ID=961330657114607646`,
`ADMIN_URL`, `OFFICERS_CHANNEL_ID`, `REQUESTER_ROLE_IDS`, `MOD_ROLE_IDS`, `STREAMER_ROLE_ID`,
`LIVE_ANNOUNCE_CHANNEL_ID`, `COMMUNITY_STREAM_ROLE_ID`, `CSG_STREAM_ROLE_ID`, `DAILY_GAMES_CHANNEL_ID`,
`BOT_LOGS_CHANNEL_ID`, `BOT_COMMANDS_CHANNEL_ID`, `WORKER_ORIGIN` (optional), tournament block
(`TOURNAMENT_ADMIN_CHANNEL_ID`, `TOURNAMENT_NOTIFICATIONS_CHANNEL_ID`, `TOURNAMENT_SUPPORT_CHANNEL_ID`,
`TOURNAMENT_ADMIN_ROLE_ID`, `TOURNAMENT_STAFF_ROLE_ID`, `MATCHPLAY_TOURNAMENT_ID=255077`,
`MATCHPLAY_ORGANIZER_ID=57756`, `CHALLONGE_TOURNAMENT_ID=94497`, `CHALLONGE_SUBDOMAIN=cspiregaming`)
secrets: `BOT_TOKEN`, `JWT_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`,
`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_SECRET`, `STATBOT_API_KEY`,
`MATCHPLAY_API_KEY`, `CHALLONGE_API_KEY`

### worker: deployed @ `https://api.cspiregaming.com` (custom domain route, confirmed in wrangler.toml + CI)

### admin SPA: deploy target — resolved, was not actually conflicting
- `wrangler.toml` `ADMIN_URL` = `https://cspiregaming.github.io/cspiregaming-admin` ← worker's own post-login redirect, truth
- repo's GitHub mirror remote = `cspiregaming/cspiregaming-admin` (≠ local dir name `cspiregaming-workers`) ∴ GH Pages project URL correctly resolves to `/cspiregaming-admin`
- README top-of-file link `https://cspiregaming.com/cspiregaming-admin/` = same content via custom domain CNAME on `cspiregaming.github.io` — consistent, not stale
- `.gitlab-ci.yml` `pages` job → GitLab Pages mirror, now labeled legacy/secondary; canonical = GH Pages via `.github/workflows/deploy-pages.yml`

### site: pages
`index.html` (full page, ~18KB) + `views/main.html` (ng-route `/` template: events, officers, members
grid) + `docs/privacy-policy.html` (static, states worker proxies Discord API + logs visitor IPs) +
`404.html`. `views/about.html` = dead Yeoman boilerplate, unlinked.

### site → worker: client-side calls (`scripts/controllers/main.js`)
`WORKER_BASE = 'https://api.cspiregaming.com'` — fixed 2026-07-27, was pointing @ personal
`cspiregaming-api.michaellamb.workers.dev` subdomain, not intentional (§B.1)
- `GET {WORKER_BASE}/api/public/members` → members/roles/roleCounts. fail → visible `membersError` banner
- `GET {WORKER_BASE}/api/public/content` → officers (sorted `order`) + events (via `decorateEvent()`).
  fail → **silent** fallback to hardcoded officer list + empty events, no user-facing error
- ? mismatch between error handling (visible vs silent) undocumented as intentional

### site: domain
`CNAME` = `cspiregaming.com` (GitHub Pages custom domain)

## §V INVARIANTS
V1: `POST /api/interactions` → Ed25519 verify (`X-Signature-Ed25519`/`-Timestamp` vs `DISCORD_PUBLIC_KEY`) before handling, else 401
V2: `POST /api/twitch/eventsub` → HMAC-SHA256 verify vs `TWITCH_EVENTSUB_SECRET` before handling
V3: admin routes ! HS256 JWT (Bearer | `admin_token` cookie) → tier ∈ {officer,mod,tournament-admin,tournament-staff,⊥}. legacy JWT w/o `roles` array → treated as `officer` (back-compat)
V4: idempotency ! held — games-grader via high-water-mark msg id; statbot-daily via last-run-date KV + claim-before-work order; welcome via member-snapshot diff w/ first-run bootstrap (⊥ mass-DM on first deploy); twitch sub creation idempotent per streamer
V5: tournament-platform.js routes ∀ platform ∈ {matchplay,challonge}; `pruneStaleTournaments()` skips a platform's staleness check if that platform's API key absent (⊥ nuke valid state on missing secret)
V6: tournament cron ! skip leaderboard msg edit unless standings hash changed (rate-limit/cost avoidance)
V7: reason-length ≥10 chars validated both client (Discord cmd option `min_length`) & server (interactions route + streamer DELETE admin route)
V8: Discord link buttons ! `{type:2, style:5}` — `type:5` = User Select, causes 400 (prod incident, see memory)
V9: site `$sceDelegateProvider.resourceUrlWhitelist` ! `['self','https://www.google.com/**']` — embed URLs outside this ⊥ load
V10: worker `/api/public/content` failure → officer/event fallback silent; `/api/public/members` failure → visible error — ? inconsistent, not confirmed intentional
V11: site `WORKER_BASE` ! point @ `api.cspiregaming.com` (custom domain), ⊥ personal `*.workers.dev` subdomain
V12: games-grader boards ∈ {wordle,framed,connections,strands,custom}; `custom` = declarative (extractors→scoring→legend, + bonus rules) ∴ new game ⊥ code change. Reactions = primary + bonuses, sequential. Per-board legend overrides global key-by-key. `scoring.bands` ([{min,score}], highest min ≤ value wins) for higher-is-better. Presets (4x3, krillion, strands) opt-in via admin; saved `grader_config` ⊥ auto-gain new default boards. Only msgs newer than high-water mark graded (⊥ backfill) ∴ board added after a post ⇏ that post graded

## §T TASKS
id|status|task|cites
T1|.|add automated test coverage to worker (currently zero — plan written in README, `vitest-pool-workers` recommended, not yet implemented)|C
T2|x|reconcile worker README: documented statbot/welcome/tournament/checkins routes + CHECKINS KV; fixed stale admin-URL/officer-signin refs; expanded project layout|I
T3|x|fixed stale site CLAUDE.md claims: test suite is real & passing (not broken scaffolding), no officer-shuffle behavior exists, documented live API dependency|I
T4|x|fixed site `WORKER_BASE` → `api.cspiregaming.com`|I,V11,B1
T5|~|`.gitlab-ci.yml` GitLab Pages job relabeled legacy/secondary w/ pointer to canonical GH Pages deploy — not removed, decision to drop it still open|I
T6|.|remove dead `views/about.html` Yeoman boilerplate ? optional cleanup|-
T7|.|reconcile site/worker error-handling asymmetry: members-fetch fails loud, content-fetch fails silent — confirm intentional|V10

## §B BUGS
id|date|cause|fix
B1|2026-07-27|site `WORKER_BASE` pointed @ personal `*.workers.dev` subdomain not custom domain|V11
