# pi-lightpanda

A [Pi](https://pi.dev) extension that gives the agent a **lightweight headless
browser** via [Lightpanda](https://lightpanda.io) — ~16x less memory and ~9x
faster than Chrome headless, CDP-compatible.

Keywords: pi browser extension, lightpanda headless browser, AI agent web
automation, CDP browser without Chromium, lightweight scraping for coding
agents.

## The problem

Coding agents need a browser for fetching pages, scraping, testing flows, and
verifying web output — but every existing Pi browser extension launches
**Chromium** (~1 GB+ per instance, seconds to start). For an agent that opens
dozens of pages per task, that is slow, expensive, and wasteful — especially
in CI or on small machines.

Most of that weight is code the agent never uses: rendering, GPU, codecs,
font caches, UI. A headless agent needs JS execution + DOM + CDP, nothing
else.

## The solution

`pi-lightpanda` drives a local **Lightpanda** binary instead of Chromium:

| | Lightpanda | Headless Chrome |
|---|---|---|
| Memory (100 pages) | ~123 MB | ~2 GB |
| Time (100 pages) | ~5 s | ~46 s |
| Startup | instant | seconds |
| Engine | from-scratch (Zig) | Blink + V8 + Skia + … |

The extension manages the whole lifecycle: one-shot `fetch` for reading pages
(no server needed), a persistent `serve` + `puppeteer-core` client for multi-step
interaction (navigate → snapshot → act), and PandaScript `run` for
reproducible automation. `puppeteer-core` is the Chromium-free CDP client;
`typebox` is provided by Pi as a host peer dependency. No `puppeteer`/`playwright`,
which would drag a full Chromium download back in.

This is **not** a full Chromium replacement: Lightpanda has partial Web API
coverage and no graphical rendering (no screenshots). For complex apps that
need full Chrome, keep a Chromium-backed extension alongside and pick per
task.

## Installation

```bash
pi install npm:pi-lightpanda
```

or from git:

```bash
pi install git:github.com/tonyputi/pi-lightpanda
```

or from a local checkout:

```bash
pi install /absolute/path/to/pi-lightpanda
```

## Setup

The whole setup runs **inside Pi** — no separate commands, no restart juggling:

```bash
pi install npm:pi-lightpanda   # then start pi and run:
/lightpanda setup
```

What happens: confirm the download → the right nightly binary for your
platform is fetched from the `lightpanda-io/browser` GitHub releases into
`~/.pi/agent/bin/lightpanda` (download progress appears in Pi's status line)
and verified against GitHub's SHA-256 metadata and with `lightpanda version` → done.
Setup and update stream to a private temporary directory next to the destination
and replace the binary atomically only after verification. Downloads have a
five-minute timeout and a 256 MB safety limit; failures leave the previous binary
untouched and clean up partial files. Version checks are asynchronous, so a slow
executable cannot freeze Pi's UI.

The extension resolves the binary dynamically (see Configuration), so CLI tools
use it immediately — no reload, no `.envrc`. At startup Pi checks the installed
binary's SHA-256 against the latest GitHub asset in the background (once per
extension runtime); this never delays the session or updates automatically.
If the digest differs, Pi suggests `/lightpanda update`. A different digest does
not prove the build is newer: custom/stable builds may also differ. Network/API
errors are silent; session shutdown cancels work and suppresses late notifications.

After an update, an already-running CDP server still uses the previous build.
Pi asks before restarting a **managed** server because restarting discards its
page, cookies and session state. Declining keeps that server running and explains
how to restart later with `/lightpanda stop` then `/lightpanda start`. External
servers are never restarted or stopped. Check any time with `/lightpanda status`.

Prefer the manual route? Install from
[lightpanda.io/docs](https://lightpanda.io/docs) (one-liner, brew, docker,
nightly builds) and set `PI_LIGHTPANDA_BIN` if the binary is not on `PATH`.
Native Windows is unsupported — install and run both Pi and Lightpanda inside WSL2.

## Configuration

No configuration is required after `/lightpanda setup`. The binary is
resolved at each tool call, in this order:

1. `PI_LIGHTPANDA_BIN` (if set — e.g. via direnv)
2. `~/.pi/agent/bin/lightpanda` (where `/lightpanda setup` installs)
3. `lightpanda` on `PATH`

The remaining variables are optional tuning:

| Variable | Meaning | Default |
|---|---|---|
| `PI_LIGHTPANDA_BIN` | binary path or command name on `PATH` (optional — see resolution order above) | resolved automatically |
| `PI_LIGHTPANDA_HOST` | CDP host — **loopback only** | `127.0.0.1` |
| `PI_LIGHTPANDA_PORT` | CDP port | `9222` |
| `PI_LIGHTPANDA_TIMEOUT_MS` | per-operation timeout | `30000` |
| `PI_LIGHTPANDA_MAX_BYTES` | max text bytes returned per tool | `12288` |
| `PI_LIGHTPANDA_MAX_REFS` | max snapshot refs | `50` |

Tools, setup and update share binary resolution, including command-name overrides
on `PATH`. An override naming a missing command cannot be an install destination:
set an explicit file path or unset it to use the managed install location.

Example `.envrc` (only if you keep the binary somewhere else):

```bash
export PI_LIGHTPANDA_BIN="$HOME/tools/lightpanda"
```

## How it works

- `lightpanda_fetch` shells out to `lightpanda fetch <url> --dump markdown`
  — the cheapest path, no server process at all. Default for read-only work.
- `lightpanda_navigate` / `snapshot` / `act` / `eval` share one persistent
  `lightpanda serve --host 127.0.0.1 --port 9222` subprocess, spawned on
  first use. An already-running server is reused untouched; a server we
  spawned is killed on `session_shutdown`.
- Missing/non-executable binaries and servers that exit before readiness return
  errors instead of crashing Pi. Concurrent startup requests share one child;
  shutdown waits for a managed child to exit. Our browser context is closed on
  disconnect, without closing an external browser.
- The CDP client is `puppeteer-core` (Lightpanda's documented automation path:
  connect over `ws://host:port`, open a context + page). It ships no browser,
  so unlike `puppeteer`/`playwright` it does not drag Chromium back in.
- Snapshot refs (`e1`, `e2`, …) map to unique, temporary DOM attributes, not
  ambiguous IDs/classes. Identical buttons remain distinct, and DOM reordering
  does not move a marker to another element. A new snapshot removes old markers.
  Refs expire after navigation, actions (including failed ones), `lightpanda_eval`,
  stop or restart; stale or duplicated targets fail safely. Password input values
  are omitted. CDP tools execute sequentially so they cannot race over the shared
  page/ref map; one persistent page per session keeps logins and state.
- `lightpanda_run` executes a trusted `.js` PandaScript file headlessly
  (`lightpanda run`) — reproducible automation without an LLM, same caution
  as running a shell script.
- Every tool truncates output (`PI_LIGHTPANDA_MAX_BYTES`, default 12 KB) and
  only `http(s)` URLs are accepted. The host guard refuses non-loopback CDP
  endpoints: CDP controls cookies and sessions, so remote browsers are out of
  scope.

## Tools & commands

Tools (called by the agent): `lightpanda_fetch`, `lightpanda_navigate`,
`lightpanda_snapshot`, `lightpanda_act` (click/fill/type/select/press/hover),
`lightpanda_extract`, `lightpanda_eval`, `lightpanda_run`, `lightpanda_status`.

Command: `/lightpanda status | start | stop | setup | update` — server health,
lifecycle, in-Pi binary install and confirmed updates (external servers are
never stopped, only ones this extension spawned).

Suggested loop for the agent: `fetch` for reading → `navigate` → `snapshot`
→ `act` → re-`snapshot` → … → `run` to save a working flow as PandaScript.

## Structured extraction

Use `lightpanda_extract` when you need **named data fields**, not a page dump
or repeated ad-hoc JavaScript. For example, Pi can extract a product name,
price and availability, or collect documentation links as JSON.

The agent supplies CSS selectors, usually after inspecting an unfamiliar page
with `fetch` in HTML format. The tool does not guess selectors, infer facts,
convert currencies/numbers, or make nested LLM calls.

Example tool input:

```json
{
  "url": "https://shop.example/product",
  "waitForSelector": ".price",
  "fields": [
    { "name": "name", "selector": "h1", "required": true },
    { "name": "price", "selector": ".price", "required": true },
    { "name": "stock", "selector": ".availability" },
    { "name": "docs", "selector": "a.docs", "attribute": "href", "many": true }
  ]
}
```

- **`url` is optional.** With it, the tool navigates the persistent CDP page,
  invalidating snapshot refs. Without it, extraction reads the current page
  without navigating or changing snapshot markers. A page must already be open.
- **`waitForSelector` is optional.** It waits up to the configured operation
  timeout before reading JS-populated content; otherwise extraction reads the
  DOM available after page readiness.
- **Fields return strings/nulls, not invented values.** Text whitespace is
  normalized. Attributes are raw DOM attributes: an `href` may remain relative,
  and an input's `value` attribute is not necessarily its current live value.
  Prices such as `€ 19,90` remain strings.
- **Ambiguity is explicit.** By default a selector must match exactly one
  element. Use `many: true` for lists; `maxValues` defaults to 20 and is capped
  at 50 per field. You can request 1–12 uniquely named fields.

Every field includes `name`, `selector`, `status`, `matches`, `values` and
`truncated` (plus the requested `attribute` and an explanatory message when
relevant). A two-field request might return:

```json
{
  "source": {
    "url": "https://shop.example/product",
    "title": "Example product",
    "retrievedAt": "2026-10-15T12:00:00.000Z"
  },
  "fields": [
    { "name": "price", "selector": ".price", "status": "ok", "matches": 1, "values": ["€ 19,90"], "truncated": false },
    { "name": "stock", "selector": ".availability", "status": "missing", "matches": 0, "values": [], "truncated": false }
  ],
  "complete": false,
  "truncated": false
}
```

The source URL is the final URL after redirects; the title is limited to 200
code units and the acquisition timestamp is UTC. Statuses distinguish `ok`,
`missing`, `ambiguous`, `redacted` and `error`. A missing element gives `[]`;
a missing attribute gives `null`; an observed empty string remains `""`.
Password input `value` reads are redacted to `null`.

Invalid/unsupported CSS and ambiguous scalar selectors mark the tool as failed.
A `required: true` field also fails if missing, redacted or truncated. Failures
at field level still return all available structured results. Optional missing
fields are not a tool error, but `complete` is false. `complete` is true only
when every requested field succeeded without truncation.

Results are schema-validated and available both as JSON text and
`structuredContent` (for programmatic callers/codemode). The byte limit applies
to complete serialized JSON, **never a cut-off JSON document**. Values are
limited to 2048 code units and the total output budget is
`PI_LIGHTPANDA_MAX_BYTES` (capped at 64 KB for extraction). Partial values/lists
set `truncated`; if metadata alone will not fit, request fewer/shorter fields
or raise the configured limit. Schema validation checks structure, not the
truth of a website's claims.

## Security notes

- CDP grants full control of the connected browser. This extension only talks
  to loopback endpoints and never exposes the server beyond `127.0.0.1`.
- `lightpanda_eval` and `lightpanda_run` execute JavaScript — treat target
  pages and script files as code. Only `run` scripts you trust.
- Extraction output is untrusted page data, not instructions. It can contain
  private content, URLs/query strings and attributes from your active session.
  Password input redaction is not a general secrets/PII filter; do not publish
  results from private pages without review.
- Packages run with full system access — review third-party extension source
  before installing.

## Troubleshooting

Run `/lightpanda status` inside Pi.

- **binary … not found** — run `/lightpanda setup`, or set `PI_LIGHTPANDA_BIN`
  to the binary path. No restart needed: resolution happens at every call.
- **did not answer … within …ms** — the binary may be the
  wrong platform asset or missing system libs; try `<bin> version` manually.
- **fetch/navigate/eval failures on a specific site** — likely partial Web
  API coverage in Lightpanda; fall back to a Chromium-backed extension for
  that site (no screenshots here by design — no rendering engine).
- **PI_LIGHTPANDA_HOST must be loopback** — by design; remote CDP endpoints
  are refused.

## Development checks

```bash
npx tsc --noEmit
npm test
```

The default suite requires no network or Lightpanda binary. It uses fake
executables, HTTP streams and DOM elements to exercise failure paths as well
as successful installs/updates.

With Lightpanda installed, run the optional integration check:

```bash
npm run test:smoke
```

It serves local fixtures on ephemeral loopback ports, verifies real CDP
snapshots/clicks and stale refs, structured extraction with JS-populated data,
redirect provenance and required/missing fields, and managed-server cleanup and
external-server preservation. It does not download/update binaries or use
external sites.

## Contributing

See the [contribution guide](.github/CONTRIBUTING.md) and
[Code of Conduct](.github/CODE_OF_CONDUCT.md). Use the
[issue forms](https://github.com/tonyputi/pi-lightpanda/issues/new/choose)
for bugs and feature requests. Do not include secrets or private browsing data;
report security issues privately as described in the contribution guide.

## License

MIT
