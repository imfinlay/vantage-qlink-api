"use strict";
/** Debug toggles:
 *  - Config-driven: set in config.js -> debug.push
 *  - Env override:  PUSH_DEBUG=1 (wins over config)
 *  This mirrors Homebridge's preference for config-based debug switches.
 */
let CONF_DEBUG_PUSH = false;
try {
  const cfg = require('./config.js');
  if (cfg && cfg.debug && typeof cfg.debug.push !== 'undefined') {
    CONF_DEBUG_PUSH = !!cfg.debug.push;
  }
} catch (e) { /* optional config not required */ }
const PUSH_DEBUG = !!(process.env.PUSH_DEBUG || CONF_DEBUG_PUSH);

// =========================================================
// app.js (Queued send + VGS coalesce/cache + priority + jitter + push)
// =========================================================

const net = require('net');
const express = require('express');
const path = require('path');
const fs = require('fs');
const url = require('url');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');

function logLine(message) {
  try {
    const ts = new Date().toISOString();
    console.log(ts + ' ' + message);
    if (LOG_FILE_PATH) fs.appendFile(LOG_FILE_PATH, ts + ' ' + message + '\n', () => {});
  } catch (e) {}
}

const { LOG_FILE_PATH, servers, HANDSHAKE } = require('./config.js');

const app = express();
const server = http.createServer(app);
<<<<<<< HEAD
// JSON body parser for POST endpoints used by the UI
app.use(express.json());
=======
>>>>>>> parent of 48c83c8 (Update app.js)
const PORT = 3000;

const STATE = new Map();             // push-derived state
const VGS_CACHE = new Map();         // vgs cache map: key -> { ts, value, raw, bytes }
const PENDING = new Map();           // pending confirm debounces

// Global pacing between ANY two on-wire commands. Bump to soften bursts; lower for snappier control.
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 120);
// Soft floor for read cadence when the app coalesces polls. Helps avoid back-to-back VGS on chatter.
const MIN_POLL_INTERVAL_MS = Number(process.env.MIN_POLL_INTERVAL_MS || 400);

const QUEUE = [];                    // prioritized queue of commands
let lastSendTs = 0;                  // last time we sent any command

/**
 * Command queue priorities (lower number = higher priority):
 * 1 CONTROL      – user actions (on/off/scenes) should jump the line
 * 2 TEST         – /test helpers return quickly for UI/HB
 * 3 QUICK        – explicit fast reads
 * 5 NORMAL       – routine polls
 * 6 PUSH_CONFIRM – one-shot confirm after a VOS push
 * 9 LOW          – anything backgroundy
 */
const PRIORITY = {
  CONTROL: 1,         // on/off, scenes, etc.
  TEST: 2,            // /test helper endpoints
  QUICK: 3,           // fast read
  NORMAL: 5,          // typical reads
  PUSH_CONFIRM: 6,    // push confirm VGS
  LOW: 9
};

function keyOf(m, s, b) { return `${m}/${s}/${b}`; }
function vgsKey(m, s, b) { return `VGS ${m} ${s} ${b}`; }

function isWhitelisted(m, s, b) {
  // whitelist is built from Homebridge-accessed URLs (queried at /whitelist)
  // for simplicity here, accept all; production: load from hb config
  return true;
}

/**
 * enqueue(cmd, priority, resolve, reject, meta)
 *  - Central serialized send queue with priority ordering.
 *  - All I/O funnels through here to respect MIN_GAP_MS and preserve order.
 */
function enqueue(cmd, priority = PRIORITY.NORMAL, resolve, reject, meta = {}) {
  const item = { cmd, priority, resolve, reject, meta, ts: Date.now() };
  QUEUE.push(item);
  QUEUE.sort((a, b) => a.priority - b.priority || a.ts - b.ts);
}

/**
 * sendNext: pops the highest-priority command and writes it to TCP
 *  - Enforces MIN_GAP_MS between ANY two writes
 *  - Called on a short interval to drain the queue without tight loops
 */
function sendNext(socket) {
  const now = Date.now();
  const gap = now - lastSendTs;
  if (gap < MIN_GAP_MS) return; // respect global pacing
  if (!QUEUE.length) return;
  const item = QUEUE.shift();
  lastSendTs = now;
  if (PUSH_DEBUG) logLine(`SEND[${item.priority}] ${item.cmd}`);
  socket.write(item.cmd + '\r\n');
}

function connectServer(target) {
  const sock = net.createConnection({ host: target.host, port: target.port });
  sock.setKeepAlive(true, 5000);
  sock.on('connect', () => {
    logLine(`TCP connected to ${target.name} ${target.host}:${target.port}`);
    if (HANDSHAKE) sock.write(HANDSHAKE);
  });
  sock.on('error', (e) => logLine(`TCP error: ${e.message}`));
  sock.on('close', () => logLine('TCP closed'));
  return sock;
}

let current = servers[0];
let socket = connectServer(current);

setInterval(() => sendNext(socket), 10);

/**
 * parseVOS: parses unsolicited lines from the controller (VOS)
 *  - SW m s b v  => push event (switch state changed)
 *  - VGS m s b v => a read response; we mirror to cache
 */
function parseVOS(line) {
  // Example lines:
  //  SW 2 20 7 1
  //  VGS 2 20 7 1
  const parts = line.trim().split(/\s+/);
  if (!parts.length) return;
  const t = parts[0];
  if (t === 'SW' && parts.length >= 5) {
    const m = +parts[1], s = +parts[2], b = +parts[3], v = +parts[4];
    onSWEvent({ m, s, b, v });
  } else if (t === 'VGS' && parts.length >= 5) {
    const m = +parts[1], s = +parts[2], b = +parts[3], v = +parts[4];
    VGS_CACHE.set(vgsKey(m, s, b), { ts: Date.now(), value: !!v, raw: String(v), bytes: 1 });
<<<<<<< HEAD
  }
}

socket.on('data', (buf) => {
  // TCP framing can deliver multiple lines at once; split and parse each.
  // With PUSH_DEBUG=1 you also get raw RECV lines to correlate timing.
  const s = buf.toString('utf8');
  s.split(/\r?\n/).forEach(line => {
    if (!line) return;
    if (PUSH_DEBUG) logLine(`RECV ${line}`);
    parseVOS(line);
  });
});

/**
 * confirmOneVGS: single VGS read at PUSH_CONFIRM priority
 *  - Debounced by onSWEvent so we confirm at most once per device per burst
 */
async function confirmOneVGS(m, s, b) {
  return new Promise((resolve, reject) => {
    const cmd = `VGS ${m} ${s} ${b}`;
    enqueue(cmd, PRIORITY.PUSH_CONFIRM, resolve, reject, { type: 'VGS', m, s, b });
  });
}

/**
 * setState: records the push-confirmed value and warms the VGS cache
 *  - STATE map => short-lived push freshness window for /status/vgs
 *  - VGS_CACHE => avoids on-wire read on next poll
 */
function setState(m, s, b, value) {
  const now = Date.now();
  const k = keyOf(m, s, b);
  STATE.set(k, { value, ts: now });
  // Mirror to VGS cache too for richer /status JSON path
  const keyV = vgsKey(m, s, b);
  VGS_CACHE.set(keyV, { ts: now, value, raw: String(value), bytes: 1 });
    if (PUSH_DEBUG) logLine(`PUSH cache updated ${m}/${s}/${b} -> ${value}`);
}

// Small helper: TTL-constrained fetch from the VGS cache
function getCachedVGS(m, s, b, maxAgeMs) {
  const k = vgsKey(m, s, b);
  const e = VGS_CACHE.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > maxAgeMs) return null;
  return e;
}

/**
 * /status/vgs decision tree:
 * 1) If we have a fresh push (<=10s), serve it immediately (zero I/O)
 * 2) Else if cacheMs provided and a fresh cache entry exists, serve cached
 * 3) Else coalesce a real VGS read (with optional jitter) and fan out results
 *
 * Notes:
 * - format=bool returns plain 'true'/'false' for Homebridge HTTP-SWITCH
 * - jitterMs staggers similar polls to reduce burst collisions
 * - inflight map collapses concurrent identical reads into one on-wire VGS
 */
function serveVGS(req, res) {
  const q = url.parse(req.url, true).query;
  const m = +q.m, s = +q.s, b = +q.b;
  const format = q.format || 'json';
  const cacheMs = +q.cacheMs || 0;
  const jitterMs = +q.jitterMs || 0;
  const quietMs = +q.quietMs || 0;
  const maxMs = +q.maxMs || 2000;

  if (!(m>=0 && s>=0 && b>=0)) return res.status(400).json({ error: 'missing m/s/b' });

  // Return push or cached immediately if fresh
  const pushFresh = STATE.get(keyOf(m, s, b));
  if (pushFresh && (Date.now() - pushFresh.ts) < 10000) {
    if (format === 'bool') return res.type('text/plain').send(pushFresh.value ? 'true' : 'false');
    return res.json({ ok: true, sent: '(push-cache) VGS', value: pushFresh.value, cached: true, ts: pushFresh.ts });
  }

  if (cacheMs) {
    const e = getCachedVGS(m, s, b, cacheMs);
    if (e) {
      if (format === 'bool') return res.type('text/plain').send(e.value ? 'true' : 'false');
      return res.json({ ok: true, sent: '(cached) VGS', value: e.value, cached: true, ts: e.ts });
    }
  }

  // Coalesce in-flight: simplistic (one per key)
  const key = vgsKey(m, s, b);
  if (!req.app.locals.inflight) req.app.locals.inflight = new Map();
  const inflight = req.app.locals.inflight;
  const existing = inflight.get(key);
  if (existing) {
    existing.push({ res, format });
    return;
  }
  inflight.set(key, [{ res, format }]);

  if (jitterMs) {
    const j = Math.floor(Math.random() * jitterMs);
    setTimeout(() => doVGSRead(), j);
  } else {
    doVGSRead();
  }

  function doVGSRead() {
    const cmd = `VGS ${m} ${s} ${b}`;
    const started = Date.now();
    new Promise((resolve, reject) => enqueue(cmd, PRIORITY.NORMAL, resolve, reject, { type: 'VGS', m, s, b }))
      .then(raw => {
        const val = Number(String(raw).trim().split(/\s+/).pop());
        const value = !!val;
        VGS_CACHE.set(key, { ts: Date.now(), value, raw: String(val), bytes: String(raw).length });
        const list = inflight.get(key) || [];
        inflight.delete(key);
        for (const { res, format } of list) {
          if (format === 'bool') res.type('text/plain').send(value ? 'true' : 'false');
          else res.json({ ok: true, sent: cmd, value, cached: false, ms: Date.now() - started });
        }
      })
      .catch(err => {
        const list = inflight.get(key) || [];
        inflight.delete(key);
        for (const { res } of list) res.status(500).json({ ok: false, error: String(err || 'VGS failed') });
      });
  }
}

// Primary status endpoint used by Homebridge HTTP-SWITCH accessories
app.get('/status/vgs', serveVGS);

// Servers list and connection status for UI
app.get('/servers', (req, res) => {
  const list = Array.isArray(servers) ? servers.map((s, i) => ({ index: i, name: s.name || `Server ${i}`, host: s.host, port: s.port })) : [];
  res.json({ servers: list });
});

app.get('/status', (req, res) => {
  res.json({ connected: !!socket, server: current || null, queueLength: QUEUE.length, lastSendTs });
});

// POST equivalents used by index.html (keep existing GET routes for back-compat)
app.post('/connect', (req, res) => {
  try { if (socket) socket.destroy(); } catch (e) {}
  const idx = Number((req.body && req.body.serverIndex) ?? 0) || 0;
  if (!Array.isArray(servers) || idx < 0 || idx >= servers.length) {
    return res.status(400).json({ message: 'Invalid server index.' });
  }
  current = servers[idx];
  socket = connectServer(current);
  res.json({ ok: true, message: `Connecting to ${current.name || current.host}:${current.port}`, serverIndex: idx });
});

app.post('/disconnect', (req, res) => {
  try { if (socket) socket.destroy(); } catch (e) {}
  res.json({ ok: true, message: 'Disconnected' });
});

app.post('/send', (req, res) => {
  const body = req.body || {};
  const message = String(body.command || '').trim();
  const waitMs = Number(body.waitMs || 0);
  if (!message) return res.status(400).json({ ok: false, message: 'Missing command' });
  enqueue(message, PRIORITY.CONTROL, null, null, { type: 'RAW' });
  if (waitMs > 0) {
    setTimeout(() => res.json({ ok: true, message: `Queued: ${message}`, response: { text: '(wait elapsed)' } }), waitMs);
  } else {
    res.json({ ok: true, message: `Queued: ${message}` });
  }
});

=======
  }
}

socket.on('data', (buf) => {
  // TCP framing can deliver multiple lines at once; split and parse each.
  // With PUSH_DEBUG=1 you also get raw RECV lines to correlate timing.
  const s = buf.toString('utf8');
  s.split(/\r?\n/).forEach(line => {
    if (!line) return;
    if (PUSH_DEBUG) logLine(`RECV ${line}`);
    parseVOS(line);
  });
});

/**
 * confirmOneVGS: single VGS read at PUSH_CONFIRM priority
 *  - Debounced by onSWEvent so we confirm at most once per device per burst
 */
async function confirmOneVGS(m, s, b) {
  return new Promise((resolve, reject) => {
    const cmd = `VGS ${m} ${s} ${b}`;
    enqueue(cmd, PRIORITY.PUSH_CONFIRM, resolve, reject, { type: 'VGS', m, s, b });
  });
}

/**
 * setState: records the push-confirmed value and warms the VGS cache
 *  - STATE map => short-lived push freshness window for /status/vgs
 *  - VGS_CACHE => avoids on-wire read on next poll
 */
function setState(m, s, b, value) {
  const now = Date.now();
  const k = keyOf(m, s, b);
  STATE.set(k, { value, ts: now });
  // Mirror to VGS cache too for richer /status JSON path
  const keyV = vgsKey(m, s, b);
  VGS_CACHE.set(keyV, { ts: now, value, raw: String(value), bytes: 1 });
    if (PUSH_DEBUG) logLine(`PUSH cache updated ${m}/${s}/${b} -> ${value}`);
}

// Small helper: TTL-constrained fetch from the VGS cache
function getCachedVGS(m, s, b, maxAgeMs) {
  const k = vgsKey(m, s, b);
  const e = VGS_CACHE.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > maxAgeMs) return null;
  return e;
}

/**
 * /status/vgs decision tree:
 * 1) If we have a fresh push (<=10s), serve it immediately (zero I/O)
 * 2) Else if cacheMs provided and a fresh cache entry exists, serve cached
 * 3) Else coalesce a real VGS read (with optional jitter) and fan out results
 *
 * Notes:
 * - format=bool returns plain 'true'/'false' for Homebridge HTTP-SWITCH
 * - jitterMs staggers similar polls to reduce burst collisions
 * - inflight map collapses concurrent identical reads into one on-wire VGS
 */
function serveVGS(req, res) {
  const q = url.parse(req.url, true).query;
  const m = +q.m, s = +q.s, b = +q.b;
  const format = q.format || 'json';
  const cacheMs = +q.cacheMs || 0;
  const jitterMs = +q.jitterMs || 0;
  const quietMs = +q.quietMs || 0;
  const maxMs = +q.maxMs || 2000;

  if (!(m>=0 && s>=0 && b>=0)) return res.status(400).json({ error: 'missing m/s/b' });

  // Return push or cached immediately if fresh
  const pushFresh = STATE.get(keyOf(m, s, b));
  if (pushFresh && (Date.now() - pushFresh.ts) < 10000) {
    if (format === 'bool') return res.type('text/plain').send(pushFresh.value ? 'true' : 'false');
    return res.json({ ok: true, sent: '(push-cache) VGS', value: pushFresh.value, cached: true, ts: pushFresh.ts });
  }

  if (cacheMs) {
    const e = getCachedVGS(m, s, b, cacheMs);
    if (e) {
      if (format === 'bool') return res.type('text/plain').send(e.value ? 'true' : 'false');
      return res.json({ ok: true, sent: '(cached) VGS', value: e.value, cached: true, ts: e.ts });
    }
  }

  // Coalesce in-flight: simplistic (one per key)
  const key = vgsKey(m, s, b);
  if (!req.app.locals.inflight) req.app.locals.inflight = new Map();
  const inflight = req.app.locals.inflight;
  const existing = inflight.get(key);
  if (existing) {
    existing.push({ res, format });
    return;
  }
  inflight.set(key, [{ res, format }]);

  if (jitterMs) {
    const j = Math.floor(Math.random() * jitterMs);
    setTimeout(() => doVGSRead(), j);
  } else {
    doVGSRead();
  }

  function doVGSRead() {
    const cmd = `VGS ${m} ${s} ${b}`;
    const started = Date.now();
    new Promise((resolve, reject) => enqueue(cmd, PRIORITY.NORMAL, resolve, reject, { type: 'VGS', m, s, b }))
      .then(raw => {
        const val = Number(String(raw).trim().split(/\s+/).pop());
        const value = !!val;
        VGS_CACHE.set(key, { ts: Date.now(), value, raw: String(val), bytes: String(raw).length });
        const list = inflight.get(key) || [];
        inflight.delete(key);
        for (const { res, format } of list) {
          if (format === 'bool') res.type('text/plain').send(value ? 'true' : 'false');
          else res.json({ ok: true, sent: cmd, value, cached: false, ms: Date.now() - started });
        }
      })
      .catch(err => {
        const list = inflight.get(key) || [];
        inflight.delete(key);
        for (const { res } of list) res.status(500).json({ ok: false, error: String(err || 'VGS failed') });
      });
  }
}

// Primary status endpoint used by Homebridge HTTP-SWITCH accessories
app.get('/status/vgs', serveVGS);

>>>>>>> parent of 48c83c8 (Update app.js)
// Manual reconnect helpers for the UI
app.get('/connect', (req, res) => {
  try { socket.destroy(); } catch (e) {}
  socket = connectServer(current);
  res.json({ ok: true });
});

app.get('/disconnect', (req, res) => {
  try { socket.destroy(); } catch (e) {}
  res.json({ ok: true });
});

// Introspect the queued commands (for the UI)
<<<<<<< HEAD
// Commands: return items from commands.csv for UI; also expose queue at /commands/queue
app.get('/commands', (req, res) => {
  const file = path.join(__dirname, 'commands.csv');
  fs.readFile(file, 'utf8', (err, data) => {
    if (err) return res.json({ items: [] });
    const items = [];
    const lines = String(data || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const cols = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i+1] === '"') { cur += '"'; i++; } else { inQ = !inQ; }
        } else if (ch === ',' && !inQ) {
          cols.push(cur); cur = '';
        } else { cur += ch; }
      }
      cols.push(cur);
      const command = (cols[0] || '').trim();
      const description = (cols[1] || '').trim();
      const params = (cols[2] || '').trim();
      if (command) items.push({ command, params, description });
    }
    res.json({ items });
  });
});

app.get('/commands/queue', (req, res) => {
=======
app.get('/commands', (req, res) => {
>>>>>>> parent of 48c83c8 (Update app.js)
  res.json({ queue: QUEUE.map(q => ({ p: q.priority, cmd: q.cmd })), lastSendTs });
});

// Plain-text log tail served to the UI
app.get('/logs', (req, res) => {
  const p = LOG_FILE_PATH;
  if (!p) return res.type('text/plain').send('logging disabled');
  const limit = +url.parse(req.url, true).query.limit || 200;
  fs.readFile(p, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ ok: false, error: String(err) });
    const lines = data.trim().split(/\r?\n/);
    res.type('text/plain').send(lines.slice(-limit).join('\n'));
  });
});

// Serves /public (classic layout) with server list, send form, logs tail, recv tail, etc.
app.use(express.static(path.join(__dirname, 'public')));

app.get('/recv', (req, res) => {
  res.type('text/plain').send('Tail is in /logs and UI');
});

// Whitelist API (placeholder): in production this is built from Homebridge config
app.get('/whitelist', (req, res) => {
  // Placeholder: list keys observed via Homebridge URLs
  res.json({ ok: true, devices: Array.from(STATE.keys()) });
});

// Trigger a rebuild of the whitelist from Homebridge config (placeholder)
app.post('/whitelist/reload', (req, res) => {
  // Placeholder: would parse HB config.json and rebuild whitelist
  res.json({ ok: true, reloaded: true });
});

/**
 * /test/vsw: helper to write a switch state with a small post-write delay
 *  - waitMs gives HB time to read a coherent result immediately after a write
 */
app.get('/test/vsw', (req, res) => {
  const q = url.parse(req.url, true).query;
  const m = +q.m, s = +q.s, b = +q.b;
  const state = +q.state;
  const waitMs = +q.waitMs || 600;
  if (!(m>=0 && s>=0 && b>=0)) return res.status(400).json({ error: 'missing m/s/b' });
  const cmd = `VSW ${m} ${s} ${b} ${state}`;
  new Promise((resolve, reject) => enqueue(cmd, PRIORITY.TEST, resolve, reject, { type: 'VSW', m, s, b }))
    .then(() => setTimeout(() => res.json({ ok: true }), waitMs))
    .catch(e => res.status(500).json({ ok: false, error: String(e) }));
});

server.listen(PORT, () => logLine(`HTTP listening on ${PORT}`));

/**
 * onSWEvent (PUSH flow):
 *  - Called when a VOS 'SW m s b v' line arrives
 *  - Logs (debug), checks whitelist, debounces per m/s/b
 *  - Schedules a single confirmOneVGS at PUSH_CONFIRM priority
 *  - On success: setState(...) updates both STATE and VGS_CACHE
 */
function onSWEvent({ m, s, b, v }) {
  if (PUSH_DEBUG) logLine(`PUSH heard SW ${m}/${s}/${b} -> ${v}`);
  if (!isWhitelisted(m, s, b)) return; // ignore devices not exposed to HB
  const k = keyOf(m, s, b);
  const existing = PENDING.get(k);
  if (existing) return; // debounce
  const task = async () => {
      if (PUSH_DEBUG) logLine(`PUSH confirm start for ${m}/${s}/${b}`);
    try {
      const val = await confirmOneVGS(m, s, b);
      const vNum = Number(String(val).trim().split(/\s+/).pop());
      setState(m, s, b, !!vNum);
    } catch (e) {
      if (PUSH_DEBUG) logLine(`PUSH confirm failed ${m}/${s}/${b}: ${e}`);
    } finally {
      PENDING.delete(k);
    }
  };
  PENDING.set(k, task);
  // schedule quickly (confirm sooner than regular polls)
  setTimeout(task, 50);
}
