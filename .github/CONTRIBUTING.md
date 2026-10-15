# Contributing

Thanks for taking a look! This is a small Pi extension that drives a local
Lightpanda browser — the bar is intentionally high on correctness and low on
ceremony.

## Community

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) when participating.
Use the [issue forms](https://github.com/tonyputi/pi-lightpanda/issues/new/choose)
for bug reports and feature requests. Include a minimal, public reproduction
when possible; never post private browsing data or credentials.

## Development setup

```bash
npm ci
npx tsc --noEmit
npm test       # offline self-checks and regression tests; no browser required
```

With Lightpanda already installed, optionally run:

```bash
npm run test:smoke   # real CDP checks against ephemeral loopback fixtures
```

The smoke test does not install/update binaries or visit external sites.

No build step: Pi loads the TypeScript extension directly (`index.ts`,
`setup.ts` and `extract.ts`); tests use Node 22.18+ native type stripping. Keep the runtime
small — few files are the auditability feature.

## Pull requests

- Small diffs. If a change needs a wall of prose to explain, split it.
- Pure helpers get tests in `test.ts`. Lifecycle, setup/update, stream failures
  and snapshot regressions belong in `reliability.test.ts`; extraction/schema
  checks belong in `extraction.test.ts`. Real-browser checks belong in the
  optional `smoke.ts` fixture.
- Typecheck and `npm test` must pass; update the README if user-visible behavior
  changes. Run the optional smoke test when changing CDP interactions if possible.
- The only runtime dependency is `puppeteer-core` (the CDP client; ships no
  browser). Pi supplies `typebox` and its extension API as peer dependencies
  with a `"*"` range. No new runtime dependencies without review; in particular,
  do not add a browser download via Playwright or full Puppeteer.
- Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles
  and commits: semantic-release derives versions from the commit history.
  `fix:` patches, `feat:` bumps minor, `feat!:`/`BREAKING CHANGE:` bumps major.
  `docs:`, `chore:`, `test:` and friends release nothing.

## Security issues

This extension drives a browser over CDP and can access authenticated pages.
**Do not open a public issue for security problems** — contact the maintainer
privately at <filippo@sallemi.it>.

Never post passwords, tokens, cookies, authorization headers, private page
contents, or credential files. `/lightpanda status` can contain local paths and
the current page URL/query string: review and redact its output before sharing.

## License

By contributing you agree that your contributions are licensed under the MIT
License.
