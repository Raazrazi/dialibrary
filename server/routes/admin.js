'use strict';
/** Admin only: settings, data uploads, accounts, audit trail, exports. */
const express = require('express');
const crypto = require('crypto');
const { sql, nosql } = require('../db');
const settings = require('../settings');
const A = require('../auth');
const csv = require('../csv');
const staff = require('./staff');
const { wrap, str, int, HttpError, bad } = require('../util');

const r = express.Router();
r.use(A.requireRole('admin'));

/* ----- settings ----- */
const NUM = {
  loanDays: [1, 120], maxRenewals: [0, 10], graceDays: [0, 30], finePerDay: [0, 1000], maxFine: [0, 100000],
  lostAfterDays: [1, 365], lostCharge: [0, 100000], blockCheckoutAtFines: [0, 100000],
  maxLoans: [1, 50], maxHolds: [0, 20], holdWaitDays: [1, 30],
};
r.get('/settings', (req, res) => res.json({ settings: settings.get() }));
r.put('/settings', wrap(async (req, res) => {
  const patch = {};
  const b = req.body || {};
  if ('libraryName' in b) patch.libraryName = str(b.libraryName, { max: 80, min: 2, name: 'Library name' });
  if ('tagline' in b) patch.tagline = str(b.tagline, { max: 120 });
  if ('currency' in b) patch.currency = str(b.currency, { max: 4, min: 1, name: 'Currency symbol' });
  if ('publicSearch' in b) patch.publicSearch = b.publicSearch === true;
  for (const [k, [min, max]] of Object.entries(NUM)) if (k in b) patch[k] = int(b[k], { min, max, name: k });
  const before = settings.get();
  const next = await settings.update(patch);
  const changed = Object.keys(patch).filter((k) => before[k] !== next[k]);
  await A.audit(req, 'settings.update', { changed });
  res.json({ settings: next });
}));

/* ----- uploading data (CSV) ----- */
const clean = (v, n) => String(v || '').replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, n);

r.post('/import/catalog', wrap(async (req, res) => {
  const rows = csv.parse(str(req.body.csv, { max: 5_000_000, min: 1, name: 'CSV file' }));
  if (!rows.length) throw bad('The file has no rows');
  if (rows.length > 20000) throw bad('Please upload up to 20,000 rows at a time');
  if (!('title' in rows[0])) throw bad('The file needs a "title" column');
  const out = { titlesCreated: 0, itemsCreated: 0, skipped: 0, errors: [] };
  const find = sql.prepare(`SELECT id FROM biblio WHERE (isbn <> '' AND isbn = ?) OR (lower(title)=lower(?) AND lower(author)=lower(?)) LIMIT 1`);
  const ins = sql.prepare(`INSERT INTO biblio (title,author,isbn,publisher,year,language,subjects,call_number,description) VALUES (?,?,?,?,?,?,?,?,?)`);
  sql.transaction(() => {
    rows.forEach((x, i) => {
      try {
        const title = clean(x.title, 200);
        if (!title) { out.skipped++; out.errors.push(`Row ${i + 2}: missing title`); return; }
        const isbn = clean(x.isbn, 20).replace(/[^0-9Xx-]/g, '');
        const author = clean(x.author, 150);
        let id = (find.get(isbn, title, author) || {}).id;
        if (!id) {
          const yr = parseInt(x.year, 10);
          id = ins.run(title, author, isbn, clean(x.publisher, 100), yr >= 1000 && yr <= 2100 ? yr : null, clean(x.language, 40) || 'English',
            clean(x.subjects, 200).split(/[|;]/).map((s) => s.trim()).filter(Boolean).join('|'), clean(x.call_number, 40), clean(x.description, 1500)).lastInsertRowid;
          out.titlesCreated++;
        }
        const copies = Math.min(Math.max(parseInt(x.copies, 10) || 1, 1), 20);
        for (let c = 0; c < copies; c++) {
          let bc = c === 0 ? clean(x.barcode, 40) : '';
          if (bc && sql.prepare('SELECT 1 FROM items WHERE barcode=?').get(bc)) { out.errors.push(`Row ${i + 2}: barcode ${bc} already exists, a new one was assigned`); bc = ''; }
          staff.addItem(id, clean(x.location, 60) || 'Main Shelves', bc || undefined);
          out.itemsCreated++;
        }
      } catch (e) { out.skipped++; out.errors.push(`Row ${i + 2}: ${e.message}`); }
    });
  })();
  out.errors = out.errors.slice(0, 30);
  await A.audit(req, 'import.catalog', { titles: out.titlesCreated, items: out.itemsCreated });
  res.json(out);
}));

r.post('/import/patrons', wrap(async (req, res) => {
  const rows = csv.parse(str(req.body.csv, { max: 5_000_000, min: 1, name: 'CSV file' }));
  if (!rows.length) throw bad('The file has no rows');
  if (rows.length > 5000) throw bad('Please upload up to 5,000 students at a time');
  if (!('name' in rows[0])) throw bad('The file needs a "name" column');
  const out = { created: 0, skipped: 0, errors: [], credentials: [] };
  for (const [i, x] of rows.entries()) {
    const name = clean(x.name, 80);
    const card = clean(x.card_number, 20);
    if (name.length < 2 || !card) { out.skipped++; out.errors.push(`Row ${i + 2}: name and card_number are required`); continue; }
    const username = (clean(x.username, 40) || card).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) { out.skipped++; out.errors.push(`Row ${i + 2}: invalid username`); continue; }
    if (await nosql.users.findOneAsync({ $or: [{ username }, { cardNumber: card }] })) { out.skipped++; out.errors.push(`Row ${i + 2}: ${card} already exists`); continue; }
    const temp = crypto.randomBytes(6).toString('base64url') + crypto.randomInt(10, 99);
    await nosql.users.insertAsync({
      role: 'student', name, username, cardNumber: card, email: clean(x.email, 120), className: clean(x.class, 40), department: clean(x.department, 60),
      passHash: await A.hashPassword(temp), mustChangePassword: true, active: true, passkeys: [], createdAt: new Date().toISOString(),
    });
    out.created++; out.credentials.push({ name, username, card_number: card, temporary_password: temp });
  }
  out.errors = out.errors.slice(0, 30);
  await A.audit(req, 'import.patrons', { created: out.created });
  res.json(out);
}));

r.post('/csv-credentials', wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 5000) : [];
  res.type('text/csv').send(csv.stringify(rows, ['name', 'username', 'card_number', 'temporary_password']));
}));

/* ----- exports / backups ----- */
r.get('/export/catalog.csv', wrap(async (req, res) => {
  const rows = sql.prepare(`SELECT b.title,b.author,b.isbn,b.publisher,b.year,b.language,b.subjects,b.call_number,b.description,
    (SELECT group_concat(barcode,' ') FROM items WHERE biblio_id=b.id) barcodes, (SELECT COUNT(*) FROM items WHERE biblio_id=b.id) copies FROM biblio b ORDER BY b.id`).all();
  await A.audit(req, 'export.catalog', { rows: rows.length });
  res.type('text/csv').attachment('catalogue.csv').send(csv.stringify(rows, ['title', 'author', 'isbn', 'publisher', 'year', 'language', 'subjects', 'call_number', 'description', 'barcodes', 'copies']));
}));
r.get('/export/backup.json', wrap(async (req, res) => {
  const strip = (u) => { const { passHash, passkeys, ...rest } = u; return { ...rest, passkeyCount: (passkeys || []).length }; };
  await A.audit(req, 'export.backup');
  res.attachment('library-backup.json').json({
    exportedAt: new Date().toISOString(), settings: settings.get(),
    biblio: sql.prepare('SELECT * FROM biblio').all(), items: sql.prepare('SELECT * FROM items').all(), loans: sql.prepare('SELECT * FROM loans').all(),
    users: (await nosql.users.findAsync({})).map(strip), holds: await nosql.holds.findAsync({}), fines: await nosql.fines.findAsync({}),
  });
}));

/* ----- accounts ----- */
r.get('/users', wrap(async (req, res) => {
  const role = ['student', 'librarian', 'admin'].includes(req.query.role) ? req.query.role : null;
  const list = await nosql.users.findAsync(role ? { role } : { role: { $in: ['librarian', 'admin'] } }).sort({ role: 1, name: 1 }).limit(200);
  res.json({ users: list.map(A.publicUser).map((u, i) => ({ ...u, lastLogin: list[i].lastLogin || null })) });
}));
r.post('/users', wrap(async (req, res) => {
  const role = str(req.body.role, { max: 12 });
  if (!['librarian', 'admin'].includes(role)) throw bad('Staff role must be librarian or admin');
  const name = str(req.body.name, { max: 80, min: 2, name: 'Name' });
  const username = str(req.body.username, { max: 40, min: 3, name: 'Username' }).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad('Username may use letters, numbers, dot, dash and underscore');
  if (await nosql.users.findOneAsync({ username })) throw new HttpError(409, 'That username is taken');
  const temp = crypto.randomBytes(6).toString('base64url') + crypto.randomInt(10, 99);
  const u = await nosql.users.insertAsync({
    role, name, username, email: str(req.body.email, { max: 120 }), passHash: await A.hashPassword(temp),
    mustChangePassword: true, active: true, passkeys: [], createdAt: new Date().toISOString(),
  });
  await A.audit(req, 'user.create', { username, role });
  res.json({ user: A.publicUser(u), tempPassword: temp });
}));
r.patch('/users/:id', wrap(async (req, res) => {
  const u = await nosql.users.findOneAsync({ _id: req.params.id });
  if (!u) throw new HttpError(404, 'Account not found');
  const set = {}; let temp = null;
  if ('active' in req.body) {
    if (u._id === req.user._id && req.body.active === false) throw new HttpError(409, 'You cannot deactivate your own account');
    set.active = req.body.active === true;
  }
  if ('role' in req.body) {
    if (u._id === req.user._id) throw new HttpError(409, 'You cannot change your own role');
    if (!['student', 'librarian', 'admin'].includes(req.body.role)) throw bad('Unknown role');
    set.role = req.body.role;
  }
  if (req.body.resetPassword === true) {
    temp = crypto.randomBytes(6).toString('base64url') + crypto.randomInt(10, 99);
    set.passHash = await A.hashPassword(temp); set.mustChangePassword = true; set.failed = 0; set.lockedUntil = 0;
  }
  if (req.body.clearPasskeys === true) set.passkeys = [];
  if (!Object.keys(set).length) throw bad('Nothing to change');
  await nosql.users.updateAsync({ _id: u._id }, { $set: set });
  if (set.active === false || temp || set.role) await nosql.sessions.removeAsync({ userId: u._id }, { multi: true });
  await A.audit(req, 'user.update', { target: u.username, fields: Object.keys(set).filter((k) => k !== 'passHash') });
  res.json({ ok: true, tempPassword: temp });
}));

/* ----- audit trail ----- */
r.get('/audit', wrap(async (req, res) => {
  const q = str(req.query.q, { max: 40 });
  const filter = q ? { $or: [{ action: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { actorName: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }] } : {};
  res.json({ events: await nosql.audit.findAsync(filter).sort({ at: -1 }).limit(150) });
}));

module.exports = r;
