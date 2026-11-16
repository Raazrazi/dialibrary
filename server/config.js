'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3000;
const isVercel = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const isRender = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const VERCEL_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || null;
const ORIGIN = process.env.ORIGIN || RENDER_URL || VERCEL_URL || `http://localhost:${PORT}`;

// In Vercel serverless environments, only /tmp is writable
const rawDataDir = process.env.DATA_DIR || (isVercel ? path.join('/tmp', 'library-data') : path.join(__dirname, '..', 'data'));
const DATA_DIR = path.isAbsolute(rawDataDir) ? rawDataDir : path.resolve(__dirname, '..', rawDataDir);
fs.mkdirSync(DATA_DIR, { recursive: true });

const SQL_FILENAME = process.env.SQL_DATABASE || 'catalogue.sqlite';

let defaultRpId = 'localhost';
try {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    defaultRpId = process.env.RENDER_EXTERNAL_HOSTNAME;
  } else if (process.env.VERCEL_URL) {
    defaultRpId = process.env.VERCEL_URL.split(':')[0];
  } else {
    defaultRpId = new URL(ORIGIN).hostname;
  }
} catch {
  defaultRpId = 'localhost';
}

module.exports = {
  PORT,
  ORIGIN,
  // WebAuthn relying-party id must equal the site's hostname (no port).
  RP_ID: process.env.RP_ID || defaultRpId,
  PROD: process.env.NODE_ENV === 'production' || isVercel || isRender,
  DATA_DIR,
  SQL_FILENAME,
  IS_VERCEL: isVercel,
  IS_RENDER: isRender,
  SESSION_IDLE_MS: 30 * 60 * 1000,
  SESSION_ABSOLUTE_MS: 8 * 60 * 60 * 1000,
  MAX_FAILED_LOGINS: 5,
  LOCKOUT_MS: 15 * 60 * 1000,
};
