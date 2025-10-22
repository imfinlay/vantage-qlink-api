'use strict';
const http = require('http');
const app = require('./app');
const ctx = require('./core/context');
const { logLine } = require('./core/logger');

const PORT = Number(process.env.PORT || ctx.config.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(app);
ctx.httpServer = server;

server.listen(PORT, HOST, () => {
  console.log(`[init index.js] HTTP listening on ${HOST}:${PORT}`);
  try { logLine(`init HTTP listening on ${HOST}:${PORT}`); } catch (_) {}
});

server.on('error', (err) => {
  const msg = err?.message || String(err);
  console.error('[init] HTTP listen error:', msg);
  try { logLine(`HTTP listen error: ${msg}`); } catch (_) {}
});



process.on('SIGINT', () => {
  try { logLine('SIGINT received, shutting down'); } catch (_) {}
  try { if (ctx._logStream) ctx._logStream.end(); } catch (_) {}
  try { const { ensureDisconnected } = require('./core/tcp'); ensureDisconnected(); } catch (_) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { logLine('SIGTERM received, shutting down'); } catch (_) {}
  try { if (ctx._logStream) ctx._logStream.end(); } catch (_) {}
  try { const { ensureDisconnected } = require('./core/tcp'); ensureDisconnected(); } catch (_) {}
  process.exit(0);
});
