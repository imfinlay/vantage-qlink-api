'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { logLine } = require('../core/logger');
const { runQueued, sleep } = require('../core/queue');
const { sendCmdLogged } = require('../core/tcp');
const { keyOf, vgsKey } = require('../core/parsing');

function clientIp(req){
  try { const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); } catch (_) {}
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}
function logHttp(req, msg){ try { logLine(`HTTP ${req.method} ${req.path} from ${clientIp(req)} -> ${msg}`); } catch (_) {} }

// Shared by GET (params in the query string) and POST (params in the JSON body).
async function vsw(req, res) {
  try {
    if (!ctx.tcpClient) { logHttp(req, 'VSW attempt while not connected'); return res.status(400).json({ ok:false, message: 'Not connected.' }); }
    const p = req.method === 'GET' ? req.query : (req.body || {});
    const m = parseInt(p.m, 10) || 2;
    const s = parseInt(p.s, 10) || 20;
    const b = parseInt(p.b, 10) || 7;
    const state = (p.state != null) ? String(p.state) : '1';
    const waitMs = Number(p.waitMs || 800);
    const cmd = `VSW ${m} ${s} ${b} ${state}`;

    logHttp(req, cmd);

    const buf = await runQueued(async () => {
      const startLen = ctx.RECV_BUFFER.length;
      await sendCmdLogged(cmd);
      // The switch is changing: drop what we cached for it so the next status read polls the
      // controller instead of serving the pre-command state (a later push/poll repopulates it).
      ctx.VGS_CACHE.delete(vgsKey(m, s, b));
      ctx.STATE.delete(keyOf(m, s, b));
      if (waitMs > 0) { await sleep(waitMs); return ctx.RECV_BUFFER.slice(startLen); }
      return Buffer.alloc(0);
    }, { priority: 10, label: cmd });

    const response = (waitMs > 0) ? { bytes: buf.length, text: buf.toString('utf8') } : null;
    return res.json({ ok:true, sent: cmd, response });
  } catch (err) {
    logLine(`VSW test error: ${err.message}`);
    return res.status(500).json({ ok:false, message: 'VSW test failed.' });
  }
}

router.route('/test/vsw').get(vsw).post(vsw);

module.exports = router;
