'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { loadWhitelistFromHomebridgeSync } = require('../core/whitelist');

router.get('/whitelist', (_req, res) => {
  res.json({
    source: 'homebridge',
    path: ctx.HB_CONFIG_PATH,
    count: ctx.WHITELIST.size,
    mtime: ctx.WHITELIST_MTIME,
    devices: Array.from(ctx.WHITELIST).sort()
  });
});

router.post('/whitelist/reload', (_req, res) => {
  loadWhitelistFromHomebridgeSync();
  res.json({ message: 'reloaded', count: ctx.WHITELIST.size, mtime: ctx.WHITELIST_MTIME });
});

module.exports = router;
