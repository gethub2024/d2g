import 'dotenv/config';
import { google } from 'googleapis';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import moment from 'moment-timezone';

const required = ['BOT_TOKEN', 'SPREADSHEET_ID', 'MEMBERS_LOGS_CHANNEL_ID', 'DYNO_BOT_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

async function fetchAllLogsMessages(channelId, dynoId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found`);

  const allMessages = [];
  let lastId = null;
  let totalFetched = 0;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    const dynoMessages = [...messages.values()].filter(m => m.author.id === dynoId);
    allMessages.push(...dynoMessages);

    lastId = messages.last().id;
    totalFetched += messages.size;
    console.log(`[FETCH] Got ${messages.size} (${dynoMessages.length} Dyno), total fetched: ${totalFetched}, Dyno total: ${allMessages.length}`);

    await sleep(300);
    if (totalFetched > 10000) {
      console.log('[FETCH] Safety cap reached (10000 messages), stopping');
      break;
    }
  }
  return allMessages;
}

function parseTraineeEmbeds(messages) {
  const history = new Map();

  for (const msg of messages) {
    for (const embed of msg.embeds) {
      const desc = embed.description || '';
      if (!desc.toLowerCase().includes('was given the `trainee` role')) continue;

      const footer = embed.footer?.text || '';
      const match = footer.match(/ID:\s*(\d{17,20})/);
      if (!match) continue;

      const userId = match[1];

      try {
        const grantedAt = moment.tz(msg.createdAt, 'Asia/Kolkata').format('YYYY-MM-DD');
        if (!history.has(userId)) history.set(userId, grantedAt);
      } catch (e) {
        console.warn(`[PARSE] Failed for ${userId}: ${e.message}`);
      }
    }
  }
  return history;
}

async function readPitSheet() {
  const res = await sheets.spreadsheets.values.get({
    ...ss('PIT!A2:E'),
  });
  return res.data.values || [];
}

function buildColumnCValues(pitRows, historyMap) {
  return pitRows.map(row => {
    const userId = row[1]?.toString().trim();
    if (userId && historyMap.has(userId)) {
      return [historyMap.get(userId)];
    }
    return ['first'];
  });
}

async function writeColumnC(values) {
  const range = `PIT!C2:C${values.length + 1}`;
  await sheets.spreadsheets.values.update({
    ...ss(range),
    valueInputOption: 'RAW',
    resource: { values },
  });
  console.log(`[WRITE] Updated ${values.length} rows in ${range}`);
}

async function main() {
  console.log('[START] Logging in to Discord...');
  await client.login(process.env.BOT_TOKEN);
  console.log('[START] Logged in');

  console.log('[FETCH] Fetching all logs messages...');
  const messages = await fetchAllLogsMessages(
    process.env.MEMBERS_LOGS_CHANNEL_ID,
    process.env.DYNO_BOT_ID
  );
  console.log(`[FETCH] Total Dyno messages: ${messages.length}`);

  console.log('[PARSE] Extracting Trainee role embeds...');
  const history = parseTraineeEmbeds(messages);
  console.log(`[PARSE] Unique users with Trainee role: ${history.size}`);

  console.log('[READ] Reading PIT sheet...');
  const pitRows = await readPitSheet();
  console.log(`[READ] PIT rows: ${pitRows.length}`);

  console.log('[BUILD] Building column C...');
  const columnC = buildColumnCValues(pitRows, history);
  const matched = columnC.filter(v => v[0] !== 'first').length;
  console.log(`[BUILD] Matched: ${matched}, Fallback (first): ${columnC.length - matched}`);

  console.log('[WRITE] Writing column C...');
  await writeColumnC(columnC);

  console.log('[DONE] Backfill complete!');
  client.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error('[ERROR]', err);
  client.destroy();
  process.exit(1);
});