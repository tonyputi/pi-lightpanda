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
and verified with `lightpanda version` → done.
The extension resolves the binary dynamically (see Configuration), so the
tools work immediately — no restart, no `.envrc`. At startup Pi checks the
installed binary's SHA-256 against the latest GitHub asset in the background
(once per Pi process); this never delays the session or updates automatically.
If a newer nightly is available, Pi suggests `/lightpanda update`. Network/API
errors are silent. Check the installation any time with `/lightpanda status`.

Prefer the manual route? Install from
[lightpanda.io/docs](https://lightpanda.io/docs) (one-liner, brew, docker,
nightly builds) and set `PI_LIGHTPANDA_BIN` if the binary is not on `PATH`.
Native Windows is unsupported — run inside WSL2 and set `PI_LIGHTPANDA_BIN`
to the host serving CDP (or install inside WSL and run pi there).

## Configuration

No configuration is required after `/lightpanda setup`. The binary is
resolved at each tool call, in this order:

1. `PI_LIGHTPANDA_BIN` (if set — e.g. via direnv)
2. `~/.pi/agent/bin/lightpanda` (where `/lightpanda setup` installs)
3. `lightpanda` on `PATH`

The remaining variables are optional tuning:

| Variable | Meaning | Default |
|---|---|---|
| `PI_LIGHTPANDA_BIN` | path to the `lightpanda` binary (optional — see resolution order above) | resolved automatically |
| `PI_LIGHTPANDA_HOST` | CDP host — **loopback only** | `127.0.0.1` |
| `PI_LIGHTPANDA_PORT` | CDP port | `9222` |
| `PI_LIGHTPANDA_TIMEOUT_MS` | per-operation timeout | `30000` |
| `PI_LIGHTPANDA_MAX_BYTES` | max text bytes returned per tool | `12288` |
| `PI_LIGHTPANDA_MAX_REFS` | max snapshot refs | `50` |

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
- The CDP client is `puppeteer-core` (Lightpanda's documented automation path:
  connect over `ws://host:port`, open a context + page). It ships no browser,
  so unlike `puppeteer`/`playwright` it does not drag Chromium back in.
  Snapshot refs (`e1`, `e2`, …) map to selectors in memory and expire after
  each act; one persistent page per session keeps logins and state.
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
`lightpanda_eval`, `lightpanda_run`, `lightpanda_status`.

Command: `/lightpanda status | start | stop | setup | update` — server health,
lifecycle, in-Pi binary install and confirmed updates (external servers are
never stopped, only ones this extension spawned).

Suggested loop for the agent: `fetch` for reading → `navigate` → `snapshot`
→ `act` → re-`snapshot` → … → `run` to save a working flow as PandaScript.

## Security notes

- CDP grants full control of the connected browser. This extension only talks
  to loopback endpoints and never exposes the server beyond `127.0.0.1`.
- `lightpanda_eval` and `lightpanda_run` execute JavaScript — treat target
  pages and script files as code. Only `run` scripts you trust.
- Packages run with full system access — review third-party extension source
  before installing.

## Troubleshooting

Run `/lightpanda status` inside Pi.

- **binary … not found** — run `/lightpanda setup`, or set `PI_LIGHTPANDA_BIN`
  to the binary path. No restart needed: resolution happens at every call.
- **did not answer on 127.0.0.1:9222 within 15s** — the binary may be the
  wrong platform asset or missing system libs; try `<bin> version` manually.
- **fetch/navigate/eval failures on a specific site** — likely partial Web
  API coverage in Lightpanda; fall back to a Chromium-backed extension for
  that site (no screenshots here by design — no rendering engine).
- **PI_LIGHTPANDA_HOST must be loopback** — by design; remote CDP endpoints
  are refused.

## License

MIT
