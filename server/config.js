'use strict';
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  PORT,
  ORIGIN,
  // WebAuthn relying-party id must equal the site's hostname (no port).
  RP_ID: process.env.RP_ID || new URL(ORIGIN).hostname,
  PROD: process.env.NODE_ENV === 'production',
  DATA_DIR,
  SESSION_IDLE_MS: 30 * 60 * 1000,
  SESSION_ABSOLUTE_MS: 8 * 60 * 60 * 1000,
  MAX_FAILED_LOGINS: 5,
  LOCKOUT_MS: 15 * 60 * 1000,
};
