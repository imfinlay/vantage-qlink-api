'use strict';
const net = require('net');
const ctx = require('./context');
const { logLine } = require('./logger');

function resetRecv() { ctx.RECV_BUFFER = Buffer.alloc(0); ctx.INCOMING_TEXT_BUF = ''; }
function appendRecv(buf) {
  try {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf));
    const MAX_RECV_BYTES = 32768;
    if (ctx.RECV_BUFFER.length + buf.length > MAX_RECV_BYTES) {
      const keep = Math.max(0, MAX_RECV_BYTES - buf.length);
      if (keep < ctx.RECV_BUFFER.length) ctx.RECV_BUFFER = ctx.RECV_BUFFER.slice(ctx.RECV_BUFFER.length - keep);
    }
    ctx.RECV_BUFFER = Buffer.concat([ctx.RECV_BUFFER, buf]);

    const text = buf.toString('utf8');
    const preview = text.replace(/\r?\n/g, ' ').slice(0, 200);
    if (preview) logLine(`RX <- ${preview}`);

    const { processIncomingText } = require('./parsing');
    processIncomingText(text);
  } catch (_) {}
}

function ensureDisconnected() {
  if (ctx.tcpClient) {
    try { ctx.tcpClient.removeAllListeners('data'); } catch (_) {}
    try { ctx.tcpClient.destroy(); } catch (_) {}
  }
  ctx.tcpClient = null;
  ctx.connectedServer = null;
  resetRecv();

  try {
    for (const [, t] of ctx.PENDING) { try { clearTimeout(t); } catch (_) {} }
    ctx.PENDING.clear();
  } catch (_) {}
  try {
    for (const [k, list] of ctx.AWAITERS) {
      ctx.AWAITERS.delete(k);
      for (const entry of list) {
        try { clearTimeout(entry.timeout); entry.reject(new Error('disconnected')); } catch (_) {}
      }
    }
    ctx.VGS_WAIT_ORDER.length = 0;
  } catch (_) {}
}

function connectToServer(target) {
  return new Promise((resolve, reject) => {
    ensureDisconnected();
    const socket = new net.Socket();
    let done = false;

    socket.setTimeout(10000);
    socket.once('connect', () => {
      socket.setNoDelay(true);
      ctx.tcpClient = socket;
      ctx.connectedServer = target;
      resetRecv();
      socket.on('data', appendRecv);

      try { if (typeof ctx.HANDSHAKE === 'string' && ctx.HANDSHAKE.length) ctx.tcpClient.write(ctx.HANDSHAKE); } catch (_) {}
      try {
        if (ctx.HANDSHAKE_RETRY_MS > 0) setTimeout(() => {
          try { if (ctx.tcpClient === socket && typeof ctx.HANDSHAKE === 'string' && ctx.HANDSHAKE.length) ctx.tcpClient.write(ctx.HANDSHAKE); } catch (_) {}
        }, ctx.HANDSHAKE_RETRY_MS);
      } catch (_) {}
      done = true; resolve();
    });
    socket.once('timeout', () => { if (!done) { socket.destroy(); reject(new Error('TCP connection timeout')); } });
    socket.once('error', (err) => { if (!done) { socket.destroy(); reject(err || new Error('TCP connection error')); } });
    socket.once('close', () => { if (ctx.tcpClient === socket) { ctx.tcpClient = null; ctx.connectedServer = null; } });

    socket.connect(target.port, target.host);
  });
}

function sendToTCP(data) {
  return new Promise((resolve, reject) => {
    if (!ctx.tcpClient) return reject(new Error('Not connected'));
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      ctx.tcpClient.write(buf, (err) => (err ? reject(err) : resolve()));
    } catch (err) { reject(err); }
  });
}

function sendCmdLogged(cmd) {
  try { logLine(`CMD/API -> ${cmd}`); } catch (_) {}
  return sendToTCP(cmd + ctx.NL);
}

module.exports = {
  connectToServer, ensureDisconnected,
  sendToTCP, sendCmdLogged,
  resetRecv,
};
