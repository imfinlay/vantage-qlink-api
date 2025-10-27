'use strict';
const ctx = require('./context');
const { vgsKey, keyOf } = require('./parsing');
const { logLine } = require('./logger');

function setState(m, s, b, value) {
  const k = keyOf(m, s, b);
  const prev = ctx.STATE.get(k);
  const now = Date.now();
  if (!prev || prev.value !== value) {
    ctx.STATE.set(k, { value, ts: now });
    logLine(`PUSH state ${k} = ${value}`);
    const keyV = vgsKey(m, s, b);
    ctx.VGS_CACHE.set(keyV, { ts: now, value, raw: String(value), bytes: 1, source: 'push-state' });
  } else {
    ctx.STATE.set(k, { value, ts: now });
  }
}

module.exports = { setState };
