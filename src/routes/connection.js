'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { connectToServer, ensureDisconnected } = require('../core/tcp');
const { logLine } = require('../core/logger');

router.post('/connect', async (req, res) => {
  try {
    const { serverIndex } = req.body || {};
    const list = Array.isArray(ctx.config.servers) ? ctx.config.servers : [];
    if (typeof serverIndex !== 'number' || serverIndex < 0 || serverIndex >= list.length) {
      return res.status(400).json({ message: 'Invalid server index.' });
    }
    const target = list[serverIndex];
    await connectToServer(target);
    logLine(`Connected to ${target.name || target.host}:${target.port}`);
    return res.json({ message: `Connected to ${target.name || target.host}:${target.port}` });
  } catch (err) {
    logLine(`Connect error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to connect to the server.' });
  }
});

router.post('/disconnect', (_req, res) => {
  if (!ctx.tcpClient) return res.json({ message: 'Already disconnected.' });
  const target = ctx.connectedServer;
  ensureDisconnected();
  logLine(`Disconnected from ${target ? (target.name || `${target.host}:${target.port}`) : 'unknown'}`);
  res.json({ message: 'Disconnected.' });
});

module.exports = router;
