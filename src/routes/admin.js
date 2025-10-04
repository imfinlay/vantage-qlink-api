'use strict';
const express = require('express');
const router = express.Router();
const { VALID_COMMANDS, COMMAND_ITEMS, loadCommandsCSV, COMMANDS_CSV_PATH } = require('./shared_commands');
const { logLine } = require('../core/logger');

router.get('/commands', (_req, res) => {
  const cmds = Array.from(VALID_COMMANDS.values()).sort();
  res.json({ commands: cmds, count: cmds.length, items: COMMAND_ITEMS });
});

router.post('/admin/reload-commands', (_req, res) => {
  loadCommandsCSV(COMMANDS_CSV_PATH);
  const count = VALID_COMMANDS.size;
  console.log(`[admin] Reloaded commands: ${count}`);
  logLine(`[admin] Reloaded commands: ${count}`);
  res.json({ message: 'Commands reloaded', count });
});

module.exports = router;
