import moment from 'moment-timezone';

/**
 * Pure helpers shared by the bot and the test suite.
 *
 * Nothing in this file talks to Discord or Google, so it can be imported
 * without credentials and tested in isolation.
 */

export const TIMEZONE = 'Asia/Kolkata';
export const DISCORD_EPOCH = 1420070400000n;
export const DELETE_WINDOW_MS = 48n * 60n * 60n * 1000n;

/**
 * Turn a Discord message into a sheet row.
 *
 * @param {{ id: string, content: string, createdAt: Date, author: { username: string } }} msg
 * @returns {string[]} [username, content, DD/MM/YYYY, hh:mm:ss AM/PM, messageId]
 */
export function formatRow(msg) {
  const ts = moment(msg.createdAt).tz(TIMEZONE);
  return [
    msg.author.username,
    msg.content,
    ts.format('DD/MM/YYYY'),
    ts.format('hh:mm:ss A'),
    msg.id,
  ];
}

/**
 * Discord snowflakes embed a millisecond timestamp in their top 42 bits.
 * Build the smallest snowflake that could belong to `timestampMs`.
 */
export function generateSnowflake(timestampMs) {
  return ((BigInt(timestampMs) - DISCORD_EPOCH) << 22n).toString();
}

/** The timestamp (ms since epoch) encoded in a snowflake. */
export function snowflakeToTimestamp(messageId) {
  return (BigInt(messageId) >> 22n) + DISCORD_EPOCH;
}

/**
 * True when a message is older than the 48 hour deletion window.
 * `now` is injectable so the check can be tested without freezing time.
 */
export function isOlderThan48h(messageId, now = Date.now()) {
  return snowflakeToTimestamp(messageId) < BigInt(now) - DELETE_WINDOW_MS;
}

/**
 * Sort two sheet rows by their Message ID column (index 4).
 * Rows without an ID are pushed to the bottom; unparsable IDs keep their place.
 */
export function compareByMessageId(a, b) {
  const idA = a[4];
  const idB = b[4];
  if (!idA && !idB) return 0;
  if (!idA) return 1;
  if (!idB) return -1;
  try {
    const bigA = BigInt(idA);
    const bigB = BigInt(idB);
    return bigA < bigB ? -1 : bigA > bigB ? 1 : 0;
  } catch {
    return 0;
  }
}

/** Format an audit-log timestamp the same way the PIT sheet expects. */
export function formatAuditDateTime(createdAt) {
  return moment(createdAt).tz(TIMEZONE).format('DD/MM/YYYY hh:mm:ss A');
}
