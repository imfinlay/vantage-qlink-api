'use strict';
const ctx = require('./context');
const { logLine } = require('./logger');

function keyOf(m, s, b) { return `${Number(m)}/${Number(s)}/${Number(b)}`; }
const vgsKey = (m, s, b) => `${m}-${s}-${b}`;
const loadKey = (m, e, mod, load) => `${m}-${e}-${mod}-${load}`;

function processIncomingText(chunkUtf8) {
  ctx.INCOMING_TEXT_BUF += chunkUtf8;
  let idx;
  while ((idx = ctx.INCOMING_TEXT_BUF.search(/[\r\n]/)) >= 0) {
    let line = ctx.INCOMING_TEXT_BUF.slice(0, idx);
    let rest = ctx.INCOMING_TEXT_BUF.slice(idx + 1);
    if (rest.startsWith('\n') && ctx.INCOMING_TEXT_BUF[idx] === '\r') rest = rest.slice(1);
    ctx.INCOMING_TEXT_BUF = rest;
    if (line.length) {
      processIncomingLineForSW(line);
      processIncomingLineForVGS(line);
      processIncomingLineForRGS(line);
      processIncomingLineForRLB(line);
      processIncomingLineForRGB(line);
      processIncomingLineForBare01(line);
    }
  }
}

function processIncomingLineForSW(rawLine) {
  const re = /(?:^|\s)SW\s+(\d+)\s+(\d+)\s+(\d+)\s+([01])\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    onSWEvent({ m: M, s: S, b: B, v: V });
  }
}

function processIncomingLineForVGS(rawLine) {
  const re = /(?:^|\s)VGS\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    const key = vgsKey(M, S, B);
    ctx.VGS_CACHE.set(key, { ts: Date.now(), value: (V ? 1 : 0), raw: String(V), bytes: String(rawLine).length });
    const list = ctx.AWAITERS.get(key);
    if (list && list.length) {
      ctx.AWAITERS.delete(key);
      for (const entry of list) { try { clearTimeout(entry.timeout); entry.resolve(rawLine); } catch (_) {} }
    }
  }
}

function processIncomingLineForBare01(rawLine) {
  const m = String(rawLine).trim().match(/^([01])$/);
  if (!m) return;
  const v = Number(m[1]);
  const key = ctx.VGS_WAIT_ORDER.shift();
  if (!key) return;
  ctx.VGS_CACHE.set(key, { ts: Date.now(), value: (v ? 1 : 0), raw: String(v), bytes: String(rawLine).length });
  const list = ctx.AWAITERS.get(key);
  if (list && list.length) {
    ctx.AWAITERS.delete(key);
    for (const entry of list) { try { clearTimeout(entry.timeout); entry.resolve(String(v)); } catch (_) {} }
  }
}

function processIncomingLineForRGS(rawLine) {
  const re = /(?:^|\s)RGS#?\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const M = Number(m[1]), S = Number(m[2]), B = Number(m[3]), V = Number(m[4]);
    const key = vgsKey(M, S, B);
    ctx.VGS_CACHE.set(key, { ts: Date.now(), value: (V ? 1 : 0), raw: String(V), bytes: String(rawLine).length });

    const list = ctx.AWAITERS.get(key);
    if (list && list.length) {
      ctx.AWAITERS.delete(key);
      for (const entry of list) { try { clearTimeout(entry.timeout); entry.resolve(rawLine); } catch (_) {} }
    }

    const idx = ctx.VGS_WAIT_ORDER.indexOf(key);
    if (idx !== -1) ctx.VGS_WAIT_ORDER.splice(idx, 1);
  }
}

function processIncomingLineForRLB(rawLine) {
  const re = /(?:^|\s)RLB#?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)(?:\s+([-+]?\d*(?:\.\d+)?))?/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const master = Number(m[1]);
    const enclosure = Number(m[2]);
    const modulePos = Number(m[3]);
    const load = Number(m[4]);
    const level = Number(m[5]);
    const fade = (m[6] != null && m[6] !== '') ? Number(m[6]) : null;
    const key = loadKey(master, enclosure, modulePos, load);
    const raw = String(m[0]).trim();
    const rec = {
      ts: Date.now(),
      level,
      fade,
      raw,
      bytes: Buffer.byteLength(raw, 'utf8'),
      source: 'RLB'
    };
    ctx.LOAD_CACHE.set(key, rec);
    const list = ctx.LOAD_AWAITERS.get(key);
    if (list && list.length) {
      ctx.LOAD_AWAITERS.delete(key);
      for (const entry of list) {
        try {
          clearTimeout(entry.timeout);
          entry.resolve(raw);
        } catch (_) {}
      }
    }
  }
}

function processIncomingLineForRGB(rawLine) {
  const re = /(?:^|\s)RGB#?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\b/g;
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    const master = Number(m[1]);
    const enclosure = Number(m[2]);
    const modulePos = Number(m[3]);
    const load = Number(m[4]);
    const level = Number(m[5]);
    const key = loadKey(master, enclosure, modulePos, load);
    const raw = String(m[0]).trim();
    const rec = {
      ts: Date.now(),
      level,
      fade: null,
      raw,
      bytes: Buffer.byteLength(raw, 'utf8'),
      source: 'RGB'
    };
    ctx.LOAD_CACHE.set(key, rec);
    const list = ctx.LOAD_AWAITERS.get(key);
    if (list && list.length) {
      ctx.LOAD_AWAITERS.delete(key);
      for (const entry of list) {
        try {
          clearTimeout(entry.timeout);
          entry.resolve(raw);
        } catch (_) {}
      }
    }
  }
}

function parseRgsLine(text) {
  const re = new RegExp('(?:^|\\s)RGS#?\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(-?\\d+)\\b');
  const m = String(text).match(re);
  return m ? { m: Number(m[1]), s: Number(m[2]), b: Number(m[3]), v: Number(m[4]) } : null;
}
function parseVgsLine(text) {
  const re = new RegExp('(?:^|\\s)VGS#?\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(-?\\d+)\\b');
  const m = String(text).match(re);
  return m ? { m: Number(m[1]), s: Number(m[2]), b: Number(m[3]), v: Number(m[4]) } : null;
}

function parseRlbLine(text) {
  const re = new RegExp('(?:^|\\s)RLB#?\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(-?\\d+)(?:\\s+([-+]?\\d*(?:\\.\\d+)?))?');
  const m = String(text).match(re);
  if (!m) return null;
  return {
    type: 'RLB',
    master: Number(m[1]),
    enclosure: Number(m[2]),
    module: Number(m[3]),
    load: Number(m[4]),
    level: Number(m[5]),
    fade: (m[6] != null && m[6] !== '') ? Number(m[6]) : null
  };
}

function parseRgbLine(text) {
  const re = new RegExp('(?:^|\\s)RGB#?\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(-?\\d+)');
  const m = String(text).match(re);
  if (!m) return null;
  return {
    type: 'RGB',
    master: Number(m[1]),
    enclosure: Number(m[2]),
    module: Number(m[3]),
    load: Number(m[4]),
    level: Number(m[5]),
    fade: null
  };
}

function parseLoadLine(text) {
  return parseRlbLine(text) || parseRgbLine(text);
}
function parseStateFromAny(text) {
  const r = parseRgsLine(text) || parseVgsLine(text);
  if (r) return { key: `${r.m}-${r.s}-${r.b}`, value: r.v ? 1 : 0, raw: String(text) };
  const reBare = new RegExp('(?:^|\\s)([01])(?:\\s|$)');
  const mb = String(text).match(reBare);
  if (mb) return { key: null, value: Number(mb[1]) ? 1 : 0, raw: String(text) };
  return null;
}

function onSWEvent({ m, s, b, v }) {
  const { isWhitelisted } = require('./whitelist');
  const { confirmOneVGS } = require('../routes/vgs_helpers');
  const { setState } = require('./state');

  if (ctx.PUSH_DEBUG) logLine(`PUSH heard SW ${m}/${s}/${b} -> ${v}`);
  if (!isWhitelisted(m, s, b)) return;
  const k = keyOf(m, s, b);

  const existing = ctx.PENDING.get(k);
  if (existing) clearTimeout(existing);
  const delay = (v === 0) ? 60 : ctx.DEBOUNCE_MS;
  const timer = setTimeout(async () => {
    ctx.PENDING.delete(k);
    try {
      if (ctx.PUSH_DEBUG) logLine(`PUSH confirm start for ${m}/${s}/${b}`);
      const val = await confirmOneVGS(m, s, b);
      setState(m, s, b, val);
    } catch (e) {}
  }, delay);
  ctx.PENDING.set(k, timer);
}

module.exports = {
  processIncomingText, processIncomingLineForSW, processIncomingLineForVGS,
  processIncomingLineForRGS, processIncomingLineForRLB, processIncomingLineForRGB, processIncomingLineForBare01,
  parseRgsLine, parseVgsLine, parseRlbLine, parseRgbLine, parseLoadLine, parseStateFromAny, onSWEvent,
  keyOf, vgsKey, loadKey
};
