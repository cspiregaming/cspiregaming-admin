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

The worker is the only thing officers' web browsers and the public homepage talk to. State lives in three Cloudflare KV namespaces; member rosters are pulled live from Discord and cached for 5 minutes.

```
cspiregaming.github.io ─┐
                        ├──► Worker ──► Discord API (bot token)
Admin SPA ──────────────┘       │
                                ├──► KV: CONFIG  (settings)
                                ├──► KV: CONTENT (officers, events, social)
                                └──► KV: CACHE   (5-min member cache)
```

---

## For Officers

### Signing in

1. Open http://cspiregaming.csgitpages.cspire.net/cspiregaming-workers/.
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
- **Daily Games** *(officers and mods)* — controls for the auto-grader described below. Three panels:
  - **Legend** — edit the score-1..6 + miss emoji reactions. Each cell accepts a single unicode emoji (e.g. `🌟`) or a Discord custom-emoji reference in `name:id` form (e.g. `csgwin:123456789012345678`). Use **Custom Emojis** in the sidebar to find the right `name:id`.
  - **Boards** — add / edit / remove the boards the grader recognizes. Each board picks a built-in parser type (`wordle`, `framed`, `connections`) and a header regex that identifies it. New `wordle`-type boards (e.g. Strands) just need the right regex with a capture group for the score token.
  - **Test** — paste a Discord message body and click **Grade it** to see what the current draft (saved or unsaved) would react with. No need to save first.
  Saves take effect on the next cron tick (≤ 1 minute).
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

**Parser types** are built-in and not user-editable (adding a brand-new shape needs code in `worker/src/games-grader.js`). Existing types officers can plug new boards into:

- `wordle` — header regex must contain exactly one capture group; that group is the score token (digit or `X`). Score is the digit.
- `framed` — header regex is a presence gate. Scoring looks for the first 🟩 in any line containing 6 🟥/🟩/⬛ squares.
- `connections` — header regex is a presence gate. Also requires a `Puzzle #N` line. Scoring counts solid-same-color rows (groups solved) and mixed rows (mistakes).

A Cloudflare Cron Trigger fires every minute, polls the channel for messages newer than the saved high-water mark (`CONTENT:daily_games_last_seen`), grades each parseable board, and reacts via REST. Bot-authored messages are skipped, so the Wordle Discord App's "your group is on a streak" announcements don't get a grade. Reactions are idempotent on Discord's side, so a manual re-poll won't double-stamp. Config changes take effect on the next tick (≤ 1 minute).

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
    index.js          Router + CORS
    auth.js           HS256 JWT sign/verify, requireAuth middleware
    discord.js        Discord API: guild members, roles, OAuth exchange
    routes/
      public.js       /api/public/* — no auth, used by cspiregaming.github.io
      admin.js        /api/admin/*  — requireAuth-gated CRUD + auth flow
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

### KV namespace contents

| Binding | Key | Value |
| --- | --- | --- |
| `CONFIG` | `role_ids` | JSON array of Discord role IDs to show publicly. Written by Roles Config in the admin UI. |
| `CONFIG` | `default_role_id` | Optional Discord role ID that should be the active filter chip on first load of the public Members section. Absent (or unset) means "All Members". |
| `CONFIG` | `grader_config` | JSON `{legend: {score1..score6, miss}, boards: [{id, name, parserType, headerRegex}]}` driving the daily-games grader. Written by the Daily Games admin view; falls back to in-code defaults if absent. |
| `CONTENT` | `officers` | JSON array of `{id, name, image, about, order, createdAt, updatedAt?}` |
| `CONTENT` | `events` | JSON array of `{id, title, subtitle, description, actionButtonText, actionButtonUrl, googleMapsUrl, imagePath, createdAt, updatedAt?}` |
| `CONTENT` | `discord_event_overlays` | JSON object keyed by Discord scheduled-event ID. Each entry: `{published, actionButtonText?, actionButtonUrl?}`. Only events with `published === true` show on the public site. Empty entries are deleted. |
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

### API reference

All admin endpoints require a valid `admin_token` cookie (set by the OAuth callback) or a `Bearer` JWT in `Authorization`. Public endpoints have no auth.

The OAuth callback admits members with **either** `ADMIN_ROLE_ID` (officer) or any role in `MOD_ROLE_IDS` (mod). The user's full Discord role list is embedded in the JWT, and per-endpoint middleware (`requireOfficer` / `requireMod` in `worker/src/auth.js`) enforces tier. Endpoints below are marked *Officer* (admin-only) or *Mod or officer* (both tiers); the unmarked auth helpers default to *Officer*.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/interactions` | Discord interactions endpoint. Verifies Ed25519 signatures via `DISCORD_PUBLIC_KEY`. Handles PING, slash commands (`/request-event-publish`, `/register-stream`, `/unregister-stream`, `/streamer-list`, `/streamer-remove`, `/parrotbomb`, `/toggle-public-membership`), button clicks (Approve/Deny on the officers-channel post), and autocomplete. Discord-only — not called by the SPA or public site. |
| GET | `/api/auth/stream-callback` | OAuth callback for `/register-stream`. Verifies the JWT state token, exchanges the code for a Discord access token, reads `/users/@me/connections`, then asynchronously creates Twitch EventSub subscriptions, assigns the `@streamer` role, and follows up to the original interaction. Returns a static success page. |
| POST | `/api/twitch/eventsub` | Twitch EventSub webhook. Verifies HMAC-SHA256 signatures with `TWITCH_EVENTSUB_SECRET`. Handles the one-time `webhook_callback_verification` challenge plus `notification` (posts the live embed for `stream.online`) and `revocation` (logs only). |
| GET | `/api/public/members` | Returns members with at least one configured role + role metadata + `defaultRoleId` (the role ID the public site should pre-select, or `null` for "All Members"). Cached 5 min. |
| GET | `/api/public/content` | Returns `{officers, events, social}`. `events` is a unified, time-sorted list combining published Discord events (live + recent-past archive) with manually-curated events; each entry has `source: 'discord' \| 'manual'` plus the rendering fields (`title, subtitle, description, startTime, endTime, status, location, imagePath\|coverImage, actionButtonText, actionButtonUrl, googleMapsUrl, discordUrl?`). |
| GET | `/api/auth/discord` | 302 → Discord OAuth authorize URL. |
| GET | `/api/auth/callback` | Discord redirects here. Sets `admin_token` cookie, redirects to `ADMIN_URL`. |
| POST | `/api/auth/logout` | Clears the `admin_token` cookie. |
| GET, PUT | `/api/admin/config` | GET returns `{guild_id, role_ids, default_role_id, bot_token_set, jwt_secret_set}` for the dashboard/settings views. PUT accepts `{role_ids, default_role_id}` (both optional, used by Roles Config); `default_role_id` is cleared when set to `null`, `"all"`, or a role ID not present in the saved `role_ids`. Also invalidates the member cache. |
| GET | `/api/admin/roles` | All roles in the guild via the bot, minus `@everyone`. Used by Roles Config. *Officer.* |
| GET | `/api/admin/members/opt-outs` | Returns `{optOuts: {<discordId>: {...}}}` — every member currently opted out of the public list. *Officer.* |
| PUT | `/api/admin/members/opt-outs/{discordId}` | Body `{optedOut: bool}`. Opt the given Discord user out of (or back into) the public Members section. Records `source: 'officer'` plus `actorId`/`actorName` for audit. *Officer.* |
| GET, PUT | `/api/admin/grader` | GET returns `{config, defaults, parserTypes, legendKeys}`. PUT replaces `CONFIG:grader_config` after schema validation. *Mod or officer.* |
| POST | `/api/admin/grader/test` | Body: `{content, config?}`. Runs the grader against `content` using the supplied draft `config` (if any) or the saved one. Returns `{grade}` where `grade` is `null` or `{game, score, emoji, fail}`. *Mod or officer.* |
| GET | `/api/admin/emojis` | Returns the guild's custom-emoji catalog as `{id, name, animated, available, reaction, url}`. Used by the Daily Games view's emoji picker. *Mod or officer.* |
| GET | `/api/admin/members` | Same as public, but bypasses cache and includes each member's Discord `id` plus `optedOut: bool` (whether they're hidden from the public list). `?format=csv` exports CSV (adds an `optedOut` column). |
| GET, POST | `/api/admin/officers` | List or create. POST returns the new item with a generated `id`. |
| GET, PUT, DELETE | `/api/admin/officers/{id}` | Read, update, or delete one officer. |
| GET, POST | `/api/admin/events` | Manually-curated events. Same shape as officers. |
| GET, PUT, DELETE | `/api/admin/events/{id}` |  |
| GET | `/api/admin/discord-events` | Returns `{live, archived, overlays}`. `live` and `archived` are normalized Discord scheduled events; `overlays` is the `discord_event_overlays` map. Calling this also runs the archive/prune logic when the live cache misses (every ~5 minutes). |
| PUT | `/api/admin/discord-events/{eventId}` | Body: `{published, actionButtonText?, actionButtonUrl?}`. Writes (or removes if all fields empty) one entry in `discord_event_overlays`. |
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

### Auth model

1. User hits `/api/auth/discord` → 302 to Discord with `client_id` and `redirect_uri=worker/api/auth/callback`. Scopes: `identify guilds.members.read`.
2. Discord posts back to `/api/auth/callback` with a code.
3. Worker exchanges the code for a Discord access token, then calls:
   - `GET /users/@me` for identity
   - `GET /users/@me/guilds/{GUILD_ID}/member` to read the user's roles in our guild — this 404s if they aren't a member, which is the first gate.
4. If `env.ADMIN_ROLE_ID` is set (in `wrangler.toml [vars]`) and the user's `member.roles` doesn't include it, redirect to admin with `?error=not_authorized`. **If `ADMIN_ROLE_ID` is empty, this check is skipped** — any guild member gets in.
5. Otherwise sign an HS256 JWT (7-day expiry) and set it as `admin_token` cookie (`HttpOnly; Secure; SameSite=None`) on the worker domain. Redirect to `ADMIN_URL`.
6. The admin SPA's `fetch(..., credentials: 'include')` calls back to the worker carry the cookie cross-site (worker on `workers.dev`, admin on `csgitpages.cspire.net`).

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
