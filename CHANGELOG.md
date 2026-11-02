# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Unit tests for the pure helpers (`formatRow`, snowflake maths, row sorting,
  audit-log date formatting) using the built-in `node:test` runner.
- CI workflow that runs a syntax check and the test suite on every push and
  pull request. The scheduled bot workflow is unchanged.
- `CONTRIBUTING.md`, issue templates and a pull-request template.

### Changed

- Pure helpers moved to `src/lib.js` so they can be tested without Discord or
  Google credentials. Runtime behaviour is unchanged.

## [2.0.0]

### Added

- Audit-log sync for the `PIT` tab: "Date Got Role" is read from Discord's audit
  log, with a cursor stored in `logs!C1` for incremental runs.
- Run-once guard in `logs!A1` so a duplicate trigger does nothing.
- Summary embed with per-sheet counts and elapsed time.
- Structured error embeds posted to the log channel.

### Changed

- Deletion sync limited to the last 48 hours.
- Rows sorted by Discord snowflake ID instead of string comparison.

### Security

- All Sheets writes use `valueInputOption: 'RAW'`, so message content is never
  interpreted as a formula.
- Credentials are read from environment variables and a local key file only.

## [1.0.0]

### Added

- Initial release: mirror Discord channel messages into Google Sheets, with
  catch-up, edit sync and delete sync.

[Unreleased]: https://github.com/gethub2024/d2g/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/gethub2024/d2g/releases/tag/v2.0.0
[1.0.0]: https://github.com/gethub2024/d2g/releases/tag/v1.0.0
