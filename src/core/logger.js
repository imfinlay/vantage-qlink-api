'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');

try { fs.mkdirSync(path.dirname(ctx.LOG_FILE_PATH), { recursive: true }); } catch (_) {}

function _openLogStream() {
  try {
    ctx._logStream = fs.createWriteStream(ctx.LOG_FILE_PATH, { flags: 'a' });
    ctx._logStream.on('drain', () => {
      ctx._logBusy = false;
      try {
        while (ctx._logQueue.length && !ctx._logBusy) {
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
_openLogStream();

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;

  try {
    ctx.LOG_RING.push(line.endsWith('\n') ? line.slice(0, -1) : line);
    if (ctx.LOG_RING.length > ctx.LOG_RING_MAX) ctx.LOG_RING.splice(0, ctx.LOG_RING.length - ctx.LOG_RING_MAX);
  } catch (_) {}

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

module.exports = { logLine, tailFile, _openLogStream };
