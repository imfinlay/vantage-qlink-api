'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { logLine } = require('../core/logger');
const { sleep } = require('../core/queue');
const { parseStateFromAny, keyOf, vgsKey } = require('../core/parsing');
const { sendVGSWithAwaiter } = require('./vgs_helpers');

function sendFormatted(res, format, value, raw) {
  if (format === 'bool') return res.status(200).type('text/plain').send(value ? 'true' : 'false');
  if (format === 'raw')  return res.status(200).type('text/plain').send(raw != null ? String(raw) : '');
  return res.status(200).json({ ok: true, value, raw });
}

function previewRaw(raw) {
  const str = raw == null ? '' : String(raw);
  return str.replace(/\r?\n/g, ' ').trim().slice(0, 200);
}

function respondWith(res, format, key, value, raw, meta = {}) {
  const {
    source = null,
    cacheState = null,
    ageMs = null,
    note = null
  } = meta || {};

  if (source) res.setHeader('X-VGS-Source', source);
  if (cacheState) res.setHeader('X-VGS-Cache', cacheState);
  if (ageMs != null && Number.isFinite(ageMs)) {
    const rounded = Math.max(0, Math.round(ageMs));
    res.setHeader('X-VGS-Age', String(rounded));
  }
  if (note) res.setHeader('X-VGS-Note', note);

  const result = `${cacheState}/${source}`;
  ctx.VGS_STATS.counts[result] = (ctx.VGS_STATS.counts[result] || 0) + 1;

  if (ctx.VGS_DEBUG) {
    const tags = [];
    if (source) tags.push(source);
    if (cacheState) tags.push(cacheState);
    if (ageMs != null && Number.isFinite(ageMs)) tags.push(`age=${Math.max(0, Math.round(ageMs))}ms`);
    if (note) tags.push(note);
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
    const preview = previewRaw(raw);
    logLine(`VGS RESP ${key || 'unknown'}${tagStr}${preview ? ` ${preview}` : ''}`);
  }

  return sendFormatted(res, format, value, raw);
}

router.get('/status/vgs', async (req, res) => {
  const m = parseInt(req.query.m, 10);
  const s = parseInt(req.query.s, 10);
  const b = parseInt(req.query.b, 10);
  const valid = Number.isFinite(m) && Number.isFinite(s) && Number.isFinite(b);
  const key = valid ? vgsKey(m, s, b) : null;   // also used by the catch block's stale-cache fallback
  const fmt = String(req.query.format || '').toLowerCase();
  try {
    if (!ctx.tcpClient) return res.status(400).json({ ok:false, message: 'Not connected.' });
    if (!valid) return res.status(400).json({ ok:false, message: 'Missing or invalid m/s/b.' });

    const cmd = `VGS# ${m} ${s} ${b}`;
    const maxMs    = Number(req.query.maxMs   || 1200);
    // MIN_POLL_INTERVAL_MS is a floor, so one server setting governs every accessory's cacheMs.
    // An explicit cacheMs=0 still forces a fresh read (debugging).
    const asked = req.query.cacheMs === undefined || req.query.cacheMs === '' ? NaN : Number(req.query.cacheMs);
    const cacheMs = asked === 0 ? 0 : Math.max(Number.isFinite(asked) ? asked : 0, ctx.MIN_POLL_INTERVAL_MS);
    const jitterMs = Math.max(0, Number(req.query.jitterMs || 0));
    const now = Date.now();

    const st = ctx.STATE.get(keyOf(m, s, b));
    if (st && (now - st.ts) < ctx.PUSH_FRESH_MS) {
      const value = st.value;
      const ageMs = now - st.ts;
      return respondWith(res, fmt, key, value, String(value), {
        source: 'push-state',
        cacheState: 'cache-hit',
        ageMs
      });
    }

    const cached = ctx.VGS_CACHE.get(key);
    if (cached && (now - cached.ts) < cacheMs) {
      const ageMs = now - cached.ts;
      return respondWith(res, fmt, key, cached.value, cached.raw, {
        source: cached.source || 'cache',
        cacheState: 'cache-hit',
        ageMs
      });
    }

    if (ctx.VGS_INFLIGHT.has(key)) {
      const infl = await ctx.VGS_INFLIGHT.get(key);
      const resolvedAt = Date.now();
      const ageMs = infl && typeof infl.ts === 'number' ? (resolvedAt - infl.ts) : null;
      return respondWith(res, fmt, key, infl ? infl.value : null, infl ? infl.raw : null, {
        source: (infl && infl.source) || 'tcp:inflight',
        cacheState: 'stream',
        ageMs: ageMs != null ? Math.max(0, ageMs) : null
      });
    }

    const p = (async () => {
      if (jitterMs > 0) await sleep(Math.floor(Math.random() * jitterMs));
      const raw = await sendVGSWithAwaiter(m, s, b, cmd, maxMs);
      const parsed = parseStateFromAny(raw);
      const value = parsed ? parsed.value : null;
      const rawStr = String(raw);
      const rec = {
        ts: Date.now(),
        value,
        raw: rawStr,
        bytes: Buffer.byteLength(rawStr, 'utf8'),
        source: 'tcp:await'
      };
      ctx.VGS_CACHE.set(key, rec);
      return rec;
    })();

    ctx.VGS_INFLIGHT.set(key, p);
    let out;
    try { out = await p; } finally { ctx.VGS_INFLIGHT.delete(key); }
    const resolvedAt = Date.now();
    const ageMs = out && typeof out.ts === 'number' ? (resolvedAt - out.ts) : null;
    return respondWith(res, fmt, key, out ? out.value : null, out ? out.raw : null, {
      source: (out && out.source) || 'tcp:await',
      cacheState: 'stream',
      ageMs: ageMs != null ? Math.max(0, ageMs) : null
    });

  } catch (err) {
    logLine(`VGS status error: ${err?.message || String(err)}`);

    if (key) {
      const stale = ctx.VGS_CACHE.get(key);
      if (stale) {
        res.setHeader('X-Status-Fallback', 'stale-cache');
        const ageMs = stale && typeof stale.ts === 'number' ? (Date.now() - stale.ts) : null;
        return respondWith(res, fmt, key, stale ? stale.value : null, stale ? stale.raw : null, {
          source: (stale && stale.source) || 'cache',
          cacheState: 'cache-stale',
          ageMs
        });
      }
    }

    res.setHeader('X-Status-Error', err?.message || 'error');
    if (fmt === 'bool') {
      return respondWith(res, 'bool', key || 'unknown', 0, null, {
        source: 'error',
        cacheState: 'cache-miss'
      });
    }
    return res.status(500).json({ ok:false, message: 'VGS status failed.' });
  }
});

module.exports = router;
