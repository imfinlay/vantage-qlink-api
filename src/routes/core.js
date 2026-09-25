'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');

router.get('/servers', (_req, res) => {
  const list = Array.isArray(ctx.config.servers)
    ? ctx.config.servers.map((s, i) => ({ index: i, name: s.name || `Server ${i}`, host: s.host, port: s.port }))
    : [];
  res.json({ servers: list });
});

router.get('/status', (_req, res) => {
  const { since, counts } = ctx.VGS_STATS;
  let total = 0, hits = 0;
  for (const [result, n] of Object.entries(counts)) {
    total += n;
    if (result.startsWith('cache-hit/')) hits += n;
  }
  res.json({
    connected: Boolean(ctx.tcpClient),
    server: ctx.connectedServer || null,
    vgs: { since: new Date(since).toISOString(), total, hits, hitRate: total ? +(hits / total).toFixed(3) : null, counts }
  });
});

module.exports = router;
