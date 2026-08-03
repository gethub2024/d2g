import 'dotenv/config';
import { google } from 'googleapis';
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import moment from 'moment-timezone';

const CHANNELS = [
  { id: process.env.CHANNEL_1_ID, sheet: 'DA' },
  { id: process.env.CHANNEL_2_ID, sheet: 'DT' },
];

const HEADERS = ['Username', 'Content', 'Date', 'Time', 'Message ID'];
const ERROR_CHANNEL_ID = process.env.ERROR_CHANNEL_ID;
const MAX_RUN_MS = 150 * 1000;
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

function formatRow(msg) {
  const ts = moment(msg.createdAt).tz('Asia/Kolkata');
  return [
    msg.author.username,
    msg.content,
    ts.format('DD/MM/YYYY'),
    ts.format('hh:mm:ss A'),
    msg.id,
  ];
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

      const sorted = [...dataRows].sort((a, b) => {
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
      });

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

function generateSnowflake(timestampMs) {
  const DISCORD_EPOCH = 1420070400000n;
  return ((BigInt(timestampMs) - DISCORD_EPOCH) << 22n).toString();
}

function isOlderThan48h(messageId) {
  const DISCORD_EPOCH = 1420070400000n;
  const ts = (BigInt(messageId) >> 22n) + DISCORD_EPOCH;
  const cutoff = BigInt(Date.now()) - 48n * 60n * 60n * 1000n;
  return ts < cutoff;
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
  const roleId = '1120709236918337596';
  const hadRole = oldMember.roles.cache.has(roleId);
  const hasRole = newMember.roles.cache.has(roleId);

  if (hadRole !== hasRole) {
    await updateTraineeRoleColumn();
  }
});

async function updateTraineeRoleColumn() {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  await guild.members.fetch();
  const role = guild.roles.cache.get('1120709236918337596');
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
    const preservedDate = existingDates.get(userId) || 'first';
    return [
      m.user.username,
      m.user.id,
      preservedDate,
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

async function syncNewTraineeRoles() {
  const logsChannelId = process.env.MEMBERS_LOGS_CHANNEL_ID;
  const dynoId = process.env.DYNO_BOT_ID;
  if (!logsChannelId || !dynoId) {
    console.log('[SYNC] Skipped — missing MEMBERS_LOGS_CHANNEL_ID or DYNO_BOT_ID');
    return;
  }

  const logsChannel = await client.channels.fetch(logsChannelId);
  if (!logsChannel) {
    console.log('[SYNC] Logs channel not found');
    return;
  }

  const lastRes = await sheets.spreadsheets.values.get({ ...ss('logs!B1:B1') });
  const lastCheckedId = lastRes.data.values?.[0]?.[0] || null;

  const options = { limit: 100 };
  if (lastCheckedId) options.after = lastCheckedId;

  const messages = await logsChannel.messages.fetch(options);
  if (messages.size === 0) {
    console.log('[SYNC] No new messages since last check');
    return;
  }

  const newGrants = [];
  for (const msg of messages.values()) {
    if (msg.author.id !== dynoId) continue;
    for (const embed of msg.embeds) {
      const desc = embed.description || '';
      if (!desc.toLowerCase().includes('was given the \`trainee\` role')) continue;
      const footer = embed.footer?.text || '';
      const match = footer.match(/ID:\s*(\d{17,20})/);
      if (!match) continue;
      newGrants.push({
        userId: match[1],
        date: moment.tz(msg.createdAt, 'Asia/Kolkata').format('YYYY-MM-DD'),
      });
    }
  }

  if (newGrants.length === 0) {
    console.log('[SYNC] No new Trainee role grants');
  } else {
    const pitRes = await sheets.spreadsheets.values.get({ ...ss('PIT!A2:C') });
    const pitRows = pitRes.data.values || [];
    let updated = 0;

    for (const grant of newGrants) {
      const idx = pitRows.findIndex(r => r[1] === grant.userId);
      if (idx !== -1) {
        const rowNum = idx + 2;
        await sheets.spreadsheets.values.update({
          ...ss(`PIT!C${rowNum}`),
          valueInputOption: 'RAW',
          resource: { values: [[grant.date]] },
        });
        updated++;
      }
    }
    console.log(`[SYNC] Updated ${updated}/${newGrants.length} PIT rows from ${newGrants.length} new grants`);
  }

  const lastMsg = messages.last();
  if (lastMsg) {
    await sheets.spreadsheets.values.update({
      ...ss('logs!B1:B1'),
      valueInputOption: 'RAW',
      resource: { values: [[lastMsg.id]] },
    });
  }
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
  await ensurePitHeader();
  await syncNewTraineeRoles();
  await reorderSheetData();
  await catchUpMessages();
  await checkRecentEdits();
  await checkDeletedMessages();
  await updateTraineeRoleColumn();

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
