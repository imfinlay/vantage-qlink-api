'use strict';
const path = require('path');
const express = require('express');
const ctx = require('./core/context');
const { loadWhitelistFromHomebridgeSync } = require('./core/whitelist');
const { logLine } = require('./core/logger');

const app = express();
ctx.app = app;
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files (defaults to <repo>/public)
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// Mount routes
app.use(require('./routes/core'));
app.use(require('./routes/connection'));
app.use(require('./routes/io'));
app.use(require('./routes/test'));
app.use(require('./routes/dim'));
app.use(require('./routes/vgs'));
app.use(require('./routes/admin'));
app.use(require('./routes/whitelist'));
app.use(require('./routes/logging')); // <-- new

try { loadWhitelistFromHomebridgeSync(); } catch (_) {}

module.exports = app;
