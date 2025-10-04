'use strict';
const path = require('path');
let config = {};
try { config = require('../../config'); }           // project root config.js
catch (e1) {
  try { config = require('../config'); }            // src/config.js shim
  catch (e2) { config = {}; }
}

module.exports = {
  config,
  LOG_FILE_PATH: (config.LOG_FILE_PATH) || path.join(__dirname, '..', 'app.log'),
  HANDSHAKE: Object.prototype.hasOwnProperty.call(config, 'HANDSHAKE') ? config.HANDSHAKE : 'VCL 1 0\r\n',
  NL: (typeof config.LINE_ENDING === 'string') ? config.LINE_ENDING : '\r\n',
  PUSH_DEBUG: !!(process.env.PUSH_DEBUG || (config && config.debug && config.debug.push)),
  MIN_POLL_INTERVAL_MS: Number(config.MIN_POLL_INTERVAL_MS || process.env.MIN_POLL_INTERVAL_MS || 400),
  MIN_GAP_MS: Number(config.MIN_GAP_MS || process.env.MIN_GAP_MS || 120),
  PUSH_FRESH_MS: Number(config.PUSH_FRESH_MS || process.env.PUSH_FRESH_MS || 10000),
  HB_WHITELIST_STRICT: (config && Object.prototype.hasOwnProperty.call(config, 'HB_WHITELIST_STRICT')) ? !!config.HB_WHITELIST_STRICT : true,
  HANDSHAKE_RETRY_MS: Number(config.HANDSHAKE_RETRY_MS || process.env.HANDSHAKE_RETRY_MS || 0),
  LOG_RING_MAX: Number(process.env.LOG_RING_MAX || (config && config.LOG_RING_MAX) || 2000),

  app: null,
  httpServer: null,
  tcpClient: null,
  connectedServer: null,
  RECV_BUFFER: Buffer.alloc(0),

  LOG_RING: [],
  _logStream: null,
  _logBusy: false,
  _logQueue: [],
  __queue: [],
  __pumping: false,
  __lastSendAt: 0,

  VGS_CACHE: new Map(),
  VGS_INFLIGHT: new Map(),
  AWAITERS: new Map(),
  VGS_WAIT_ORDER: [],
  AWAITERS_MAX_PER_KEY: Number(config.AWAITERS_MAX_PER_KEY || process.env.AWAITERS_MAX_PER_KEY || 200),

  HB_CONFIG_PATH: null,
  WHITELIST: new Set(),
  WHITELIST_MTIME: null,

  STATE: new Map(),
  PENDING: new Map(),
  DEBOUNCE_MS: 250,

  INCOMING_TEXT_BUF: '',
};
