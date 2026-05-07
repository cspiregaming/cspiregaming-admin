# cspiregaming-workers

Backend API and admin console for [cspiregaming.github.io](https://cspiregaming.github.io). Deployed as a Cloudflare Worker plus a static admin SPA hosted on GitLab Pages.

- **Public site:** https://cspiregaming.github.io
- **Admin console:** http://cspiregaming.csgitpages.cspire.net/cspiregaming-workers/
- **Worker API:** https://cspiregaming-api.michaellamb.workers.dev

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
3. You're in if (a) you're a member of the C Spire Gaming guild and (b) you have the configured Admin Role.

If sign-in fails:

| Error | Meaning | Fix |
| --- | --- | --- |
| "You cancelled the Discord login." | You denied the OAuth prompt. | Click sign-in again. |
| "Your Discord account does not have officer access to this server." | You don't have the configured Admin Role. | Have an existing officer assign you that role in Discord, then sign in again. |
| Stuck on a Discord error page | The redirect URI isn't registered in the Discord app. | Developer task — see [Discord application](#discord-application). |

### Granting officer access to someone

1. In Discord, give them the role configured as `ADMIN_ROLE_ID` in `worker/wrangler.toml`.
2. They sign in via the admin link above.

The role gate is set in `wrangler.toml` (developer access required to change). If you need a different role to gate the admin, ask a developer to update and redeploy.

### What each section does

- **Dashboard** — at-a-glance counts, "Refresh Member Cache" button (forces a re-fetch from Discord), and CSV export.
- **Members** — live roster pulled from Discord via the bot. Filter by role, export to CSV.
- **Roles Config** — toggle which Discord roles appear publicly on the homepage, and pick which one (or "All Members") is selected by default when a visitor lands on the Members section. The full guild role list comes from Discord; check the ones you want shown. Saves go live within 5 minutes (or hit "Refresh Member Cache" on the dashboard to apply immediately).
- **Officers** — manually-curated officer cards (name, photo URL, bio HTML, display order). Used by the public site's "Officers" section.
- **Events** — split into two sections:
  - **Discord Events** — live list of guild scheduled events from Discord. Toggle "Publish" to surface an event on the public site, and optionally provide a custom action button (text + URL) per event. Default action button is "View on Discord". Recent past events stay listed for 30 days after they end.
  - **Manual Events** — hand-curated event cards (title, subtitle, description HTML, action button, optional Google Maps embed and cover image) for events that don't live in Discord.
- **Social Links** — Discord, Twitch, Facebook, Instagram, Twitter/X, Subscribe, Outlook group, Status page URLs.
- **Settings** — read-only view of bot/JWT secret status and the current guild. Guild ID and Admin Role ID are managed in `worker/wrangler.toml` by developers. Also has a **Sign Out** button.

### Common operational tasks

- **A new member isn't showing up on the public site.** Their role probably isn't in Roles Config, or the 5-min cache hasn't expired yet. Hit "Refresh Member Cache" on the dashboard.
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
| `CONTENT` | `officers` | JSON array of `{id, name, image, about, order, createdAt, updatedAt?}` |
| `CONTENT` | `events` | JSON array of `{id, title, subtitle, description, actionButtonText, actionButtonUrl, googleMapsUrl, imagePath, createdAt, updatedAt?}` |
| `CONTENT` | `discord_event_overlays` | JSON object keyed by Discord scheduled-event ID. Each entry: `{published, actionButtonText?, actionButtonUrl?}`. Only events with `published === true` show on the public site. Empty entries are deleted. |
| `CONTENT` | `past_discord_events` | JSON object keyed by Discord event ID, snapshotted when an event completes or disappears from Discord. Each entry is the normalized event shape plus `archivedAt`. Pruned to entries newer than 30 days every time the live cache misses. |
| `CONTENT` | `social` | JSON object `{discord, twitch, facebook, instagram, twitter, subscribe, exchange, status}` |
| `CACHE` | `members_<guildId>` | cached members payload, TTL 300s |
| `CACHE` | `discord_events_live` | cached normalized list of Discord scheduled events, TTL 300s |
| `CACHE` | `discord_events_seen` | last-seen normalized list (TTL 7 days) — used to detect events that disappeared from Discord so they can be archived |

### API reference

All admin endpoints require a valid `admin_token` cookie (set by the OAuth callback) or a `Bearer` JWT in `Authorization`. Public endpoints have no auth.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/public/members` | Returns members with at least one configured role + role metadata + `defaultRoleId` (the role ID the public site should pre-select, or `null` for "All Members"). Cached 5 min. |
| GET | `/api/public/content` | Returns `{officers, events, social}`. `events` is a unified, time-sorted list combining published Discord events (live + recent-past archive) with manually-curated events; each entry has `source: 'discord' \| 'manual'` plus the rendering fields (`title, subtitle, description, startTime, endTime, status, location, imagePath\|coverImage, actionButtonText, actionButtonUrl, googleMapsUrl, discordUrl?`). |
| GET | `/api/auth/discord` | 302 → Discord OAuth authorize URL. |
| GET | `/api/auth/callback` | Discord redirects here. Sets `admin_token` cookie, redirects to `ADMIN_URL`. |
| POST | `/api/auth/logout` | Clears the `admin_token` cookie. |
| GET, PUT | `/api/admin/config` | GET returns `{guild_id, role_ids, default_role_id, bot_token_set, jwt_secret_set}` for the dashboard/settings views. PUT accepts `{role_ids, default_role_id}` (both optional, used by Roles Config); `default_role_id` is cleared when set to `null`, `"all"`, or a role ID not present in the saved `role_ids`. Also invalidates the member cache. |
| GET | `/api/admin/roles` | All roles in the guild via the bot, minus `@everyone`. Used by Roles Config. |
| GET | `/api/admin/members` | Same as public, but bypasses cache. `?format=csv` exports CSV. |
| GET, POST | `/api/admin/officers` | List or create. POST returns the new item with a generated `id`. |
| GET, PUT, DELETE | `/api/admin/officers/{id}` | Read, update, or delete one officer. |
| GET, POST | `/api/admin/events` | Manually-curated events. Same shape as officers. |
| GET, PUT, DELETE | `/api/admin/events/{id}` |  |
| GET | `/api/admin/discord-events` | Returns `{live, archived, overlays}`. `live` and `archived` are normalized Discord scheduled events; `overlays` is the `discord_event_overlays` map. Calling this also runs the archive/prune logic when the live cache misses (every ~5 minutes). |
| PUT | `/api/admin/discord-events/{eventId}` | Body: `{published, actionButtonText?, actionButtonUrl?}`. Writes (or removes if all fields empty) one entry in `discord_event_overlays`. |
| GET, PUT | `/api/admin/social` | Object stored under `CONTENT:social`. |

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
- **`pages`** — copies `admin/` into `public/` and publishes to GitLab Pages.

Required CI/CD variables (Settings → CI/CD → Variables in csgit, masked + protected):

- `CLOUDFLARE_API_TOKEN` — Cloudflare token with the **Edit Cloudflare Workers** template, or manually: Account → Workers Scripts: Edit, Workers KV Storage: Edit, Account Settings: Read.
- `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard sidebar or `npx wrangler whoami`.

Manual deploy:

```bash
cd worker
npx wrangler deploy
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
- **OAuth2 → Redirects** — register `https://cspiregaming-api.michaellamb.workers.dev/api/auth/callback` *exactly*. If this isn't there, every authorize request fails with "invalid redirect_uri" before reaching the worker.
- **Bot → Reset Token / Generate** if you need to rotate the bot token. Then run `wrangler secret put BOT_TOKEN`.
- The bot must be invited to guild `379707231077138442` with the `bot` scope and at least the **View Server Members** permission.

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
```

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
| "Discord roles fetch failed: 401" in worker logs | `BOT_TOKEN` not set or rotated. |
| `wrangler deploy` complains about Node version | Wrangler 4 needs Node ≥22. CI uses `node:22-alpine`. |
| Manual entry box is missing in Roles Config | Intentional — the full guild role list is fetched via `/api/admin/roles`, no manual ID entry needed. |
