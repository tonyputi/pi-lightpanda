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
npm ci --ignore-scripts
npm run check          # typecheck + all offline tests + package contents
npm run test:coverage  # production-module coverage floors
```

With Lightpanda already installed, optionally run:

```bash
npm run test:smoke   # real CDP checks against ephemeral loopback fixtures
```

The smoke test does not install/update binaries or visit external sites. It also
compares default Markdown, 4 KB Markdown and three required extracted fields on
the same local page. It prints returned UTF-8 byte counts (including truncation
markers and JSON metadata) and checks that the requested values remain present.
The fixture and assertions live in `smoke.ts`; exact sizes can vary with the
Lightpanda version and are not token or performance benchmarks.

Requires Node 22.19+; CI also checks Node 24 and macOS. No build step: Pi loads
`index.ts`, `browser.ts`, `setup.ts` and `extract.ts` directly; tests use native
type stripping and `node:test`. Keep the runtime small. See
[architecture and test contracts](../docs/architecture.md) for ownership,
cancellation, extraction budgets and suite responsibilities.

The default CI is offline apart from dependency installation/auditing. A manual
**Run workflow** on CI additionally installs a digest-verified upstream nightly
and runs smoke tests. Do not make ordinary PR checks depend on a moving nightly.

## Pull requests

- Small diffs. If a change needs a wall of prose to explain, split it.
- Reuse `test-support.ts` for registration/process/HTTP fixtures. Put assertions
  in the suite for the relevant behavioural contract (see the architecture
  guide), preferably as table-driven boundary cases. Avoid source-keyword,
  function-arity and redundant command-builder tests. Preserve distinct failure
  scenarios, not a particular number of test functions.
- `npm run check` and coverage floors must pass; update the README if user-visible behavior
  changes. Run the optional smoke test when changing CDP interactions if possible.
- The only runtime dependency is `puppeteer-core` (the CDP client; ships no
  browser). Pi supplies `typebox` and its extension API as peer dependencies
  with a `"*"` range. No new runtime dependencies without review; in particular,
  do not add a browser download via Playwright or full Puppeteer.
- Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles
  and commits: semantic-release derives versions from the commit history.
  `fix:` patches, `feat:` bumps minor, `feat!:`/`BREAKING CHANGE:` bumps major.
  `docs:`, `chore:`, `test:` and friends release nothing.

## Dependency updates

Review `npm audit --omit=dev` for shipped dependencies and the full `npm audit`
for development/release tooling. Prefer compatible updates; do not blindly use
`npm audit fix --force` or override transitive major versions to silence an
advisory. Confirm the installed artifact with `npm run test:package` when changing
imports, package files or README documentation links. Keep runtime requirements,
Node type definitions and the CI matrix aligned.

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
