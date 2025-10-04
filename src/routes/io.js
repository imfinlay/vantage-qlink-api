'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { logLine, tailFile } = require('../core/logger');
const { sendToTCP, sendCmdLogged } = require('../core/tcp');
const { runQueued, sleep } = require('../core/queue');

function clientIp(req){
  try { const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); } catch (_) {}
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}
function logHttp(req, msg){ try { logLine(`HTTP ${req.method} ${req.path} from ${clientIp(req)} -> ${msg}`); } catch (_) {} }
const toOn = (v) => (v === 1 || v === true || v === '1');

router.post('/send', async (req, res) => {
  try {
    if (!ctx.tcpClient) return res.status(400).json({ message: 'Not connected.' });
    const body = req.body || {};
    const { command, data } = body;
    const waitMs = Number(body.waitMs || 0);
    const quietMs = Number(body.quietMs || 0);
    const maxMs = Number(body.maxMs || 2000);

    let payload = null;
    if (typeof command === 'string' && command.trim()) {
      const cmd = command.trim();

      const { VALID_COMMANDS } = require('./shared_commands');
      const base = cmd.replace(/[\r\n]+/g, '').replace(/[$#]+$/g, '').split(/\s+/)[0];
      if (VALID_COMMANDS.size > 0 && !VALID_COMMANDS.has(cmd) && !VALID_COMMANDS.has(base)) {
        return res.status(400).json({ message: 'Invalid command.' });
      }
      payload = cmd + ctx.NL;
      logLine(`CMD -> ${cmd}`);
    } else if (typeof data === 'string' || Buffer.isBuffer(data)) {
      payload = data;
      logLine(`DATA -> ${String(data).slice(0, 200)}${String(data).length > 200 ? '…' : ''}`);
    } else {
      return res.status(400).json({ message: 'No command or data provided.' });
    }

    const uiPriority = 5;
    const buf = await runQueued(async () => {
      const startLen = ctx.RECV_BUFFER.length;
      if (typeof command === 'string' && command.trim()) {
        await sendCmdLogged(command.trim());
      } else {
        await sendToTCP(payload);
      }
      if (quietMs > 0) {
        return await (async function waitQuiet(startLen, quietMs, maxMs) {
          return await new Promise((resolve) => {
            let timer = null, hardTimer = null;
            const finish = () => {
              if (timer) clearTimeout(timer);
              if (hardTimer) clearTimeout(hardTimer);
              if (ctx.tcpClient) ctx.tcpClient.removeListener('data', onData);
              const buf = ctx.RECV_BUFFER.slice(startLen);
              resolve(buf);
            };
            const onData = () => { if (timer) clearTimeout(timer); timer = setTimeout(finish, Math.max(quietMs, 1)); };
            hardTimer = setTimeout(finish, Math.max(maxMs, quietMs || 0, 1));
            timer = setTimeout(finish, Math.max(quietMs, 1));
            if (ctx.tcpClient) ctx.tcpClient.on('data', onData);
          });
        })(startLen, quietMs, maxMs);
      } else if (waitMs > 0) {
        await sleep(waitMs);
        return ctx.RECV_BUFFER.slice(startLen);
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

router.get('/logs', (req, res) => {
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 200;
  const lines = tailFile(ctx.LOG_FILE_PATH, limit);
  const fmt = String(req.query.format || '').toLowerCase();
  if (fmt === 'txt') return res.type('text/plain').send(lines.join('\n'));
  return res.json({ file: ctx.LOG_FILE_PATH, count: lines.length, lines });
});

router.get('/recv', (req, res) => {
  try {
    const fmtRaw = (req.query && req.query.format) ? String(req.query.format) : 'utf8';
    const fmt = fmtRaw.toLowerCase();
    const startRaw = parseInt(req.query && req.query.start, 10);
    const endRaw = parseInt(req.query && req.query.end, 10);
    const start = Number.isFinite(startRaw) ? Math.max(0, startRaw) : 0;
    const end = Number.isFinite(endRaw) ? Math.max(0, Math.min(endRaw, ctx.RECV_BUFFER.length)) : ctx.RECV_BUFFER.length;
    let buf = ctx.RECV_BUFFER;
    if (start > 0 || end < ctx.RECV_BUFFER.length) buf = ctx.RECV_BUFFER.slice(start, end);

    if (fmt === 'hex')    return res.type('text/plain').send(buf.toString('hex'));
    if (fmt === 'base64') return res.type('text/plain').send(buf.toString('base64'));
    return res.type('text/plain').send(buf.toString('utf8'));
  } catch (e) {
    return res.status(500).json({ message: 'recv error' });
  }
});

router.post('/recv/reset', (_req, res) => {
  const { resetRecv } = require('../core/tcp');
  resetRecv();
  res.json({ message: 'recv reset' });
});

module.exports = router;
