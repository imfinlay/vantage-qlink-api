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
  HANDSHAKE: 'VCL 1 0\r\n', //Set the crlf in case something else messed it up
  HANDSHAKE_RETRY_MS: 0,
  HB_WHITELIST_STRICT: true,

  // --- whitelist discovery (username-free) ---
  // If set, use this exact path. Otherwise we’ll probe candidates (below).
  HB_CONFIG_PATH: process.env.HB_CONFIG_PATH || null,

  // Additional candidates to probe
  // $HOME/.homebridge/config.json is added automatically in app.js.
  HB_CONFIG_CANDIDATES: [
    '/var/lib/homebridge/config.json'
  ],

  // --- optional debug ---
  debug: { push: false }
};
