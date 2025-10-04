'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { logLine } = require('../core/logger');
const { runQueued, sleep } = require('../core/queue');
const { sendCmdLogged } = require('../core/tcp');

function clientIp(req){
  try { const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); } catch (_) {}
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}
function logHttp(req, msg){ try { logLine(`HTTP ${req.method} ${req.path} from ${clientIp(req)} -> ${msg}`); } catch (_) {} }

router.get('/test/vsw', async (req, res) => {
  try {
    if (!ctx.tcpClient) { logHttp(req, 'VSW attempt while not connected'); return res.status(400).json({ ok:false, message: 'Not connected.' }); }
    const m = parseInt(req.query.m, 10) || 2;
    const s = parseInt(req.query.s, 10) || 20;
    const b = parseInt(req.query.b, 10) || 7;
    const state = (req.query.state != null) ? String(req.query.state) : '1';
    const waitMs = Number(req.query.waitMs || 800);
    const cmd = `VSW ${m} ${s} ${b} ${state}`;

    logHttp(req, cmd);

    const buf = await runQueued(async () => {
      const startLen = ctx.RECV_BUFFER.length;
      await sendCmdLogged(cmd);
      if (waitMs > 0) { await sleep(waitMs); return ctx.RECV_BUFFER.slice(startLen); }
      return Buffer.alloc(0);
    }, { priority: 10, label: cmd });

    const response = (waitMs > 0) ? { bytes: buf.length, text: buf.toString('utf8') } : null;
    return res.json({ ok:true, sent: cmd, response });
  } catch (err) {
    logLine(`VSW test error: ${err.message}`);
    return res.status(500).json({ ok:false, message: 'VSW test failed.' });
  }
});

router.post('/test/vsw', async (req, res) => {
  try {
    if (!ctx.tcpClient) { logHttp(req, 'VSW attempt while not connected'); return res.status(400).json({ ok:false, message: 'Not connected.' }); }
    const body = req.body || {};
    const m = parseInt(body.m, 10) || 2;
    const s = parseInt(body.s, 10) || 20;
    const b = parseInt(body.b, 10) || 7;
    const state = (body.state != null) ? String(body.state) : '1';
    const waitMs = Number(body.waitMs || 800);
    const cmd = `VSW ${m} ${s} ${b} ${state}`;

    logHttp(req, cmd);

    const buf = await runQueued(async () => {
      const startLen = ctx.RECV_BUFFER.length;
      await sendCmdLogged(cmd);
      if (waitMs > 0) { await sleep(waitMs); return ctx.RECV_BUFFER.slice(startLen); }
      return Buffer.alloc(0);
    }, { priority: 10, label: cmd });

    const response = (waitMs > 0) ? { bytes: buf.length, text: buf.toString('utf8') } : null;
    return res.json({ ok:true, sent: cmd, response });
  } catch (err) {
    logLine(`VSW test error: ${err.message}`);
    return res.status(500).json({ ok:false, message: 'VSW test failed.' });
  }
});

module.exports = router;
