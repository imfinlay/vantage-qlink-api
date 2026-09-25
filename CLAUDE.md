# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A minimal Node/Express HTTP bridge in front of a **Vantage QLink lighting controller** reachable over raw TCP. It exposes a REST API (and a small static Web UI in `public/`) so Homebridge (and other HTTP clients) can read switch/load state and send commands without talking TCP directly. Designed to run as a single PM2-managed process on a Raspberry Pi.

## Commands

There is no build step, linter, or test suite in this repo (`package.json` only defines `start`).

```bash
npm install
npm start                       # runs node src/index.js
pm2 start ecosystem.config.js   # production; keep instances: 1 (see below)
pm2 start app.js --name vantage-qlink-api   # simple alternative, no ecosystem file
```

Manual smoke test against a running instance:

```bash
curl -sS http://127.0.0.1:3000/servers
curl -sS http://127.0.0.1:3000/commands | jq '.count, .items[0]'
curl -sS "http://127.0.0.1:3000/status/vgs?m=1&s=9&b=34&format=raw&quietMs=300&maxMs=2200&cacheMs=800&jitterMs=300"
curl -sS "http://127.0.0.1:3000/logs?limit=10&format=txt"
```

There's no automated way to exercise a single endpoint other than curling it against a live (or absent) TCP connection — most routes short-circuit with `400` when `ctx.tcpClient` is null, so you can sanity-check request validation without a real controller attached.

## Architecture

```
Homebridge / curl / Web UI ──HTTP──> Express routes ──> queue.runQueued ──> TCP socket ──> Vantage controller
                                          ^                                      │
                                          └──────────── awaiters / caches <──────┘ (async replies)
```

**Single shared mutable state object.** `src/core/context.js` (`ctx`) is a plain object holding *everything*: the TCP socket, all caches, all queues, all config. Every module does `const ctx = require('../core/context')` and reads/writes its properties directly — there's no dependency injection or class instances. When tracing behavior, start here to see what state exists, then grep for where it's mutated.

**All outbound TCP writes are serialized through one queue.** `src/core/queue.js`'s `runQueued(fn, { priority, label })` pushes work onto `ctx.__queue` (priority-ordered insert) and pumps it with a `MIN_GAP_MS` delay enforced between sends (`ctx.__lastSendAt`). This exists because the Vantage controller cannot be flooded — every route that talks to the controller (`/send`, `/status/vgs`, `/dim`, `/test/vsw`) goes through `runQueued`, never writes to the socket directly.

**Request/response matching uses an "awaiter" pattern**, because the TCP protocol is asynchronous/line-based with no request IDs:
- `src/routes/vgs_helpers.js` (`awaitVGS`/`sendVGSWithAwaiter`) and `src/routes/load_helpers.js` (`awaitLoad`/`sendLoadWithAwaiter`) register a `{resolve, reject, timeout}` entry in `ctx.AWAITERS` / `ctx.LOAD_AWAITERS`, keyed by `"m-s-b"` or `"m-e-mod-load"`, *before* the command is sent.
- `src/core/parsing.js` parses every incoming line from the controller and resolves matching awaiters when a reply arrives (`RGS#`, `VGS#`, `RGB#`, `RLB#`, or a bare `0`/`1` reply matched via FIFO `ctx.VGS_WAIT_ORDER`).
- Concurrent requests for the same key are coalesced via `ctx.VGS_INFLIGHT` / `ctx.LOAD_INFLIGHT` (an in-flight promise is shared rather than issuing a second on-wire poll).
- `ctx.VGS_CACHE` / `ctx.LOAD_CACHE` hold the last known value per key with a timestamp; routes serve from cache when fresh (`cacheMs` param, default `MIN_POLL_INTERVAL_MS`).

**Push + confirm state flow.** The controller can proactively push `SW m s b v` lines when a physical switch changes. `core/parsing.js`'s `onSWEvent` debounces these (`DEBOUNCE_MS`, shorter for OFF events), checks `core/whitelist.js`'s `isWhitelisted(m,s,b)`, then issues a one-shot `VGS#` confirm and writes the result to `ctx.STATE` via `core/state.js`. `ctx.STATE` entries satisfy `/status/vgs` directly within `PUSH_FRESH_MS`, short-circuiting a fresh poll — this is the main latency optimization for Homebridge's polling.

**Whitelist is derived from Homebridge, not hand-maintained.** `core/whitelist.js` reads the Homebridge `config.json` (path resolution: `HB_CONFIG_PATH` env → `config.HB_CONFIG_PATH` → `HB_CONFIG_CANDIDATES` → default `/var/lib/homebridge/config.json`), extracts `(m,s,b)` triples from `statusUrl`/`onUrl`/`offUrl` query params across `accessories` and `platforms[].accessories|devices`, and builds `ctx.WHITELIST`. With `HB_WHITELIST_STRICT: true` (default), an empty whitelist denies all push-confirm activity — this is a safety valve, not a feature to route around. Reload via `POST /whitelist/reload`.

**Command validation for the raw `/send` endpoint** is driven by `commands.csv` at the repo root, loaded into a `Set` by `src/routes/shared_commands.js` at startup (and reloadable via `POST /admin/reload-commands`). A submitted command is accepted if the full string, its first whitespace-delimited token, or that token with trailing `#`/`$` stripped matches an entry in the set.

**Config resolution**: `config.js` at the repo **root** (tracked in git, contains this deployment's real controller IP and filesystem paths — it is not a template) is the source of truth, loaded once by `core/context.js` and exposed everywhere as `ctx.config`. `core/context.js` resolves the numeric timing/limit knobs (`MIN_GAP_MS`, `MIN_POLL_INTERVAL_MS`, `PUSH_FRESH_MS`, `HANDSHAKE_RETRY_MS`, `LOG_RING_MAX`, `DEFAULT_LOAD_FADE_SECONDS`, the `*AWAITERS_MAX_PER_KEY` pair) and `LOG_FILE_PATH` with the `pick()`/`num()` helpers: environment variable first (empty counts as unset), then `config.js`, then a hardcoded default. `LOG_ENABLED` follows the same order in `core/logger.js`. `HANDSHAKE`, `LINE_ENDING` and `HB_WHITELIST_STRICT` are read from `config.js` only.

**Logging** (`core/logger.js`) always keeps an in-memory ring buffer (`ctx.LOG_RING`, capped at `LOG_RING_MAX`) for the `/logs` endpoint and UI tail, independent of whether disk logging (`ctx.LOG_ENABLED`, toggleable via `POST /logging/start|stop`) is on. Don't assume `/logs` reflects the log file — it reads the ring buffer first.

## Structural conventions specific to this repo

- `src/routes/*.js` are grouped Express routers, one per feature area (`core`, `connection`, `io`, `test`, `vgs`, `dim`, `admin`, `whitelist`, `logging`), all mounted flatly in `src/app.js` — there's no `/api` prefix or versioning.
- `src/core/*.js` is shared infrastructure, not route-specific: `context` (state), `tcp` (socket lifecycle + writes), `queue` (send serialization), `parsing` (incoming line dispatch + regexes), `state` (push-confirmed cache), `whitelist` (Homebridge-derived allow-list), `logger`.
- Almost every function wraps its body in `try { ... } catch (_) {}` to keep a single flaky TCP read/write from crashing the process — this is intentional given it's an unattended Pi service with one controller connection; match this style rather than letting errors propagate in this layer.
- **Only run one instance** (`instances: 1` in `ecosystem.config.js`). Multiple instances would compete for the single TCP session to the controller — do not suggest clustering or `exec_mode: cluster`.
- The Vantage line protocol (`VGS#`/`RGS#`/`VLB#`/`RLB#`/`RGB#`/`SW`/`VOS`) is documented in `README.md`'s "HTTP API" / "Protocol details" sections — check there before guessing at command formats, and check `commands.csv` for the full accepted command list.
