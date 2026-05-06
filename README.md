# cspiregaming-workers

Cloudflare Worker API and admin page for cspiregaming.github.io.

## Structure

```
worker/    Cloudflare Worker (public API + admin API)
admin/     Static admin SPA (deployed to GitLab Pages)
```

## First-time setup

### 1. Create KV namespaces

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

Paste the returned IDs into `wrangler.toml`.

### 2. Set secrets

```bash
npx wrangler secret put BOT_TOKEN         # Discord bot token (GuildMembers intent required)
npx wrangler secret put JWT_SECRET        # Any random string (openssl rand -hex 32)
npx wrangler secret put DISCORD_CLIENT_SECRET  # Discord OAuth2 app secret
```

### 3. Discord application setup

1. Go to https://discord.com/developers/applications and create a new application
2. Under OAuth2, add redirect URI: `https://<your-worker-url>/api/auth/callback`
3. Copy the Client ID → save in admin Settings page as "Discord OAuth Client ID"
4. Copy the Client Secret → `wrangler secret put DISCORD_CLIENT_SECRET`

### 4. Add bot to your Discord server

1. In your Discord app, go to Bot → enable **Server Members Intent**
2. Generate an invite link with scopes `bot` and permission `Read Members`
3. Invite the bot to the C Spire Gaming server (guild `379707231077138442`)

### 5. Deploy

```bash
cd worker && npx wrangler deploy
```

### 6. Configure via admin UI

Open `https://cspiregaming.csgitpages.cspire.net`, sign in with Discord, then:
- **Settings**: set Guild ID, Admin Role ID, Discord Client ID
- **Roles Config**: enable the Discord roles to show in the members section

## Local development

```bash
cd worker
npx wrangler dev   # Starts at http://localhost:8787
```

Open `admin/index.html` directly in a browser (the `<meta name="worker-base">` defaults to `http://localhost:8787`).

## CI/CD

Push to `main` triggers:
- Worker deploy via `wrangler deploy`
- Admin page deploy to GitLab Pages

Required CI/CD variables (set in GitLab project → Settings → CI/CD → Variables):
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
