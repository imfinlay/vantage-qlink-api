'use strict';
const ctx = require('./context');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pumpQueue() {
  if (ctx.__pumping) return;
  ctx.__pumping = true;
  try {
    while (ctx.__queue.length) {
      const item = ctx.__queue.shift();
      const now = Date.now();
      const gap = Math.max(0, ctx.MIN_GAP_MS - (now - ctx.__lastSendAt));
      if (gap > 0) await sleep(gap);
      try {
        const r = await item.fn();
        ctx.__lastSendAt = Date.now();
        item.resolve(r);
      } catch (e) {
        item.reject(e);
      }
    }
  } finally {
    ctx.__pumping = false;
  }
}

function runQueued(taskFn, { priority = 0, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const item = { fn: taskFn, priority, resolve, reject, label, enqueuedAt: Date.now() };
    const idx = ctx.__queue.findIndex(x => (x.priority || 0) < priority);
    if (idx === -1) ctx.__queue.push(item); else ctx.__queue.splice(idx, 0, item);
    pumpQueue();
  });
}

module.exports = { runQueued, pumpQueue, sleep };
