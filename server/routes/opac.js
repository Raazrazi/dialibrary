'use strict';
/** OPAC: public-catalogue search, record view, facets, new arrivals. */
const express = require('express');
const { sql } = require('../db');
const settings = require('../settings');
const circ = require('../circ');
const { wrap, str, int, HttpError } = require('../util');

const r = express.Router();

r.use((req, res, next) => {
  if (!req.user && !settings.get().publicSearch) return next(new HttpError(401, 'Please sign in to search the catalogue'));
  next();
});

const FIELDS = { all: null, title: 'title', author: 'author', subject: 'subjects', isbn: 'isbn', callno: 'call_number' };

function ftsQuery(raw, field) {
  const terms = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
  if (!terms.length) return null;
  const body = terms.map((t) => `${t}*`).join(' ');
  const col = FIELDS[field];
  return col ? `${col}: (${body})` : body;
}

const shape = (b, av) => ({
  id: b.id, title: b.title, author: b.author, year: b.year, publisher: b.publisher, language: b.language,
  subjects: b.subjects ? b.subjects.split('|') : [], callNumber: b.call_number, isbn: b.isbn,
  copies: (av[b.id] || {}).copies || 0, available: (av[b.id] || {}).available || 0, nextDue: (av[b.id] || {}).nextDue || null,
});

r.get('/search', wrap(async (req, res) => {
  const q = str(req.query.q, { max: 120 });
  const field = FIELDS[req.query.field] !== undefined ? req.query.field : 'all';
  const subject = str(req.query.subject, { max: 80 });
  const language = str(req.query.language, { max: 40 });
  const onlyAvail = req.query.available === '1';
  const page = int(req.query.page, { min: 1, max: 500, def: 1, name: 'page' });
  const per = 12;

  const where = [], args = [];
  let from = 'biblio b';
  if (q) {
    const m = ftsQuery(q, field);
    if (!m) return res.json({ total: 0, page, per, results: [], facets: { subjects: [], languages: [] } });
    from = 'biblio b JOIN biblio_fts f ON f.rowid = b.id';
    where.push('biblio_fts MATCH ?'); args.push(m);
  }
  if (subject) { where.push(`('|'||b.subjects||'|') LIKE ?`); args.push(`%|${subject.replace(/[%_]/g, '')}|%`); }
  if (language) { where.push('b.language = ?'); args.push(language); }
  if (onlyAvail) where.push(`EXISTS (SELECT 1 FROM items i WHERE i.biblio_id=b.id AND i.status='available')`);
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = q ? 'ORDER BY rank' : 'ORDER BY b.title COLLATE NOCASE';

  const total = sql.prepare(`SELECT COUNT(*) c FROM ${from} ${W}`).get(...args).c;
  const rows = sql.prepare(`SELECT b.* FROM ${from} ${W} ${order} LIMIT ? OFFSET ?`).all(...args, per, (page - 1) * per);
  const av = circ.availabilityMap(rows.map((b) => b.id));

  // facets over the whole filtered set
  const ids = sql.prepare(`SELECT b.subjects s, b.language l FROM ${from} ${W}`).all(...args);
  const sc = {}, lc = {};
  for (const x of ids) {
    for (const s of x.s ? x.s.split('|') : []) sc[s] = (sc[s] || 0) + 1;
    lc[x.l] = (lc[x.l] || 0) + 1;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
  res.json({ total, page, per, results: rows.map((b) => shape(b, av)), facets: { subjects: top(sc, 12), languages: top(lc, 6) } });
}));

r.get('/new', wrap(async (req, res) => {
  const rows = sql.prepare(`SELECT * FROM biblio ORDER BY id DESC LIMIT 8`).all();
  const av = circ.availabilityMap(rows.map((b) => b.id));
  res.json({ results: rows.map((b) => shape(b, av)) });
}));

r.get('/biblio/:id', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1, name: 'id' });
  const b = sql.prepare(`SELECT * FROM biblio WHERE id=?`).get(id);
  if (!b) throw new HttpError(404, 'Record not found');
  const av = circ.availabilityMap([id]);
  const items = sql.prepare(`SELECT i.id, i.barcode, i.location, i.status,
    (SELECT due_at FROM loans WHERE item_id=i.id AND returned_at IS NULL) dueAt FROM items i WHERE biblio_id=? ORDER BY i.id`).all(id);
  const holds = (await circ.pendingHolds(id)).length;
  const out = { ...shape(b, av), description: b.description, items: items.map((i) => ({ ...i, barcode: req.user && req.user.role !== 'student' ? i.barcode : undefined })), holds };
  if (req.user && req.user.role === 'student') {
    const { nosql } = require('../db');
    out.myHold = await nosql.holds.findOneAsync({ patronId: req.user._id, biblioId: id, status: { $in: ['pending', 'waiting'] } });
    const shelf = await nosql.shelves.findOneAsync({ _id: req.user._id });
    out.saved = !!(shelf && shelf.biblioIds.includes(id));
  }
  res.json(out);
}));

module.exports = r;
