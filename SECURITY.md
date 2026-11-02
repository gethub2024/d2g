# Security Policy

## Supported versions

Only the latest commit on `main` receives security fixes.

| Version | Supported |
|---|---|
| 2.x | ✅ |
| < 2.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability** (GitHub private advisory).
3. If that option is not shown, contact the maintainer through GitHub: [@gethub2024](https://github.com/gethub2024).

Please describe what you found, how to reproduce it, and the impact you expect.
You will usually get a reply within **7 days**.

Never include real bot tokens, private keys, or spreadsheet contents in a report.
Use redacted examples instead.

## What counts as a vulnerability

- Reading or modifying the spreadsheet without authorisation
- Obtaining the Discord bot token or the Google service-account key
- Executing code through message content
- Injecting formulas into Google Sheets through message content
- Credentials exposed in the repository, its history, or Actions logs
- A workflow that lets an outside contributor run code with secrets

## What is not a vulnerability

- **Discord IDs** (channels, roles, users) — public by design and useless without the bot token
- **The spreadsheet ID alone** — access is controlled entirely by Google sharing settings
- **The bot reading channels it was invited to** — that is the intended behaviour
- **Rate limits or Discord API outages** — operational issues, not security issues

## Handling leaked credentials

This project never stores credentials in the repository. If you believe a
credential has leaked:

| Credential | What to do |
|---|---|
| Discord bot token | Developer Portal → **Bot → Reset Token**, then update the GitHub Secret |
| Google service-account key | Google Cloud → **IAM & Admin → Service Accounts → Keys** → delete and recreate, then update `GOOGLE_CREDENTIALS` |

Then remove the leaked value from wherever it was published.

## Scope

In scope: the code in this repository and its GitHub Actions workflow.

Out of scope: vulnerabilities in Discord, Google Sheets, or `npm` dependencies —
please report those to the respective vendors.

## Good practice for forks

If you deploy your own copy:

- Keep `.env` and `file.json` out of version control (already in `.gitignore`)
- Set the spreadsheet to **Restricted**, never "Anyone with the link"
- Store credentials as GitHub Actions secrets, not in code
- Enable **Secret scanning** and **Push protection** in the repository settings
