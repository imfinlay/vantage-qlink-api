'use strict';
const express = require('express');
const router = express.Router();
const ctx = require('../core/context');
const { isLoggingEnabled, enableLogging, disableLogging } = require('../core/logger');

router.get('/logging/status', (_req, res) => {
  return res.json({
    enabled: isLoggingEnabled(),
    file: ctx.LOG_FILE_PATH,
    ring_size: Array.isArray(ctx.LOG_RING) ? ctx.LOG_RING.length : 0
  });
});

router.post('/logging/start', (_req, res) => {
  enableLogging();
  return res.json({ message: 'logging enabled', enabled: true });
});

router.post('/logging/stop', (_req, res) => {
  disableLogging();
  return res.json({ message: 'logging disabled', enabled: false });
});

module.exports = router;
