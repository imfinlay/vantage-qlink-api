'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');

// File logging is on unless LOG_ENABLED is 0/false in the environment or config.js (env wins).
ctx.LOG_ENABLED = !['0', 'false'].includes(String(process.env.LOG_ENABLED ?? ctx.config.LOG_ENABLED).toLowerCase());

try { fs.mkdirSync(path.dirname(ctx.LOG_FILE_PATH), { recursive: true }); } catch (_) {}

// Set after a stream error so a bad log path is reported once instead of
// reopening (and failing) on every logLine. enableLogging() clears it.
let openFailed = false;

function _openLogStream() {
  if (!ctx.LOG_ENABLED || ctx._logStream || openFailed) return;
  try {
    const stream = fs.createWriteStream(ctx.LOG_FILE_PATH, { flags: 'a' });
    stream.on('error', (err) => {
      try { console.error('[log] stream error:', err?.message || String(err)); } catch (_) {}
      openFailed = true;
      try { stream.destroy(); } catch (_) {}
      if (ctx._logStream === stream) ctx._logStream = null;
    });
    ctx._logStream = stream;
  } catch (_) { ctx._logStream = null; }
}

// Start with a stream only if enabled
_openLogStream();

// Trimming to exactly LOG_RING_MAX on every push means Array#splice has to
// shift the whole remaining ring on every call once at capacity. Instead,
// let the ring overshoot by a slack margin and trim back to MAX in one
// batched splice, amortizing the O(n) shift cost over many pushes.
const LOG_RING_TRIM_SLACK = 200;

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;

  // Always keep a memory ring for quick UI tailing (even when disk logging is disabled)
  try {
    ctx.LOG_RING.push(line.endsWith('\n') ? line.slice(0, -1) : line);
    if (ctx.LOG_RING.length > ctx.LOG_RING_MAX + LOG_RING_TRIM_SLACK) {
      ctx.LOG_RING.splice(0, ctx.LOG_RING.length - ctx.LOG_RING_MAX);
    }
  } catch (_) {}

  if (!ctx.LOG_ENABLED) return; // disk logging disabled: skip file writes

  // WriteStream buffers internally, so no manual backpressure queue is needed.
  try {
    _openLogStream();
    if (ctx._logStream) ctx._logStream.write(line);
  } catch (_) {}
}

function tailFile(maxLines) {
  return ctx.LOG_RING.slice(-Math.max(1, Number(maxLines) || 1));
}

function isLoggingEnabled() { return !!ctx.LOG_ENABLED; }

function enableLogging() {
  ctx.LOG_ENABLED = true;
  openFailed = false;
  _openLogStream();
  return true;
}

function disableLogging() {
  ctx.LOG_ENABLED = false;
  // end() flushes anything still buffered before closing
  try { if (ctx._logStream) ctx._logStream.end(); } catch (_) {}
  ctx._logStream = null;
  return true;
}

module.exports = { logLine, tailFile, isLoggingEnabled, enableLogging, disableLogging };
