// config.js (CommonJS – single object)
module.exports = {
  // --- servers ---
  servers: [
    { name: 'Vantage', host: '10.101.111.70', port: 3040 }
  ],

  // --- logging / files ---
  LOG_FILE_PATH: '/home/homeauto/apps/vantage-qlink-api/app.log',

  // --- timings / behavior ---
  MIN_GAP_MS: 120,
  MIN_POLL_INTERVAL_MS: 400,
  PUSH_FRESH_MS: 10000,
  HANDSHAKE: 'VCL 1 0\r\n',   // CRLF included
  HANDSHAKE_RETRY_MS: 0,
  HB_WHITELIST_STRICT: true,

  // --- dimming defaults ---
  DEFAULT_LOAD_FADE_SECONDS: 3,
  LOAD_AWAITERS_MAX_PER_KEY: 200,

  // --- whitelist discovery (username-free) ---
  HB_CONFIG_PATH: process.env.HB_CONFIG_PATH || null,
  HB_CONFIG_CANDIDATES: [
    '/var/lib/homebridge/config.json'
  ],

  // --- auto-connect on startup (env-overridable) ---
  // You can also set AUTO_CONNECT=1, AUTO_CONNECT_INDEX=0, AUTO_CONNECT_RETRY_MS=5000 in the environment.
  AUTO_CONNECT: /^(1|true|yes)$/i.test(String(process.env.AUTO_CONNECT || 1)),
  AUTO_CONNECT_INDEX: Number(process.env.AUTO_CONNECT_INDEX ?? 0),
  AUTO_CONNECT_RETRY_MS: Number(process.env.AUTO_CONNECT_RETRY_MS ?? 5000),

  // --- optional debug ---
  debug: { push: false }
};
