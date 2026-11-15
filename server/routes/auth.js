'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const cfg = require('../config');
const { nosql } = require('../db');
const settings = require('../settings');
const A = require('../auth');
const { wrap, str, HttpError, bad } = require('../util');

const r = express.Router();

const getOrigin = (req) => {
  if (process.env.ORIGIN) return process.env.ORIGIN;
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : cfg.ORIGIN;
};

const getRPID = (req) => {
  if (process.env.RP_ID) return process.env.RP_ID;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? host.split(':')[0] : cfg.RP_ID;
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

const sessionPayload = (req) => ({
  user: A.publicUser(req.user), csrf: req.session.csrf,
  settings: (({ libraryName, currency, loanDays, graceDays, finePerDay, maxFine, maxLoans, maxRenewals, lostAfterDays }) =>
    ({ libraryName, currency, loanDays, graceDays, finePerDay, maxFine, maxLoans, maxRenewals, lostAfterDays }))(settings.get()),
});

/* ----- password sign-in with lockout ----- */
r.post('/login', authLimiter, wrap(async (req, res) => {
  const username = str(req.body.username, { max: 60, min: 1, name: 'Username' }).toLowerCase();
  const password = str(req.body.password, { max: 128, min: 1, name: 'Password' });
  const user = await nosql.users.findOneAsync({ username });
  const generic = new HttpError(401, 'Username or password is incorrect');

  if (!user) { await A.burnTime(password); await A.audit(req, 'login.fail', { username }); throw generic; }
  if (user.lockedUntil && user.lockedUntil > Date.now()) {
    throw new HttpError(429, 'Too many failed attempts. This account is locked for a few minutes.');
  }
  const ok = await A.verifyPassword(password, user.passHash);
  if (!ok) {
    const failed = (user.failed || 0) + 1;
    const set = { failed };
    if (failed >= cfg.MAX_FAILED_LOGINS) { set.lockedUntil = Date.now() + cfg.LOCKOUT_MS; set.failed = 0; }
    await nosql.users.updateAsync({ _id: user._id }, { $set: set });
    await A.audit(req, 'login.fail', { username }, user);
    throw generic;
  }
  if (!user.active) throw new HttpError(403, 'This account is deactivated. Please see the library desk.');
  await nosql.users.updateAsync({ _id: user._id }, { $set: { failed: 0, lockedUntil: 0, lastLogin: new Date().toISOString() } });
  req.user = user;
  req.session = await A.createSession(req, res, user);
  await A.audit(req, 'login.password');
  res.json(sessionPayload(req));
}));

r.post('/logout', wrap(async (req, res) => {
  if (req.user) await A.audit(req, 'logout');
  await A.destroySession(req, res);
  res.json({ ok: true });
}));

r.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, settings: { libraryName: settings.get().libraryName } });
  res.json(sessionPayload(req));
});

r.post('/password', A.requireAuth, authLimiter, wrap(async (req, res) => {
  const current = str(req.body.current, { max: 128, min: 1, name: 'Current password' });
  const next = str(req.body.next, { max: 128, min: 1, name: 'New password' });
  if (!(await A.verifyPassword(current, req.user.passHash))) throw new HttpError(403, 'Current password is incorrect');
  A.checkPasswordPolicy(next, req.user.username);
  await nosql.users.updateAsync({ _id: req.user._id }, { $set: { passHash: await A.hashPassword(next), mustChangePassword: false } });
  // sign out every other session after a password change
  await nosql.sessions.removeAsync({ userId: req.user._id, _id: { $ne: req.session._id } }, { multi: true });
  await A.audit(req, 'password.change');
  res.json({ ok: true });
}));

/* ----- passkeys (WebAuthn; user verification required = fingerprint / face / device PIN) ----- */
const saveChallenge = async (challenge, extra) => {
  const id = A.rand(18);
  await nosql.challenges.insertAsync({ _id: id, challenge, ...extra, expireAt: new Date(Date.now() + 5 * 60 * 1000) });
  return id;
};
const takeChallenge = async (id, type) => {
  if (typeof id !== 'string') throw bad('Sign-in request expired. Please try again.');
  const c = await nosql.challenges.findOneAsync({ _id: id, type });
  await nosql.challenges.removeAsync({ _id: id }, {});
  if (!c) throw bad('Sign-in request expired. Please try again.');
  return c;
};

r.get('/passkeys', A.requireAuth, (req, res) => {
  res.json({ passkeys: (req.user.passkeys || []).map((p) => ({
    id: p.id, name: p.name, createdAt: p.createdAt, lastUsed: p.lastUsed || null,
    deviceType: p.deviceType, backedUp: p.backedUp,
  })) });
});

r.post('/passkey/register/options', A.requireAuth, authLimiter, wrap(async (req, res) => {
  const u = req.user;
  const options = await generateRegistrationOptions({
    rpName: settings.get().libraryName, rpID: getRPID(req),
    userName: u.username, userDisplayName: u.name,
    userID: new TextEncoder().encode(u._id),
    attestationType: 'none',
    excludeCredentials: (u.passkeys || []).map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  const challengeId = await saveChallenge(options.challenge, { type: 'reg', userId: u._id });
  res.json({ options, challengeId });
}));

r.post('/passkey/register/verify', A.requireAuth, wrap(async (req, res) => {
  const c = await takeChallenge(req.body.challengeId, 'reg');
  if (c.userId !== req.user._id) throw new HttpError(403, 'Challenge does not belong to you');
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: req.body.response, expectedChallenge: c.challenge,
      expectedOrigin: getOrigin(req), expectedRPID: getRPID(req), requireUserVerification: true,
    });
  } catch (e) { throw bad('Could not verify this passkey: ' + e.message); }
  if (!v.verified) throw bad('Passkey could not be verified');
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const entry = {
    id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter, transports: credential.transports || [],
    deviceType: credentialDeviceType, backedUp: credentialBackedUp,
    name: str(req.body.name, { max: 40 }) || 'My device', createdAt: new Date().toISOString(),
  };
  await nosql.users.updateAsync({ _id: req.user._id }, { $push: { passkeys: entry } });
  await A.audit(req, 'passkey.add', { name: entry.name });
  res.json({ ok: true });
}));

r.delete('/passkeys/:id', A.requireAuth, wrap(async (req, res) => {
  const keep = (req.user.passkeys || []).filter((p) => p.id !== req.params.id);
  await nosql.users.updateAsync({ _id: req.user._id }, { $set: { passkeys: keep } });
  await A.audit(req, 'passkey.remove');
  res.json({ ok: true });
}));

r.post('/passkey/login/options', authLimiter, wrap(async (req, res) => {
  // Works with or without a typed username (discoverable credentials).
  const username = str(req.body.username, { max: 60 }).toLowerCase();
  let allow;
  if (username) {
    const u = await nosql.users.findOneAsync({ username });
    if (u && (u.passkeys || []).length) allow = u.passkeys.map((p) => ({ id: p.id, transports: p.transports }));
  }
  const options = await generateAuthenticationOptions({ rpID: getRPID(req), userVerification: 'required', allowCredentials: allow });
  const challengeId = await saveChallenge(options.challenge, { type: 'auth' });
  res.json({ options, challengeId });
}));

r.post('/passkey/login/verify', authLimiter, wrap(async (req, res) => {
  const c = await takeChallenge(req.body.challengeId, 'auth');
  const credId = req.body.response && req.body.response.id;
  if (typeof credId !== 'string') throw bad('Invalid passkey response');
  const user = await nosql.users.findOneAsync({ 'passkeys.id': credId });
  const fail = new HttpError(401, 'This passkey is not recognised. Sign in with your password instead.');
  if (!user) throw fail;
  const pk = user.passkeys.find((p) => p.id === credId);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: req.body.response, expectedChallenge: c.challenge,
      expectedOrigin: getOrigin(req), expectedRPID: getRPID(req), requireUserVerification: true,
      credential: { id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports },
    });
  } catch (e) { await A.audit(req, 'login.passkey.fail', {}, user); throw fail; }
  if (!v.verified) throw fail;
  if (!user.active) throw new HttpError(403, 'This account is deactivated. Please see the library desk.');
  const passkeys = user.passkeys.map((p) => p.id === pk.id
    ? { ...p, counter: v.authenticationInfo.newCounter, lastUsed: new Date().toISOString() } : p);
  await nosql.users.updateAsync({ _id: user._id }, { $set: { passkeys, lastLogin: new Date().toISOString() } });
  req.user = user;
  req.session = await A.createSession(req, res, user);
  await A.audit(req, 'login.passkey');
  res.json(sessionPayload(req));
}));

module.exports = r;
