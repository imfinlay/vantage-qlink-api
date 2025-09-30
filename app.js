'use strict';

// =========================================================
// app.js (Queued send + VGS coalesce/cache + priority + jitter + HB whitelist + VOS push)
// - Serves /public (index.html)
// - HTTP -> TCP bridge with connect/disconnect/send
// - /commands  : expose commands.csv (rich)
// - /logs      : tail the app log
// - /recv      : expose recent TCP bytes (utf8/hex/base64)
// - /test/vsw  : press/release a VSW (for HomeKit etc.)
// - /status/vgs: poll a switch state with VGS <m> <s> <b>
//   Formats:
//     * format=raw  -> text/plain "0" or "1" (empty if unknown)
//     * format=bool -> text/plain "true" or "false" (empty if unknown)
//     * (default)   -> JSON { ok, sent, state, raw, bytes, cached? }
// - Logs API-originated commands and HTTP polling attempts
// - Serializes TCP I/O to prevent mixed replies + short cache & coalescing for VGS
// - Global min inter-command gap (MIN_GAP_MS), priority queue, jitter, cacheMs param
// - NEW: Homebridge-driven whitelist + VOS (SW m s b v) event ingest -> one-shot VGS confirm + state cache
// =========================================================

const path = require('path');
const fs = require('fs');
const net = require('net');
const express = require('express');

// -------------------------------
// Configuration
// -------------------------------
const config = require('./config');
const LOG_FILE_PATH = config.LOG_FILE_PATH || path.join(__dirname, 'app.log');
const HANDSHAKE = Object.prototype.hasOwnProperty.call(config, 'HANDSHAKE') ? config.HANDSHAKE : 'VCL 1 0\r\n';
const NL = (typeof config.LINE_ENDING === 'string') ? config.LINE_ENDING : '\r\n'; // allow CR-only via config
const PUSH_DEBUG = !!(process.env.PUSH_DEBUG || (config && config.debug && config.debug.push));

// Short cache window to avoid hammering the controller with back-to-back polls
const MIN_POLL_INTERVAL_MS = Number(config.MIN_POLL_INTERVAL_MS || process.env.MIN_POLL_INTERVAL_MS || 400);
// Global minimum spacing between *any* on-wire sends (in ms)
const MIN_GAP_MS = Number(config.MIN_GAP_MS || process.env.MIN_GAP_MS || 120);

try { fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true }); } catch (_) {}

// -------------------------------
// Globals
// -------------------------------
const app = express();
app.disable('x-powered-by');

let tcpClient = null;       // active net.Socket
let connectedServer = null; // { name, host, port }

// Recent TCP bytes buffer for /recv and send responses
const MAX_RECV_BYTES = 32768; // 32KB ring
let RECV_BUFFER = Buffer.alloc(0);
function appendRecv(buf) {
  try {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf));
    RECV_BUFFER = Buffer.concat([RECV_BUFFER, buf]);
    if (RECV_BUFFER.length > MAX_RECV_BYTES) {
      RECV_BUFFER = RECV_BUFFER.slice(RECV_BUFFER.length - MAX_RECV_BYTES);
    }
    // Logging preview
    const preview = buf.toString('utf8').replace(/\r?\n/g, ' ').slice(0, 200);
    if (preview) logLine(`RX <- ${preview}`);

    // Feed event line parser
    processIncomingText(buf.toString('utf8'));
  } catch (_) {}
}
function resetRecv() { RECV_BUFFER = Buffer.alloc(0); INCOMING_TEXT_BUF = ''; }

// -------------------------------
// Middleware
// -------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// -------------------------------
// Logging helpers
// -------------------------------
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE_PATH, line); } catch (_) {}
}
function clientIp(req){
  try {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  } catch (_) {}
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}
function logHttp(req, msg){
  try { logLine(`HTTP ${req.method} ${req.path} from ${clientIp(req)} -> ${msg}`); } catch (_) {}
}

// -------------------------------
// Commands.csv parsing & validation (rich)
// -------------------------------
const VALID_COMMANDS = new Set();
let COMMAND_ITEMS = []; // [{ command, description, params }]

function splitCSVLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

function loadCommandsCSV(csvPath) {
  COMMAND_ITEMS = [];
  VALID_COMMANDS.clear();
  try {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    if (!lines.length) return;

    const first = splitCSVLine(lines[0]).map(s => s.trim().toLowerCase());
    const hasHeader = first.includes('command');
    const startIdx = hasHeader ? 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const [command = '', description = '', params = ''] = splitCSVLine(lines[i]).map(s => s.trim());
      if (!command) continue;
      VALID_COMMANDS.add(command);
      COMMAND_ITEMS.push({ command, description, params });
    }
  } catch (err) {
    console.warn(`[WARN] Could not load commands from ${csvPath}: ${err.message}`);
  }
}

const COMMANDS_CSV_PATH = path.join(__dirname, 'commands.csv');
loadCommandsCSV(COMMANDS_CSV_PATH);
console.log(`[init] Loaded ${VALID_COMMANDS.size} commands from ${COMMANDS_CSV_PATH}`);

// -------------------------------
// TCP helpers
// -------------------------------
function ensureDisconnected() {
  if (tcpClient) {
    try { tcpClient.removeAllListeners('data'); } catch (_) {}
    try { tcpClient.destroy(); } catch (_) {}
  }
  tcpClient = null;
  connectedServer = null;
  resetRecv();
}

function connectToServer(target) {
  return new Promise((resolve, reject) => {
    ensureDisconnected();
    const socket = new net.Socket();
    let done = false;

    socket.setTimeout(10000);

    socket.once('connect', () => {
      tcpClient = socket;
      connectedServer = target;
      resetRecv();
      socket.on('data', appendRecv);
      try { if (typeof HANDSHAKE === 'string' && HANDSHAKE.length) tcpClient.write(HANDSHAKE); } catch (_) {}
      done = true; resolve();
    });
    socket.once('timeout', () => { if (!done) { socket.destroy(); reject(new Error('TCP connection timeout')); } });
    socket.once('error', (err) => { if (!done) { socket.destroy(); reject(err || new Error('TCP connection error')); } });
    socket.once('close', () => { if (tcpClient === socket) { tcpClient = null; connectedServer = null; } });

    socket.connect(target.port, target.host);
  });
}

function sendToTCP(data) {
  return new Promise((resolve, reject) => {
    if (!tcpClient) return reject(new Error('Not connected'));
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      tcpClient.write(buf, (err) => (err ? reject(err) : resolve()));
    } catch (err) { reject(err); }
  });
}

// Log API commands before sending
function sendCmdLogged(cmd) {
  try { logLine(`CMD/API -> ${cmd}`); } catch (_) {}
  return sendToTCP(cmd + NL);
}

function tailFile(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-maxLines);
  } catch (_) { return []; }
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function waitQuiet(startLen, quietMs, maxMs) {
  return await new Promise((resolve) => {
    let timer = null;
    let hardTimer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (tcpClient) tcpClient.removeListener('data', onData);
      const buf = RECV_BUFFER.slice(startLen);
      resolve(buf);
    };
    const onData = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, Math.max(quietMs, 1));
    };
    hardTimer = setTimeout(finish, Math.max(maxMs, quietMs || 0, 1));
    timer = setTimeout(finish, Math.max(quietMs, 1));
    if (tcpClient) tcpClient.on('data', onData);
  });
}

// -------------------------------
// Priority queue for on-wire sends + global min gap
// -------------------------------
let __queue = []; // items: { fn, priority, resolve, reject, label, enqueuedAt }
let __pumping = false;
let __lastSendAt = 0;

function runQueued(taskFn, { priority = 0, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const item = { fn: taskFn, priority, resolve, reject, label, enqueuedAt: Date.now() };
    // stable priority insert (higher priority first)
    const idx = __queue.findIndex(x => (x.priority || 0) < priority);
    if (idx === -1) __queue.push(item); else __queue.splice(idx, 0, item);
    pumpQueue();
  });
}

async function pumpQueue(){
  if (__pumping) return;
  __pumping = true;
  try {
    while (__queue.length) {
      const item = __queue.shift();
      const now = Date.now();
      const gap = Math.max(0, MIN_GAP_MS - (now - __lastSendAt));
      if (gap > 0) await sleep(gap);
      try {
        const r = await item.fn();
        __lastSendAt = Date.now();
        item.resolve(r);
      } catch (e) {
        item.reject(e);
      }
    }
  } finally {
    __pumping = false;
  }
}

// Back-compat wrapper
function runInTcpQueue(task) { return runQueued(task, { priority: 0 }); }

// Helper: send + collect using quietMs/maxMs inside the queue
function sendAndCollect(cmd, { quietMs = 200, maxMs = 1200, priority = 0 } = {}) {
  return runQueued(async () => {
    const startLen = RECV_BUFFER.length;
    await sendCmdLogged(cmd);
    return await waitQuiet(startLen, quietMs, maxMs);
  }, { priority, label: cmd });
}

// -------------------------------
// VGS cache + in-flight coalescing
// -------------------------------
const VGS_CACHE = new Map(); // key -> { ts, value, raw, bytes }
const VGS_INFLIGHT = new Map(); // key -> Promise<{ value, raw, bytes }>
const vgsKey = (m, s, b) => `${m}-${s}-${b}`;

// Awaiters: allow parallel VGS requests without holding the queue
const AWAITERS = new Map();
const VGS_WAIT_ORDER = []; // FIFO of keys awaiting a reply (for bare 0/1 fallbacks) // key -> [{resolve,reject,timeout}]
function awaitVGS(m, s, b, timeoutMs) {
  const key = vgsKey(m, s, b);
  return new Promise((resolve, reject) => {
    const list = AWAITERS.get(key) || [];
    const to = setTimeout(() => {
      try {
        const arr = AWAITERS.get(key) || [];
        AWAITERS.set(key, arr.filter(x => x.resolve !== resolve));
      } catch (_) {}
      reject(new Error('VGS timeout'));
    }, Math.max(50, timeoutMs || 2000));
    list.push({ resolve, reject, timeout: to });
    AWAITERS.set(key, list);
  });
}

// -------------------------------
// NEW: Homebridge-driven whitelist + VOS push ingest
// -------------------------------
let HB_CONFIG_PATH = null;
let WHITELIST = new Set();
let WHITELIST_MTIME = null;

const STATE = new Map();        // key "m/s/b" -> { value, ts }
const PENDING = new Map();      // key -> timeoutId
const DEBOUNCE_MS = 250;        // debounce SW bursts per device
let INCOMING_TEXT_BUF = '';

function keyOf(m, s, b) { return `${Number(m)}/${Number(s)}/${Number(b)}`; }

function detectHBConfigPath() {
  if (process.env.HB_CONFIG_PATH && fs.existsSync(process.env.HB_CONFIG_PATH)) return process.env.HB_CONFIG_PATH;
  const candidates = [
    '/var/lib/homebridge/config.json',
    '/home/homeauto/.homebridge/config.json',
    '/home/imfinlay/.homebridge/config.json'
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

function parseTripletFromUrl(u) {
  try {
    const url = new URL(u, 'http://localhost');
    const m = Number(url.searchParams.get('m'));
    const s = Number(url.searchParams.get('s'));
    const b = Number(url.searchParams.get('b'));
    if ([m,s,b].every(n => Number.isFinite(n))) return keyOf(m,s,b);
  } catch (_) {}
  return null;
}

function extractWhitelistFromHBConfig(cfg) {
  const set = new Set();
  if (Array.isArray(cfg.accessories)) {
    for (const acc of cfg.accessories) {
      if (!acc || typeof acc !== 'object') continue;
      const urls = [];
      if (typeof acc.statusUrl === 'string') urls.push(acc.statusUrl);
      if (typeof acc.onUrl === 'string')     urls.push(acc.onUrl);
      if (typeof acc.offUrl === 'string')    urls.push(acc.offUrl);
      for (const u of urls) { const k = parseTripletFromUrl(u); if (k) set.add(k); }
    }
  }
  if (Array.isArray(cfg.platforms)) {
    for (const p of cfg.platforms) {
      if (!p || typeof p !== 'object') continue;
      const items = Array.isArray(p.accessories) ? p.accessories : (Array.isArray(p.devices) ? p.devices : null);
      if (!items) continue;
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const urls = [];
        if (typeof it.statusUrl === 'string') urls.push(it.statusUrl);
        if (typeof it.onUrl === 'string')     urls.push(it.onUrl);
        if (typeof it.offUrl === 'string')    urls.push(it.offUrl);
        for (const u of urls) { const k = parseTripletFromUrl(u); if (k) set.add(k); }
      }
    }
  }
  return set;
}

function loadWhitelistFromHomebridgeSync() {
  try {
    HB_CONFIG_PATH = detectHBConfigPath();
    if (!HB_CONFIG_PATH) {
      WHITELIST = new Set();
      WHITELIST_MTIME = null;
      logLine('[WL/HB] no Homebridge config.json found; whitelist empty');
      return;
    }
    const stat = fs.statSync(HB_CONFIG_PATH);
    const raw  = fs.readFileSync(HB_CONFIG_PATH, 'utf8');
    const cfg  = JSON.parse(raw);
    const set  = extractWhitelistFromHBConfig(cfg);
    WHITELIST = set;
    WHITELIST_MTIME = stat.mtime.toISOString();
    logLine(`[WL/HB] loaded ${WHITELIST.size} devices from ${HB_CONFIG_PATH}`);
  } catch (e) {
    logLine(`[WL/HB] load failed: ${e.message}`);
    WHITELIST = new Set();
    WHITELIST_MTIME = null;
  }
}

function isWhitelisted(m, s, b) {
  // Empty whitelist means "deny all" for safety; change to `return true` if you prefer allow-all
  if (WHITELIST.size === 0) return false;
  return WHITELIST.has(keyOf(m, s, b));
}

function setState(m, s, b, value) {
  const k = keyOf(m, s, b);
  const prev = STATE.get(k);
  const now = Date.now();
  if (!prev || prev.value !== value) {
    STATE.set(k, { value, ts: now });
    logLine(`PUSH state ${k} = ${value}`);
    // Optionally mirror to VGS cache too for richer /status JSON path
    const keyV = vgsKey(m, s, b);
    VGS_CACHE.set(keyV, { ts: now, value, raw: String(value), bytes: 1 });
    if (PUSH_DEBUG) logLine(`PUSH cache updated ${m}/${s}/${b} -> ${value}`);
  } else {
    STATE.set(k, { value, ts: now });
  }
}

function processIncomingText(chunkUtf8) {
  INCOMING_TEXT_BUF += chunkUtf8;
  // split on CR or LF boundaries
  let idx;
  while ((idx = INCOMING_TEXT_BUF.search(/[\r\n]/)) >= 0) {
    // consume through the first newline char, also drop a following \n if this was \r\n
    let line = INCOMING_TEXT_BUF.slice(0, idx);
    let rest = INCOMING_TEXT_BUF.slice(idx + 1);
    if (rest.startsWith('\n') && INCOMING_TEXT_BUF[idx] === '\r') rest = rest.slice(1);
    INCOMING_TEXT_BUF = rest;
    if (line.length) { processIncomingLineForSW(line); processIncomingLineForVGS(line); processIncomingLineForRGS(line); processIncomingLineForBare01(line); }
  }
  // If no newline present, keep accumulating.
}

function processIncomingLineForSW(rawLine) {
  // Matches multiple tokens on one line: "SW m s b v"
  const re = /(?:^|\s)SW\s+(\d+)\s+(\d+)\s+(\d+)\s+([01])\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    onSWEvent({ m: M, s: S, b: B, v: V });
  }
}

function processIncomingLineForVGS(rawLine) {
  // Resolve awaiters on lines like: "VGS m s b v"
  const re = /(?:^|\s)VGS\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    const key = vgsKey(M, S, B);
    VGS_CACHE.set(key, { ts: Date.now(), value: !!V, raw: String(V), bytes: String(rawLine).length });
    const list = AWAITERS.get(key);
    if (list && list.length) {
      AWAITERS.delete(key);
      for (const entry of list) {
        try { clearTimeout(entry.timeout); entry.resolve(rawLine); } catch (_) {}
      }
    }
  }
}

function processIncomingLineForBare01(rawLine) {
  const m = String(rawLine).trim().match(/^([01])$/);
  if (!m) return;
  const v = Number(m[1]);
  const key = VGS_WAIT_ORDER.shift();
  if (!key) return;
  VGS_CACHE.set(key, { ts: Date.now(), value: !!v, raw: String(v), bytes: String(rawLine).length });
  const list = AWAITERS.get(key);
  if (list && list.length) {
    AWAITERS.delete(key);
    for (const entry of list) {
      try { clearTimeout(entry.timeout); entry.resolve(String(v)); } catch (_) {}
    }
  }
}

function processIncomingLineForRGS(rawLine) {
  // Resolve awaiters on lines like: "RGS m s b v" (detailed read reply)
  const re = /(?:^|\s)RGS\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    const key = vgsKey(M, S, B);
    VGS_CACHE.set(key, { ts: Date.now(), value: !!V, raw: String(V), bytes: String(rawLine).length });
    // Resolve any awaiters for this key
    const list = AWAITERS.get(key);
    if (list && list.length) {
      AWAITERS.delete(key);
      for (const entry of list) {
        try { clearTimeout(entry.timeout); entry.resolve(rawLine); } catch (_) {}
      }
    }
    // Remove from FIFO fallback queue if present
    if (typeof VGS_WAIT_ORDER !== 'undefined') {
      const idx = VGS_WAIT_ORDER.indexOf(key);
      if (idx !== -1) VGS_WAIT_ORDER.splice(idx, 1);
    }
  }
}

function onSWEvent({ m, s, b, v }) {
  if (PUSH_DEBUG) logLine(`PUSH heard SW ${m}/${s}/${b} -> ${v}`);
  if (!isWhitelisted(m, s, b)) return; // ignore devices not exposed to HB
  const k = keyOf(m, s, b);
  // Debounce confirm (release confirms quicker)
  const existing = PENDING.get(k);
  if (existing) clearTimeout(existing);
  const delay = (v === 0) ? 60 : DEBOUNCE_MS;
  const timer = setTimeout(async () => {
    PENDING.delete(k);
    try {
      if (PUSH_DEBUG) logLine(`PUSH confirm start for ${m}/${s}/${b}`);

      const val = await confirmOneVGS(m, s, b);
      setState(m, s, b, val);
    } catch (e) {
      logLine(`VOS->VGS confirm failed for ${k}: ${e.message}`);
    }
  }, delay);
  PENDING.set(k, timer);
}

async function confirmOneVGS(m, s, b) {
  const cmd = `VGS# ${m} ${s} ${b}`;
  const buf = await sendAndCollect(cmd, { quietMs: 300, maxMs: 2000, priority: 6 });
  const raw = buf.toString('utf8').trim();
  const m01 = raw.match(/\b([01])\b/);
  return m01 ? Number(m01[1]) : 0;
}

// -------------------------------
// API
// -------------------------------

// Servers list
app.get('/servers', (_req, res) => {
  const list = Array.isArray(config.servers) ? config.servers.map((s, i) => ({ index: i, name: s.name || `Server ${i}` , host: s.host, port: s.port })) : [];
  res.json({ servers: list });
});

// Status of connection
app.get('/status', (_req, res) => {
  res.json({ connected: Boolean(tcpClient), server: connectedServer || null });
});

// Connect
app.post('/connect', async (req, res) => {
  try {
    const { serverIndex } = req.body || {};
    const list = Array.isArray(config.servers) ? config.servers : [];
    if (typeof serverIndex !== 'number' || serverIndex < 0 || serverIndex >= list.length) {
      return res.status(400).json({ message: 'Invalid server index.' });
    }
    const target = list[serverIndex];
    await connectToServer(target);
    logLine(`Connected to ${target.name || target.host}:${target.port}`);
    return res.json({ message: `Connected to ${target.name || target.host}:${target.port}` });
  } catch (err) {
    logLine(`Connect error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to connect to the server.' });
  }
});

// Disconnect
app.post('/disconnect', (_req, res) => {
  if (!tcpClient) return res.json({ message: 'Already disconnected.' });
  const target = connectedServer;
  ensureDisconnected();
  logLine(`Disconnected from ${target ? (target.name || `${target.host}:${target.port}`) : 'unknown'}`);
  res.json({ message: 'Disconnected.' });
});

// Send (supports waitMs and quietMs)
app.post('/send', async (req, res) => {
  try {
    if (!tcpClient) return res.status(400).json({ message: 'Not connected.' });
    const body = req.body || {};
    const { command, data } = body;

    const waitMs = Number(body.waitMs || 0);
    const quietMs = Number(body.quietMs || 0);
    const maxMs = Number(body.maxMs || 2000);

    let payload = null;
    if (typeof command === 'string' && command.trim()) {
      const cmd = command.trim();
      // Soft validation: accept base token with params and trailing modifiers
      const base = cmd.replace(/[\r\n]+/g, '').replace(/[$#]+$/g, '').split(/\s+/)[0];
      if (VALID_COMMANDS.size > 0 && !VALID_COMMANDS.has(cmd) && !VALID_COMMANDS.has(base)) {
        return res.status(400).json({ message: 'Invalid command.' });
      }
      payload = cmd + NL;
      logLine(`CMD -> ${cmd}`); // UI/clients via /send
    } else if (typeof data === 'string' || Buffer.isBuffer(data)) {
      payload = data;
      logLine(`DATA -> ${String(data).slice(0, 200)}${String(data).length > 200 ? '…' : ''}`);
    } else {
      return res.status(400).json({ message: 'No command or data provided.' });
    }

    // Run send + wait INSIDE the queue so nothing else interleaves
    const uiPriority = 5; // higher than status polls (0), lower than control bursts (10)
    const buf = await runQueued(async () => {
      const startLen = RECV_BUFFER.length;
      if (typeof command === 'string' && command.trim()) {
        await sendCmdLogged(command.trim());
      } else {
        await sendToTCP(payload);
      }
      if (quietMs > 0) {
        return await waitQuiet(startLen, quietMs, maxMs);
      } else if (waitMs > 0) {
        await sleep(waitMs);
        return RECV_BUFFER.slice(startLen);
      }
      return Buffer.alloc(0);
    }, { priority: uiPriority, label: 'UI/send' });

    const response = (waitMs > 0 || quietMs > 0) ? {
      bytes: buf.length,
      text: buf.toString('utf8'),
      hex: buf.toString('hex'),
      base64: buf.toString('base64')
    } : null;

    return res.json({ message: 'Sent.', response });
  } catch (err) {
    logLine(`Send error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to send.' });
  }
});

// Convenience: VSW test route
//   GET /test/vsw?m=2&s=20&b=7&state=1&waitMs=800
//   POST /test/vsw { m,s,b,state,waitMs }
app.get('/test/vsw', async (req, res) => {
  try {
    if (!tcpClient) { logHttp(req, 'VSW attempt while not connected'); return res.status(400).json({ ok:false, message: 'Not connected.' }); }
    const m = parseInt(req.query.m, 10) || 2;
    const s = parseInt(req.query.s, 10) || 20;
    const b = parseInt(req.query.b, 10) || 7;
    const state = (req.query.state != null) ? String(req.query.state) : '1';
    const waitMs = Number(req.query.waitMs || 800);
    const cmd = `VSW ${m} ${s} ${b} ${state}`;

    logHttp(req, cmd);

    const buf = await runQueued(async () => {
      const startLen = RECV_BUFFER.length;
      await sendCmdLogged(cmd);
      if (waitMs > 0) { await sleep(waitMs); return RECV_BUFFER.slice(startLen); }
      return Buffer.alloc(0);
    }, { priority: 10, label: cmd }); // priority: controls > polls

    const response = (waitMs > 0) ? { bytes: buf.length, text: buf.toString('utf8') } : null;
    return res.json({ ok:true, sent: cmd, response });
  } catch (err) {
    logLine(`VSW test error: ${err.message}`);
    return res.status(500).json({ ok:false, message: 'VSW test failed.' });
  }
});

app.post('/test/vsw', async (req, res) => {
  try {
    if (!tcpClient) { logHttp(req, 'VSW attempt while not connected'); return res.status(400).json({ ok:false, message: 'Not connected.' }); }
    const body = req.body || {};
    const m = parseInt(body.m, 10) || 2;
    const s = parseInt(body.s, 10) || 20;
    const b = parseInt(body.b, 10) || 7;
    const state = (body.state != null) ? String(body.state) : '1';
    const waitMs = Number(body.waitMs || 800);
    const cmd = `VSW ${m} ${s} ${b} ${state}`;

    logHttp(req, cmd);

    const buf = await runQueued(async () => {
      const startLen = RECV_BUFFER.length;
      await sendCmdLogged(cmd);
      if (waitMs > 0) { await sleep(waitMs); return RECV_BUFFER.slice(startLen); }
      return Buffer.alloc(0);
    }, { priority: 10, label: cmd });

    const response = (waitMs > 0) ? { bytes: buf.length, text: buf.toString('utf8') } : null;
    return res.json({ ok:true, sent: cmd, response });
  } catch (err) {
    logLine(`VSW test error: ${err.message}`);
    return res.status(500).json({ ok:false, message: 'VSW test failed.' });
  }
});

// Status: VGS (switch only)
//   GET /status/vgs?m=2&s=20&b=7[&quietMs=200&maxMs=1200][&cacheMs=750&jitterMs=300][&format=raw|bool]
//   - Sends "VGS m s b" and returns state
//   - format=raw  -> text/plain "0" or "1" (empty if none)
//   - format=bool -> text/plain "true" or "false" (empty if none)
//   - default JSON -> { ok, sent, state, raw, bytes, cached? }
app.get('/status/vgs', async (req, res) => {
  try {
    if (!tcpClient) { logHttp(req, 'VGS poll while not connected'); return res.status(400).json({ ok:false, message: 'Not connected.' }); }
    const m = parseInt(req.query.m, 10);
    const s = parseInt(req.query.s, 10);
    const b = parseInt(req.query.b, 10);
    if (!Number.isFinite(m) || !Number.isFinite(s) || !Number.isFinite(b)) {
      return res.status(400).json({ ok:false, message: 'Missing or invalid m/s/b.' });
    }

    const cmd = `VGS# ${m} ${s} ${b}`;
    logHttp(req, cmd);

    const quietMs  = Number(req.query.quietMs || 200);
    const maxMs    = Number(req.query.maxMs   || 1200);
    const cacheMs  = Math.max(0, Number(req.query.cacheMs || MIN_POLL_INTERVAL_MS));
    const jitterMs = Math.max(0, Number(req.query.jitterMs || 0));

    const key = vgsKey(m, s, b);
    const now = Date.now();
    const fmt = String(req.query.format || '').toLowerCase();

    // FAST PATH: serve from push STATE if fresh (10s)
    const kState = keyOf(m, s, b);
    const st = STATE.get(kState);
    if (st && (now - st.ts) < 10_000) {
      const value = st.value;
      if (fmt === 'raw') { res.type('text/plain'); return res.status(200).send(value == null ? '' : String(value)); }
      if (fmt === 'bool') { res.type('text/plain'); return res.status(200).send(value == null ? '' : (value ? 'true' : 'false')); }
      return res.json({ ok:true, sent: `(push-cache) ${cmd}`, state: value, raw: String(value), bytes: 1, cached: true });
    }

    // Serve fresh VGS cache immediately
    const cached = VGS_CACHE.get(key);
    if (cached && (now - cached.ts) < cacheMs) {
      const value = cached.value;
      if (fmt === 'raw') { res.type('text/plain'); return res.status(200).send(value == null ? '' : String(value)); }
      if (fmt === 'bool') { res.type('text/plain'); return res.status(200).send(value == null ? '' : (value ? 'true' : 'false')); }
      return res.json({ ok:true, sent: `(cached) ${cmd}`, state: value, raw: cached.raw, bytes: cached.bytes, cached: true });
    }

    // Coalesce concurrent identical VGS polls
    if (VGS_INFLIGHT.has(key)) {
      const infl = await VGS_INFLIGHT.get(key);
      const value = infl.value;
      if (fmt === 'raw') { res.type('text/plain'); return res.status(200).send(value == null ? '' : String(value)); }
      if (fmt === 'bool') { res.type('text/plain'); return res.status(200).send(value == null ? '' : (value ? 'true' : 'false')); }
      return res.json({ ok:true, sent: `(coalesced) ${cmd}`, state: value, raw: infl.raw, bytes: infl.bytes, cached: false });
    }

    // Start a new on-wire poll with optional jitter and queue spacing
    const p = (async () => {
      if (jitterMs > 0) await sleep(Math.floor(Math.random() * jitterMs));
      // Register waiter before sending so we don't miss the reply
      const respP = awaitVGS(m, s, b, maxMs);
      VGS_WAIT_ORDER.push(key);
      // Only the write is serialized; we don't block the queue while waiting
      await runQueued(async () => { await sendCmdLogged(cmd); }, { priority: 0, label: cmd });
      const raw = await respP;
      const m01 = String(raw).match(/\b([01])\b/);
      const value = m01 ? Number(m01[1]) : null;
      const rec = { ts: Date.now(), value, raw: String(raw), bytes: String(raw).length };
      VGS_CACHE.set(key, rec);
      // cleanup any leftover entry in the wait-order queue
      {
        const idx = VGS_WAIT_ORDER.indexOf(key);
        if (idx !== -1) VGS_WAIT_ORDER.splice(idx, 1);
      }
      return { value, raw: String(raw), bytes: String(raw).length };
    })();

    VGS_INFLIGHT.set(key, p);
    let out;
    try { out = await p; } finally { VGS_INFLIGHT.delete(key); }

    if (fmt === 'raw') { res.type('text/plain'); return res.status(200).send(out.value == null ? '' : String(out.value)); }
    if (fmt === 'bool') { res.type('text/plain'); return res.status(200).send(out.value == null ? '' : (out.value ? 'true' : 'false')); }

    return res.json({ ok:true, sent: cmd, state: out.value, raw: out.raw, bytes: out.bytes });
  } catch (err) {
    logLine(`VGS status error: ${err.message}`);
    return res.status(500).json({ ok:false, message: 'VGS status failed.' });
  }
});

// Commands (rich + legacy)
app.get('/commands', (_req, res) => {
  const cmds = Array.from(VALID_COMMANDS.values()).sort();
  res.json({ commands: cmds, count: cmds.length, items: COMMAND_ITEMS });
});

// Admin: reload commands.csv on demand
app.post('/admin/reload-commands', (_req, res) => {
  loadCommandsCSV(COMMANDS_CSV_PATH);
  const count = VALID_COMMANDS.size;
  console.log(`[admin] Reloaded commands: ${count}`);
  logLine(`[admin] Reloaded commands: ${count}`);
  res.json({ message: 'Commands reloaded', count });
});

// Whitelist visibility + reload (Homebridge-driven)
app.get('/whitelist', (_req, res) => {
  res.json({
    source: 'homebridge',
    path: HB_CONFIG_PATH,
    count: WHITELIST.size,
    mtime: WHITELIST_MTIME,
    devices: Array.from(WHITELIST).sort()
  });
});
app.post('/whitelist/reload', (_req, res) => {
  loadWhitelistFromHomebridgeSync();
  res.json({ message: 'reloaded', count: WHITELIST.size, mtime: WHITELIST_MTIME });
});

// Logs tail
app.get('/logs', (req, res) => {
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 200;
  const lines = tailFile(LOG_FILE_PATH, limit);
  res.json({ file: LOG_FILE_PATH, count: lines.length, lines });
});

// Recent TCP receive buffer
app.get('/recv', (req, res) => {
  const limitRaw = parseInt(req.query.limitBytes, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_RECV_BYTES) : 2048;
  const encoding = (req.query.encoding || 'utf8').toString().toLowerCase();
  const slice = RECV_BUFFER.slice(Math.max(0, RECV_BUFFER.length - limit));
  let data;
  if (encoding === 'hex') data = slice.toString('hex');
  else if (encoding === 'base64') data = slice.toString('base64');
  else data = slice.toString('utf8');
  res.json({ length: slice.length, encoding, data });
});

// -------------------------------
// SPA fallback (optional)
// -------------------------------
app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/send') ||
    req.path.startsWith('/connect') ||
    req.path.startsWith('/disconnect') ||
    req.path.startsWith('/status') ||
    req.path.startsWith('/servers') ||
    req.path.startsWith('/commands') ||
    req.path.startsWith('/logs') ||
    req.path.startsWith('/recv') ||
    req.path.startsWith('/admin') ||
    req.path.startsWith('/test') ||
    req.path.startsWith('/whitelist')
  ) {
    return next();
  }
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return next();
});

// -------------------------------
// Start server (when run directly)
// -------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Load HB whitelist on boot
loadWhitelistFromHomebridgeSync();

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`HTTP to TCP API listening on http://${HOST}:${PORT}`);
  });
} else {
  module.exports = app;
}
