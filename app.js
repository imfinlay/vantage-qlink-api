'use strict';

const path = require('path');
const fs = require('fs');
const net = require('net');
const express = require('express');
const os = require('os');

const config = require('./config');
const LOG_FILE_PATH = config.LOG_FILE_PATH || path.join(__dirname, 'app.log');
const HANDSHAKE = Object.prototype.hasOwnProperty.call(config, 'HANDSHAKE') ? config.HANDSHAKE : 'VCL 1 0\r\n';
const NL = (typeof config.LINE_ENDING === 'string') ? config.LINE_ENDING : '\r\n'; 
const PUSH_DEBUG = !!(process.env.PUSH_DEBUG || (config && config.debug && config.debug.push));

const MIN_POLL_INTERVAL_MS = Number(config.MIN_POLL_INTERVAL_MS || process.env.MIN_POLL_INTERVAL_MS || 400);

const MIN_GAP_MS = Number(config.MIN_GAP_MS || process.env.MIN_GAP_MS || 120);

const PUSH_FRESH_MS = Number(config.PUSH_FRESH_MS || process.env.PUSH_FRESH_MS || 10000);
const HB_WHITELIST_STRICT = (config && Object.prototype.hasOwnProperty.call(config, 'HB_WHITELIST_STRICT')) ? !!config.HB_WHITELIST_STRICT : true;
const HANDSHAKE_RETRY_MS = Number(config.HANDSHAKE_RETRY_MS || process.env.HANDSHAKE_RETRY_MS || 0);

try { fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true }); } catch (_) {}

const app = express();
app.disable('x-powered-by');

let tcpClient = null;       
let connectedServer = null; 

const MAX_RECV_BYTES = 32768; 
let RECV_BUFFER = Buffer.alloc(0);
function appendRecv(buf) {
  try {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf));

    if (RECV_BUFFER.length + buf.length > MAX_RECV_BYTES) {
      const keep = Math.max(0, MAX_RECV_BYTES - buf.length);
      if (keep < RECV_BUFFER.length) RECV_BUFFER = RECV_BUFFER.slice(RECV_BUFFER.length - keep);
    }
    RECV_BUFFER = Buffer.concat([RECV_BUFFER, buf]);

    const text = buf.toString('utf8');
    const preview = text.replace(/\r?\n/g, ' ').slice(0, 200);
    if (preview) logLine(`RX <- ${preview}`);

    processIncomingText(text);
  } catch (_) {}
}
function resetRecv() { RECV_BUFFER = Buffer.alloc(0); INCOMING_TEXT_BUF = ''; }

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const LOG_RING_MAX = Number(process.env.LOG_RING_MAX || (config && config.LOG_RING_MAX) || 2000);
let LOG_RING = [];
let _logStream = null;
let _logBusy = false;
let _logQueue = [];
function _openLogStream() {
  try {
    _logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' });
    _logStream.on('drain', () => {
      _logBusy = false;
      try {
        while (_logQueue.length && !_logBusy) {
          const s = _logQueue.shift();
          _logBusy = !_logStream.write(s);
        }
      } catch (_) {}
    });
    _logStream.on('error', (err) => {
      try { console.error('[log] stream error:', err && err.message ? err.message : String(err)); } catch (_) {}
      try { _logStream.destroy(); } catch (_) {}
      _logStream = null;
    });
  } catch (_) { _logStream = null; }
}
_openLogStream();
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;

  try {
    LOG_RING.push(line.endsWith('\n') ? line.slice(0, -1) : line);
    if (LOG_RING.length > LOG_RING_MAX) LOG_RING.splice(0, LOG_RING.length - LOG_RING_MAX);
  } catch (_) {}

  try {
    if (!_logStream) _openLogStream();
    if (_logStream) {
      if (!_logBusy) {
        _logBusy = !_logStream.write(line);
      } else {
        _logQueue.push(line);
      }
    } else {

      fs.appendFile(LOG_FILE_PATH, line, () => {});
    }
  } catch (_) {
    try { fs.appendFile(LOG_FILE_PATH, line, () => {}); } catch (_) {}
  }
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

function toOn(v) {

  return v === 1 || v === true || v === '1';
}

const VALID_COMMANDS = new Set();
let COMMAND_ITEMS = []; 

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

function ensureDisconnected() {
  if (tcpClient) {
    try { tcpClient.removeAllListeners('data'); } catch (_) {}
    try { tcpClient.destroy(); } catch (_) {}
  }
  tcpClient = null;
  connectedServer = null;
  resetRecv();

  try {
    for (const [, t] of PENDING) { try { clearTimeout(t); } catch (_) {} }
    PENDING.clear();
  } catch (_) {}
  try {
    for (const [k, list] of AWAITERS) {
      AWAITERS.delete(k);
      for (const entry of list) {
        try { clearTimeout(entry.timeout); entry.reject(new Error('disconnected')); } catch (_) {}
      }
    }
    VGS_WAIT_ORDER.length = 0;
  } catch (_) {}
}

/**
 * Establish a TCP connection to the target Vantage server.
 * Enables Nagle off (NoDelay), attaches the RX handler, sends HANDSHAKE once
 * (and optionally retries after `HANDSHAKE_RETRY_MS`).
 * @param {{name?:string, host:string, port:number}} target
 * @returns {Promise<void>}
 */
function connectToServer(target) {
  return new Promise((resolve, reject) => {
    ensureDisconnected();
    const socket = new net.Socket();
    let done = false;

	// Had some issues with timeout
    //socket.setTimeout(10000); 
    socket.setTimeout(0);               // 0 = disable idle timeout
    socket.setKeepAlive(true, 30000);   // send keepalive every ~30s

    socket.once('connect', () => {
      socket.setNoDelay(true); 
      tcpClient = socket;
      connectedServer = target;
      resetRecv();
      socket.on('data', appendRecv);
      // Optional handshake — only if configured
      try {
        if (typeof HANDSHAKE === 'string' && HANDSHAKE.length) tcpClient.write(HANDSHAKE);
      } catch (_) {}
      
      // Optional second handshake — safe to keep, but it’s fine to disable via config
      try {
        if (HANDSHAKE_RETRY_MS > 0)
          setTimeout(() => {
            try {
              if (tcpClient === socket && typeof HANDSHAKE === 'string' && HANDSHAKE.length) tcpClient.write(HANDSHAKE);
            } catch (_) {}
          }, HANDSHAKE_RETRY_MS);
      } catch (_) {}
		
      done = true; resolve();
    });
// With idle timeout disabled, this rarely triggers; keep for safety if setTimeout > 0 is ever reintroduced
    socket.once('timeout', () => { if (!done) { socket.destroy(); reject(new Error('TCP connection timeout')); } });
    socket.once('error', (err) => { if (!done) { socket.destroy(); reject(err || new Error('TCP connection error')); } });
    socket.once('close', () => { if (tcpClient === socket) { tcpClient = null; connectedServer = null; } });

    socket.connect(target.port, target.host);
  });
}

/**
 * Write raw data to the active TCP socket.
 * @param {Buffer|string} data
 * @returns {Promise<void>}
 */
function sendToTCP(data) {
  return new Promise((resolve, reject) => {
    if (!tcpClient) return reject(new Error('Not connected'));
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      tcpClient.write(buf, (err) => (err ? reject(err) : resolve()));
    } catch (err) { reject(err); }
  });
}

/**
 * Log an API command and send it with the configured line ending.
 * @param {string} cmd Command without trailing newline
 * @returns {Promise<void>}
 */
function sendCmdLogged(cmd) {
  try { logLine(`CMD/API -> ${cmd}`); } catch (_) {}
  return sendToTCP(cmd + NL);
}

function tailFile(filePath, maxLines) {
  const n = Math.max(1, Number(maxLines) || 1);

  if (Array.isArray(LOG_RING) && LOG_RING.length) {
    return LOG_RING.slice(-n);
  }

  if (!fs.existsSync(filePath)) return [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
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

let __queue = []; 
let __pumping = false;
let __lastSendAt = 0;

/**
 * Schedule a function to run inside the global on‑wire queue with an optional priority.
 * Higher `priority` executes earlier; spacing is enforced by `MIN_GAP_MS`.
 * @template T
 * @param {() => Promise<T>} taskFn
 * @param {{priority?:number,label?:string}} [opts]
 * @returns {Promise<T>}
 */
function runQueued(taskFn, { priority = 0, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const item = { fn: taskFn, priority, resolve, reject, label, enqueuedAt: Date.now() };

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

const VGS_CACHE = new Map(); 
const VGS_INFLIGHT = new Map(); 
const vgsKey = (m, s, b) => `${m}-${s}-${b}`;

const AWAITERS = new Map();

const VGS_WAIT_ORDER = [];

const AWAITERS_MAX_PER_KEY = Number(config.AWAITERS_MAX_PER_KEY || process.env.AWAITERS_MAX_PER_KEY || 200);
/**
 * Register an awaiter for a `VGS# m s b` reply and enforce a timeout.
 * The actual on‑wire send is performed elsewhere; this only tracks the response.
 * @param {number} m
 * @param {number} s
 * @param {number} b
 * @param {number} timeoutMs
 * @returns {Promise<string>} Resolves with the raw line containing the reply
 */
function awaitVGS(m, s, b, timeoutMs) {
  const key = vgsKey(m, s, b);
  return new Promise((resolve, reject) => {
    const list = AWAITERS.get(key) || [];
    if (list.length >= AWAITERS_MAX_PER_KEY) {
      return reject(new Error('awaiters limit reached'));
    }
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

/**
 * Queue a `VGS#` send and attach an awaiter so the reply can resolve asynchronously
 * (the queue is released immediately after the write).
 * @param {number} m
 * @param {number} s
 * @param {number} b
 * @param {string} cmd Command string (e.g., `VGS# m s b`)
 * @param {number} maxMs Timeout in milliseconds
 * @returns {Promise<string>} Raw reply text captured by the awaiter
 */
function sendVGSWithAwaiter(m, s, b, cmd, maxMs) {
  return new Promise((resolve, reject) => {
    runQueued(async () => {
      try {
        const key = vgsKey(m, s, b);
        const p = awaitVGS(m, s, b, maxMs);
        VGS_WAIT_ORDER.push(key);
        await sendCmdLogged(cmd);
        p.then((raw) => {
          try { const idx = VGS_WAIT_ORDER.indexOf(key); if (idx !== -1) VGS_WAIT_ORDER.splice(idx, 1); } catch (_) {}
          resolve(raw);
        }).catch((err) => {
          try { const idx = VGS_WAIT_ORDER.indexOf(key); if (idx !== -1) VGS_WAIT_ORDER.splice(idx, 1); } catch (_) {}
          reject(err);
        });
        return; 
      } catch (e) {
        reject(e);
      }
    }, { priority: 0, label: cmd });
  });
}

let HB_CONFIG_PATH = null;
let WHITELIST = new Set();
let WHITELIST_MTIME = null;

const STATE = new Map();        
const PENDING = new Map();      
const DEBOUNCE_MS = 250;        
let INCOMING_TEXT_BUF = '';

function keyOf(m, s, b) { return `${Number(m)}/${Number(s)}/${Number(b)}`; }

function detectHBConfigPath() {

  const fromEnv = process.env.HB_CONFIG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const fromCfg = (config.HB_CONFIG_PATH && fs.existsSync(config.HB_CONFIG_PATH))
    ? config.HB_CONFIG_PATH
    : null;
  if (fromCfg) return fromCfg;

  const home = os.homedir && os.homedir();
  const candidates = [
    ...(Array.isArray(config.HB_CONFIG_CANDIDATES) ? config.HB_CONFIG_CANDIDATES : []),
    '/var/lib/homebridge/config.json',
    home ? path.join(home, '.homebridge', 'config.json') : null
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
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

  if (WHITELIST.size === 0) return HB_WHITELIST_STRICT ? false : true;
  return WHITELIST.has(keyOf(m, s, b));
}

function setState(m, s, b, value) {
  const k = keyOf(m, s, b);
  const prev = STATE.get(k);
  const now = Date.now();
  if (!prev || prev.value !== value) {
    STATE.set(k, { value, ts: now });
    logLine(`PUSH state ${k} = ${value}`);

    const keyV = vgsKey(m, s, b);
    VGS_CACHE.set(keyV, { ts: now, value, raw: String(value), bytes: 1 });
    if (PUSH_DEBUG) logLine(`PUSH cache updated ${m}/${s}/${b} -> ${value}`);
  } else {
    STATE.set(k, { value, ts: now });
  }
}

/**
 * Incrementally parse incoming bytes into lines and dispatch to line handlers.
 * Accepts both `\r`, `\n`, and `\r\n` as delimiters.
 * @param {string} chunkUtf8
 */
function processIncomingText(chunkUtf8) {
  INCOMING_TEXT_BUF += chunkUtf8;

  let idx;
  while ((idx = INCOMING_TEXT_BUF.search(/[\r\n]/)) >= 0) {

    let line = INCOMING_TEXT_BUF.slice(0, idx);
    let rest = INCOMING_TEXT_BUF.slice(idx + 1);
    if (rest.startsWith('\n') && INCOMING_TEXT_BUF[idx] === '\r') rest = rest.slice(1);
    INCOMING_TEXT_BUF = rest;
	if (line.length) { processIncomingLineForSW(line); processIncomingLineForVGS(line); processIncomingLineForRGS(line); processIncomingLineForBare01(line); }

  }

}

function processIncomingLineForSW(rawLine) {

  const re = /(?:^|\s)SW\s+(\d+)\s+(\d+)\s+(\d+)\s+([01])\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    onSWEvent({ m: M, s: S, b: B, v: V });
  }
}

function processIncomingLineForVGS(rawLine) {

  const re = /(?:^|\s)VGS\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    const key = vgsKey(M, S, B);
	VGS_CACHE.set(key, { ts: Date.now(), value: (V ? 1 : 0), raw: String(V), bytes: String(rawLine).length });
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
  VGS_CACHE.set(key, { ts: Date.now(), value: (v ? 1 : 0), raw: String(v), bytes: String(rawLine).length });
  const list = AWAITERS.get(key);
  if (list && list.length) {
    AWAITERS.delete(key);
    for (const entry of list) {
      try { clearTimeout(entry.timeout); entry.resolve(String(v)); } catch (_) {}
    }
  }
}

function processIncomingLineForRGS(rawLine) {

  const re = /(?:^|\s)RGS#?\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    const key = vgsKey(M, S, B);
	VGS_CACHE.set(key, { ts: Date.now(), value: (V ? 1 : 0), raw: String(V), bytes: String(rawLine).length });

    const list = AWAITERS.get(key);
    if (list && list.length) {
      AWAITERS.delete(key);
      for (const entry of list) {
        try { clearTimeout(entry.timeout); entry.resolve(rawLine); } catch (_) {}
      }
    }

    if (typeof VGS_WAIT_ORDER !== 'undefined') {
      const idx = VGS_WAIT_ORDER.indexOf(key);
      if (idx !== -1) VGS_WAIT_ORDER.splice(idx, 1);
    }
  }
}

function parseRgsLine(text) {

  const re = new RegExp('(?:^|\\s)RGS#?\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(-?\\d+)\\b');
  const m = String(text).match(re);
  return m ? { m: Number(m[1]), s: Number(m[2]), b: Number(m[3]), v: Number(m[4]) } : null;
}

function parseVgsLine(text) {

  const re = new RegExp('(?:^|\\s)VGS#?\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(-?\\d+)\\b');
  const m = String(text).match(re);
  return m ? { m: Number(m[1]), s: Number(m[2]), b: Number(m[3]), v: Number(m[4]) } : null;
}

function parseStateFromAny(text) {
  const r = parseRgsLine(text) || parseVgsLine(text);
  if (r) return { key: vgsKey(r.m, r.s, r.b), value: r.v ? 1 : 0, raw: String(text) };
  const reBare = new RegExp('(?:^|\\s)([01])(?:\\s|$)');
  const mb = String(text).match(reBare);
  if (mb) return { key: null, value: Number(mb[1]) ? 1 : 0, raw: String(text) };
  return null;
}

function onSWEvent({ m, s, b, v }) {
  if (PUSH_DEBUG) logLine(`PUSH heard SW ${m}/${s}/${b} -> ${v}`);
  if (!isWhitelisted(m, s, b)) return; 
  const k = keyOf(m, s, b);

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

/**
 * One‑shot confirmation read for a switch using `VGS#`.
 * @param {number} m
 * @param {number} s
 * @param {number} b
 * @returns {Promise<0|1>} Parsed switch state (0/1)
 */
async function confirmOneVGS(m, s, b) {
  const cmd = `VGS# ${m} ${s} ${b}`;
  const raw = await sendVGSWithAwaiter(m, s, b, cmd, 2000);
  const parsed = parseStateFromAny(raw);
  if (parsed && (parsed.key === null || parsed.key === vgsKey(m, s, b))) return parsed.value;
  const mBare = String(raw).trim().match(/^([01])$/);
  return mBare ? Number(mBare[1]) : 0;
}

/**
 * Send a response in one of the supported formats for `/status/vgs`.
 * @param {import('express').Response} res
 * @param {string} format `raw` | `bool` | (default JSON)
 * @param {0|1|null} value
 * @param {string|null} raw
 */
function sendFormatted(res, format, value, raw) {
  try {
    if (format === 'bool') {
      const out = value ? 'true' : 'false';
      return res.status(200).type('text/plain').send(out);
    }
    if (format === 'raw') {
      return res.status(200).type('text/plain').send(raw != null ? String(raw) : '');
    }
    return res.status(200).json({ ok: true, value, raw });
  } catch (_) {

    return res.status(200).type('text/plain').send(value ? 'true' : 'false');
  }
}

app.get('/servers', (_req, res) => {
  const list = Array.isArray(config.servers) ? config.servers.map((s, i) => ({ index: i, name: s.name || `Server ${i}` , host: s.host, port: s.port })) : [];
  res.json({ servers: list });
});

app.get('/status', (_req, res) => {
  res.json({ connected: Boolean(tcpClient), server: connectedServer || null });
});

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

app.post('/disconnect', (_req, res) => {
  if (!tcpClient) return res.json({ message: 'Already disconnected.' });
  const target = connectedServer;
  ensureDisconnected();
  logLine(`Disconnected from ${target ? (target.name || `${target.host}:${target.port}`) : 'unknown'}`);
  res.json({ message: 'Disconnected.' });
});

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

      const base = cmd.replace(/[\r\n]+/g, '').replace(/[$#]+$/g, '').split(/\s+/)[0];
      if (VALID_COMMANDS.size > 0 && !VALID_COMMANDS.has(cmd) && !VALID_COMMANDS.has(base)) {
        return res.status(400).json({ message: 'Invalid command.' });
      }
      payload = cmd + NL;
      logLine(`CMD -> ${cmd}`); 
    } else if (typeof data === 'string' || Buffer.isBuffer(data)) {
      payload = data;
      logLine(`DATA -> ${String(data).slice(0, 200)}${String(data).length > 200 ? '…' : ''}`);
    } else {
      return res.status(400).json({ message: 'No command or data provided.' });
    }

    const uiPriority = 5; 
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
    }, { priority: 10, label: cmd }); 

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

	// push-state fresh
	const kState = keyOf(m, s, b);
	const st = STATE.get(kState);
	if (st && (now - st.ts) < PUSH_FRESH_MS) {
	  const value = st.value;
	  return sendFormatted(res, fmt, value, String(value));
	}
	
	// cached
	const cached = VGS_CACHE.get(key);
	if (cached && (now - cached.ts) < cacheMs) {
	  const value = cached.value;
	  return sendFormatted(res, fmt, cached.value, cached.raw);
	}  // <-- only one }
	
	// in-flight
	if (VGS_INFLIGHT.has(key)) {
	  const infl = await VGS_INFLIGHT.get(key);
	  return sendFormatted(res, fmt, infl.value, infl.raw);
	}  // <-- add this }
	
	// fresh on-wire
	const p = (async () => {
	  if (jitterMs > 0) await sleep(Math.floor(Math.random() * jitterMs));
	  const raw = await sendVGSWithAwaiter(m, s, b, cmd, maxMs);
	  const parsed = parseStateFromAny(raw);
	  const value = parsed ? parsed.value : null;
	  const rec = { ts: Date.now(), value, raw: String(raw), bytes: String(raw).length };
	  VGS_CACHE.set(key, rec);
	  return { value, raw: String(raw), bytes: String(raw).length };
	})();
	
	VGS_INFLIGHT.set(key, p);
	let out;
	try { out = await p; } finally { VGS_INFLIGHT.delete(key); }
	return sendFormatted(res, fmt, out.value, out.raw);

  } catch (err) {
    logLine(`VGS status error: ${err && err.message ? err.message : String(err)}`);

    const format = String((req.query && req.query.format) || '').toLowerCase();
    let key = null;
    try {
      const mm = parseInt(req.query.m, 10);
      const ss = parseInt(req.query.s, 10);
      const bb = parseInt(req.query.b, 10);
      if (Number.isFinite(mm) && Number.isFinite(ss) && Number.isFinite(bb)) {
        key = vgsKey(mm, ss, bb);
      }
    } catch (_) {}

    if (key) {
      const stale = VGS_CACHE.get(key);
      if (stale) {
        res.setHeader('X-Status-Fallback', 'stale-cache');
        return sendFormatted(res, format, stale.value, stale.raw);
      }
    }

    res.setHeader('X-Status-Error', err && err.message ? err.message : 'error');
    if (format === 'bool') {
      return sendFormatted(res, 'bool', 0, null); 
    }

    return res.status(500).json({ ok:false, message: 'VGS status failed.' });
  }
});

app.get('/commands', (_req, res) => {
  const cmds = Array.from(VALID_COMMANDS.values()).sort();
  res.json({ commands: cmds, count: cmds.length, items: COMMAND_ITEMS });
});

app.post('/admin/reload-commands', (_req, res) => {
  loadCommandsCSV(COMMANDS_CSV_PATH);
  const count = VALID_COMMANDS.size;
  console.log(`[admin] Reloaded commands: ${count}`);
  logLine(`[admin] Reloaded commands: ${count}`);
  res.json({ message: 'Commands reloaded', count });
});

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

app.get('/logs', (req, res) => {
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 200;
  const lines = tailFile(LOG_FILE_PATH, limit);
  const fmt = String(req.query.format || '').toLowerCase();
  if (fmt === 'txt') {
    return res.type('text/plain').send(lines.join('\n'));
  }
  return res.json({ file: LOG_FILE_PATH, count: lines.length, lines });
});

app.get('/recv', (req, res) => {
  try {
    const fmtRaw = (req.query && req.query.format) ? String(req.query.format) : 'utf8';
    const fmt = fmtRaw.toLowerCase();
    const startRaw = parseInt(req.query && req.query.start, 10);
    const endRaw = parseInt(req.query && req.query.end, 10);
    const start = Number.isFinite(startRaw) ? Math.max(0, startRaw) : 0;
    const end = Number.isFinite(endRaw) ? Math.max(0, Math.min(endRaw, RECV_BUFFER.length)) : RECV_BUFFER.length;
    let buf = RECV_BUFFER;
    if (start > 0 || end < RECV_BUFFER.length) buf = RECV_BUFFER.slice(start, end);

    if (fmt === 'hex')    return res.type('text/plain').send(buf.toString('hex'));
    if (fmt === 'base64') return res.type('text/plain').send(buf.toString('base64'));
    return res.type('text/plain').send(buf.toString('utf8'));
  } catch (e) {
    return res.status(500).json({ message: 'recv error' });
  }
});

app.post('/recv/reset', (_req, res) => {
  resetRecv();
  res.json({ message: 'recv reset' });
});

const PORT = Number(process.env.PORT || config.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

try { loadWhitelistFromHomebridgeSync(); } catch (_) {}

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`[init] HTTP listening on ${HOST}:${PORT}`);
  try { logLine(`HTTP listening on ${HOST}:${PORT}`); } catch (_) {}
});


httpServer.on('error', (err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error('[init] HTTP listen error:', msg);
  try { logLine(`HTTP listen error: ${msg}`); } catch (_) {}
});

// --- Auto-connect on startup (optional) ---
try {
  const AUTO = !!config.AUTO_CONNECT;
  const IDX  = Number(process.env.AUTO_CONNECT_INDEX ?? config.AUTO_CONNECT_INDEX ?? 0);
  const RETRY_MS = Number(process.env.AUTO_CONNECT_RETRY_MS ?? config.AUTO_CONNECT_RETRY_MS ?? 0);

  if (AUTO) {
    const list = Array.isArray(config.servers) ? config.servers : [];
    const target = list[IDX];

    const tryConnect = async (why = 'startup') => {
      if (!target) {
        logLine(`[auto] no server at index ${IDX}; skipping auto-connect`);
        return;
      }
      if (tcpClient) {
        // already connected or connecting
        return;
      }
      try {
        logLine(`[auto] connecting (${why}) to ${target.name || target.host}:${target.port}`);
        await connectToServer(target);
        logLine(`[auto] connected to ${target.name || target.host}:${target.port}`);
      } catch (err) {
        logLine(`[auto] connect failed: ${err && err.message ? err.message : String(err)}`);
        if (RETRY_MS > 0) {
          setTimeout(() => tryConnect('retry'), Math.max(500, RETRY_MS));
        }
      }
    };

    // initial attempt
    tryConnect('startup');

    // optional: if socket closes unexpectedly and AUTO is on, attempt a reconnect
    // (this doesn’t fight /disconnect because ensureDisconnected() clears tcpClient first)
    const onMaybeReconnect = () => {
      if (AUTO && RETRY_MS > 0) setTimeout(() => tryConnect('reconnect'), Math.max(500, RETRY_MS));
    };
    // attach once per process
    httpServer.on('close', onMaybeReconnect);
  }
} catch (e) {
  try { logLine(`[auto] auto-connect setup error: ${e.message}`); } catch (_) {}
}

// --- end auto-connect ---

process.on('SIGINT', () => {
  try { logLine('SIGINT received, shutting down'); } catch (_) {}
  try { if (_logStream) _logStream.end(); } catch (_) {}
  try { ensureDisconnected(); } catch (_) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { logLine('SIGTERM received, shutting down'); } catch (_) {}
  try { if (_logStream) _logStream.end(); } catch (_) {}
  try { ensureDisconnected(); } catch (_) {}
  process.exit(0);
});
