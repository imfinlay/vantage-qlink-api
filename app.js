'use strict';

// ===============================
// Revised app.js
// - Serves /public (index.html)
// - HTTP -> TCP bridge with connect/disconnect/send
// - /commands  : expose commands.csv
// - /logs      : tail the app log
// - PM2/systemd friendly, binds 0.0.0.0
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
// Command validation via CSV
// -------------------------------
const VALID_COMMANDS = new Set();
function loadValidCommandsFromCSV(csvPath) {
  try {
    const raw = fs.readFileSync(csvPath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const [cmd] = trimmed.split(',');
      if (cmd) VALID_COMMANDS.add(cmd.trim());
    });
  } catch (err) {
    console.warn(`[WARN] Could not load commands from ${csvPath}: ${err.message}`);
  }
}
loadValidCommandsFromCSV(path.join(__dirname, 'commands.csv'));

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE_PATH, line); } catch (_) {}
}

// -------------------------------
// Helpers
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

// Send
app.post('/send', async (req, res) => {
  try {
    if (!tcpClient) return res.status(400).json({ message: 'Not connected.' });
    const { command, data } = req.body || {};
    let payload = null;
    if (typeof command === 'string' && command.trim()) {
      const cmd = command.trim();
      if (VALID_COMMANDS.size > 0 && !VALID_COMMANDS.has(cmd)) {
        return res.status(400).json({ message: 'Invalid command.' });
      }
      payload = cmd + '\r\n';
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

// -------------------------------
// New: /commands (read-only)
// -------------------------------
app.get('/commands', (_req, res) => {
  const cmds = Array.from(VALID_COMMANDS.values()).sort();
  res.json({ commands: cmds, count: cmds.length });
});

// -------------------------------
// New: /logs (tail last N lines)
// -------------------------------
//   GET /logs?limit=200
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
  if (req.path.startsWith('/api/') || req.path.startsWith('/send') || req.path.startsWith('/connect') || req.path.startsWith('/disconnect') || req.path.startsWith('/status') || req.path.startsWith('/servers') || req.path.startsWith('/commands') || req.path.startsWith('/logs')) {
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
