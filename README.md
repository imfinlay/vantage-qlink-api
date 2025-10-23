# Vantage QLink API Bridge

[![Node](https://img.shields.io/badge/node-22.20.0-339933)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Raspberry%20Pi-blue)]()
[![PM2](https://img.shields.io/badge/PM2-managed-2b9348)](https://pm2.keymetrics.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Minimal HTTP + Web UI bridge for a Vantage QLink (Q‑Link) controller over TCP**, designed to play nicely with Homebridge polling. It exposes a small REST API, serves a lightweight console UI, serializes on‑wire traffic, and coalesces status polls so multiple clients don’t stampede the controller.

> Host target: Raspberry Pi (tested), Node.js **v22.20.0** (nvm), runs under **PM2**.

---

## Table of Contents

* [What it does](#what-it-does)
* [Architecture](#architecture)
* [Requirements](#requirements)
* [Install](#install)
* [Configure](#configure)
* [Run (PM2)](#run-pm2)
* [Security](#security)
* [HTTP API](#http-api)
* [Web UI](#web-ui)
* [Screenshots](#screenshots)
* [Homebridge integration](#homebridge-integration)
* [Timing, caching & coalescing](#timing-caching--coalescing)
* [Troubleshooting](#troubleshooting)
* [Roadmap](#roadmap)
* [License](#license)

---

## What it does

* Maintains **one TCP connection** to a Vantage controller and writes commands with a **global send gap** to avoid flooding.
* Provides `/status/vgs` for fast switch state reads using `VGS# <m> <s> <b>` and parsing `RGS# <m> <s> <b> <v>` (or `VGS# … <v>` / bare `0|1`).
* **Coalesces parallel polls** for the same (m,s,b) so only one on‑wire read occurs.
* Parses **VOS push** lines like `SW m s b v`, does a one‑shot `VGS#` confirm, and updates a state cache that can short‑circuit polling for a short window.
* Serves a **simple Web UI** for sending commands, viewing logs, and browsing available commands.

* **VERY IMPORTANT!** The back-end app does NOT auto-connect to the Vantage Qlink IP thing. I left this in the web UI (i.e. you HAVE to manually connect) because the Qlink application which lets you program the system connects directly to the same IP/port, so I wanted to be able to disconnect and/or troubleshoot the Vantage system easily. Mine, every time there's a daylight savings time change, gets its timers messed up and I have to reload the programming. 

## Architecture

```
Homebridge (HTTP‑SWITCH) ─┐           ┌─> /public/index.html (UI)
                          ├─> REST API│
Other clients (curl etc.) ┘           └─> TCP bridge ──> Vantage IP interface --> Vantage serial interface
```

Key pieces:

* **Serialized TCP** queue; configurable `MIN_GAP_MS` between sends
* **Awaiters** map to match replies to in‑flight `VGS#` requests
* **State cache** fed by push + confirm and by recent polls
* **Homebridge‑driven whitelist** of allowed (m,s,b)

## Requirements

* Vantage Qlink master controller with an IP interface
* Raspberry Pi (Linux) with network access to the Vantage controller
* Node.js **v22.20.0** (via nvm is fine)
* PM2 for process management (optional but recommended)

## Install

```bash
# as the service user (e.g., homeauto)
# 1) Node via nvm
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22.20.0
nvm use 22.20.0

# 2) Clone & install
git clone https://github.com/imfinlay/vantage-qlink-api.git
cd vantage-qlink-api
npm install
```

## Configure

Configuration lives in `config.js` (a sample is checked into the repo).

**Servers** (multiple supported):

```js
module.exports = {
  SERVERS: [
    { name: 'Vantage', host: '<IP address>', port: 3040 }
  ],
  // Optional TCP handshake string sent on connect - depending on your Qlink config you may need to send VOS 0 1/n to enable reporting of switch presses. This is persistent in the Qlink master, so you don't actually need to send it every time, but it doesn't hurt! You may also need to change the CRLF behaviour in your environment with VCL 1. If you have the Qlink config program, you can set all this in the RS-232 station config. 
  HANDSHAKE: '',

  // Timing & behavior
  MIN_GAP_MS: 120,          // global on‑wire gap between sends
  PUSH_FRESH_MS: 10000,     // how long push‑confirmed state satisfies /status/vgs
  HANDSHAKE: 'VCL 1 0\r\n', // Optional, set CRLF at startup
  HANDSHAKE_RETRY_MS: 0,    // retry handshake once after N ms (0 = disabled)

  // Direct load dimming
  DEFAULT_LOAD_FADE_SECONDS: 3, // fallback fade when /dim POST omits fade
  LOAD_AWAITERS_MAX_PER_KEY: 200, // concurrent awaiters allowed per load key

  // Whitelist behavior (derived from Homebridge config)
  HB_WHITELIST_STRICT: true // true: empty whitelist denies all; false: allow all when empty
  // Configuratble config path in case you moved it
  HB_CONFIG_PATH: process.env.HB_CONFIG_PATH || null,
  HB_CONFIG_CANDIDATES: [
    '/var/lib/homebridge/config.json'
  ],

  // Auto-connect on startup
  // You can also set AUTO_CONNECT=1, AUTO_CONNECT_INDEX=0, AUTO_CONNECT_RETRY_MS=5000 in the environment.
  AUTO_CONNECT: /^(1|true|yes)$/i.test(String(process.env.AUTO_CONNECT || 1)),
  AUTO_CONNECT_INDEX: Number(process.env.AUTO_CONNECT_INDEX ?? 0),
  AUTO_CONNECT_RETRY_MS: Number(process.env.AUTO_CONNECT_RETRY_MS ?? 5000),

  // --- optional debug ---
  debug: { push: false }
};
```

> The app also reads the Homebridge `config.json` (path usually `/var/lib/homebridge/config.json`) to build a whitelist of allowed (master, station, button). You can refresh it via the UI or a server restart.

## Run (PM2)

Simple start:

```bash
pm2 start app.js --name vantage-qlink-api
pm2 save
```

Ecosystem file (optional `ecosystem.config.js`):

```js
module.exports = {
  apps: [{
    name: 'vantage-qlink-api',
    script: './app.js',
    env: {
      PORT: 3000,
      HOST: '0.0.0.0'
    }
  }]
}
```

Then:

```bash
pm2 start ecosystem.config.js
pm2 save
```

**Advanced ecosystem with environment & clustering**

> Keep `instances: 1` (one TCP session to the controller)

```js
module.exports = {
  apps: [{
    name: 'vantage-qlink-api',
    script: './app.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    env: {
      PORT: 3000,
      HOST: '0.0.0.0',
      MIN_GAP_MS: 120,
      PUSH_DEBUG: '0',
      HB_CONFIG_PATH: '/var/lib/homebridge/config.json',
      LOG_FILE_PATH: '/home/homeauto/apps/vantage-qlink-api/app.log'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    merge_logs: true,
    max_restarts: 10,
    restart_delay: 2000
  }]
}
```

## Security

* **Bind address**: For LAN‑only use, set `HOST=127.0.0.1` (and reverse‑proxy if you want a UI from another host). Otherwise, firewall port 3000 to your subnet only.
* **Firewall** (UFW example):

  ```bash
  sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
  ```
* **Reverse proxy** (Nginx snippet):

  ```nginx
  server {
    listen 80;
    server_name yourhost;
    location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
  }
  ```

  Add HTTPS (e.g., via certbot) and optional Basic Auth when exposing beyond your LAN.
* **Whitelist**: The app builds an allow‑list from your Homebridge `config.json`. With `HB_WHITELIST_STRICT: true`, an empty list denies all.
* **Single TCP session**: Run one instance only. Multiple instances could compete for the controller RS‑232/TCP port.

## HTTP API

All endpoints are `GET` unless noted.

### Connection

* `POST /connect` → `{ serverIndex }`
* `POST /disconnect`
* `GET /status` → `{ connected: boolean, server?: { name, host, port } }`

### Commands & logs

* `GET /servers` → `{ servers: [{ index, name, host, port }...] }`
* `GET /commands` → `{ commands, count, items: [{ command, description, params }] }`
* `GET /logs?limit=200&format=txt` → plain text (newline‑separated)

  * default (no `format`): JSON `{ file, count, lines }`

### Send raw command

* `POST /send` with JSON body:

```json
{
  "command": "VGS# 1 9 34",
  "quietMs": 300,
  "maxMs": 2000
}
```

### Switch status (coalesced)

* `GET /status/vgs?m=<master>&s=<station>&b=<button>&format=<raw|bool>&quietMs=&maxMs=&cacheMs=&jitterMs=`

  * `format=raw` → `"0"` or `"1"` (plain text)
  * `format=bool` → `"true"` or `"false"`
  * default JSON: `{ ok, sent, state, raw, bytes, cached }`

**Protocol details**

* Sends `VGS# m s b` - this is the 'Get Switch' v-command, detailed response (the #) sending master, station and switch (button, if you like)
* Accepts `RGS# m s b v` or `VGS# m s b v` (or bare `0|1`) - this is the detailed response to VGS#
* The **last field** is treated as the boolean state (non‑zero = `1`)

### Load dimming (direct load control)

* `POST /dim` (JSON)

  ```json
  {
    "master": 3,
    "enclosure": 4,
    "module": 1,
    "load": 2,
    "level": 75,
    "fade": 3.5,
    "maxMs": 2200
  }
  ```

  * Sends `VLB# m enclosure module load level [fade]` to set the dim level
  * Omitting `fade` uses `DEFAULT_LOAD_FADE_SECONDS` from `config.js`
  * `504` on timeout, `429` when awaiters are saturated, `400` on validation failure
  * Successful responses include `{ ok, level, fade, raw, source, ts, ageMs, cached, command, requested }`

* `GET /dim?m=<master>&e=<enclosure>&module=<module>&load=<load>&format=<json|raw|level>&cacheMs=&maxMs=`

  * Issues `VGB# m enclosure module load` and waits for `RGB` feedback
  * Cache hits return immediately with `X-Load-Cache: hit`; misses trigger a new poll
  * `format=raw` emits the raw `RGB/RLB` line, `format=level` emits only the numeric level, default JSON matches the POST body
  * `cacheMs` (default `MIN_POLL_INTERVAL_MS`) controls cache reuse; `maxMs` caps how long the awaiter waits

Both endpoints attach `X-Load-Command` with the dispatched line plus headers (`X-Load-Level`, `X-Load-Fade`, `X-Load-Source`) for quick introspection.

### Receive buffer (debug)

* `GET /recv?format=utf8|hex|base64&start=&end=`
* `POST /recv/reset`

## Web UI

Open `http://<pi>:3000/`:

* **Server**: pick target and Connect/Disconnect
* **Send Command**: enter a line (e.g. `VGS 2 20 7`) and choose response **modifier**:

  * `$` → short form (adds `$` after the command token)
  * `#` → detailed (adds `#` after the command token, e.g. `VGS# 2 20 7`)
* **Wait/Collect**: optionally set `quietMs` and `maxMs` for `/send`
* **Commands**: searchable table from `commands.csv`; click to copy into the input
* **Logs Tail**: live log viewer with adjustable interval; supports auto‑scroll, stop/start logging to file, view filtering

> The UI persists preferences (log limit/interval, auto‑scroll, selected server, modifier) in `localStorage`.

## Screenshots

> TODO

![UI – Commands](docs/screenshot-commands.png)
![UI – Logs Tail](docs/screenshot-logs.png)
![UI – Send Command](docs/screenshot-send.png)

## Homebridge integration

### Switches (HTTP‑SWITCH plugin)

Using the community **HTTP‑SWITCH** plugin:
* Get master, station and switch/button IDs from the Qlink program or by pressing buttons and watching the logs in the HTML front end
* Create an accessory with the following config. Be aware that the plugin someties creates a unique ID, so don't just copy/paste and edit the JSON from another device
* Use the ./scripts/add_hb_switch to generate the JSON or add directly to the Homebridge config if you're working on the API server.

```json
{
  "accessory": "HTTP-SWITCH",
  "name": "Hall Eyeball",
  "switchType": "stateful",
  "method": "GET",
  "onUrl": "http://127.0.0.1:3000/test/vsw?m=2&s=20&b=7&state=1&waitMs=800",
  "offUrl": "http://127.0.0.1:3000/test/vsw?m=2&s=20&b=7&state=0&waitMs=500",
  "statusUrl": "http://127.0.0.1:3000/status/vgs?m=2&s=20&b=7&format=bool&quietMs=300&maxMs=2200&cacheMs=800&jitterMs=300",
  "statusMethod": "GET",
  "statusPattern": "^true$",
  "pullInterval": 3500,
  "timeout": 3000
}
```

For "one shot" or momentary buttons (i.e. where it's not on or off, but just a single push to execute a switch function) you can use the **HTTP-DUMMY** Homebridge plugin.

### Dimmable loads (homebridge-http-lightbulb)

The `/dim` endpoints expose load-level control. Configure the plugin so brightness writes `POST /dim` with JSON containing your load address and the desired level (0‑100), and poll `GET /dim` for status. Example using [homebridge-http-lightbulb](https://github.com/Supereg/homebridge-http-lightbulb):

```json
{
  "accessory": "HttpLightbulb",
  "name": "Kitchen Pendants",
  "setBrightness": {
    "url": "http://127.0.0.1:3000/dim",
    "method": "POST",
    "headers": { "Content-Type": "application/json" },
    "body": "{\"master\":3,\"enclosure\":1,\"module\":1,\"load\":2,\"level\":{{BRIGHTNESS}},\"fade\":3}"
  },
  "getBrightness": {
    "url": "http://127.0.0.1:3000/dim?m=3&e=1&module=1&load=2&format=level",
    "method": "GET"
  },
  "getOnOff": {
    "url": "http://127.0.0.1:3000/dim?m=3&e=1&module=1&load=2&format=level",
    "method": "GET",
    "responseFormatter": "{{#if (gt BODY 0)}}true{{else}}false{{/if}}"
  }
}
```

Replace `{{BRIGHTNESS}}` with the templating token your plugin exposes (e.g., `%b`, `{{BRIGHTNESS}}`, etc.). Omitting `fade` falls back to `DEFAULT_LOAD_FADE_SECONDS`.

**Notes**

* `statusUrl` uses `format=bool` so the plugin expects `true|false`.
* `cacheMs` lets the server satisfy polls from its cache briefly.
* `quietMs`/`maxMs` tune when a status response is considered complete.
* Use `pullInterval` ≥ **3.5s** and add **jitter** to avoid alignment across many accessories.

## Timing, caching & coalescing

* **`MIN_GAP_MS`**: enforced between all sends to the controller (avoid bursty traffic)
* **Coalescing**: multiple concurrent `/status/vgs` for the same (m,s,b) share one on‑wire request
* **Push + confirm**: on receiving a `VOS` `SW m s b v`, the app does a single `VGS#` confirm and updates the cache
* **`PUSH_FRESH_MS`**: window where push‑confirmed state can short‑circuit `/status/vgs`
* **Whitelist**: built from Homebridge config; `HB_WHITELIST_STRICT: true` means empty → deny all

## Utility scripts

In ./scripts, there's add_hb_switch.sh which will either create JSON for a switch and print to STDOUT or modify the homebridge config.json directly. You should check in the homebridge config and restart homebridge for changes to take effect. Note that it randomizes the pullInterval to reduce load on the Vantage master.
```bash
Usage:
  ./add_hb_switch.sh [options] "<name>" <m> <s> <b>

Options:
  -c, --config PATH   Path to Homebridge config.json (default: /var/lib/homebridge/config.json or ~/.homebridge/config.json)
  -a, --apply         Write directly into config.json (otherwise prints JSON to stdout)
  -r, --replace       If an accessory with the same name exists, replace it (default: update/insert by name)
  --host HOST         API host for URLs (default: 127.0.0.1)
  --port PORT         API port for URLs (default: 3000)

  # Timings
  --wait-on N         waitMs for ON (default: 800)
  --wait-off N        waitMs for OFF (default: 500)
  --quiet N           quietMs for status (default: 300)
  --max N             maxMs for status (default: 2200)
  --cache N           cacheMs for status (default: 800)
  --jitter N          jitterMs for status (default: 300)
  --timeout N         timeout for the accessory (default: 3000)

Notes:
- pullInterval is randomized between 3800–4500 ms on each run.
- Requires 'jq'.
- Examples:
    ./add_hb_switch.sh "Hall Light" 2 20 7
    ./add_hb_switch.sh -a -c /var/lib/homebridge/config.json "Dining room" 1 9 48
```
## Troubleshooting

* **`HTTP 500` on `/status/vgs`** → controller didn’t answer in time

  * Increase `maxMs`, reduce concurrency (raise `pullInterval`, add `jitterMs`), or raise `MIN_GAP_MS`
* **`ESOCKETTIMEDOUT` in Homebridge** → the accessory’s `timeout` is too low for the chosen `statusUrl` timings
* **UI doesn’t show servers/commands/logs**

  * Check browser console for syntax errors
  * Verify `/servers`, `/commands`, `/logs` return 200 (`curl` them)
  * For logs: use `?format=txt` or parse JSON `{ lines }`
* **RGS# shows 0 but Homebridge thinks ON**

  * Ensure `statusPattern` is `^true$` and `format=bool` on `statusUrl`
* **No push confirms in log**

  * Ensure VOS push is enabled in the controller; confirm app logs include `PUSH` lines
* **`git branch -m work load-dimming` says `No branch named 'work'`**

  * Run the command from the repository root (where `package.json` lives) so Git can see the branches
  * If you are already on `load-dimming`, drop the old name from the command: `git branch -m load-dimming`
  * List local branches with `git branch` to confirm the current name before pushing with `git push -u origin load-dimming`

## Roadmap

* Server‑Sent Events / WebSocket log streaming (replace polling)
* Optional per‑key rate limits / circuit breaker when a device flaps
* Built‑in health endpoint with queue depth and awaiter counts

## License

MIT — see [LICENSE](LICENSE).

---

### Quick smoke test

```bash
# after pm2 start …
curl -sS http://127.0.0.1:3000/servers | jq .
curl -sS http://127.0.0.1:3000/commands | jq '.count, .items[0]'
curl -sS "http://127.0.0.1:3000/status/vgs?m=1&s=9&b=34&format=raw&quietMs=300&maxMs=2200&cacheMs=800&jitterMs=300"
curl -sS "http://127.0.0.1:3000/logs?limit=10&format=txt"
```
