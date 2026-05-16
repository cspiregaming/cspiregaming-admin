/**
 * Daily Statbot report.
 *
 * The single minute cron polls this function on every tick. It fires exactly
 * once per Central day, the first time the cron runs at or after 18:00 (6 PM)
 * Central. KV holds the last successful run date (Central) as an idempotency
 * guard, so a worker restart, a missed minute, or a manual replay can't
 * double-post.
 *
 * The report consists of three Statbot Premium API calls:
 *   1. Message sums over the trailing 30 days (the `/server` equivalent).
 *   2. Top message channels for the trailing 24 hours (the `/top` equivalent).
 *   3. Top message members for the trailing 24 hours.
 *
 * The combined embed is posted to BOT_LOGS_CHANNEL_ID (mods-only) and
 * BOT_COMMANDS_CHANNEL_ID (public-facing) — same content in both.
 */

import { postChannelMessage } from './discord-outbound.js';
import {
  fetchTopMessageChannels,
  fetchTopMessageMembers,
  fetchMessageSums,
  msDaysAgo,
} from './statbot.js';

const LAST_RUN_KEY = 'statbot_last_run_date';
const DAILY_HOUR_CENTRAL = 18;
const TOP_LIMIT = 10;

export async function maybeRunDailyStatbotReport(env) {
  if (!env.STATBOT_API_KEY) return; // not configured yet — silently skip

  const { date, hour } = centralDateParts();
  if (hour < DAILY_HOUR_CENTRAL) return;

  const lastRun = await env.CONFIG.get(LAST_RUN_KEY);
  if (lastRun === date) return;

  // Claim the slot before doing any work so a slow or partially-failing run
  // doesn't get retried on the next minute tick and double-post.
  await env.CONFIG.put(LAST_RUN_KEY, date);

  try {
    await runDailyStatbotReport(env);
  } catch (err) {
    console.error('statbot-daily: report failed', err);
  }
}

/**
 * Fetches the three Statbot datasets for the current windows and returns the
 * formatted Discord embed alongside the raw API payloads — without posting.
 * Shared between the scheduled run, the manual /run endpoint, and the SPA
 * preview so all three render identical embeds.
 */
export async function buildDailyReport(env) {
  const nowMs = Date.now();
  const tzOffset = centralOffsetHours(new Date(nowMs));

  const dayWindow = {
    start: msDaysAgo(1, nowMs),
    end: nowMs,
    interval: 'day',
    timezone_offset: tzOffset,
  };
  const monthWindow = {
    start: msDaysAgo(30, nowMs),
    end: nowMs,
    timezone_offset: tzOffset,
  };

  // `full: true` returns the expanded channel / member records (with name +
  // display name) so the embed can render aligned name-only tables instead
  // of opaque IDs. `bot: false` filters bots out of the member leaderboard
  // so chat-active bots (Statbot itself, MEE6, etc.) don't dominate the top
  // spots.
  const [sums30d, topChannels24h, topMembers24h] = await Promise.all([
    fetchMessageSums(env, monthWindow),
    fetchTopMessageChannels(env, { ...dayWindow, full: true }),
    fetchTopMessageMembers(env, { ...dayWindow, full: true, bot: false }),
  ]);

  const embed = buildEmbed({
    centralDate: centralDateParts().date,
    sums30d,
    topChannels24h,
    topMembers24h,
  });

  return { embed, raw: { sums30d, topChannels24h, topMembers24h } };
}

export async function runDailyStatbotReport(env) {
  const { embed, raw } = await buildDailyReport(env);
  const targets = [env.BOT_LOGS_CHANNEL_ID, env.BOT_COMMANDS_CHANNEL_ID].filter(Boolean);
  const results = await Promise.all(
    targets.map(channelId => postChannelMessage(env, channelId, { embeds: [embed] })),
  );
  return {
    embed,
    posted: results.map((r, i) => ({ channelId: targets[i], ok: r.ok, status: r.status })),
    raw,
  };
}

// ─── Embed formatting ────────────────────────────────────────────────────────

// Code-block column widths. Tuned so two inline fields fit comfortably
// side-by-side on a typical Discord client without wrapping. Channel names
// can run long ("community-events", "introductions"), so they get more room;
// member display names sit in a tighter column.
const CHANNEL_NAME_WIDTH = 18;
const MEMBER_NAME_WIDTH = 14;
const COUNT_WIDTH = 4;

function buildEmbed({ centralDate, sums30d, topChannels24h, topMembers24h }) {
  return {
    title: `📊 Daily Stats Report — ${formatLongDate(centralDate)}`,
    color: 0x4c9fff,
    fields: [
      { name: 'Last 30 Days', value: formatSums(sums30d), inline: false },
      {
        name: 'Top Channels (24h)',
        value: formatTopTable(topChannels24h, channelName, CHANNEL_NAME_WIDTH),
        inline: false,
      },
      {
        name: 'Top Members (24h)',
        value: formatTopTable(topMembers24h, memberName, MEMBER_NAME_WIDTH),
        inline: false,
      },
    ],
    footer: { text: 'Powered by Statbot Premium' },
    timestamp: new Date().toISOString(),
  };
}

function formatSums(result) {
  if (!result?.ok) return `_(Statbot API error: ${escMd(result?.error || 'unknown')})_`;
  const count = pickNumber(result.json, ['count', 'messages', 'total', 'sum', 'value']);
  if (count == null) return `_(unexpected payload — see logs)_`;
  return `**${count.toLocaleString('en-US')}** messages`;
}

/**
 * Build a monospace name+count table wrapped in a Discord code block. Inside
 * a code block, channel and member mentions don't resolve, so the formatter
 * returns plain names (with a `#` prefix for channels). For the actual post
 * we accept that trade-off in exchange for clean column alignment.
 */
function formatTopTable(result, getName, nameWidth) {
  if (!result?.ok) {
    return `_(Statbot API error: ${escMd(result?.error || 'unknown')})_`;
  }
  const items = asArray(result.json);
  if (!items.length) return '_(no activity)_';
  const lines = items.slice(0, TOP_LIMIT).map(item => {
    const name = truncatePad(getName(item), nameWidth);
    const raw = pickNumber(item, ['count', 'messages', 'messageCount', 'value']);
    const count = (raw == null ? '?' : String(raw)).padStart(COUNT_WIDTH);
    return ` ${name} ${count}`;
  });
  return '```\n' + lines.join('\n') + '\n```';
}

function channelName(item) {
  const name = pickString(item, ['name'], pickString(item.channel, ['name']));
  if (name) return `#${name}`;
  const id = pickString(item, ['channelId', 'id'], pickString(item.channel, ['id']));
  return id ? `#${id}` : '?';
}

function memberName(item) {
  const name = pickString(
    item,
    ['displayName', 'nickname', 'name', 'username'],
    pickString(item.member, ['displayName', 'nickname', 'name', 'username']),
  );
  if (name) return name;
  const id = pickString(item, ['memberId', 'userId', 'id'], pickString(item.member, ['id']));
  return id || '?';
}

function truncatePad(s, w) {
  const str = String(s ?? '?');
  if (str.length > w) return str.slice(0, w - 1) + '…';
  return str.padEnd(w);
}

// ─── Defensive payload helpers ───────────────────────────────────────────────

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.results)) return json.results;
  if (Array.isArray(json?.items)) return json.items;
  return [];
}

function pickString(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k]) return obj[k];
  }
  return fallback;
}

function pickNumber(obj, keys) {
  if (obj == null) return null;
  if (typeof obj === 'number') return obj;
  if (typeof obj !== 'object') return null;
  for (const k of keys) {
    if (typeof obj[k] === 'number') return obj[k];
  }
  return null;
}

function escMd(s) {
  return String(s).replace(/([_*~`>|\\])/g, '\\$1');
}

// ─── Central time helpers (DST-safe via Intl) ────────────────────────────────

function centralDateParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
  };
}

// Returns Central's UTC offset in whole hours (e.g. -5 during CDT, -6 during CST).
// Used as Statbot's `timezone_offset` query param so day-boundary bucketing
// aligns with Central rather than UTC.
function centralOffsetHours(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour, +parts.minute, +parts.second,
  );
  return Math.round((asUtc - date.getTime()) / 3600000);
}

function formatLongDate(isoDate) {
  // isoDate is "YYYY-MM-DD" already in Central; convert to "Month D, YYYY".
  const [y, m, d] = isoDate.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}
