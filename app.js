'use strict';

// ===============================
// app.js (validation fixes + rich commands)
// - Serves /public (index.html)
// - HTTP -> TCP bridge with connect / disconnect / send
// - /commands : parses commands.csv => items [{command, params, description}] + legacy list
// - /logs     : tail log file
// - Validation now accepts commands with params/modifiers (e.g., "VEC 123", "VEC$")
// - Binds 0.0.0.0, PM2/systemd friendly, keeps existing behavior intact
// ===============================

const path = require('path');
const fs = require('fs');
const net = require('net');
const express = require('express');

// -------------------------------
// Configuration
// -------------------------------
const config = require('./config');
const LOG_FILE_PATH = config.LOG_FILE_PATH || path.join(__dirname, 'app.log');
const HANDSHAKE = Object.prototype.hasOwnProperty.call(config, 'HANDSHAKE')
  ? config.HANDSHAKE
  : 'VCL 1 0\r\n';

try { fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true }); } catch (_) {}

// -------------------------------
// Globals
// -------------------------------
const app = express();
app.disable('x-powered-by');

let tcpClient = null;       // active net.Socket
let connectedServer = null; // { name, host, port }

// -------------------------------
// Middleware
// -------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// -------------------------------
// Commands.csv parsing & validation
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
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
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
      const cols = splitCSVLine(lines[i]).map(s => s.trim());
      const command = cols[0] || '';
      const description = cols[1] || '';
      const params = cols[2] || '';
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

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE_PATH, line); } catch (_) {}
}

// -------------------------------
// TCP helpers
// -------------------------------
function ensureDisconnected() {
  if (tcpClient) { try { tcpClient.destroy(); } catch (_) {} }
  tcpClient = null;
  connectedServer = null;
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

function tailFile(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-maxLines);
  } catch (_) { return []; }
}

// -------------------------------
// Validation helpers (NEW)
// -------------------------------
function normalizeForValidation(input) {
  // Trim, strip CR/LF, remove trailing modifiers like $ or # (one or more)
  let s = String(input || '').replace(/[\r\n]+/g, '').trim();
  s = s.replace(/[$#]+$/g, '');
  return s;
}

function isKnownCommand(input) {
  if (!input) return false;
  if (VALID_COMMANDS.size === 0) return true; // no CSV => no validation

  const s = normalizeForValidation(input);
  const base = s.split(/\s+/)[0]; // token before first space

  if (VALID_COMMANDS.has(s)) return true;     // exact match (no params)
  if (VALID_COMMANDS.has(base)) return true;  // base token matches (with params)

  // Fallback: prefix match for multi-word commands
  const list = Array.from(VALID_COMMANDS.values());
  for (const c of list) {
    if (s === c) return true;
    if (s.startsWith(c + ' ')) return true;
    if (s.startsWith(c + '$')) return true;
    if (s.startsWith(c + '#')) return true;
  }
  return false;
}

// -------------------------------
// API
// -------------------------------

// Servers list
app.get('/servers', (_req, res) => {
  const list = Array.isArray(config.servers) ? config.servers.map((s, i) => ({
    index: i,
    name: s.name || `Server ${i}`,
    host: s.host,
    port: s.port
  })) : [];
  res.json({ servers: list });
});

// Status
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

// Send (VALIDATION FIXED)
app.post('/send', async (req, res) => {
  try {
    if (!tcpClient) return res.status(400).json({ message: 'Not connected.' });
    const { command, data } = req.body || {};

    let payload = null;
    if (typeof command === 'string' && command.trim()) {
      const cmd = command.trim();

      if (!isKnownCommand(cmd)) {
        const base = normalizeForValidation(cmd).split(/\s+/)[0];
        logLine(`Invalid command rejected (base="${base}", raw="${cmd}")`);
        return res.status(400).json({ message: 'Invalid command.' });
      }

      payload = cmd + '\r\n'; // CRLF line protocol preserved
      logLine(`CMD -> ${cmd}`);
    } else if (typeof data === 'string' || Buffer.isBuffer(data)) {
      payload = data;
      logLine(`DATA -> ${String(data).slice(0, 200)}${String(data).length > 200 ? '…' : ''}`);
    } else {
      return res.status(400).json({ message: 'No command or data provided.' });
    }

    await sendToTCP(payload);
    return res.json({ message: 'Sent.' });
  } catch (err) {
    logLine(`Send error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to send.' });
  }
});

// Commands (rich + legacy)
app.get('/commands', (_req, res) => {
  const cmds = Array.from(VALID_COMMANDS.values()).sort();
  res.json({
    commands: cmds,
    count: cmds.length,
    items: COMMAND_ITEMS
  });
});

// Admin: reload commands.csv on demand
app.post('/admin/reload-commands', (_req, res) => {
  loadCommandsCSV(COMMANDS_CSV_PATH);
  const count = VALID_COMMANDS.size;
  console.log(`[admin] Reloaded commands: ${count}`);
  logLine(`[admin] Reloaded commands: ${count}`);
  res.json({ message: 'Commands reloaded', count });
});

// Logs tail
app.get('/logs', (req, res) => {
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 200;
  const lines = tailFile(LOG_FILE_PATH, limit);
  res.json({ file: LOG_FILE_PATH, count: lines.length, lines });
});

// -------------------------------
// SPA fallback (optional)
// -------------------------------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/send') || req.path.startsWith('/connect') || req.path.startsWith('/disconnect') || req.path.startsWith('/status') || req.path.startsWith('/servers') || req.path.startsWith('/commands') || req.path.startsWith('/logs') || req.path.startsWith('/admin')) {
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

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`HTTP to TCP API listening on http://${HOST}:${PORT}`);
  });
} else {
  module.exports = app;
}
