# cspiregaming-workers

Backend API and admin console for [cspiregaming.github.io](https://cspiregaming.github.io). Deployed as a Cloudflare Worker plus a static admin SPA hosted on GitLab Pages.

- **Public site:** https://cspiregaming.github.io
- **Admin console:** https://cspiregaming.com/cspiregaming-admin/
- **Worker API:** https://api.cspiregaming.com

---

## What's here

```
worker/    Cloudflare Worker (public read API + authenticated admin API)
admin/     Static admin SPA (vanilla JS modules, no build step)
```

The worker is the only thing officers' web browsers and the public homepage talk to. State lives in four Cloudflare KV namespaces; member rosters are pulled live from Discord and cached for 5 minutes.

```
cspiregaming.github.io ─┐
                        ├──► Worker ──► Discord API (bot token)
Admin SPA ──────────────┘       │    ──► Twitch API, MatchPlay API, Challonge API
                                ├──► KV: CONFIG   (settings, tournament state, grader/welcome/statbot config)
                                ├──► KV: CONTENT  (officers, events, social, streamers)
                                ├──► KV: CACHE    (5-min member cache, Discord events, Twitch token)
                                └──► KV: CHECKINS (event check-in records)
```

---

## For Officers

### Signing in

1. Open https://cspiregaming.com/cspiregaming-admin/ (same content as https://cspiregaming.github.io/cspiregaming-admin — this repo's GitHub mirror is `cspiregaming/cspiregaming-admin`).
2. Click **Sign in with Discord**, authorize the app.
3. You're in if you're a member of the C Spire Gaming guild AND you hold either (a) the configured Admin Role (officer), or (b) any role listed in `MOD_ROLE_IDS` (mod).

Access tiers:

- **Officer** (`ADMIN_ROLE_ID`) — full access to every section.
- **Mod** (`MOD_ROLE_IDS`) — limited to **Daily Games** and **Settings**. Other sidebar items are hidden, and the worker rejects writes to officer-only endpoints with `403 Officer access required`.

If sign-in fails:

| Error | Meaning | Fix |
| --- | --- | --- |
| "You cancelled the Discord login." | You denied the OAuth prompt. | Click sign-in again. |
| "Your Discord account does not have officer or mod access to this server." | You don't have any of the configured roles. | Have an existing officer give you the Admin Role or a Mod role in Discord, then sign in again. |
| Stuck on a Discord error page | The redirect URI isn't registered in the Discord app. | Developer task — see [Discord application](#discord-application). |

### Granting officer access to someone

1. In Discord, give them the role configured as `ADMIN_ROLE_ID` in `worker/wrangler.toml`.
2. They sign in via the admin link above.

The role gate is set in `wrangler.toml` (developer access required to change). If you need a different role to gate the admin, ask a developer to update and redeploy.

### What each section does

- **Dashboard** — at-a-glance counts, "Refresh Member Cache" button (forces a re-fetch from Discord), and CSV export.
- **Members** — live roster pulled from Discord via the bot. Filter by role, export to CSV. Each card has a **Hide from public** / **Show on public site** toggle that opts the member out of (or back into) the public Members section on https://cspiregaming.com — the public list is opt-in by role, so this is a per-user override. Members can also self-toggle via `/toggle-public-membership` in Discord. The "🚫 Hidden from public" filter chip narrows the grid to opted-out members. Changes take effect within ~5 min (or hit "Refresh Member Cache" on the dashboard to apply immediately).
- **Roles Config** — toggle which Discord roles appear publicly on the homepage, and pick which one (or "All Members") is selected by default when a visitor lands on the Members section. The full guild role list comes from Discord; check the ones you want shown. Saves go live within 5 minutes (or hit "Refresh Member Cache" on the dashboard to apply immediately).
- **Officers** — manually-curated officer cards (name, photo URL, bio HTML, display order). Used by the public site's "Officers" section.
- **Events** — split into two sections:
  - **Discord Events** — live list of guild scheduled events from Discord. Toggle "Publish" to surface an event on the public site, and optionally provide a custom action button (text + URL) per event. Default action button is "View on Discord". Recent past events stay listed for 30 days after they end. Toggling Publish here also auto-resolves any pending `/request-event-publish` request for the event (see below).
  - **Manual Events** — hand-curated event cards (title, subtitle, description HTML, action button, optional Google Maps embed and cover image) for events that don't live in Discord.
- **Streamers** — table of every member registered with the bot via `/register-stream`, plus any official channels registered through this section. Click **Deregister** on a row to remove someone (the SPA prompts for a reason, ≥10 chars, which gets posted to the officers channel as an audit-log embed). Same teardown as `/streamer-remove`: the @streamer role (skipped for official channels — no Discord user), EventSub subscriptions, and KV record all drop together.
  - **Test Embed** — appears only on rows with a Twitch link. Posts a preview of the live-announcement embed to `BOT_LOGS_CHANNEL_ID` so you can see exactly what an announcement looks like without firing it in the public live-announce channel. The preview is identical to the real embed except (a) it doesn't ping anyone and (b) the lead text reads "_Preview — {name} would be live on Twitch_". If the streamer is currently live, it pulls the real title/game/thumbnail; if offline, it falls back to placeholder text with the same layout.
  - **Add Official Streamer** — for Twitch channels that don't have a Discord user (e.g. the C Spire Gaming Twitch account itself). Enter the Twitch login, hit Register, and the bot creates an `isOfficial: true` streamer record (synthetic `discordId = official:<twitchUserId>`), wires up Twitch EventSub, and tags `@csg stream notifications` instead of `@community stream notifications` when this channel goes live. Idempotent — re-registering the same login is safe.
- **Twitch** — diagnostic panel for the Twitch EventSub integration. Shows the status of all three Twitch secrets and the app token, lists every active EventSub subscription cross-referenced against registered streamers, and highlights any issues (missing subscriptions, non-enabled statuses, orphaned subs with no matching streamer record). Key actions:
  - **Sync All Subscriptions** — for every streamer whose stored sub IDs are missing or absent from Twitch's active list, creates fresh subscriptions and updates KV with the new IDs. Use this after rotating `TWITCH_EVENTSUB_SECRET` or when EventSub subscriptions were lost.
  - **Test** *(per stream.online row)* — posts a suppressed preview embed directly to `LIVE_ANNOUNCE_CHANNEL_ID` (not `#bot-logs`), confirming the bot has Send Messages + Embed Links in the real announcement channel.
  - **Delete** *(per row)* — removes a specific subscription from Twitch immediately. Running Sync or re-registering the streamer will recreate it.
  The **Configuration** card shows whether `LIVE_ANNOUNCE_CHANNEL_ID` is set and its current value so you can confirm it points at the right channel.
- **Daily Games** *(officers and mods)* — controls for the auto-grader described below. Three areas:
  - **Default legend** — edit the score-1..6 + miss emoji reactions. Each cell accepts a unicode emoji or a Discord custom-emoji reference in `name:id` form; the **😀** button opens a picker with common emojis and the server's custom emojis.
  - **Boards** — add / edit / delete / reorder (▲▼) the boards the grader recognizes; order matters, first match wins. **+ Add board…** offers a blank custom board or a preset (**4x3.fun**, **Strands**). **Edit** opens the board editor: detection (starts with / contains / advanced regex), parser type, and — for `custom` boards — extractors, scoring and the primary reaction. Any board can also have bonus reactions and its own legend. The editor has a **live test** pane (paste a post → matched?, extracted values, reactions it would add) and can save sample posts per board.
  - **Test all boards** — paste a Discord message body to see what the whole current draft (saved or unsaved) would react with.
  Nothing is published until **Save Changes**; saves take effect on the next cron tick (≤ 1 minute).
- **Custom Emojis** *(officers and mods)* — read-only catalog of every custom emoji the bot can see in the guild, filterable by name/ID and split by static vs. animated. Click any cell to copy its `name:id` reaction string — the format anywhere the worker (or the Daily Games legend) accepts a custom emoji. The list is cached for one hour from Discord.

### Event publish requests

Members with the configured requester roles (e.g. *C Spire Employee*, *Mods*) can run `/request-event-publish` in Discord to ask for one of their scheduled events to be surfaced on the public website. The bot picks events from autocomplete and posts a request card with **Approve** / **Deny** buttons in the configured officers channel.

- Officers click Approve or Deny in the channel — the buttons disappear and the message gets edited to record who decided and when. Approve flips the public publish flag (same toggle as the admin SPA) and the event appears on cspiregaming.github.io within 5 minutes.
- The admin SPA is the alternate path: an officer who toggles Publish in **Discord Events** while a request is pending also auto-resolves it (the channel message is edited to "Approved by …" automatically).
- Requests older than 30 days from their decision time are auto-pruned.

If `/request-event-publish` doesn't show up in Discord, the bot is missing the `applications.commands` scope — see [Discord application](#discord-application).

### Daily-games auto-grader

Boards posted in `#daily-games` (or whichever channel `DAILY_GAMES_CHANNEL_ID` points at) get an automatic emoji reaction with the score. The set of recognized boards and the score → emoji legend live in `CONFIG:grader_config` and are editable from the **Daily Games** admin section (officers + mods). Defaults out of the box:

- **Wordle** — header line `Wordle 1,234 N/6` (or `X/6`, optionally `*` for hard mode). Score is N.
- **Framed** — `Framed #N` followed by a row of 6 squares; score is the 1-indexed position of the first 🟩 square. No 🟩 = miss.
- **Connections** — `Connections … Puzzle #N` followed by 4-square rows. Solid same-color rows count as solved groups; mixed rows count as mistakes. Solved with 0–3 mistakes scores 1–4; ≥4 mistakes (or otherwise unsolved) is a miss.

Default score → emoji legend (Wordle/Framed scores 1–6, Connections 1–4, all share the miss icon):

| Score | Emoji | | Score | Emoji |
| --- | --- | --- | --- | --- |
| 1 | 🌟 | | 5 | 🔸 |
| 2 | ⭐ | | 6 | ▪️ |
| 3 | 💫 | | Miss | ❌ |
| 4 | ✴️ | | | |

Other boards (**Strands**, **Krillion**, **Globle**, **Codenames Daily**, **4x3.fun**) are not in the defaults. Add them from **+ Add board… → Presets**; saved configs replace the defaults, so existing deployments are never changed silently.

**Parser types.** Four are built in; `custom` is declarative and needs no worker code:

- `wordle` — header regex must contain exactly one capture group; that group is the score token (digit or `X`). Score is the digit.
- `framed` — header regex is a presence gate. Scoring looks for the first 🟩 in any line containing 6 🟥/🟩/⬛ squares.
- `connections` — header regex is a presence gate. Also requires a `Puzzle #N` line. Scoring counts solid-same-color rows (groups solved) and mixed rows (mistakes).
- `strands` — header regex is a presence gate. Score = 💡 hints + 1, capped at 6; no miss state.
- `custom` — the board defines:
  - **extractors** `{name, kind, pattern, default?}`: `regex` (number in the first capture group; commas and negatives ok; no match → `default` or "not a board"), `count` (occurrences of a literal string/emoji), `present` (1 if the regex matches).
  - **scoring** `{field, offset, cap, bands?, failWhen?}`: score = `clamp(field + offset, 1, cap)`, mapped through the legend; or, with `bands: [{min, score}]`, the band with the highest `min` ≤ the value wins (for higher-is-better games); `failWhen` (e.g. `mistakes > 3`) uses the miss reaction.
  - **bonuses** (any board type) `{field, op, value, emoji}`: extra reactions added when the rule holds. Fields are extractor names, `score`, or `fail` (0/1). Ops: `== != > >= < <=`.

**Krillion preset** — detects `^Krillion #N`; `depth` is the bare-number line under the header. Higher is better, via bands: 450+ → score 1 (🦐), 351–449 → 2 (🦑), 251–350 → 3 (🦞), 151–250 → 4 (🐟), 0–150 → 5 (🫧). The emojis are a per-board legend; swap in Krillion's custom emojis (`name:id`) in the editor.

**Globle preset** — detects `Avg. Guesses`; `guesses` is the number after `=` on the squares line, `streak` is the number after 🔥 (extracted but unused). Lower is better, scored by bands because the average is ~9 guesses: 1–3 → score 1, 4–5 → 2, 6–7 → 3, 8–9 → 4, 10–12 → 5, 13+ → 6. A post without an `= N` (e.g. a failed game, format unknown) is not graded.

**Codenames Daily preset** — detects a line starting `CODENAMES DAILY`; `wrong` = count of ❌, `correct` = count of ✅ (unused by default). Primary reaction is `wrong + 1` (0 wrong → score 1, up to 3 wrong → score 4).

**4x3.fun preset** — detects `4x3.fun`; extracts `points` (`-?[\d,]+ points`, range roughly −100…150) and `mistakes` (`N mistake(s)`, default 0). Primary reaction is `mistakes + 1` (0 mistakes → score-1 emoji). Placeholder bonuses: points ≥ 130 → 💯, no mistakes → ✨, points < 0 → 💀 (tune in the admin).

Per-board legends: a board may override any legend key; blanks fall back to the default legend. Boards may also store up to 8 sample posts for the editor's live test.

A Cloudflare Cron Trigger fires every minute, polls the channel for messages newer than the saved high-water mark (`CONTENT:daily_games_last_seen`), grades each parseable board, and reacts via REST with the primary emoji followed by any bonus-rule emojis. Bot-authored messages are skipped, so the Wordle Discord App's "your group is on a streak" announcements don't get a grade. Reactions are idempotent on Discord's side, so a manual re-poll won't double-stamp. Config changes take effect on the next tick (≤ 1 minute).

The poller runs entirely on the worker's REST API, not a gateway connection, so the privileged Message Content Intent is **not** required — `GET /channels/{id}/messages` returns full content with just the bot's normal channel-read permissions.

### Public-listing opt-out

The public Members section on https://cspiregaming.com is **opt-in by role** — every member with one of the roles in Roles Config appears by default. Two paths can flip an individual member off the list:

- **`/toggle-public-membership`** *(any member)* — ephemerally toggles the runner's own opt-out state and explains the opt-in model. Running it again flips back.
- **Members admin section** *(officers)* — each member card has a **Hide from public** / **Show on public site** button. Hiding records the officer as the actor for audit. Use the "🚫 Hidden from public" filter chip to review who's currently opted out.

Opt-outs are stored in `CONTENT:public_member_opt_outs` and filtered at response time on `/api/public/members`, so toggles take effect on the next public request without requiring a cache bust.

### Streamer registration

Members can self-register as streamers from Discord:

- **`/register-stream`** — replies ephemerally with brief instructions and a one-time OAuth link. The user clicks the link, authorizes the bot for the `connections` scope, and the worker reads their Twitch / YouTube connections off their Discord profile. On success the bot:
  - assigns the **@streamer** role (`STREAMER_ROLE_ID` in `wrangler.toml`),
  - subscribes to Twitch EventSub (`stream.online` + `stream.offline`) for that user, and
  - DMs / follows-up the original interaction confirming they're set up.
- **Going live** — when Twitch fires `stream.online`, the worker posts an embed in the configured `LIVE_ANNOUNCE_CHANNEL_ID`: stream title, game/category, live thumbnail, "Watch on Twitch" link, plus role + user pings:
  - Community streamers ping `@community stream notifications` (`COMMUNITY_STREAM_ROLE_ID`) and the streamer's own Discord user.
  - The official C Spire Gaming Twitch channel pings `@csg stream notifications` (`CSG_STREAM_ROLE_ID`) only — there's no Discord user behind it.
  - Members opt in to either or both roles independently for the notifications they want.
- **`/unregister-stream`** — removes the @streamer role, deletes the Twitch EventSub subscriptions, and drops the streamer record.
- **`/streamer-list`** *(mods+)* — ephemeral list of every member registered with the bot, including their Twitch login and YouTube channel name. Capped at 25 entries with an overflow note.
- **`/streamer-remove user reason`** *(mods+)* — deregisters someone else's streamer record. The `reason` field is required (≥10 chars) and gets posted as an audit-log embed in `OFFICERS_CHANNEL_ID` along with who acted, who was removed, what platforms they had connected, and a Central-Time timestamp. Reuses the same teardown path as `/unregister-stream` (KV record + EventSub subs + @streamer role all dropped).
  - **Permission:** member must hold any role in `MOD_ROLE_IDS` (comma list in `wrangler.toml`) or hold `ADMIN_ROLE_ID`. Officers always pass.
- **YouTube** — connections are saved when present, but live announcements for YouTube channels are not implemented in v1. Twitch only for now.
- **Adding the connection** — direct streamers to **Discord User Settings → Connections → Add → Twitch** and authenticate with their Twitch account before running `/register-stream`. The bot can't read connections that aren't there yet.
- **Social Links** — Discord, Twitch, Facebook, Instagram, Twitter/X, Subscribe, Outlook group, Status page URLs.
- **Settings** — read-only view of bot/JWT secret status and the current guild. Guild ID and Admin Role ID are managed in `worker/wrangler.toml` by developers. Also has a **Sign Out** button.

### Common operational tasks

- **A new member isn't showing up on the public site.** Their role probably isn't in Roles Config, the 5-min cache hasn't expired yet, or they've opted themselves out via `/toggle-public-membership`. Hit "Refresh Member Cache" on the dashboard; check the "🚫 Hidden from public" filter in Members to confirm they aren't opted out.
- **Member's avatar / display name is wrong.** Members get their avatar and display name from Discord. After they update it there, refresh the cache.
- **A member appears under the wrong role.** Roles in Discord override anything here — fix it in Discord and refresh the cache.
- **Member count on the dashboard looks wrong.** The dashboard counts only members with at least one *configured* role. Check Roles Config.

---

## For Developers

### Project layout

```
worker/
  src/
    index.js               Router + CORS + cron dispatch (scheduled())
    auth.js                HS256 JWT sign/verify, requireAuth/requireOfficer/requireMod/
                            requireTournamentStaff/requireTournamentAdmin, getTier()
    discord.js              Discord API: guild members, roles, OAuth exchange
    discord-interactions.js Ed25519 signature verification for /api/interactions
    discord-events.js       Discord scheduled-events fetch + live/archive cache
    twitch.js               Twitch Helix + EventSub client
    matchplay.js            MatchPlay API client (Bearer auth)
    challonge.js             Challonge API v1 client (api_key param)
    tournament-platform.js  Platform router — VALID_PLATFORMS, getOpenTournaments,
                            getMatchPlayOrganizerIds, pruneStaleTournaments
    tournament-actions.js   announceTournament / startLiveTournament / endTournament
                            (shared by slash commands + admin API)
    tournament-scheduler.js 1-min cron: edits live queue + leaderboard Discord messages
    tournament.js           Discord embed builders (platform-agnostic)
    games-grader.js         Wordle/Framed/Connections/Strands/custom board parser + scorer + bonus rules
    games-grader-scheduler.js  1-min cron poller for the daily-games channel
    grader-config.js        Grader config schema, validation, defaults, board presets
    statbot.js              Statbot Premium API client
    statbot-daily.js        Builds + posts the 6pm-Central daily stats embed
    welcome.js              New-member welcome DM (member-snapshot diff each cron tick)
    checkins.js             Event check-in record storage/lookup (CHECKINS KV)
    streamers.js            Streamer registry: register/unregister, EventSub wiring
    event-publish-requests.js  /request-event-publish approve/deny flow
    member-opt-outs.js      Public-member-list opt-out storage
    routes/
      public.js       /api/public/* — no auth, used by cspiregaming.github.io
      admin.js        /api/admin/*  — requireAuth-gated CRUD + auth flow
      interactions.js /api/interactions — slash commands, buttons, autocomplete
      streamers.js    Streamer admin routes + Twitch EventSub webhook handling
      checkins.js     /api/checkin + /api/admin/checkins* (see checkins.js)
    scripts/register-commands.js  Registers Discord slash commands (run by CI post-deploy)
  wrangler.toml       Bindings, vars, KV namespace IDs

admin/
  index.html          SPA shell (worker base URL in <meta>)
  css/admin.css       Styles
  js/
    api.js            fetch wrapper, all endpoints
    app.js            Bootstrap, login screen, nav
    views/*.js        One per section
```

### Local development

```bash
cd worker
npm install
npx wrangler dev          # starts at http://localhost:8787
```

The admin SPA points at `<meta name="worker-base">` in `admin/index.html`. For local UI work, either edit that meta to `http://localhost:8787` or open `admin/index.html` directly in a browser — it defaults to localhost when not loaded from a known origin.

`admin/js/app.js` has a `DEV_PREVIEW` flag (false in committed code). Setting it to `true` skips the auth check on bootstrap so you can iterate on view styling without a worker session. **Never commit it set to true.**

### Testing

**Current state: zero automated test coverage.** No test directory, no test framework dependency, no `test` script in `worker/package.json`. Everything here has shipped and been verified manually against the deployed worker.

Recommended plan, in priority order (each phase should land independently rather than waiting for full coverage):

1. **Set up the framework.** Add [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) as a devDependency — it runs tests inside the actual `workerd` runtime (via `wrangler.toml`), so KV bindings, `Request`/`Response`, and Web Crypto behave exactly as in production, unlike a generic Node test runner with mocked globals.
2. **Auth/security first** (`auth.js`, `discord-interactions.js`) — highest blast radius if broken: JWT sign/verify round-trip, tier resolution (`getTier()`) for all four roles including the legacy-JWT-without-`roles` back-compat path (§V.3 in `SPEC.md`), Ed25519 signature verification accepting valid signatures and rejecting invalid/missing ones.
3. **Idempotency guards** (§V.4) — games-grader high-water-mark advance, statbot-daily once-per-day guard, welcome-DM snapshot diff (especially the first-run bootstrap sends-no-DMs case), Twitch subscription creation not double-creating.
4. **Pure logic with no KV/network dependency** — `games-grader.js` parser/scorer (all board types, especially edge cases like a 0-mistake vs. 4+-mistake Connections board) and `grader-config.js` schema validation are the easiest wins: no mocking required, straightforward input → output assertions.
5. **Route-level tests** for the public endpoints (`/api/public/members`, `/api/public/content`) — these are the site's only integration point with the worker, so a contract-shape regression here breaks production silently.
6. **Tournament platform abstraction** (`tournament-platform.js`) — `pruneStaleTournaments()`'s missing-API-key skip logic (§V.5) is exactly the kind of edge case that's easy to regress without a test.

Skip: admin CRUD routes that are thin KV read/write passthroughs (`officers`, `events`, `social`) — low value relative to effort until the framework and the higher-risk areas above are in place.

### KV namespace contents

| Binding | Key | Value |
| --- | --- | --- |
| `CONFIG` | `role_ids` | JSON array of Discord role IDs to show publicly. Written by Roles Config in the admin UI. |
| `CONFIG` | `default_role_id` | Optional Discord role ID that should be the active filter chip on first load of the public Members section. Absent (or unset) means "All Members". |
| `CONFIG` | `grader_config` | JSON `{legend: {score1..score6, miss}, boards: [{id, name, parserType, headerRegex, legend?, bonuses?, samples?, extractors?, scoring?}]}` driving the daily-games grader. Written by the Daily Games admin view; falls back to in-code defaults if absent. |
| `CONFIG` | `welcome_config` | JSON `{enabled, message}` for the new-member welcome DM. Written by the Welcome admin view (`GET`/`PUT /api/admin/welcome`); falls back to `DEFAULT_WELCOME_MESSAGE` if absent. |
| `CONFIG` | `welcome_member_snapshot` | JSON array of guild member IDs, diffed each cron tick to detect new joins for the welcome DM. `null` until the first cron tick bootstraps it (bootstrap run sends no DMs, just seeds the snapshot, to avoid mass-DMing the whole guild on first deploy). |
| `CONFIG` | `statbot_last_run_date` | `YYYY-MM-DD` (Central) of the last daily Statbot report post. Idempotency guard so the report only fires once per day; also drives the "next run" label in the admin Settings status panel. |
| `CONFIG` | `statbot_channel_targets` | JSON array of channel IDs (subset of `BOT_LOGS_CHANNEL_ID`/`BOT_COMMANDS_CHANNEL_ID`) the daily report posts to. Written by the Statbot admin view. |
| `CONFIG` | `tournament:matchplay:organizers` | JSON array of MatchPlay organizer IDs the tournament discovery/cron scans. `MATCHPLAY_ORGANIZER_ID` (`wrangler.toml`) is only a bootstrap seed used when this list is empty. Managed via the Tournament admin view's organizer sub-resource. |
| `CONFIG` | `tournament:state:{platform}:{id}` | JSON tournament state (`platform` ∈ `matchplay`\|`challonge`) — announcement/live/end status, message IDs for the live queue + leaderboard embeds, last-posted standings hash (skips a re-edit if unchanged). Written/read by `worker/src/tournament-actions.js` and `tournament-scheduler.js`; pruned by `pruneStaleTournaments()`, which skips a platform's staleness check entirely if that platform's API key secret is absent. |
| `CONTENT` | `officers` | JSON array of `{id, name, image, about, order, createdAt, updatedAt?}` |
| `CONTENT` | `events` | JSON array of `{id, title, subtitle, description, actionButtonText, actionButtonUrl, googleMapsUrl, imagePath, createdAt, updatedAt?}` |
| `CONTENT` | `discord_event_overlays` | JSON object keyed by Discord scheduled-event ID. Each entry: `{published, actionButtonText?, actionButtonUrl?, eventButtonText?, eventButtonUrl?}` (the event button is a second, RSVP-style button; `eventButtonUrl` is required for it to render and text defaults to `RSVP`). Only events with `published === true` show on the public site. Empty entries are deleted. |
| `CONTENT` | `past_discord_events` | JSON object keyed by Discord event ID, snapshotted when an event completes or disappears from Discord. Each entry is the normalized event shape plus `archivedAt`. Pruned to entries newer than 30 days every time the live cache misses. |
| `CONTENT` | `event_publish_requests` | JSON object keyed by Discord interaction ID. Each entry: `{id, eventId, requestedBy, requestedAt, status: 'pending'\|'approved'\|'denied', channelId, channelMessageId, decidedBy?, decidedAt?, downgradeReason?}`. Pruned 30 days after `decidedAt`. |
| `CONTENT` | `public_member_opt_outs` | JSON object keyed by Discord user ID → `{discordId, optedOutAt, source: 'self'\|'officer', actorId?, actorName?}`. Carves out individual members who shouldn't appear on the public Members section even though they hold a configured role. Written by `/toggle-public-membership` (self) and `/api/admin/members/opt-outs/{id}` (officer). Filtered at response time in `/api/public/members`. |
| `CONTENT` | `streamers` | JSON object keyed by Discord user ID. Each entry: `{discordId, discordUsername, displayName, registeredAt, updatedAt, isOfficial?, twitch?: {userId, login, displayName, eventSubIds: {online, offline}}, youtube?: {channelId, name}}`. Written by the `/register-stream` OAuth callback; deleted by `/unregister-stream`. Official channels (the C Spire Gaming Twitch account) use `discordId = "official:<twitchUserId>"` and have `isOfficial: true`. |
| `CONTENT` | `streamers_by_twitch` | JSON object keyed by Twitch user ID → Discord user ID. Reverse index used by the EventSub webhook to resolve incoming `stream.online` notifications back to a streamer record. |
| `CONTENT` | `daily_games_last_seen` | Last Discord message ID processed by the games-grader cron in `DAILY_GAMES_CHANNEL_ID`. Acts as a high-water mark so each tick only inspects messages newer than the previous run. Initialized to the most-recent message on first run (no historical backfill). |
| `CONTENT` | `social` | JSON object `{discord, twitch, facebook, instagram, twitter, subscribe, exchange, status}` |
| `CACHE` | `members_<guildId>` | cached members payload, TTL 300s |
| `CACHE` | `discord_events_live` | cached normalized list of Discord scheduled events, TTL 300s |
| `CACHE` | `discord_events_seen` | last-seen normalized list (TTL 7 days) — used to detect events that disappeared from Discord so they can be archived |
| `CACHE` | `twitch_app_token` | Twitch app access token (client_credentials grant), TTL = Twitch's `expires_in` minus 5 minutes. |
| `CHECKINS` | `checkin:<uuid>` | One event check-in record: `{id, checkedInAt, gamertag, fullName, email, employeeFlag, outreachFlag, eventId?, eventTitle?, eventStartTime?, eventSource?}`. Written by `POST /api/checkin` (kiosk-facing, no auth). |
| `CHECKINS` | `event:<eventId>:checkins` / `event:none:checkins` | Index of check-in IDs for a given event (or the unaffiliated bucket when no active event is set). Used by `GET /api/admin/checkins?eventId=…` to scope a query without a full table scan. |
| `CHECKINS` | `index:email:<lower>` / `index:gamertag:<lower>` | Lookup indexes (lowercased) used by `recordCheckIn()` to return a check-in's prior-visit history to the kiosk UI. |

### API reference

All admin endpoints require a valid `admin_token` cookie (set by the OAuth callback) or a `Bearer` JWT in `Authorization`. Public endpoints have no auth.

The OAuth callback admits members with **either** `ADMIN_ROLE_ID` (officer) or any role in `MOD_ROLE_IDS` (mod). The user's full Discord role list is embedded in the JWT, and per-endpoint middleware (`requireOfficer` / `requireMod` in `worker/src/auth.js`) enforces tier. Endpoints below are marked *Officer* (admin-only) or *Mod or officer* (both tiers); the unmarked auth helpers default to *Officer*.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/interactions` | Discord interactions endpoint. Verifies Ed25519 signatures via `DISCORD_PUBLIC_KEY`. Handles PING, slash commands (`/request-event-publish`, `/register-stream`, `/unregister-stream`, `/streamer-list`, `/streamer-remove`, `/parrotbomb`, `/toggle-public-membership`), button clicks (Approve/Deny on the officers-channel post), and autocomplete. Discord-only — not called by the SPA or public site. |
| GET | `/api/auth/stream-callback` | OAuth callback for `/register-stream`. Verifies the JWT state token, exchanges the code for a Discord access token, reads `/users/@me/connections`, then asynchronously creates Twitch EventSub subscriptions, assigns the `@streamer` role, and follows up to the original interaction. Returns a static success page. |
| POST | `/api/twitch/eventsub` | Twitch EventSub webhook. Verifies HMAC-SHA256 signatures with `TWITCH_EVENTSUB_SECRET`. Handles the one-time `webhook_callback_verification` challenge plus `notification` (posts the live embed for `stream.online`) and `revocation` (logs only). |
| GET | `/api/public/members` | Returns members with at least one configured role + role metadata + `defaultRoleId` (the role ID the public site should pre-select, or `null` for "All Members"). Cached 5 min. |
| GET | `/api/public/content` | Returns `{officers, events, social}`. `events` is a unified, time-sorted list combining published Discord events (live + recent-past archive) with manually-curated events; each entry has `source: 'discord' \| 'manual'` plus the rendering fields (`title, subtitle, description, startTime, endTime, status, location, imagePath\|coverImage, actionButtonText, actionButtonUrl, eventButtonText?, eventButtonUrl?, googleMapsUrl, discordUrl?`). |
| GET | `/api/auth/discord` | 302 → Discord OAuth authorize URL. |
| GET | `/api/auth/callback` | Discord redirects here. Sets `admin_token` cookie, redirects to `ADMIN_URL`. |
| POST | `/api/auth/logout` | Clears the `admin_token` cookie. |
| GET, PUT | `/api/admin/config` | GET returns `{guild_id, role_ids, default_role_id, bot_token_set, jwt_secret_set}` for the dashboard/settings views. PUT accepts `{role_ids, default_role_id}` (both optional, used by Roles Config); `default_role_id` is cleared when set to `null`, `"all"`, or a role ID not present in the saved `role_ids`. Also invalidates the member cache. |
| GET | `/api/admin/roles` | All roles in the guild via the bot, minus `@everyone`. Used by Roles Config. *Officer.* |
| GET | `/api/admin/members/opt-outs` | Returns `{optOuts: {<discordId>: {...}}}` — every member currently opted out of the public list. *Officer.* |
| PUT | `/api/admin/members/opt-outs/{discordId}` | Body `{optedOut: bool}`. Opt the given Discord user out of (or back into) the public Members section. Records `source: 'officer'` plus `actorId`/`actorName` for audit. *Officer.* |
| GET, PUT | `/api/admin/grader` | GET returns `{config, defaults, parserTypes, legendKeys, extractorKinds, ruleOps, presets}`. PUT replaces `CONFIG:grader_config` after schema validation. *Mod or officer.* |
| POST | `/api/admin/grader/test` | Body: `{content, config?}`. Runs the grader against `content` using the supplied draft `config` (if any) or the saved one. Returns `{grade}` where `grade` is `null` or `{game, score, emoji, emojis, fail, values, bonuses}` (`emojis` = primary + bonus reactions; `values` = extracted numbers). *Mod or officer.* |
| GET | `/api/admin/emojis` | Returns the guild's custom-emoji catalog as `{id, name, animated, available, reaction, url}`. Used by the Daily Games view's emoji picker. *Mod or officer.* |
| GET | `/api/admin/members` | Same as public, but bypasses cache and includes each member's Discord `id` plus `optedOut: bool` (whether they're hidden from the public list). `?format=csv` exports CSV (adds an `optedOut` column). |
| GET, POST | `/api/admin/officers` | List or create. POST returns the new item with a generated `id`. |
| GET, PUT, DELETE | `/api/admin/officers/{id}` | Read, update, or delete one officer. |
| GET, POST | `/api/admin/events` | Manually-curated events. Same shape as officers. |
| GET, PUT, DELETE | `/api/admin/events/{id}` |  |
| GET | `/api/admin/discord-events` | Returns `{live, archived, overlays}`. `live` and `archived` are normalized Discord scheduled events; `overlays` is the `discord_event_overlays` map. Calling this also runs the archive/prune logic when the live cache misses (every ~5 minutes). |
| PUT | `/api/admin/discord-events/{eventId}` | Body: `{published, actionButtonText?, actionButtonUrl?, eventButtonText?, eventButtonUrl?}`. Writes (or removes if all fields empty) one entry in `discord_event_overlays`. |
| PUT | `/api/admin/discord-events` | Batch update. Body: `{overlays: {<eventId>: {published, actionButtonText?, actionButtonUrl?}}}`. Single read-modify-write across the whole map; the admin UI uses this to avoid races when toggling multiple events at once. |
| GET, PUT | `/api/admin/social` | Object stored under `CONTENT:social`. |
| GET | `/api/admin/streamers` | Returns `{streamers: [...]}` — every record in `CONTENT:streamers`, sorted by display name. Backs the admin SPA's Streamers section. |
| DELETE | `/api/admin/streamers/{discordId}` | Body: `{reason}` (≥10 chars). Calls the same `unregisterStreamer` teardown as `/streamer-remove` and posts the same audit-log embed in `OFFICERS_CHANNEL_ID`. 400 if the reason is too short, 404 if the user isn't registered. |
| POST | `/api/admin/streamers/{discordId}/test-live` | Posts a preview of the live-announcement embed to `BOT_LOGS_CHANNEL_ID`. Suppresses the @-mention so the streamer isn't pinged. Pulls live stream data via Helix when the broadcaster is online; otherwise uses generic placeholder text with the same layout. 400 if the streamer has no Twitch link or `BOT_LOGS_CHANNEL_ID` isn't set. |
| POST | `/api/admin/streamers/official` | Body: `{twitchLogin}`. Resolves the login via Helix, creates an official streamer record (`isOfficial: true`, synthetic `discordId = official:<twitchUserId>`), and registers Twitch EventSub. Idempotent — re-registering the same login reuses the existing record + subs. 400 if the login can't be resolved. |
| GET | `/api/admin/twitch/status` | Returns `{secrets, token, live_announce_channel_id, subscriptions, total_cost, max_total_cost, streamers}`. `secrets` is `{client_id, client_secret, eventsub_secret}` (boolean presence flags). `token` is `{ok, error}` from a live app-token fetch. `subscriptions` is the full paginated list from Twitch's EventSub API. `streamers` is all KV streamer records that have a Twitch connection. *Officer.* |
| POST | `/api/admin/twitch/sync` | Re-creates missing or orphaned EventSub subscriptions for all registered streamers. For each streamer, if either stored sub ID is absent from Twitch's active list, a new subscription is created and the KV record is updated. Returns `{ok, synced, errors}`. *Officer.* |
| DELETE | `/api/admin/twitch/subscriptions/{id}` | Deletes one EventSub subscription from Twitch by ID. Returns `{ok}`. *Officer.* |
| POST | `/api/admin/twitch/test-announce` | Body: `{discordId}`. Posts a suppressed preview embed to `LIVE_ANNOUNCE_CHANNEL_ID` (not `BOT_LOGS_CHANNEL_ID`), confirming the bot has permission to post in the real announcement channel. Returns `{ok}` or `{ok: false, error}`. *Officer.* |
| POST | `/api/checkin` | Public, no auth. Kiosk-facing event check-in. Body per `worker/src/checkins.js`; returns `{checkin, priorVisits}` so the kiosk can show a "welcome back" message. 400 on validation failure. |
| GET | `/api/admin/statbot/status` | Returns `{apiKeyConfigured, lastRunDate, nextRunLabel, centralNow, logsChannelId, commandsChannelId, enabledChannelIds}`. *Officer.* |
| PUT | `/api/admin/statbot/channels` | Body `{enabledChannelIds}` — which of `BOT_LOGS_CHANNEL_ID`/`BOT_COMMANDS_CHANNEL_ID` the daily report posts to. *Officer.* |
| GET | `/api/admin/statbot/preview` | Builds (without posting) today's daily-stats embed via the Statbot Premium API. Requires `STATBOT_API_KEY`. *Officer.* |
| POST | `/api/admin/statbot/run` | Forces an immediate daily-stats report post, bypassing the once-per-day KV guard. Requires `STATBOT_API_KEY`. *Officer.* |
| GET | `/api/admin/welcome` | Returns `{enabled, message, snapshotSize, bootstrapped}` for the new-member welcome DM. *Officer.* |
| PUT | `/api/admin/welcome` | Body `{enabled?, message?}` (partial update) — edit the welcome DM. *Officer.* |
| GET | `/api/admin/tournament` | Returns `{apiKeys, defaults, notificationsChannelId, tournaments}` — every tracked tournament's live state (both platforms), pruning stale entries first. *Tournament staff or admin.* |
| GET | `/api/admin/tournament/discover` | Cross-platform search for open tournaments (MatchPlay across configured organizers + the configured Challonge subdomain). *Tournament staff or admin.* |
| POST | `/api/admin/tournament/{platform}/{id}/announce` | Post the initial tournament announcement embed. *Tournament staff or admin.* |
| POST | `/api/admin/tournament/{platform}/{id}/live` | Start the 1-minute live queue + leaderboard cron updates. 409 `alreadyActive` if already running. *Tournament staff or admin.* |
| POST | `/api/admin/tournament/{platform}/{id}/end` | Stop live updates. 409 `notRunning` if not currently live. *Tournament staff or admin.* |
| DELETE | `/api/admin/tournament/{platform}/{id}` | Drop the tournament's KV state entirely. *Tournament staff or admin.* |
| GET | `/api/admin/tournament/organizers/matchplay` | Returns `{ids}` — the stored MatchPlay organizer allowlist (KV is source of truth; `MATCHPLAY_ORGANIZER_ID` env var only seeds it when empty). *Tournament staff or admin.* |
| POST | `/api/admin/tournament/organizers/matchplay` | Body `{id}`. Adds an organizer ID (idempotent — already-present IDs are a no-op). *Tournament staff or admin.* |
| DELETE | `/api/admin/tournament/organizers/matchplay/{id}` | Removes an organizer ID. *Tournament staff or admin.* |
| GET | `/api/admin/checkins/active-event` | Returns `{activeEvent}` — the event currently selected for kiosk check-ins, or `null`. *Tournament staff or admin.* |
| PUT | `/api/admin/checkins/active-event` | Body `{eventId, source: 'discord'\|'manual'}`. Builds and stores a snapshot of the chosen event as the active check-in target. 404 if the event isn't found in that source. *Tournament staff or admin.* |
| DELETE | `/api/admin/checkins/active-event` | Clears the active event. *Tournament staff or admin.* |
| GET | `/api/admin/checkins/event-candidates` | Returns `{discord: {live, archived}, manual}` — the event picker's candidate pool for setting the active event. *Tournament staff or admin.* |
| GET | `/api/admin/checkins` | Query params `eventId` (`all`\|`none`\|specific ID, default `all`), `from`, `to`, `format` (`json`\|`csv`). Lists/exports check-in records. *Tournament staff or admin.* |

### Auth model

1. User hits `/api/auth/discord` → 302 to Discord with `client_id` and `redirect_uri=worker/api/auth/callback`. Scopes: `identify guilds.members.read`.
2. Discord posts back to `/api/auth/callback` with a code.
3. Worker exchanges the code for a Discord access token, then calls:
   - `GET /users/@me` for identity
   - `GET /users/@me/guilds/{GUILD_ID}/member` to read the user's roles in our guild — this 404s if they aren't a member, which is the first gate.
4. If `env.ADMIN_ROLE_ID` is set (in `wrangler.toml [vars]`) and the user's `member.roles` doesn't include it, redirect to admin with `?error=not_authorized`. **If `ADMIN_ROLE_ID` is empty, this check is skipped** — any guild member gets in.
5. Otherwise sign an HS256 JWT (7-day expiry) and set it as `admin_token` cookie (`HttpOnly; Secure; SameSite=None`) on the worker domain. Redirect to `ADMIN_URL`.
6. The admin SPA's `fetch(..., credentials: 'include')` calls back to the worker carry the cookie cross-site (worker on `api.cspiregaming.com`, admin on `cspiregaming.github.io`/`cspiregaming.com`).

`SameSite=None` is required because the admin SPA is on a different site than the worker. The cookie is `Secure`, so the worker must be HTTPS — it is.

### Deployment

CI (`.gitlab-ci.yml`):

- **`deploy-worker`** — runs `npx wrangler deploy` from `worker/` on every push to `main`.
- **`register-discord-commands`** — runs `node scripts/register-commands.js` after `deploy-worker` succeeds. Discord's bulk-overwrite endpoint is idempotent, so this is safe (and cheap) on every push.
- **`pages`** — copies `admin/` into `public/` and publishes to GitLab Pages.

Required CI/CD variables (Settings → CI/CD → Variables in csgit, masked + protected):

- `CLOUDFLARE_API_TOKEN` — Cloudflare token with the **Edit Cloudflare Workers** template, or manually: Account → Workers Scripts: Edit, Workers KV Storage: Edit, Account Settings: Read.
- `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard sidebar or `npx wrangler whoami`.
- `DISCORD_APP_ID` — Discord application ID (same value as the `DISCORD_CLIENT_ID` secret; safe to expose).
- `BOT_TOKEN` — Discord bot token (masked + protected). Used by the slash-command registration job. Note: `wrangler secret put BOT_TOKEN` stores the token in **Cloudflare** for the worker runtime; the registration job runs in a separate GitLab CI container, so the token must also exist as a GitLab CI variable here.

Manual deploy:

```bash
cd worker
npx wrangler deploy

# Register / refresh slash commands (CI does this automatically on push to main)
DISCORD_APP_ID=… GUILD_ID=379707231077138442 BOT_TOKEN=… npm run register-commands
```

### Adding a new content type (worked example)

To add, say, a "FAQ" section managed from the admin and exposed publicly:

1. **Worker route:** in `worker/src/routes/admin.js`, add `handleAdminFaq` that calls `handleCrudCollection(request, env, 'faq')`. Wire it in `worker/src/index.js` like the existing `path.startsWith('/api/admin/...')` handlers.
2. **Public read:** in `worker/src/routes/public.js`, extend `handlePublicContent` to also return `faq`, or add a dedicated `/api/public/faq` route.
3. **API client:** add `getFaq`, `createFaq`, `updateFaq`, `deleteFaq` to `admin/js/api.js`.
4. **View:** copy `admin/js/views/officers.js` to `views/faq.js`, swap field names. Register it in `app.js` and add a sidebar nav entry in `renderApp()`.
5. **Public site:** in `cspiregaming.github.io`, fetch `/api/public/content` (or your new endpoint) from `MainCtrl` and template the result.

### Discord application

The bot and OAuth app live in the same Discord application at https://discord.com/developers/applications.

- **Bot tab** — enable the **Server Members Intent** (privileged). Without it, member fetching fails silently with empty results.
- **OAuth2 → Redirects** — register both of these URLs *exactly*:
  - `https://api.cspiregaming.com/api/auth/callback` (admin sign-in)
  - `https://api.cspiregaming.com/api/auth/stream-callback` (`/register-stream`)
  If either isn't registered, the corresponding flow fails with "invalid redirect_uri" before reaching the worker.
- **General Information → Interactions Endpoint URL** — set to `https://api.cspiregaming.com/api/interactions`. Discord PINGs the endpoint when you save the URL; the worker must already be deployed with the route live, or the save will fail with a verification error.
- **General Information → Public Key** — copy this into the `DISCORD_PUBLIC_KEY` secret (`wrangler secret put DISCORD_PUBLIC_KEY`). Used to verify Ed25519 signatures on every interaction request.
- **Bot → Reset Token / Generate** if you need to rotate the bot token. Then run `wrangler secret put BOT_TOKEN`.
- The bot must be invited to guild `379707231077138442` with **both** the `bot` and `applications.commands` scopes. Without `applications.commands`, slash commands silently won't appear in the picker. Re-invite URL: `https://discord.com/oauth2/authorize?client_id=<DISCORD_APP_ID>&scope=bot+applications.commands&permissions=0`.
- Bot must have **View Server Members** for the members feature, and **View Channel + Send Messages + Embed Links** in the channels referenced by `OFFICERS_CHANNEL_ID` (publish-request flow) and `LIVE_ANNOUNCE_CHANNEL_ID` (Twitch live announcements).
- Bot needs **View Channel + Read Message History + Add Reactions** in `DAILY_GAMES_CHANNEL_ID` for the daily-games auto-grader.
- Bot needs **View Channel + Send Messages + Embed Links** in `BOT_LOGS_CHANNEL_ID` for the admin SPA's "Test Embed" preview button.
- Bot needs **Manage Roles** in the guild, with the `@streamer` role positioned *below* the bot's highest role, so `/register-stream` can grant it.

### Twitch application

The streamer flow requires a Twitch app on https://dev.twitch.tv/console/apps:

- **Register Your Application** — name (e.g. "C Spire Gaming Live Watcher"), OAuth Redirect URLs `https://localhost` (unused — we only use client_credentials), Category "Application Integration".
- Copy the **Client ID** into `wrangler secret put TWITCH_CLIENT_ID`.
- **New Secret** → copy into `wrangler secret put TWITCH_CLIENT_SECRET`.
- Generate a random ≥10-char string (`openssl rand -hex 32`) and put it into `wrangler secret put TWITCH_EVENTSUB_SECRET`. This is the shared HMAC secret for all EventSub subscriptions; rotating it requires re-creating every subscription, so leave it stable.
- The worker creates EventSub subscriptions per registered streamer; you don't need to configure anything per-channel in the Twitch console. Subscriptions are visible at `https://dev.twitch.tv/console/apps/<your-app>/eventsub`.

### First-time Cloudflare setup

```bash
cd worker
npm install

npx wrangler kv namespace create CONFIG
npx wrangler kv namespace create CONFIG --preview
npx wrangler kv namespace create CONTENT
npx wrangler kv namespace create CONTENT --preview
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --preview
```

Wrangler v4 will edit `wrangler.toml` in place to fill the IDs in. (KV namespace IDs are not secrets — they're committed.)

Then set secrets:

```bash
npx wrangler secret put BOT_TOKEN              # Discord bot token
npx wrangler secret put JWT_SECRET             # any random string: openssl rand -hex 32
npx wrangler secret put DISCORD_CLIENT_ID      # Discord OAuth2 application client ID
npx wrangler secret put DISCORD_CLIENT_SECRET  # Discord OAuth2 application client secret
npx wrangler secret put DISCORD_PUBLIC_KEY     # Discord application Public Key (Developer Portal → General Information)
npx wrangler secret put TWITCH_CLIENT_ID       # Twitch app Client ID (dev.twitch.tv → Apps)
npx wrangler secret put TWITCH_CLIENT_SECRET   # Twitch app Client Secret
npx wrangler secret put TWITCH_EVENTSUB_SECRET # Random ≥10-char string: openssl rand -hex 32
```

Then fill in the public-but-non-secret IDs in `wrangler.toml [vars]`: `DISCORD_APP_ID`, `OFFICERS_CHANNEL_ID`, `REQUESTER_ROLE_IDS`, `MOD_ROLE_IDS`, `STREAMER_ROLE_ID`, `LIVE_ANNOUNCE_CHANNEL_ID`, `COMMUNITY_STREAM_ROLE_ID`, `CSG_STREAM_ROLE_ID`, `DAILY_GAMES_CHANNEL_ID`, and `BOT_LOGS_CHANNEL_ID`.

Then `npx wrangler deploy` once manually so the worker exists, after which CI takes over.

### Operational recipes

- **Rotate `JWT_SECRET`:** `wrangler secret put JWT_SECRET`. All existing admin sessions invalidate immediately and users re-sign-in.
- **Force-clear member cache without saving config:** the dashboard's "Refresh Member Cache" button does this by re-PUTing the existing `role_ids` (the PUT handler invalidates the cache as a side effect).
- **Switch guilds or change the admin role:** edit `GUILD_ID` / `ADMIN_ROLE_ID` in `worker/wrangler.toml [vars]`, deploy. Ensure the bot is in the target guild with the right intent.
- **Change the admin URL:** update `ADMIN_URL` in `wrangler.toml` *and* add the new origin to `ALLOWED_ORIGINS` in `worker/src/index.js`. The post-OAuth redirect goes to `ADMIN_URL`; the cross-site fetch CORS check uses `ALLOWED_ORIGINS`.
- **Worker isn't deploying via CI:** check the Node version in `.gitlab-ci.yml` — wrangler 4 needs Node ≥22.

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Admin sign-in lands on a 404 at `…workers.dev/admin/` | `ADMIN_URL` not set in `wrangler.toml`. |
| 401 on every admin call right after sign-in | Cookie didn't make it cross-site. Check `SameSite=None; Secure` and that the admin SPA origin is in `ALLOWED_ORIGINS`. |
| Members section is empty on the public site | (a) no roles configured in Roles Config, or (b) bot is missing the Server Members Intent, or (c) bot was kicked from the guild. |
| Discord Events admin section shows nothing | (a) no scheduled events exist in the guild, or (b) the bot lacks `VIEW_CHANNEL` on the channel hosting a voice-channel event (external-location events don't need this). External-location and stage events that the bot can see are returned regardless. |
| Published Discord event isn't appearing on the public site | Check that `published === true` for that event ID in `CONTENT:discord_event_overlays`, the event isn't `CANCELED`, and the live event cache isn't stale (TTL 5 min — wait it out, or delete the `discord_events_live` key from the `CACHE` KV namespace via `wrangler kv key delete`). |
| `/request-event-publish` doesn't appear in Discord's slash command picker | Bot was invited without the `applications.commands` scope. Re-invite with both `bot` and `applications.commands` (URL in [Discord application](#discord-application)). After re-invite, the next CI run (or a manual `npm run register-commands`) registers the command. |
| `/register-stream` returns "Link expired" or "User mismatch" | OAuth state JWT is signed with `JWT_SECRET`; rotating it invalidates outstanding links. User mismatch means the user signed into Discord as a different account than the one that ran the slash command — re-run the command from the right account. |
| `/register-stream` says "No streaming connections found" | The user hasn't added Twitch (or YouTube) under Discord User Settings → Connections yet. Have them add the connection and re-run the command. |
| User registered but Twitch live announcements don't post | Open the **Twitch** section in the admin SPA. Check that all secrets show ✓ and the app token is Working. Verify `LIVE_ANNOUNCE_CHANNEL_ID` shows the correct channel ID. Use the **Test** button on a stream.online row to confirm the bot can post in the announcement channel. If subscriptions are missing, hit **Sync All**. For deeper inspection, `wrangler tail` will show errors from `announceLive` — note that Twitch's "Test Notification" buttons in the dev console don't send HMAC-signed webhooks and cannot be used to test the live path. |
| Twitch EventSub subscription stuck in `webhook_callback_verification_pending` | Worker isn't responding to the challenge within 10s. Check that the worker is deployed with `/api/twitch/eventsub` live, and `TWITCH_EVENTSUB_SECRET` matches what was used when the subscription was created. Delete the stuck subscription from the **Twitch** admin panel and re-register (or hit Sync All) to get a fresh one. |
| Saving the Interactions Endpoint URL in the Developer Portal fails | Worker must be deployed with the `/api/interactions` route live before saving the URL — Discord PINGs the endpoint and rejects the save on any failure. Check `wrangler tail` for incoming PINGs and signature-verification errors; usually means `DISCORD_PUBLIC_KEY` isn't set or has a typo. |
| Approve/Deny buttons do nothing | Check `wrangler tail` while clicking. Most likely cause: the clicker doesn't have `ADMIN_ROLE_ID` (worker rejects with an ephemeral message) or `BOT_TOKEN` was rotated and the bot can't edit its own message. |
| "Discord roles fetch failed: 401" in worker logs | `BOT_TOKEN` not set or rotated. |
| `wrangler deploy` complains about Node version | Wrangler 4 needs Node ≥22. CI uses `node:22-alpine`. |
| Manual entry box is missing in Roles Config | Intentional — the full guild role list is fetched via `/api/admin/roles`, no manual ID entry needed. |
