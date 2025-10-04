'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ctx = require('./context');
const { logLine } = require('./logger');
const { keyOf } = require('./parsing');

function detectHBConfigPath() {
  const fromEnv = process.env.HB_CONFIG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const fromCfg = (ctx.config.HB_CONFIG_PATH && fs.existsSync(ctx.config.HB_CONFIG_PATH))
    ? ctx.config.HB_CONFIG_PATH : null;
  if (fromCfg) return fromCfg;

  const home = os.homedir && os.homedir();
  const candidates = [
    ...(Array.isArray(ctx.config.HB_CONFIG_CANDIDATES) ? ctx.config.HB_CONFIG_CANDIDATES : []),
    '/var/lib/homebridge/config.json',
    home ? path.join(home, '.homebridge', 'config.json') : null
  ].filter(Boolean);

  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

function parseTripletFromUrl(u) {
  try {
    const url = new URL(u, 'http://localhost');
    const m = Number(url.searchParams.get('m'));
    const s = Number(url.searchParams.get('s'));
    const b = Number(url.searchParams.get('b'));
    if ([m,s,b].every(n => Number.isFinite(n))) return keyOf(m,s,b);
  } catch (_) {}
  return null;
}

function extractWhitelistFromHBConfig(cfg) {
  const set = new Set();
  const pushIf = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const urls = [];
    if (typeof obj.statusUrl === 'string') urls.push(obj.statusUrl);
    if (typeof obj.onUrl === 'string')     urls.push(obj.onUrl);
    if (typeof obj.offUrl === 'string')    urls.push(obj.offUrl);
    for (const u of urls) { const k = parseTripletFromUrl(u); if (k) set.add(k); }
  };

  if (Array.isArray(cfg.accessories)) for (const acc of cfg.accessories) pushIf(acc);
  if (Array.isArray(cfg.platforms)) {
    for (const p of cfg.platforms) {
      if (!p || typeof p !== 'object') continue;
      const items = Array.isArray(p.accessories) ? p.accessories : (Array.isArray(p.devices) ? p.devices : null);
      if (!items) continue;
      for (const it of items) pushIf(it);
    }
  }
  return set;
}

function loadWhitelistFromHomebridgeSync() {
  try {
    ctx.HB_CONFIG_PATH = detectHBConfigPath();
    if (!ctx.HB_CONFIG_PATH) {
      ctx.WHITELIST = new Set();
      ctx.WHITELIST_MTIME = null;
      logLine('[WL/HB] no Homebridge config.json found; whitelist empty');
      return;
    }
    const stat = fs.statSync(ctx.HB_CONFIG_PATH);
    const raw  = fs.readFileSync(ctx.HB_CONFIG_PATH, 'utf8');
    const cfg  = JSON.parse(raw);
    ctx.WHITELIST = extractWhitelistFromHBConfig(cfg);
    ctx.WHITELIST_MTIME = stat.mtime.toISOString();
    logLine(`[WL/HB] loaded ${ctx.WHITELIST.size} devices from ${ctx.HB_CONFIG_PATH}`);
  } catch (e) {
    logLine(`[WL/HB] load failed: ${e.message}`);
    ctx.WHITELIST = new Set();
    ctx.WHITELIST_MTIME = null;
  }
}

function isWhitelisted(m, s, b) {
  if (ctx.WHITELIST.size === 0) return ctx.HB_WHITELIST_STRICT ? false : true;
  return ctx.WHITELIST.has(keyOf(m, s, b));
}

module.exports = { loadWhitelistFromHomebridgeSync, isWhitelisted, detectHBConfigPath };
