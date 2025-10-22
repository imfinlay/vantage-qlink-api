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
  console.log(`[init] HTTP listening on ${HOST}:${PORT}`);
  try { logLine(`HTTP listening on ${HOST}:${PORT}`); } catch (_) {}
});

server.on('error', (err) => {
  const msg = err?.message || String(err);
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
      	logLine('[index.js] already connected; skipping auto-connect');
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
  try { logLine(`[index.js] auto-connect setup error: ${e.message}`); } catch (_) {}
}

// --- end auto-connect ---

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
