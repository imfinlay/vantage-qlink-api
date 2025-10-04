'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { logLine } = require('../core/logger');
const { sleep } = require('../core/queue');
const { parseStateFromAny } = require('../core/parsing');
const { sendVGSWithAwaiter } = require('./vgs_helpers');

function sendFormatted(res, format, value, raw) {
  try {
    if (format === 'bool') return res.status(200).type('text/plain').send(value ? 'true' : 'false');
    if (format === 'raw')  return res.status(200).type('text/plain').send(raw != null ? String(raw) : '');
    return res.status(200).json({ ok: true, value, raw });
  } catch (_) {
    return res.status(200).type('text/plain').send(value ? 'true' : 'false');
  }
}

router.get('/status/vgs', async (req, res) => {
  try {
    if (!ctx.tcpClient) { 
      try { const ip = req.ip || 'unknown'; } catch (_) {}
      return res.status(400).json({ ok:false, message: 'Not connected.' });
    }
    const m = parseInt(req.query.m, 10);
    const s = parseInt(req.query.s, 10);
    const b = parseInt(req.query.b, 10);
    if (!Number.isFinite(m) || !Number.isFinite(s) || !Number.isFinite(b))
      return res.status(400).json({ ok:false, message: 'Missing or invalid m/s/b.' });

    const cmd = `VGS# ${m} ${s} ${b}`;
    const quietMs  = Number(req.query.quietMs || 200);
    const maxMs    = Number(req.query.maxMs   || 1200);
    const cacheMs  = Math.max(0, Number(req.query.cacheMs || ctx.MIN_POLL_INTERVAL_MS));
    const jitterMs = Math.max(0, Number(req.query.jitterMs || 0));
    const key = `${m}-${s}-${b}`;
    const now = Date.now();
    const fmt = String(req.query.format || '').toLowerCase();

    const kState = `${Number(m)}/${Number(s)}/${Number(b)}`;
    const st = ctx.STATE.get(kState);
    if (st && (now - st.ts) < ctx.PUSH_FRESH_MS) {
      const value = st.value;
      return sendFormatted(res, fmt, value, String(value));
    }

    const cached = ctx.VGS_CACHE.get(key);
    if (cached && (now - cached.ts) < cacheMs) {
      return sendFormatted(res, fmt, cached.value, cached.raw);
    }

    if (ctx.VGS_INFLIGHT.has(key)) {
      const infl = await ctx.VGS_INFLIGHT.get(key);
      return sendFormatted(res, fmt, infl.value, infl.raw);
    }

    const p = (async () => {
      if (jitterMs > 0) await sleep(Math.floor(Math.random() * jitterMs));
      const raw = await sendVGSWithAwaiter(m, s, b, cmd, maxMs);
      const parsed = parseStateFromAny(raw);
      const value = parsed ? parsed.value : null;
      const rec = { ts: Date.now(), value, raw: String(raw), bytes: String(raw).length };
      ctx.VGS_CACHE.set(key, rec);
      return { value, raw: String(raw), bytes: String(raw).length };
    })();

    ctx.VGS_INFLIGHT.set(key, p);
    let out;
    try { out = await p; } finally { ctx.VGS_INFLIGHT.delete(key); }
    return sendFormatted(res, fmt, out.value, out.raw);

  } catch (err) {
    logLine(`VGS status error: ${err?.message || String(err)}`);

    const format = String((req.query && req.query.format) || '').toLowerCase();
    let key = null;
    try {
      const mm = parseInt(req.query.m, 10);
      const ss = parseInt(req.query.s, 10);
      const bb = parseInt(req.query.b, 10);
      if (Number.isFinite(mm) && Number.isFinite(ss) && Number.isFinite(bb)) {
        key = `${mm}-${ss}-${bb}`;
      }
    } catch (_) {}

    if (key) {
      const stale = ctx.VGS_CACHE.get(key);
      if (stale) {
        res.setHeader('X-Status-Fallback', 'stale-cache');
        return sendFormatted(res, format, stale.value, stale.raw);
      }
    }

    res.setHeader('X-Status-Error', err?.message || 'error');
    if (format === 'bool') {
      return sendFormatted(res, 'bool', 0, null);
    }
    return res.status(500).json({ ok:false, message: 'VGS status failed.' });
  }
});

module.exports = router;
