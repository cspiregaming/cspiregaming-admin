#!/usr/bin/env node
/**
 * Registers the worker's Discord slash commands with the guild.
 *
 * Discord's PUT bulk-overwrite endpoint is idempotent — running this with the
 * same command set is a no-op. Run it on every deploy via CI; no diffing
 * needed.
 *
 * Required environment variables:
 *   DISCORD_APP_ID  Discord application ID (same value as DISCORD_CLIENT_ID).
 *   GUILD_ID        Guild to register commands in (e.g. 379707231077138442).
 *   BOT_TOKEN       Discord bot token (`Bot <token>` Authorization).
 */

const { DISCORD_APP_ID, GUILD_ID, BOT_TOKEN } = process.env;

const missing = Object.entries({ DISCORD_APP_ID, GUILD_ID, BOT_TOKEN })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(', ')}`);
  process.exit(1);
}

const commands = [
  {
    name: 'request-event-publish',
    description: 'Request publication of a Discord scheduled event on the C Spire Gaming homepage',
    dm_permission: false,
    options: [
      {
        name: 'event',
        description: 'Event to publish',
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'register-stream',
    description: 'Get the @streamer role + auto-announce when your Twitch channel goes live',
    dm_permission: false,
  },
  {
    name: 'unregister-stream',
    description: 'Remove the @streamer role and stop live announcements',
    dm_permission: false,
  },
];

const url = `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/guilds/${GUILD_ID}/commands`;

(async () => {
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  const body = await res.text();
  console.log(`Discord PUT ${url}`);
  console.log(`Status: ${res.status}`);
  console.log(body);

  if (!res.ok) process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
