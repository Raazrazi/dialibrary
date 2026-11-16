'use strict';
/** Student self-service: loans, holds, fines, reading history, saved list. */
const express = require('express');
const { sql, nosql } = require('../db');
const circ = require('../circ');
const settings = require('../settings');
const A = require('../auth');
const { wrap, int, HttpError } = require('../util');

const r = express.Router();
r.use(A.requireRole('student'));

r.get('/summary', wrap(async (req, res) => {
  const id = req.user._id;
  const s = settings.get();
  const openLoans = await circ.openLoansFor(id);
  const loans = await circ.annotateRenewable(openLoans);
  const fines = await nosql.fines.findAsync({ patronId: id }).sort({ createdAt: -1 });
  const holds = await nosql.holds.findAsync({ patronId: id, status: { $in: ['pending', 'waiting'] } }).sort({ createdAt: 1 });
  const accruing = loans.reduce((t, l) => t + l.accruedFine, 0);
  const unpaid = fines.filter((f) => f.status === 'unpaid').reduce((t, f) => t + f.amount, 0);
  const holdsWithTitle = await Promise.all(holds.map(withTitle));
  res.json({ loans, fines, holds: holdsWithTitle, unpaid, accruing,
    limits: { maxLoans: s.maxLoans, maxHolds: s.maxHolds, blockAt: s.blockCheckoutAtFines } });
}));

const withTitle = async (h) => {
  const b = (await sql.prepare('SELECT title, author FROM biblio WHERE id=?').get(h.biblioId)) || {};
  return { id: h._id, biblioId: h.biblioId, title: b.title, author: b.author, status: h.status, createdAt: h.createdAt, barcode: h.barcode, expiresAt: h.expiresAt };
};

r.get('/history', wrap(async (req, res) => res.json({ loans: await circ.historyFor(req.user._id, 50) })));

r.post('/holds', wrap(async (req, res) => {
  const biblioId = int(req.body.biblioId, { min: 1, name: 'Book' });
  const s = settings.get();
  if (!(await sql.prepare('SELECT 1 FROM biblio WHERE id=?').get(biblioId))) throw new HttpError(404, 'Book not found');
  const mine = await nosql.holds.findAsync({ patronId: req.user._id, status: { $in: ['pending', 'waiting'] } });
  if (mine.length >= s.maxHolds) throw new HttpError(409, `You can reserve up to ${s.maxHolds} books at a time`);
  if (mine.some((h) => h.biblioId === biblioId)) throw new HttpError(409, 'You have already reserved this book');
  const open = await circ.openLoansFor(req.user._id);
  if (open.some((l) => l.biblioId === biblioId)) throw new HttpError(409, 'You already have this book');
  const hold = await nosql.holds.insertAsync({
    patronId: req.user._id, patronName: req.user.name, biblioId, status: 'pending', createdAt: new Date().toISOString(),
  });
  await circ.promoteNextHold(biblioId); // a free copy goes straight to the hold shelf
  await A.audit(req, 'hold.place', { biblioId });
  res.json({ ok: true, id: hold._id });
}));

r.delete('/holds/:id', wrap(async (req, res) => {
  const h = await nosql.holds.findOneAsync({ _id: req.params.id, patronId: req.user._id, status: { $in: ['pending', 'waiting'] } });
  if (!h) throw new HttpError(404, 'Reservation not found');
  await nosql.holds.updateAsync({ _id: h._id }, { $set: { status: 'cancelled' } });
  if (h.itemId) {
    await sql.prepare(`UPDATE items SET status='available' WHERE id=? AND status='on_hold'`).run(h.itemId);
    await circ.promoteNextHold(h.biblioId);
  }
  res.json({ ok: true });
}));

r.post('/renew/:loanId', wrap(async (req, res) => {
  const out = await circ.renew(int(req.params.loanId, { min: 1, name: 'loan' }), { patronId: req.user._id });
  await A.audit(req, 'loan.renew', { loanId: req.params.loanId, by: 'student' });
  res.json(out);
}));

r.get('/shelf', wrap(async (req, res) => {
  const s = await nosql.shelves.findOneAsync({ _id: req.user._id });
  const ids = s ? s.biblioIds : [];
  if (!ids.length) return res.json({ results: [] });
  const rows = await sql.prepare(`SELECT * FROM biblio WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const av = await circ.availabilityMap(ids);
  res.json({ results: rows.map((b) => ({ id: b.id, title: b.title, author: b.author, year: b.year, available: (av[b.id] || {}).available || 0, copies: (av[b.id] || {}).copies || 0 })) });
}));

r.post('/shelf/:biblioId', wrap(async (req, res) => {
  const id = int(req.params.biblioId, { min: 1, name: 'Book' });
  const s = (await nosql.shelves.findOneAsync({ _id: req.user._id })) || { _id: req.user._id, biblioIds: [] };
  const has = s.biblioIds.includes(id);
  s.biblioIds = has ? s.biblioIds.filter((x) => x !== id) : [...s.biblioIds, id].slice(-100);
  await nosql.shelves.updateAsync({ _id: s._id }, s, { upsert: true });
  res.json({ saved: !has });
}));

module.exports = r;
