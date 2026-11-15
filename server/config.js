'use strict';
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3000;
const isVercel = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const VERCEL_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
const ORIGIN = process.env.ORIGIN || VERCEL_URL || `http://localhost:${PORT}`;

// In Vercel serverless environments, only /tmp is writable
const DATA_DIR = process.env.DATA_DIR || (isVercel ? path.join('/tmp', 'library-data') : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

let defaultRpId = 'localhost';
try {
  defaultRpId = process.env.VERCEL_URL ? process.env.VERCEL_URL.split(':')[0] : new URL(ORIGIN).hostname;
} catch {
  defaultRpId = 'localhost';
}

module.exports = {
  PORT,
  ORIGIN,
  // WebAuthn relying-party id must equal the site's hostname (no port).
  RP_ID: process.env.RP_ID || defaultRpId,
  PROD: process.env.NODE_ENV === 'production' || isVercel,
  DATA_DIR,
  IS_VERCEL: isVercel,
  SESSION_IDLE_MS: 30 * 60 * 1000,
  SESSION_ABSOLUTE_MS: 8 * 60 * 60 * 1000,
  MAX_FAILED_LOGINS: 5,
  LOCKOUT_MS: 15 * 60 * 1000,
};
