import 'dotenv/config';
import { google } from 'googleapis';
import { Client, GatewayIntentBits, Partials, EmbedBuilder, AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import moment from 'moment-timezone';
import {
  formatRow,
  generateSnowflake,
  isOlderThan48h,
  compareByMessageId,
  formatAuditDateTime,
} from './src/lib.js';

const TRAINEE_ROLE_ID = '1120709236918337596';
// Staff who grant the Trainee role — we page the audit log once per ID
// (same filter you use manually: Member Role Update + executor), then keep
// only the latest $add of TRAINEE_ROLE_ID per member.
const ROLE_GRANTOR_IDS = new Set([
  '722686657878294568',
  '1027460996744351754',
  '1113838550614540329',
  '814913231889891388',
  '1082555422382248057',
]);
// Cursor cell for audit-log incremental sync.
const AUDIT_CURSOR_RANGE = 'logs!C1';
// Per-grantor pagination: 5 grantors × 10 pages × 100 = up to 5000 filtered
// MEMBER_ROLE_UPDATE entries per full backfill (vs 1000 unfiltered before).
const AUDIT_PAGES_PER_GRANTOR = 10;

const CHANNELS = [
  { id: process.env.CHANNEL_1_ID, sheet: 'DA' },
  { id: process.env.CHANNEL_2_ID, sheet: 'DT' },
];

const HEADERS = ['Username', 'Content', 'Date', 'Time', 'Message ID'];
const ERROR_CHANNEL_ID = process.env.ERROR_CHANNEL_ID;
// 200s bot + ~60s setup/npm = ~4.5min wall → 5 billed min worst case.
// 2 runs/day × 30 = 60 jobs → ~240-300 min/month, keeps buffer under your 300 cap.
// (240s bot would push every job to 5-6 billed min → 300-360, no buffer.)
const MAX_RUN_MS = 200 * 1000;
const FLUSH_INTERVAL_MS = 30 * 1000;
const REACTION_DELAY_MS = 50;

const required = ['BOT_TOKEN', 'SPREADSHEET_ID', 'CHANNEL_1_ID', 'CHANNEL_2_ID', 'ERROR_CHANNEL_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const stats = { DA: { catchup: 0, realtime: 0 }, DT: { catchup: 0, realtime: 0 }, errors: 0 };
let startTime = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const auth = new google.auth.GoogleAuth({
  keyFile: 'file.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const authClient = await auth.getClient();
const sheets = google.sheets({ version: 'v4', auth: authClient });

function ss(range) {
  return {
    spreadsheetId: process.env.SPREADSHEET_ID,
    range,
  };
}

async function getNextRow(sheetName) {
  const res = await sheets.spreadsheets.values.get({
    ...ss(`${sheetName}!A:E`),
  });
  const rows = res.data.values;
  if (!rows || rows.length <= 1) return 2;
  for (let i = rows.length - 1; i >= 1; i--) {
    const row = rows[i];
    if (row && row.some(cell => cell && cell.toString().trim() !== '')) {
      return i + 2;
    }
  }
  return 2;
}

function getSheetByChannel(channelId) {
  const ch = CHANNELS.find(c => c.id === channelId);
  return ch ? ch.sheet : null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function reactSequentially(messages) {
  for (const msg of messages) {
    try {
      await msg.react('✅');
      await sleep(REACTION_DELAY_MS);
    } catch {
      // skip if reaction fails
    }
  }
}

async function sendEmbed(channelId, embed) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel) await channel.send({ embeds: [embed] });
  } catch {
    // cannot send to error channel, fallback to console
  }
}

function buildErrorEmbed(sheetName, action, err) {
  return new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle(`⚠️ Error — ${action} ${sheetName}`)
    .setDescription(err.message || 'Unknown error')
    .setTimestamp();
}

async function sendError(sheetName, action, err) {
  stats.errors++;
  console.error(`[ERROR] ${action} ${sheetName}:`, err.message);
  if (ERROR_CHANNEL_ID) {
    await sendEmbed(ERROR_CHANNEL_ID, buildErrorEmbed(sheetName, action, err));
  }
}

function buildSummaryEmbed() {
  const total = { DA: 0, DT: 0 };
  let totalAll = 0;
  const lines = [];
  for (const sheet of Object.keys(stats)) {
    if (sheet === 'errors') continue;
    const s = stats[sheet];
    const t = s.catchup + s.realtime;
    total[sheet] = t;
    totalAll += t;
    lines.push(`**${sheet}** ${s.catchup} caught up │ ${s.realtime} live │ **${t}** total`);
  }

  const hasErrors = stats.errors > 0;
  const color = hasErrors ? 0xF1C40F : 0x2ECC71;

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const elapsedStr = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📊 Daily Report — Ran for ${elapsedStr}`)
    .setDescription(lines.join('\n'))
    .addFields({ name: '────────────────────────', value: `**Total:** ${totalAll} messages logged` })
    .setTimestamp();

  if (hasErrors) {
    embed.setFooter({ text: `⚠️ ${stats.errors} error(s) occurred` });
  } else {
    embed.setFooter({ text: '✅ All operations successful' });
  }

  return embed;
}

async function sendSummary() {
  if (!ERROR_CHANNEL_ID) return;
  await sendEmbed(ERROR_CHANNEL_ID, buildSummaryEmbed());
}

const buffer = { DA: [], DT: [] };
let flushTimer = null;

function pushToBuffer(sheetName, message) {
  buffer[sheetName].push({ row: formatRow(message), message });
}

async function flushBuffer() {
  for (const sheetName of Object.keys(buffer)) {
    const snapshot = buffer[sheetName].splice(0);
    if (snapshot.length === 0) continue;

    const rows = snapshot.map(e => e.row);
    try {
      const nextRow = await getNextRow(sheetName);
      const range = `${sheetName}!A${nextRow}:E${nextRow + rows.length - 1}`;
      await sheets.spreadsheets.values.update({
        ...ss(range),
        valueInputOption: 'RAW',
        resource: { values: rows },
      });
      console.log(`[FLUSH] Wrote ${rows.length} rows to ${sheetName} at row ${nextRow}`);

      const msgs = snapshot.map(e => e.message);
      reactSequentially(msgs);
    } catch (err) {
      await sendError(sheetName, 'Flush', err);
    }
  }
}

function todayStr() {
  return moment().tz('Asia/Kolkata').format('DD/MM/YYYY');
}

async function hasRunToday() {
  try {
    const res = await sheets.spreadsheets.values.get({
      ...ss('logs!A1:A1'),
    });
    return res.data.values?.[0]?.[0] === todayStr();
  } catch {
    return false;
  }
}

async function markRunCompleted() {
  try {
    await sheets.spreadsheets.values.update({
      ...ss('logs!A1:A1'),
      valueInputOption: 'RAW',
      resource: { values: [[todayStr()]] },
    });
    console.log(`[LOGS] Wrote ${todayStr()} to logs!A1`);
  } catch (err) {
    console.error(`[LOGS] Failed to write date: ${err.message}`);
  }
}

async function ensureHeaders() {
  for (const { sheet } of CHANNELS) {
    try {
      const res = await sheets.spreadsheets.values.get({
        ...ss(`${sheet}!A1:E1`),
      });
      const existing = res.data.values?.[0];
      const needsUpdate = !existing || existing.join('|') !== HEADERS.join('|');
      if (needsUpdate) {
        await sheets.spreadsheets.values.update({
          ...ss(`${sheet}!A1:E1`),
          valueInputOption: 'RAW',
          resource: { values: [HEADERS] },
        });
        console.log(`[HEADER] Added headers to ${sheet}`);
      }
    } catch (err) {
      await sendError(sheet, 'Header check', err);
    }
  }
}

async function ensurePitHeader() {
  try {
    const resA = await sheets.spreadsheets.values.get({
      ...ss('PIT!A1:B1'),
    });
    const existingA = resA.data.values?.[0];
    const expectedA = ['Username', 'User ID'];
    if (!existingA || existingA.join('|') !== expectedA.join('|')) {
      await sheets.spreadsheets.values.update({
        ...ss('PIT!A1:B1'),
        valueInputOption: 'RAW',
        resource: { values: [expectedA] },
      });
      console.log('[HEADER] Added A:B headers to PIT');
    }

    const resC = await sheets.spreadsheets.values.get({
      ...ss('PIT!C1:C1'),
    });
    const existingC = resC.data.values?.[0];
    const expectedC = ['Date Got Role'];
    if (!existingC || existingC[0] !== expectedC[0]) {
      await sheets.spreadsheets.values.update({
        ...ss('PIT!C1:C1'),
        valueInputOption: 'RAW',
        resource: { values: [expectedC] },
      });
      console.log('[HEADER] Added C header to PIT');
    }

    const resD = await sheets.spreadsheets.values.get({
      ...ss('PIT!D1:E1'),
    });
    const existingD = resD.data.values?.[0];
    const expectedD = ['Display Name', 'Profile Pic'];
    if (!existingD || existingD.join('|') !== expectedD.join('|')) {
      await sheets.spreadsheets.values.update({
        ...ss('PIT!D1:E1'),
        valueInputOption: 'RAW',
        resource: { values: [expectedD] },
      });
      console.log('[HEADER] Added D:E headers to PIT');
    }
  } catch (err) {
    await sendError('PIT', 'Header check', err);
  }
}

async function catchUpMessages() {
  console.log('[CATCHUP] Syncing last 100 messages...');

  for (const { id, sheet } of CHANNELS) {
    try {
      const res = await sheets.spreadsheets.values.get({
        ...ss(`${sheet}!E:E`),
      });
      const existing = new Set();
      const sheetRows = res.data.values;
      if (sheetRows && sheetRows.length > 1) {
        for (let i = 1; i < sheetRows.length; i++) {
          const val = sheetRows[i][0];
          if (val) existing.add(val);
        }
      }

      const channel = await client.channels.fetch(id);
      if (!channel) {
        console.log(`[CATCHUP] ${sheet}: channel not found`);
        continue;
      }

      const messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size === 0) {
        console.log(`[CATCHUP] ${sheet}: 0 messages in history`);
        continue;
      }

      const newMsgs = [...messages.values()]
        .filter(msg => !msg.author.bot && !existing.has(msg.id))
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      if (newMsgs.length === 0) {
        console.log(`[CATCHUP] ${sheet}: 0 new (all ${messages.size} already in sheet)`);
        continue;
      }

      const rows = newMsgs.map(formatRow);
      const nextRow = await getNextRow(sheet);
      const range = `${sheet}!A${nextRow}:E${nextRow + rows.length - 1}`;
      await sheets.spreadsheets.values.update({
        ...ss(range),
        valueInputOption: 'RAW',
        resource: { values: rows },
      });
      stats[sheet].catchup += rows.length;
      console.log(`[CATCHUP] ${sheet}: wrote ${rows.length} messages at row ${nextRow}`);
      reactSequentially(newMsgs);
    } catch (err) {
      await sendError(sheet, 'Catch-up', err);
    }
  }

  console.log('[CATCHUP] Done');
}

async function reorderSheetData() {
  for (const { sheet } of CHANNELS) {
    try {
      const res = await sheets.spreadsheets.values.get({
        ...ss(`${sheet}!A:E`),
      });
      const rows = res.data.values;
      if (!rows || rows.length <= 2) continue;

      const dataRows = rows.slice(1);

      const sorted = [...dataRows].sort(compareByMessageId);

      let needsReorder = false;
      for (let i = 0; i < dataRows.length; i++) {
        if (dataRows[i][4] !== sorted[i][4]) {
          needsReorder = true;
          break;
        }
      }
      if (!needsReorder) continue;

      await sheets.spreadsheets.values.update({
        ...ss(`${sheet}!A2:E${sorted.length + 1}`),
        valueInputOption: 'RAW',
        resource: { values: sorted },
      });
      console.log(`[REORDER] ${sheet}: re-sorted ${sorted.length} rows by message ID`);
    } catch (err) {
      await sendError(sheet, 'Reorder', err);
    }
  }
}
  async function checkRecentEdits() {
  console.log('[EDITCHECK] Checking recent edits...');

  for (const { id, sheet } of CHANNELS) {
    try {
      const res = await sheets.spreadsheets.values.get({
        ...ss(`${sheet}!A:E`),
      });
      const rows = res.data.values;
      if (!rows || rows.length <= 1) continue;

      const lookup = {};
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row[4]) lookup[row[4]] = { rowNum: i + 1, content: row[1] || '' };
      }

      const ids = Object.keys(lookup);
      if (ids.length === 0) continue;

      const channel = await client.channels.fetch(id);
      if (!channel) continue;

      const messages = await channel.messages.fetch({ limit: 50 });
      if (messages.size === 0) continue;

      let updated = 0;
      for (const msg of messages.values()) {
        if (msg.author.bot) continue;
        const entry = lookup[msg.id];
        if (!entry) continue;

        const discordContent = msg.content || '';
        if (discordContent !== entry.content) {
          await sheets.spreadsheets.values.update({
            ...ss(`${sheet}!B${entry.rowNum}`),
            valueInputOption: 'RAW',
            resource: { values: [[discordContent]] },
          });
          await msg.react('✏️').catch(() => {});
          updated++;
        }
      }

      if (updated > 0) console.log(`[EDITCHECK] ${sheet}: updated ${updated} edited messages`);
    } catch (err) {
      await sendError(sheet, 'Edit check', err);
    }
  }

  console.log('[EDITCHECK] Done');
}

async function checkDeletedMessages() {
  console.log('[DELCHECK] Checking for deleted messages...');
  const snowflake48hAgo = generateSnowflake(Date.now() - 48 * 60 * 60 * 1000);

  for (const { id, sheet } of CHANNELS) {
    try {
      const channel = await client.channels.fetch(id);
      if (!channel) continue;

      const messages = await channel.messages.fetch({
        after: snowflake48hAgo,
        limit: 100,
      });
      if (messages.size === 0) {
        console.log(`[DELCHECK] ${sheet}: 0 messages in 48h window, skipping`);
        continue;
      }
      const existingIds = new Set(messages.keys());

      const res = await sheets.spreadsheets.values.get({
        ...ss(`${sheet}!A:E`),
      });
      const rows = res.data.values;
      if (!rows || rows.length <= 1) continue;

      let deleted = 0;
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const msgId = row[4];
        if (!msgId) continue;
        if (!/^\d{17,20}$/.test(msgId)) continue;
        if (isOlderThan48h(msgId)) continue;

        if (!existingIds.has(msgId)) {
          await sheets.spreadsheets.values.clear({
            ...ss(`${sheet}!A${i + 1}:E${i + 1}`),
          });
          deleted++;
        }
      }

      if (deleted > 0) console.log(`[DELCHECK] ${sheet}: cleared ${deleted} deleted messages`);
    } catch (err) {
      await sendError(sheet, 'Delete check', err);
    }
  }

  console.log('[DELCHECK] Done');
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const sheetName = getSheetByChannel(message.channelId);
  if (!sheetName) return;
  stats[sheetName].realtime++;
  pushToBuffer(sheetName, message);
});

client.on('messageDelete', async (message) => {
  const sheetName = getSheetByChannel(message.channelId);
  if (!sheetName) return;

  try {
    const res = await sheets.spreadsheets.values.get({
      ...ss(`${sheetName}!A:E`),
    });
    const rows = res.data.values;
    if (!rows || rows.length === 0) return;

    const idx = rows.findIndex(r => r[4] === message.id);
    if (idx !== -1) {
      await sheets.spreadsheets.values.clear({
        ...ss(`${sheetName}!A${idx + 1}:E${idx + 1}`),
      });
      console.log(`[DELETE] Cleared ${message.id} from ${sheetName}`);
    }
  } catch (err) {
    await sendError(sheetName, 'Delete', err);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (newMessage.partial) await newMessage.fetch();

  const sheetName = getSheetByChannel(newMessage.channelId);
  if (!sheetName) return;

  try {
    const res = await sheets.spreadsheets.values.get({
      ...ss(`${sheetName}!A:E`),
    });
    const rows = res.data.values;
    if (!rows || rows.length === 0) return;

    const idx = rows.findIndex(r => r[4] === newMessage.id);
    if (idx !== -1) {
      await sheets.spreadsheets.values.update({
        ...ss(`${sheetName}!B${idx + 1}`),
        valueInputOption: 'RAW',
        resource: { values: [[newMessage.content]] },
      });
      console.log(`[UPDATE] Updated ${newMessage.id} in ${sheetName}`);
      await newMessage.react('✏️').catch(() => {});
    }
  } catch (err) {
    await sendError(sheetName, 'Update', err);
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const hadRole = oldMember.roles.cache.has(TRAINEE_ROLE_ID);
  const hasRole = newMember.roles.cache.has(TRAINEE_ROLE_ID);

  if (hadRole !== hasRole) {
    await updateTraineeRoleColumn(new Map());
  }
});

async function updateTraineeRoleColumn(auditGrants = new Map()) {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  await guild.members.fetch();
  const role = guild.roles.cache.get(TRAINEE_ROLE_ID);
  if (!role) return;

  const res = await sheets.spreadsheets.values.get({
    ...ss('PIT!A2:E'),
  });
  const existingData = res.data.values || [];

  const existingDates = new Map();
  for (const row of existingData) {
    if (row[1] && row[2]) {
      existingDates.set(row[1].toString().trim(), row[2]);
    }
  }

  const newData = role.members.map(m => {
    const userId = m.user.id;
    // Prefer authoritative audit-log datetime; fall back to preserved sheet value.
    const auditDate = auditGrants.get(userId);
    const preservedDate = existingDates.get(userId) || 'first';
    const finalDate = auditDate || preservedDate;
    return [
      m.user.username,
      m.user.id,
      finalDate,
      m.displayName,
      m.user.displayAvatarURL({ format: 'png', dynamic: true, size: 256 }),
    ];
  });

  try {
    const existingTrimmed = existingData.map(r => [r[0], r[1], r[2], r[3], r[4]]);
    const newTrimmed = newData.map(r => r);

    if (JSON.stringify(existingTrimmed) !== JSON.stringify(newTrimmed)) {
      await sheets.spreadsheets.values.clear({
        ...ss('PIT!A2:E'),
      });
      await sheets.spreadsheets.values.update({
        ...ss('PIT!A2:E'),
        valueInputOption: 'RAW',
        resource: { values: newData },
      });
      console.log('[PIT] Updated trainee list (data changed)');
    } else {
      console.log('[PIT] No changes — skipped');
    }
  } catch (err) {
    await sendError('PIT', 'Trainee update', err);
  }
}

function extractTraineeAdd(entry) {
  if (!entry) return null;
  // entry.action should be 25 (MemberRoleUpdate); coerce since some
  // discord.js versions return it as string.
  if (Number(entry.action) !== Number(AuditLogEvent.MemberRoleUpdate)) return null;
  let changes = entry.changes || [];
  // changes is normally an array, but handle Collection-like shapes defensively.
  if (!Array.isArray(changes) && typeof changes.values === 'function') changes = [...changes.values()];
  if (!Array.isArray(changes)) return null;
  for (const change of changes) {
    if (!change || change.key !== '$add') continue;
    const added = change.new ?? change.new_value ?? change.newValue;
    if (!Array.isArray(added)) continue;
    if (!added.some(r => r && r.id && r.id.toString() === TRAINEE_ROLE_ID)) continue;
    if (!entry.targetId) continue;
    const createdAt = entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdTimestamp);
    if (Number.isNaN(createdAt.valueOf())) continue;
    return { userId: entry.targetId.toString(), createdAt, entryId: entry.id };
  }
  return null;
}

async function syncTraineeRolesFromAuditLog() {
  const grants = new Map();
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.log('[AUDIT] Skipped — guild not cached');
    return grants;
  }

  try {
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (me && !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      await sendError('PIT', 'Audit sync', new Error('Bot lacks View Audit Log permission'));
      console.log('[AUDIT] Skipped — missing View Audit Log permission');
      return grants;
    }
  } catch {
    // permission check is best-effort; fetch below will surface real errors
  }

  let cursor = null;
  try {
    const curRes = await sheets.spreadsheets.values.get({ ...ss(AUDIT_CURSOR_RANGE) });
    const saved = curRes.data.values?.[0]?.[0];
    if (saved && /^\d{17,20}$/.test(saved.toString().trim())) cursor = saved.toString().trim();
  } catch {
    cursor = null;
  }

  let newestSeen = null;
  const grantsTs = new Map(); // userId -> absolute ms of latest $add (avoids IST re-parse bias)

  try {
    console.log(`[AUDIT] Start — cursor=${cursor ?? 'none'}, grantors=${ROLE_GRANTOR_IDS.size}, pages/grantor=${AUDIT_PAGES_PER_GRANTOR}`);
    let totalScanned = 0;
    for (const grantorId of ROLE_GRANTOR_IDS) {
      // Stop paging early if shutdown is near so PIT write + flush still fit.
      if (startTime && Date.now() - startTime > MAX_RUN_MS - 45 * 1000) {
        console.log('[AUDIT] Stopping early — near time limit');
        break;
      }
      let before = null;
      let scannedThisGrantor = 0;
      let hitsThisGrantor = 0;
      for (let page = 0; page < AUDIT_PAGES_PER_GRANTOR; page++) {
        const options = { type: AuditLogEvent.MemberRoleUpdate, limit: 100, user: grantorId };
        if (before) {
          options.before = before;
        } else if (cursor) {
          options.after = cursor;
        }
        const logs = await guild.fetchAuditLogs(options);
        if (page === 0 && logs.entries.size > 0) {
          const sample = logs.entries.first();
          console.log(`[AUDIT] grantor=${grantorId} page=0 entries=${logs.entries.size} sampleAction=${sample?.action} sampleChanges=${JSON.stringify(sample?.changes)?.slice(0, 200)}`);
        }
        if (logs.entries.size === 0) break;

        let oldestInBatch = null;
        for (const entry of logs.entries.values()) {
          if (!newestSeen || BigInt(entry.id) > BigInt(newestSeen)) newestSeen = entry.id;
          oldestInBatch = entry.id;
          totalScanned++;
          scannedThisGrantor++;
          if (cursor && BigInt(entry.id) <= BigInt(cursor)) continue;
          const hit = extractTraineeAdd(entry);
          if (!hit) continue;
          hitsThisGrantor++;
          const ts = hit.createdAt.valueOf();
          if (!grants.has(hit.userId) || ts > (grantsTs.get(hit.userId) ?? -1)) {
            grants.set(hit.userId, formatAuditDateTime(hit.createdAt));
            grantsTs.set(hit.userId, ts);
          }
        }

        const last = logs.entries.last();
        if (!last) break;
        before = last.id;
        if (logs.entries.size < 100) break;
        if (cursor && oldestInBatch && BigInt(oldestInBatch) <= BigInt(cursor)) break;
      }
      console.log(`[AUDIT] grantor=${grantorId} scanned=${scannedThisGrantor} traineeHits=${hitsThisGrantor}`);
    }
    console.log(`[AUDIT] Done — scanned=${totalScanned} uniqueTraineeGrants=${grants.size}`);

    if (newestSeen) {
      await sheets.spreadsheets.values.update({
        ...ss(AUDIT_CURSOR_RANGE),
        valueInputOption: 'RAW',
        resource: { values: [[newestSeen]] },
      });
    }
    console.log(`[AUDIT] Found ${grants.size} Trainee grants from audit log`);
  } catch (err) {
    await sendError('PIT', 'Audit sync', err);
  }
  return grants;
}

client.once('clientReady', async () => {
  console.log('Bot is online!');
  startTime = Date.now();

  const shutdownTimer = setTimeout(async () => {
    console.log('[SHUTDOWN] Time limit reached. Flushing buffer...');
    clearInterval(flushTimer);
    await flushBuffer();
    await markRunCompleted();
    await sendSummary();
    console.log('[SHUTDOWN] Goodbye!');
    client.destroy();
    process.exit(0);
  }, MAX_RUN_MS);

  if (await hasRunToday()) {
    console.log('[STARTUP] Already ran today, skipping');
    clearTimeout(shutdownTimer);
    client.destroy();
    return;
  }

  await markRunCompleted();

  await ensureHeaders();
  // Priority 1: DA/DT message fill + edits + deletes first.
  await reorderSheetData();
  await catchUpMessages();
  await checkRecentEdits();
  await checkDeletedMessages();
  // Priority last: Trainee role dates, right before realtime listen / shutdown.
  await ensurePitHeader();
  const auditGrants = await syncTraineeRolesFromAuditLog();
  await updateTraineeRoleColumn(auditGrants);

  flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
});

process.on('SIGINT', async () => {
  console.log('[SHUTDOWN] Interrupt. Flushing buffer...');
  clearInterval(flushTimer);
  await flushBuffer();
  await sendSummary();
  client.destroy();
  process.exit(0);
});

client.login(process.env.BOT_TOKEN);
