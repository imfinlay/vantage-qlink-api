'use strict';
const path = require('path');
let config = {};
try { config = require('../../config'); } catch (_) {}  // project root config.js

// Environment variable wins over config.js, which wins over the default.
// An empty env var counts as unset.
const pick = (key, fallback) => {
  const env = process.env[key];
  return env !== undefined && env !== '' ? env : (config[key] ?? fallback);
};
const num = (key, fallback) => {
  const n = Number(pick(key, fallback));
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  config,
  LOG_FILE_PATH: pick('LOG_FILE_PATH', path.join(__dirname, '..', 'app.log')),
  HANDSHAKE: Object.prototype.hasOwnProperty.call(config, 'HANDSHAKE') ? config.HANDSHAKE : 'VCL 1 0\r\n',
  NL: (typeof config.LINE_ENDING === 'string') ? config.LINE_ENDING : '\r\n',
  PUSH_DEBUG: !!(process.env.PUSH_DEBUG || (config && config.debug && config.debug.push)),
  MIN_POLL_INTERVAL_MS: num('MIN_POLL_INTERVAL_MS', 400),
  MIN_GAP_MS: num('MIN_GAP_MS', 120),
  PUSH_FRESH_MS: num('PUSH_FRESH_MS', 10000),
  HB_WHITELIST_STRICT: (config && Object.prototype.hasOwnProperty.call(config, 'HB_WHITELIST_STRICT')) ? !!config.HB_WHITELIST_STRICT : true,
  HANDSHAKE_RETRY_MS: num('HANDSHAKE_RETRY_MS', 0),
  LOG_RING_MAX: num('LOG_RING_MAX', 2000),
  DEFAULT_LOAD_FADE_SECONDS: num('DEFAULT_LOAD_FADE_SECONDS', 3),

  app: null,
  httpServer: null,
  tcpClient: null,
  connectedServer: null,
  RECV_BUFFER: Buffer.alloc(0),

  LOG_RING: [],
  _logStream: null,
  __queue: [],
  __pumping: false,
  __lastSendAt: 0,

  VGS_CACHE: new Map(),
  VGS_INFLIGHT: new Map(),
  AWAITERS: new Map(),
  VGS_WAIT_ORDER: [],
  AWAITERS_MAX_PER_KEY: num('AWAITERS_MAX_PER_KEY', 200),

  LOAD_CACHE: new Map(),
  LOAD_INFLIGHT: new Map(),
  LOAD_AWAITERS: new Map(),
  LOAD_AWAITERS_MAX_PER_KEY: num('LOAD_AWAITERS_MAX_PER_KEY', 200),

  HB_CONFIG_PATH: null,
  WHITELIST: new Set(),
  WHITELIST_MTIME: null,

  STATE: new Map(),
  PENDING: new Map(),
  DEBOUNCE_MS: 250,

  INCOMING_TEXT_BUF: '',
};
