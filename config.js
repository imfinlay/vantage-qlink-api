// config.js (CommonJS – single object)
module.exports = {
  // --- servers ---
  servers: [
    { name: 'Vantage', host: '10.101.111.70', port: 3040 }
  ],

  // --- logging / files ---
  LOG_FILE_PATH: '/home/homeauto/apps/vantage-qlink-api/app.log',
  LOG_ENABLED: true,           // startup default for file logging; the UI start/stop buttons don't persist

  // --- timings / behavior ---
  // Numeric settings can also be set as environment variables of the same name (env wins over this file).
  MIN_GAP_MS: 250,             // on-wire gap between sends (~1000/this sends per second at most)
  MIN_POLL_INTERVAL_MS: 6000,  // floor for /status/vgs cache time: each request's cacheMs is raised to at least this
  PUSH_FRESH_MS: 10000,
  // Sent on every connect. VOS/VOL reporting may persist on the controller; if it doesn't, use:
  //   HANDSHAKE: 'VCL 1 0\r\nVOS 0 1\r\nVOL 1\r\n'   (untested as one write; HANDSHAKE_RETRY_MS: 1500 re-sends it once)
  HANDSHAKE: 'VCL 1 0\r\n',   // CRLF included
  HANDSHAKE_RETRY_MS: 0,
  HB_WHITELIST_STRICT: true,

  // --- dimming defaults ---
  DEFAULT_LOAD_FADE_SECONDS: 3,
  LOAD_AWAITERS_MAX_PER_KEY: 200,
  LOAD_PUSH: false,            // true = trust cached load levels kept current by VOL "LO" reports; only enable once LO lines show in the logs
  LOAD_PUSH_MAX_AGE_MS: 600000, // with LOAD_PUSH, re-poll a load not updated for this long (0 = never)

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
  // vgs: log a "VGS RESP" line per /status/vgs answer (cache-hit vs live); logs every poll, so use it for short sessions
  debug: { push: false, vgs: false }
};
