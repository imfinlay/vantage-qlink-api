'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');

// default to enabled unless explicitly disabled by env/config
if (typeof ctx.LOG_ENABLED !== 'boolean') {
  ctx.LOG_ENABLED = (process.env.LOG_ENABLED === '0' || process.env.LOG_ENABLED === 'false') ? false : true;
}

try { fs.mkdirSync(path.dirname(ctx.LOG_FILE_PATH), { recursive: true }); } catch (_) {}

function _openLogStream() {
  if (!ctx.LOG_ENABLED) return; // don't open if disabled
  try {
    if (ctx._logStream) return;
    ctx._logStream = fs.createWriteStream(ctx.LOG_FILE_PATH, { flags: 'a' });
    ctx._logStream.on('drain', () => {
      ctx._logBusy = false;
      try {
        while (ctx._logQueue.length && !ctx._logBusy && ctx.LOG_ENABLED) {
          const s = ctx._logQueue.shift();
          ctx._logBusy = !ctx._logStream.write(s);
        }
      } catch (_) {}
    });
    ctx._logStream.on('error', (err) => {
      try { console.error('[log] stream error:', err?.message || String(err)); } catch (_) {}
      try { ctx._logStream.destroy(); } catch (_) {}
      ctx._logStream = null;
    });
  } catch (_) { ctx._logStream = null; }
}

// Start with a stream only if enabled
_openLogStream();

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;

  // Always keep a memory ring for quick UI tailing (even when disk logging is disabled)
  try {
    ctx.LOG_RING.push(line.endsWith('\n') ? line.slice(0, -1) : line);
    if (ctx.LOG_RING.length > ctx.LOG_RING_MAX) ctx.LOG_RING.splice(0, ctx.LOG_RING.length - ctx.LOG_RING_MAX);
  } catch (_) {}

  if (!ctx.LOG_ENABLED) return; // disk logging disabled: skip file writes

  try {
    if (!ctx._logStream) _openLogStream();
    if (ctx._logStream) {
      if (!ctx._logBusy) ctx._logBusy = !ctx._logStream.write(line);
      else ctx._logQueue.push(line);
    } else {
      fs.appendFile(ctx.LOG_FILE_PATH, line, () => {});
    }
  } catch (_) {
    try { fs.appendFile(ctx.LOG_FILE_PATH, line, () => {}); } catch (_) {}
  }
}

function tailFile(filePath, maxLines) {
  const n = Math.max(1, Number(maxLines) || 1);

  if (Array.isArray(ctx.LOG_RING) && ctx.LOG_RING.length) {
    return ctx.LOG_RING.slice(-n);
  }

  if (!fs.existsSync(filePath)) return [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch (_) { return []; }
}

function isLoggingEnabled() { return !!ctx.LOG_ENABLED; }

function enableLogging() {
  ctx.LOG_ENABLED = true;
  _openLogStream();
  return true;
}

function disableLogging() {
  ctx.LOG_ENABLED = false;
  try {
    if (ctx._logStream) {
      // Close the stream gracefully and drop any pending queue
      try { ctx._logStream.end(); } catch (_) {}
      try { ctx._logStream.destroy(); } catch (_) {}
    }
  } catch (_) {}
  ctx._logStream = null;
  ctx._logBusy = false;
  try { if (Array.isArray(ctx._logQueue)) ctx._logQueue.length = 0; } catch (_) {}
  return true;
}

module.exports = { logLine, tailFile, _openLogStream, isLoggingEnabled, enableLogging, disableLogging };
