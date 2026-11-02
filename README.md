# Discord → Google Sheets Bot

A small Node.js bot that mirrors messages from Discord channels into a Google
Spreadsheet, keeps edits and deletions in sync, and maintains a live list of
members who hold a chosen Discord role.

It is designed to run **for a few minutes a day** from GitHub Actions (free tier),
rather than staying online 24/7.

```
Discord channel ──► bot (Node.js) ──► Google Sheets
       ▲                                  │
       └──── ✅ reaction on success ◄──────┘
```

---

## Contents

- [Features](#features)
- [How a run works](#how-a-run-works)
- [Sheet layout](#sheet-layout)
- [Requirements](#requirements)
- [Setup](#setup)
  - [1. Create the Discord bot](#1-create-the-discord-bot)
  - [2. Create a Google service account](#2-create-a-google-service-account)
  - [3. Prepare the spreadsheet](#3-prepare-the-spreadsheet)
  - [4. Configure `.env`](#4-configure-env)
  - [5. Run locally](#5-run-locally)
  - [6. Deploy to GitHub Actions](#6-deploy-to-github-actions)
- [Configuration reference](#configuration-reference)
- [Changing the schedule](#changing-the-schedule)
- [Security — what must stay private](#security--what-must-stay-private)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [License](#license)

---

## Features

| Feature | Description |
|---|---|
| **Message logging** | Every message in a watched channel is written to its own sheet tab |
| **Catch-up** | On each run, the last 100 messages per channel are synced (duplicates ignored) |
| **Edit sync** | Messages edited recently are re-read and the sheet row is updated, then marked with ✏️ |
| **Delete sync** | Rows whose Discord message no longer exists (48 h window) are cleared |
| **Chronological order** | Rows are sorted by Discord snowflake ID, which is time-ordered |
| **Role roster** | The `PIT` tab is rebuilt from everyone holding the Trainee role |
| **Role dates** | "Date Got Role" is read from the Discord **audit log**, with a cursor stored in the sheet |
| **Auto headers** | Missing column headers are added automatically |
| **Run-once guard** | `logs!A1` stores today's date so a duplicate trigger does nothing |
| **Summary embed** | Each run posts a short stats embed to a log channel |
| **Self-shutdown** | The process exits after `MAX_RUN_MS` so Actions jobs stay short |

---

## How a run works

1. Connect to Discord and start a shutdown timer.
2. If `logs!A1` already equals today's date (`DD/MM/YYYY`, Asia/Kolkata), exit.
3. Write today's date to `logs!A1`.
4. Ensure headers exist in `DA`, `DT` and `PIT`.
5. Re-sort existing rows by message ID.
6. Catch up the last 100 messages per channel.
7. Update edited messages, then clear deleted ones.
8. Sync the Trainee role roster from the audit log.
9. Listen in real time — buffered and flushed to the sheet every 30 s, with a ✅ reaction.
10. At the time limit: flush the buffer, write the summary embed, disconnect.

Because step 2 exists, both a primary scheduler and a backup cron can be
configured without the sheet being written twice.

---

## Sheet layout

### `DA` and `DT` tabs

| Column | Header | Content |
|---|---|---|
| A | `Username` | Discord username of the author |
| B | `Content` | Message text |
| C | `Date` | `DD/MM/YYYY` (Asia/Kolkata) |
| D | `Time` | `hh:mm:ss AM/PM` |
| E | `Message ID` | Discord message ID — used for de-duplication and sorting |

### `PIT` tab

| Column | Header | Content |
|---|---|---|
| A | `Username` | Discord username |
| B | `User ID` | Discord user ID |
| C | `Date Got Role` | Taken from the audit log; `first` if unknown |
| D | `Display Name` | Server nickname |
| E | `Profile Pic` | Avatar URL |

### `logs` tab

| Cell | Purpose |
|---|---|
| `A1` | Date of the last completed run (used by the run-once guard) |
| `C1` | Audit-log cursor — newest processed entry ID |

> The bot **does not create tabs**. Create `DA`, `DT`, `PIT` and `logs` yourself.
> Any other tab in the spreadsheet is left untouched.

---

## Requirements

- Node.js **22** (matches the GitHub Actions runner)
- A Discord application with a bot user
- A Google Cloud project with the **Google Sheets API** enabled
- A spreadsheet shared with the service account

---

## Setup

### 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Go to **Bot** → **Reset Token** → copy it. This is `BOT_TOKEN`. Treat it like a password.
3. On the same page, enable both privileged intents:
   - **Message Content Intent** — required to read message text
   - **Server Members Intent** — required for the role roster
4. Invite the bot: **OAuth2 → URL Generator**
   - Scopes: `bot`
   - Permissions: `View Channels`, `Read Message History`, `Send Messages`, `Add Reactions`, `View Audit Log`
5. Copy the invite URL into your browser and add the bot to your server.

> Without **View Audit Log**, the role-date column falls back to `first`.

### 2. Create a Google service account

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **IAM & Admin → Service Accounts → Create service account**. No roles are required.
4. Open the account → **Keys → Add key → Create new key → JSON**.
5. A file is downloaded. Rename it to **`file.json`** and place it next to `index.js`.
6. Open `file.json` and copy the `client_email` value — you will need it in the next step.

> `file.json` is a private key. It is listed in `.gitignore` and must never be committed.

### 3. Prepare the spreadsheet

1. Create a new Google Sheet.
2. Add four tabs named exactly: `DA`, `DT`, `PIT`, `logs`.
3. Click **Share**, paste the `client_email` from step 2, and give it **Editor** access.
4. Copy the spreadsheet ID from the URL:

   ```
   https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit
                                          └──────────── this part ────────────┘
   ```

5. Share the sheet only with the people who should see the data — see
   [Security](#security--what-must-stay-private).

### 4. Configure `.env`

Copy the template and fill in your values:

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

```dotenv
BOT_TOKEN=your_discord_bot_token
CHANNEL_1_ID=123456789012345678
CHANNEL_2_ID=123456789012345679
ERROR_CHANNEL_ID=123456789012345680
SPREADSHEET_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890
```

**Finding channel IDs:** Discord → **User Settings → Advanced → Developer Mode** on,
then right-click the channel → **Copy Channel ID**.

### 5. Run locally

```bash
npm install
npm start
```

The bot should print `Bot is online!` and finish with `[SHUTDOWN] Goodbye!`.
Check the sheet for new rows and the log channel for the summary embed.

### 6. Deploy to GitHub Actions

1. Push the repository to GitHub (public or private both work).
2. **Settings → Secrets and variables → Actions → New repository secret**:

   | Secret | Value |
   |---|---|
   | `BOT_TOKEN` | Discord bot token |
   | `CHANNEL_1_ID` | Channel ID for the `DA` tab |
   | `CHANNEL_2_ID` | Channel ID for the `DT` tab |
   | `ERROR_CHANNEL_ID` | Channel for summaries and errors |
   | `SPREADSHEET_ID` | The spreadsheet ID |
   | `GOOGLE_CREDENTIALS` | The **entire** contents of `file.json` |

3. Open the **Actions** tab and enable workflows if prompted.
4. Trigger it once with **Daily Discord Bot → Run workflow** to confirm it works.

The workflow writes `.env` and `file.json` at run time from those secrets, so no
credentials ever sit in the repository.

---

## Configuration reference

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `BOT_TOKEN` | ✅ | Discord bot token |
| `CHANNEL_1_ID` | ✅ | Channel mirrored into the `DA` tab |
| `CHANNEL_2_ID` | ✅ | Channel mirrored into the `DT` tab |
| `ERROR_CHANNEL_ID` | ✅ | Channel that receives error and summary embeds |
| `SPREADSHEET_ID` | ✅ | Target Google Spreadsheet |

### Constants in `index.js`

| Constant | Default | Meaning |
|---|---|---|
| `MAX_RUN_MS` | `200 * 1000` | How long the bot stays connected |
| `FLUSH_INTERVAL_MS` | `30 * 1000` | How often buffered messages are written |
| `HEADERS` | `Username, Content, Date, Time, Message ID` | Columns for `DA` / `DT` |
| `TRAINEE_ROLE_ID` | *your role* | Role used to build the `PIT` tab |
| `ROLE_GRANTOR_IDS` | *your staff* | Staff whose audit-log entries are scanned |
| `AUDIT_CURSOR_RANGE` | `logs!C1` | Cell holding the audit-log cursor |
| `AUDIT_PAGES_PER_GRANTOR` | `10` | Pages of audit log read per staff member |

> `TRAINEE_ROLE_ID` and `ROLE_GRANTOR_IDS` describe a specific Discord server.
> If you fork this project for your own server, update them at the top of `index.js`
> (or move them into environment variables).

### Adding a channel

```js
const CHANNELS = [
  { id: process.env.CHANNEL_1_ID, sheet: 'DA' },
  { id: process.env.CHANNEL_2_ID, sheet: 'DT' },
  { id: process.env.CHANNEL_3_ID, sheet: 'GR' },   // new
];
```

Then add `CHANNEL_3_ID` to `.env`, to the workflow file, and to GitHub Secrets.

---

## Changing the schedule

The workflow in `.github/workflows/bot.yml` runs at **9:00 AM IST**:

```yaml
schedule:
  - cron: '30 3 * * *'
```

GitHub cron uses **UTC**. Formula: `UTC = IST − 5 h 30 min`.

| IST | UTC | Cron |
|---|---|---|
| 6:00 AM | 00:30 | `30 0 * * *` |
| 8:00 AM | 02:30 | `30 2 * * *` |
| 9:00 AM | 03:30 | `30 3 * * *` |
| 10:00 AM | 04:30 | `30 4 * * *` |

To change the runtime, edit `MAX_RUN_MS` in `index.js` and make sure
`timeout-minutes` in the workflow stays comfortably larger.

> GitHub's scheduled triggers can be delayed during busy periods. Keep the
> run-once guard in place if you add a second scheduling service.

---

## Security — what must stay private

This repository is safe to publish **because the secrets are never stored in it.**
Keep it that way:

| Never publish | Why |
|---|---|
| `.env` | Contains the bot token — anyone with it controls your bot |
| `file.json` | Service-account private key — full access to the shared sheet |
| `package.zip` or any project archive | Usually contains the two files above |
| The **spreadsheet ID** combined with a public sheet | Lets anyone read all logged data |

**Do not set the spreadsheet to "Anyone with the link".** Use
**Share → General access → Restricted** and add people individually. The
service account stays as **Editor**; humans get the access they need.

If a secret does leak:

- **Bot token** → Developer Portal → **Bot → Reset Token**, then update the GitHub Secret.
- **Service-account key** → Google Cloud → **IAM & Admin → Service Accounts → Keys**,
  delete the key, create a new one, then update `GOOGLE_CREDENTIALS`.

Found a problem? Read **[SECURITY.md](SECURITY.md)** — please report security
issues privately, not as a public issue.

Recommended GitHub settings (free for public repositories):
**Settings → Code security → Secret scanning** and **Push protection**.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing required env var` | `.env` is incomplete or the secret name is misspelled |
| `[CATCHUP] channel not found` | Wrong channel ID, or the bot is not in that server |
| Messages appear but text is empty | **Message Content Intent** is disabled |
| PIT tab is empty | Missing **Server Members Intent** or the Trainee role ID is wrong |
| `Date Got Role` shows `first` | Bot lacks **View Audit Log**, or no matching grantor is configured |
| `The caller does not have permission` | The sheet is not shared with the service account email |
| `Unable to parse range` | A tab is missing — create `DA`, `DT`, `PIT`, `logs` |
| Run skipped immediately | `logs!A1` already holds today's date (clear it to re-test) |
| Nothing happened at the scheduled time | Workflow disabled, or GitHub delayed the cron |

---

## Project structure

```
.
├── index.js                    # Bot logic
├── package.json
├── .env.example                # Template — placeholders only
├── file.json.example           # Service-account template — placeholders only
├── .github/workflows/bot.yml   # Scheduled run
├── .gitignore                  # Blocks .env, file.json, archives
├── LICENSE
├── SECURITY.md                 # How to report a vulnerability
└── README.md
```

---

## License

[ISC](LICENSE) — use it, change it, share it.
