'use strict';
const ctx = require('../core/context');
const { runQueued } = require('../core/queue');
const { sendCmdLogged } = require('../core/tcp');
const { loadKey } = require('../core/parsing');

function awaitLoad(master, enclosure, modulePos, load, timeoutMs) {
  const key = loadKey(master, enclosure, modulePos, load);
  let entry;
  const promise = new Promise((resolve, reject) => {
    const list = ctx.LOAD_AWAITERS.get(key) || [];
    if (list.length >= ctx.LOAD_AWAITERS_MAX_PER_KEY) {
      reject(new Error('load awaiters limit reached'));
      return;
    }
    entry = { resolve, reject, timeout: null };
    entry.timeout = setTimeout(() => {
      try {
        const arr = ctx.LOAD_AWAITERS.get(key) || [];
        const filtered = arr.filter(item => item !== entry);
        if (filtered.length) ctx.LOAD_AWAITERS.set(key, filtered);
        else ctx.LOAD_AWAITERS.delete(key);
      } catch (_) {}
      reject(new Error('Load timeout'));
    }, Math.max(50, timeoutMs || 2000));
    list.push(entry);
    ctx.LOAD_AWAITERS.set(key, list);
  });
  promise._loadAwaiter = { key, entry };
  return promise;
}

function cleanupAwaiter(meta) {
  if (!meta || !meta.entry) return;
  try { if (meta.entry.timeout) clearTimeout(meta.entry.timeout); } catch (_) {}
  try {
    const arr = ctx.LOAD_AWAITERS.get(meta.key) || [];
    const filtered = arr.filter(item => item !== meta.entry);
    if (filtered.length) ctx.LOAD_AWAITERS.set(meta.key, filtered);
    else ctx.LOAD_AWAITERS.delete(meta.key);
  } catch (_) {}
}

function sendLoadWithAwaiter(master, enclosure, modulePos, load, cmd, maxMs) {
  return new Promise((resolve, reject) => {
    let meta = null;
    const queued = runQueued(async () => {
      const wait = awaitLoad(master, enclosure, modulePos, load, maxMs);
      meta = wait && wait._loadAwaiter ? wait._loadAwaiter : null;

      // Bubble the awaited response (or failure) to callers.
      wait.then(resolve).catch(reject);

      // If we failed to register an awaiter (e.g. limit reached), bail early
      // so we do not send a command with nobody listening for the reply.
      if (!meta || !meta.entry) {
        return null;
      }

      try {
        await sendCmdLogged(cmd);
      } catch (err) {
        cleanupAwaiter(meta);
        try {
          if (meta && meta.entry && typeof meta.entry.reject === 'function') {
            meta.entry.reject(err);
          }
        } catch (_) {}
        reject(err);
        throw err;
      }

      return null;
    }, { priority: 0, label: cmd });

    if (queued && typeof queued.catch === 'function') {
      queued.catch(err => {
        cleanupAwaiter(meta);
        reject(err);
      });
    }
  });
}

module.exports = { awaitLoad, sendLoadWithAwaiter };
