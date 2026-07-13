# Discord to Google Sheet Bot

A Discord bot that logs messages from specific channels to a Google Sheet. Runs daily via GitHub Actions with a 2.5-minute window.

---

## Schedule

| Detail | Value |
|---|---|
| Current run time | **8:28 AM IST** |
| GitHub cron (UTC) | `58 2 * * *` |
| Bot duration | **2 minutes 30 seconds** |
| Workflow timeout | **10 minutes** |

### Change the run time

Edit `.github/workflows/bot.yml` line 12:

```yaml
    - cron: '58 2 * * *'
```

Formula: **UTC time = IST time − 5 hours 30 minutes**

| IST | UTC | Cron |
|---|---|---|
| 6:00 AM | 0:30 | `30 0 * * *` |
| 7:00 AM | 1:30 | `30 1 * * *` |
| 8:00 AM | 2:30 | `30 2 * * *` |
| 8:28 AM | 2:58 | `58 2 * * *` |
| 9:00 AM | 3:30 | `30 3 * * *` |
| 10:00 AM | 4:30 | `30 4 * * *` |

### Change the run duration

Edit `index.js` line 14:

```js
const MAX_RUN_MS = 150 * 1000; // 2 minutes 30 seconds
```

Also update `bot.yml` line 18 so GitHub doesn't kill the bot early:

```yaml
    timeout-minutes: 10  # should be a few minutes more than MAX_RUN_MS
```

---

## Channels & Sheets

| Discord Channel | Sheet Tab |
|---|---|
| CHANNEL_1_ID | **DA** (Daily Achievement) |
| CHANNEL_2_ID | **DT** (Daily Task) |
| CHANNEL_3_ID | **GR** (Genuine Reason) |
| — | **PIT** (Trainee role list) |

---

## What the bot does on each run

1. **Auto-headers** — Adds column headers if missing (Username, Content, Date, Time, Message ID)
2. **Catch-up** — Syncs the last 100 messages per channel to the sheet (dedup by message ID)
3. **Edit check** — Checks recent 50 messages for edits, updates sheet + reacts ✏️
4. **Delete check** — Compares sheet rows against Discord (48h window), clears deleted messages
5. **Real-time listen** — Buffers new messages, flushes to sheet every 30s, reacts ✅
6. **Trainee sync** — Updates PIT sheet with users who have the Trainee role
7. **Shutdown** — Flushes buffer, sends summary embed to error channel, disconnects

---

## Reactions

| Event | Emoji | When |
|---|---|---|
| New message logged | ✅ | After sheet write succeeds |
| Edited message updated | ✏️ | After sheet update succeeds |

---

## GitHub Secrets Required

Add these in **Settings → Secrets and variables → Actions**:

| Secret | Description |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `GOOGLE_CREDENTIALS` | Full JSON content of `file.json` |
| `CHANNEL_1_ID` | Discord channel ID for DA sheet |
| `CHANNEL_2_ID` | Discord channel ID for DT sheet |
| `CHANNEL_3_ID` | Discord channel ID for GR sheet |
| `SPREADSHEET_ID` | Google Sheet ID |
| `ERROR_CHANNEL_ID` | Discord channel for error/summary embeds |

---

## Files in this repo

| File | Purpose |
|---|---|
| `index.js` | Main bot code |
| `.env.example` | Template for environment variables (safe to commit) |
| `file.json.example` | Template for Google credentials (safe to commit) |
| `.github/workflows/bot.yml` | GitHub Actions workflow |
| `.gitignore` | Prevents secrets from being pushed |
| `README.md` | This file |

**Do NOT commit `.env` or `file.json`** — they are in `.gitignore`.

---

## Manual run

Go to **Actions → Daily Discord Bot → Run workflow** to trigger it anytime.
