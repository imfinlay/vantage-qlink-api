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
  res.json({ connected: Boolean(ctx.tcpClient), server: ctx.connectedServer || null });
});

module.exports = router;
