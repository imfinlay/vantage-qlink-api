'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { logLine } = require('../core/logger');
const { loadKey, parseLoadLine } = require('../core/parsing');
const { sendLoadWithAwaiter } = require('./load_helpers');

const clampTimeout = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(50, num);
};

const toInt = (value) => {
  const num = Number(value);
  return Number.isInteger(num) ? num : NaN;
};

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
};

function validateAddress(master, enclosure, modulePos, load) {
  if (!Number.isInteger(master) || master < 0) return false;
  if (!Number.isInteger(enclosure) || enclosure < 1 || enclosure > 4) return false;
  if (!Number.isInteger(modulePos) || modulePos < 1 || modulePos > 4) return false;
  if (!Number.isInteger(load) || load < 1 || load > 8) return false;
  return true;
}

// Reuse the record the RLB/RGB parser already cached; otherwise build one from the raw reply.
function recordFor(key, raw, fallback = {}) {
  let record = ctx.LOAD_CACHE.get(key);
  if (!record) {
    const rawStr = String(raw || '').trim();
    const parsed = parseLoadLine(rawStr);
    record = {
      ts: Date.now(),
      level: parsed ? parsed.level : (fallback.level ?? null),
      fade: parsed ? parsed.fade : (fallback.fade ?? null),
      raw: rawStr,
      source: parsed ? parsed.type : null
    };
    ctx.LOAD_CACHE.set(key, record);
  }
  return record;
}

function sendErr(res, err, fallbackMessage) {
  const message = err?.message || fallbackMessage;
  const low = String(err?.message || '').toLowerCase();
  const status = low.includes('timeout') ? 504 : low.includes('awaiters limit') ? 429 : 500;
  return res.status(status).json({ ok: false, message });
}

function sendLoadResponse(res, format, record, { cached = false, extras = null } = {}) {
  if (cached) res.setHeader('X-Load-Cache', 'hit'); else res.setHeader('X-Load-Cache', 'miss');
  if (record && record.source) res.setHeader('X-Load-Source', record.source);
  if (record && Number.isFinite(record.level)) res.setHeader('X-Load-Level', String(record.level));
  if (record && record.fade != null && Number.isFinite(record.fade)) res.setHeader('X-Load-Fade', String(record.fade));
  const raw = record && record.raw != null ? String(record.raw) : '';
  const level = record && Number.isFinite(record.level) ? record.level : null;
  const fade = record && record.fade != null && Number.isFinite(record.fade) ? record.fade : null;
  const ts = record && Number.isFinite(record.ts) ? record.ts : null;
  const ageMs = ts != null ? Math.max(0, Date.now() - ts) : null;

  if (format === 'level') {
    return res.status(200).type('text/plain').send(level != null ? String(level) : '');
  }
  if (format === 'raw') {
    return res.status(200).type('text/plain').send(raw);
  }

  const payload = {
    ok: true,
    level,
    fade,
    raw,
    source: record ? record.source || null : null,
    ts,
    ageMs,
    cached
  };

  if (extras && typeof extras === 'object') {
    Object.assign(payload, extras);
  }

  return res.status(200).json(payload);
}

router.post('/dim', async (req, res) => {
  try {
    if (!ctx.tcpClient) {
      return res.status(400).json({ ok: false, message: 'Not connected.' });
    }
    const body = req.body || {};

    const master = toInt(body.m ?? body.master);
    const enclosure = toInt(body.e ?? body.enclosure);
    const modulePos = toInt(body.module ?? body.mod ?? body.modulePos);
    const load = toInt(body.load ?? body.l);
    if (!validateAddress(master, enclosure, modulePos, load)) {
      return res.status(400).json({ ok: false, message: 'Invalid load address.' });
    }

    const levelRaw = toInt(body.level ?? body.value ?? body.levelPercent);
    if (!Number.isInteger(levelRaw) || levelRaw < 0 || levelRaw > 100) {
      return res.status(400).json({ ok: false, message: 'Level must be an integer between 0 and 100.' });
    }
    const level = levelRaw;

    let fadeRaw = body.fade ?? body.fadeSeconds ?? body.speed;
    if (fadeRaw === undefined || fadeRaw === null || fadeRaw === '') {
      fadeRaw = ctx.DEFAULT_LOAD_FADE_SECONDS;
    }
    let fade = null;
    if (fadeRaw !== null && fadeRaw !== undefined && fadeRaw !== '') {
      const fadeNum = toNumber(fadeRaw);
      if (!Number.isFinite(fadeNum) || fadeNum < 0 || fadeNum > 6553) {
        return res.status(400).json({ ok: false, message: 'Fade must be between 0 and 6553 seconds.' });
      }
      fade = fadeNum;
    }

    const maxMs = clampTimeout(body.maxMs ?? body.timeoutMs, 2000);
    const key = loadKey(master, enclosure, modulePos, load);
    const parts = ['VLB#', master, enclosure, modulePos, load, level];
    if (fade != null) parts.push(String(fade));
    const cmd = parts.join(' ');

    res.setHeader('X-Load-Command', cmd);

    const raw = await sendLoadWithAwaiter(master, enclosure, modulePos, load, cmd, maxMs);
    const record = recordFor(key, raw, { level, fade });

    return sendLoadResponse(res, 'json', record, {
      cached: false,
      extras: {
        command: cmd,
        requested: { level, fade }
      }
    });
  } catch (err) {
    logLine(`Dim command failed: ${err?.message || String(err)}`);
    return sendErr(res, err, 'Failed to send dim command.');
  }
});

router.get('/dim', async (req, res) => {
  try {
    if (!ctx.tcpClient) {
      return res.status(400).json({ ok: false, message: 'Not connected.' });
    }
    const master = toInt(req.query.m ?? req.query.master);
    const enclosure = toInt(req.query.e ?? req.query.enclosure);
    const modulePos = toInt(req.query.module ?? req.query.mod ?? req.query.modulePos);
    const load = toInt(req.query.load ?? req.query.l);
    if (!validateAddress(master, enclosure, modulePos, load)) {
      return res.status(400).json({ ok: false, message: 'Invalid load address.' });
    }

    const cacheMsRaw = Number(req.query.cacheMs ?? ctx.MIN_POLL_INTERVAL_MS);
    const cacheMs = Number.isFinite(cacheMsRaw) && cacheMsRaw >= 0 ? cacheMsRaw : ctx.MIN_POLL_INTERVAL_MS;
    const maxMs = clampTimeout(req.query.maxMs ?? req.query.timeoutMs, 2000);
    const format = String(req.query.format || '').toLowerCase();
    const key = loadKey(master, enclosure, modulePos, load);
    const now = Date.now();

    // With LOAD_PUSH the cache is kept current by LO reports, so it stays valid until the
    // safety-net age; an explicit cacheMs=0 still forces a fresh read.
    const maxAge = ctx.LOAD_PUSH && cacheMsRaw !== 0 ? (ctx.LOAD_PUSH_MAX_AGE_MS || Infinity) : cacheMs;
    const cached = ctx.LOAD_CACHE.get(key);
    if (cached && (now - cached.ts) < maxAge) {
      return sendLoadResponse(res, format, cached, { cached: true });
    }

    if (ctx.LOAD_INFLIGHT.has(key)) {
      try {
        const inflight = await ctx.LOAD_INFLIGHT.get(key);
        return sendLoadResponse(res, format, inflight, { cached: false });
      } catch (_) {
        ctx.LOAD_INFLIGHT.delete(key);
      }
    }

    const cmd = `VGB# ${master} ${enclosure} ${modulePos} ${load}`;
    res.setHeader('X-Load-Command', cmd);
    const pending = (async () => {
      const raw = await sendLoadWithAwaiter(master, enclosure, modulePos, load, cmd, maxMs);
      return recordFor(key, raw);
    })();

    ctx.LOAD_INFLIGHT.set(key, pending);
    let out;
    try {
      out = await pending;
    } finally {
      ctx.LOAD_INFLIGHT.delete(key);
    }
    return sendLoadResponse(res, format, out, { cached: false });
  } catch (err) {
    logLine(`Load status error: ${err?.message || String(err)}`);
    return sendErr(res, err, 'Load status failed.');
  }
});

module.exports = router;
