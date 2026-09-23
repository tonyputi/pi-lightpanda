# Contributing

Thanks for taking a look! This is a small Pi extension that drives a local
Lightpanda browser — the bar is intentionally high on correctness and low on
ceremony.

## Development setup

```bash
npm install   # installs the Pi peer dep (devDependency, tests only)
npm test      # plain-assert self-checks, no framework, no network
```

No build step: the extension ships as `index.ts` (+ `setup.ts` for the
installer), type-stripped by Node 22.18+. Keep it that way — few files are the
auditability feature.

## Pull requests

- Small diffs. If a change needs a wall of prose to explain, split it.
- Pure logic (config parsing, truncation, CDP plumbing, ref maps) gets tests
  in `test.ts`.
- `npm test` must pass; update the README if user-visible behavior changes.
- Runtime dependencies stay at two: `typebox` (tool schemas for the Pi API)
  and `puppeteer-core` (the CDP client — Lightpanda's documented automation
  path, ships no browser).
  Everything else is Node built-ins and the Pi extension API — no new runtime
  deps without a review. In particular: no Playwright/Puppeteer (that would
  drag Chromium back in and defeat the purpose).
- Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles
  (the release workflow squash-merges them): `fix:` patches, `feat:` bumps
  minor, `feat!:`/`BREAKING CHANGE:` bumps major. `docs:`, `chore:`, `test:`
  and friends release nothing.

## Security issues

This extension drives a browser over CDP. **Do not open a public issue for
security problems** — use private vulnerability reporting instead.

## License

By contributing you agree that your contributions are licensed under the MIT
License.
