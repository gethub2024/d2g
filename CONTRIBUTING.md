# Contributing

Thanks for taking a look. This is a small project, so the process is short.

## Reporting a bug

Open an issue using the **Bug report** template. Include:

- what you expected to happen
- what actually happened
- your Node version and whether you run locally or on GitHub Actions
- the full error message, **with any token, key, user ID or sheet content removed**

For security problems, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Suggesting a feature

Open an issue using the **Feature request** template. Describe the problem you
want solved before describing the solution.

## Sending a pull request

1. Fork the repository and create a branch: `git checkout -b fix/short-name`
2. Install dependencies: `npm install`
3. Make your change.
4. Run the checks:
   ```bash
   npm run check   # syntax
   npm test        # unit tests
   ```
5. Commit with a clear message (`fix: re-queue rows when a flush fails`).
6. Open the pull request and fill in the template.

Keep pull requests focused. One fix or feature per PR is much easier to review
than a mixed bag.

## Code style

- ES modules, Node 22, no build step
- 2-space indentation, single quotes, semicolons
- Prefer small pure functions — anything that does not touch Discord or Google
  belongs in `src/lib.js` so it can be unit tested
- New behaviour needs a test in `test/`

## What not to commit

`.env`, `file.json`, `package.zip`, or anything containing a real token, key,
spreadsheet ID or Discord user data. See the security section of the
[README](README.md).

## Licence

By contributing you agree that your work is released under the
[ISC licence](LICENSE).
