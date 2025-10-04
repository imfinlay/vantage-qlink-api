'use strict';
const ctx = require('../core/context');
const { runQueued } = require('../core/queue');
const { sendCmdLogged } = require('../core/tcp');
const { parseStateFromAny } = require('../core/parsing');

function awaitVGS(m, s, b, timeoutMs) {
  const key = `${m}-${s}-${b}`;
  return new Promise((resolve, reject) => {
    const list = ctx.AWAITERS.get(key) || [];
    if (list.length >= ctx.AWAITERS_MAX_PER_KEY) return reject(new Error('awaiters limit reached'));
    const to = setTimeout(() => {
      try {
        const arr = ctx.AWAITERS.get(key) || [];
        ctx.AWAITERS.set(key, arr.filter(x => x.resolve !== resolve));
      } catch (_) {}
      reject(new Error('VGS timeout'));
    }, Math.max(50, timeoutMs || 2000));
    list.push({ resolve, reject, timeout: to });
    ctx.AWAITERS.set(key, list);
  });
}

function sendVGSWithAwaiter(m, s, b, cmd, maxMs) {
  return new Promise((resolve, reject) => {
    runQueued(async () => {
      try {
        const key = `${m}-${s}-${b}`;
        const p = awaitVGS(m, s, b, maxMs);
        ctx.VGS_WAIT_ORDER.push(key);
        await sendCmdLogged(cmd);
        p.then((raw) => {
          try { const idx = ctx.VGS_WAIT_ORDER.indexOf(key); if (idx !== -1) ctx.VGS_WAIT_ORDER.splice(idx, 1); } catch (_) {}
          resolve(raw);
        }).catch((err) => {
          try { const idx = ctx.VGS_WAIT_ORDER.indexOf(key); if (idx !== -1) ctx.VGS_WAIT_ORDER.splice(idx, 1); } catch (_) {}
          reject(err);
        });
        return;
      } catch (e) { reject(e); }
    }, { priority: 0, label: cmd });
  });
}

async function confirmOneVGS(m, s, b) {
  const cmd = `VGS# ${m} ${s} ${b}`;
  const raw = await sendVGSWithAwaiter(m, s, b, cmd, 2000);
  const parsed = parseStateFromAny(raw);
  if (parsed && (parsed.key === null || parsed.key === `${m}-${s}-${b}`)) return parsed.value;
  const mBare = String(raw).trim().match(/^([01])$/);
  return mBare ? Number(mBare[1]) : 0;
}

module.exports = { sendVGSWithAwaiter, confirmOneVGS };
