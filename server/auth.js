'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const cfg = require('./config');
const { nosql } = require('./db');
const { HttpError, bad } = require('./util');

const scrypt = promisify(crypto.scrypt);
const N = 32768, R = 8, P = 1;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');

/* ---------- passwords (scrypt, per-user salt, constant-time compare) ---------- */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N, r: R, p: P, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  try {
    const [, n, r, p, salt, key] = stored.split('$');
    const expected = Buffer.from(key, 'base64');
    const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length,
      { N: +n, r: +r, p: +p, maxmem: 128 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}
let dummyHash;
async function burnTime(pw) { dummyHash = dummyHash || await hashPassword('x'); await verifyPassword(pw, dummyHash); }

const COMMON = new Set(['password123', 'password1234', 'qwerty12345', '1234567890', 'library123', 'welcome123', 'letmein1234']);
function checkPasswordPolicy(pw, username = '') {
  if (typeof pw !== 'string' || pw.length < 10) throw bad('Password must be at least 10 characters');
  if (pw.length > 128) throw bad('Password is too long');
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) throw bad('Password needs at least one letter and one number');
  if (COMMON.has(pw.toLowerCase()) || pw.toLowerCase() === username.toLowerCase()) throw bad('That password is too easy to guess');
}

/* ---------- sessions ---------- */
const COOKIE = cfg.PROD ? '__Host-sid' : 'sid';

async function createSession(req, res, user) {
  const token = rand(32);
  const now = Date.now();
  const doc = {
    _id: sha256(token), userId: user._id, csrf: rand(24),
    createdAt: now, lastSeen: now,
    expireAt: new Date(now + cfg.SESSION_ABSOLUTE_MS),
    ip: req.ip, ua: String(req.get('user-agent') || '').slice(0, 200),
  };
  await nosql.sessions.insertAsync(doc);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: cfg.PROD, path: '/', maxAge: cfg.SESSION_ABSOLUTE_MS,
  });
  return doc;
}
async function destroySession(req, res) {
  const t = req.cookies && req.cookies[COOKIE];
  if (t) await nosql.sessions.removeAsync({ _id: sha256(t) }, {});
  res.clearCookie(COOKIE, { path: '/' });
}

async function loadSession(req, res, next) {
  try {
    const t = req.cookies && req.cookies[COOKIE];
    if (!t || typeof t !== 'string' || t.length > 100) return next();
    const s = await nosql.sessions.findOneAsync({ _id: sha256(t) });
    if (!s) return next();
    const now = Date.now();
    if (now - s.lastSeen > cfg.SESSION_IDLE_MS) { await nosql.sessions.removeAsync({ _id: s._id }, {}); return next(); }
    const user = await nosql.users.findOneAsync({ _id: s.userId });
    if (!user || !user.active) { await nosql.sessions.removeAsync({ _id: s._id }, {}); return next(); }
    if (now - s.lastSeen > 60000) await nosql.sessions.updateAsync({ _id: s._id }, { $set: { lastSeen: now } });
    req.session = s; req.user = user;
    next();
  } catch (e) { next(e); }
}

/* ---------- guards ---------- */
const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in')));
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have access to this'));
  next();
};

// CSRF: SameSite=Strict cookie + same-origin check + JSON-only bodies + per-session token header.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== cfg.ORIGIN) return next(new HttpError(403, 'Cross-site request blocked'));
  if (req.body && Object.keys(req.body).length && !req.is('application/json')) return next(new HttpError(415, 'JSON only'));
  if (req.session) {
    const sent = String(req.get('x-csrf-token') || '');
    const a = Buffer.from(sent), b = Buffer.from(req.session.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new HttpError(403, 'Security token missing or expired. Refresh the page.'));
  }
  next();
}

/* ---------- audit ---------- */
async function audit(req, action, detail = {}, actor) {
  const u = actor || req.user;
  await nosql.audit.insertAsync({
    at: new Date().toISOString(), action,
    actorId: u ? u._id : null, actorName: u ? u.name : 'anonymous', role: u ? u.role : null,
    ip: req.ip, detail,
  });
}

const publicUser = (u) => ({
  id: u._id, name: u.name, username: u.username, role: u.role, email: u.email || '',
  cardNumber: u.cardNumber || '', className: u.className || '', department: u.department || '',
  mustChangePassword: !!u.mustChangePassword, passkeys: (u.passkeys || []).length,
  active: !!u.active, createdAt: u.createdAt,
});

module.exports = {
  hashPassword, verifyPassword, burnTime, checkPasswordPolicy, rand, sha256,
  createSession, destroySession, loadSession, requireAuth, requireRole, csrfGuard, audit, publicUser,
};
