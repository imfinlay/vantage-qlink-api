// routes/connection.js
const express = require('express');
module.exports = (ctx) => {
const r = (ctx.express && ctx.express.Router ? ctx.express.Router() : express.Router());

  r.get('/servers', (_req, res) => {
    const list = Array.isArray(ctx.config.servers)
      ? ctx.config.servers.map((s, i) => ({ index: i, name: s.name || `Server ${i}`, host: s.host, port: s.port }))
      : [];
    res.json({ servers: list });
  });

  r.get('/status', (_req, res) => {
    res.json({ connected: ctx.tcp.isConnected(), server: ctx.tcp.server() || null });
  });

  r.post('/connect', async (req, res) => {
    try {
      const { serverIndex } = req.body || {};
      const list = Array.isArray(ctx.config.servers) ? ctx.config.servers : [];
      if (typeof serverIndex !== 'number' || serverIndex < 0 || serverIndex >= list.length) {
        return res.status(400).json({ message: 'Invalid server index.' });
      }
      const target = list[serverIndex];
      await ctx.connectToServer(target);
      ctx.logLine(`Connected to ${target.name || target.host}:${target.port}`);
      res.json({ message: `Connected to ${target.name || target.host}:${target.port}` });
    } catch (err) {
      ctx.logLine(`Connect error: ${err.message}`);
      res.status(500).json({ message: 'Failed to connect to the server.' });
    }
  });

  r.post('/disconnect', (_req, res) => {
    if (!ctx.tcp.isConnected()) return res.json({ message: 'Already disconnected.' });
    const target = ctx.tcp.server();
    ctx.ensureDisconnected();
    ctx.logLine(`Disconnected from ${target ? (target.name || `${target.host}:${target.port}`) : 'unknown'}`);
    res.json({ message: 'Disconnected.' });
  });

  return r;
};
