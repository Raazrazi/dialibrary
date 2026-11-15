'use strict';
/** Circulation rules: loans, returns, renewals, holds and fines. */
const { sql, nosql } = require('./db');
const settings = require('./settings');
const { HttpError, DAY, endOfDay, addDays } = require('./util');

/* ---------- fines ---------- */
function overdueDays(dueAt, until) {
  const late = new Date(until).getTime() - new Date(dueAt).getTime();
  return late > 0 ? Math.ceil(late / DAY) : 0;
}
function fineFor(dueAt, until, s = settings.get()) {
  const days = overdueDays(dueAt, until);
  const billable = Math.max(0, days - s.graceDays);
  const amount = Math.min(billable * s.finePerDay, s.maxFine);
  return { days, billable, amount };
}

async function unpaidTotal(patronId) {
  const fines = await nosql.fines.findAsync({ patronId, status: 'unpaid' });
  return fines.reduce((t, f) => t + f.amount, 0);
}

/* ---------- loan views ---------- */
const LOAN_SELECT = `
  SELECT l.*, i.barcode, i.biblio_id, b.title, b.author, b.call_number
  FROM loans l JOIN items i ON i.id = l.item_id JOIN biblio b ON b.id = i.biblio_id`;

function decorateLoan(l, s = settings.get()) {
  const until = l.returned_at || new Date();
  const f = fineFor(l.due_at, until, s);
  return {
    id: l.id, barcode: l.barcode, biblioId: l.biblio_id, title: l.title, author: l.author,
    callNumber: l.call_number, patronId: l.patron_id, patronName: l.patron_name,
    outAt: l.out_at, dueAt: l.due_at, returnedAt: l.returned_at, renewals: l.renewals,
    overdue: !l.returned_at && f.days > 0, daysOverdue: f.days,
    accruedFine: l.returned_at ? 0 : f.amount,
    presumedLost: !l.returned_at && f.days >= s.lostAfterDays,
    canRenew: false,
  };
}
const openLoansFor = (patronId) =>
  sql.prepare(`${LOAN_SELECT} WHERE l.patron_id = ? AND l.returned_at IS NULL ORDER BY l.due_at`).all(patronId).map((l) => decorateLoan(l));
const historyFor = (patronId, limit = 30) =>
  sql.prepare(`${LOAN_SELECT} WHERE l.patron_id = ? AND l.returned_at IS NOT NULL ORDER BY l.returned_at DESC LIMIT ?`).all(patronId, limit).map((l) => decorateLoan(l));

/* ---------- holds ---------- */
async function pendingHolds(biblioId) {
  return nosql.holds.findAsync({ biblioId, status: { $in: ['pending', 'waiting'] } }).sort({ createdAt: 1 });
}
async function sweepHolds() {
  const now = new Date().toISOString();
  const expired = await nosql.holds.findAsync({ status: 'waiting', expiresAt: { $lt: now } });
  for (const h of expired) {
    await nosql.holds.updateAsync({ _id: h._id }, { $set: { status: 'expired' } });
    if (h.itemId) {
      sql.prepare(`UPDATE items SET status='available' WHERE id=? AND status='on_hold'`).run(h.itemId);
      await promoteNextHold(h.biblioId);
    }
  }
}
// Give a freshly freed item to the oldest pending hold, if any.
async function promoteNextHold(biblioId) {
  const next = await nosql.holds.findOneAsync({ biblioId, status: 'pending' }).sort({ createdAt: 1 });
  if (!next) return null;
  const item = sql.prepare(`SELECT * FROM items WHERE biblio_id=? AND status='available' ORDER BY id LIMIT 1`).get(biblioId);
  if (!item) return null;
  const s = settings.get();
  sql.prepare(`UPDATE items SET status='on_hold' WHERE id=?`).run(item.id);
  await nosql.holds.updateAsync({ _id: next._id }, { $set: {
    status: 'waiting', itemId: item.id, barcode: item.barcode,
    expiresAt: endOfDay(addDays(new Date(), s.holdWaitDays)).toISOString(),
  } });
  return { ...next, barcode: item.barcode };
}

/* ---------- checkout ---------- */
async function checkout({ staff, cardNumber, barcode, override = false }) {
  const s = settings.get();
  const patron = await nosql.users.findOneAsync({ cardNumber, role: 'student' });
  if (!patron) throw new HttpError(404, 'No student found with that card number');
  if (!patron.active) throw new HttpError(409, 'This student account is deactivated');

  const item = sql.prepare(`SELECT i.*, b.title FROM items i JOIN biblio b ON b.id=i.biblio_id WHERE i.barcode=?`).get(barcode);
  if (!item) throw new HttpError(404, 'No item with that barcode');

  const warnings = [];
  const myHold = await nosql.holds.findOneAsync({ patronId: patron._id, biblioId: item.biblio_id, status: { $in: ['pending', 'waiting'] } });

  if (item.status === 'checked_out') throw new HttpError(409, `“${item.title}” is already checked out`);
  if (['lost', 'withdrawn', 'repair'].includes(item.status)) throw new HttpError(409, `This copy is marked ${item.status.replace('_', ' ')}`);
  if (item.status === 'on_hold') {
    const waiting = await nosql.holds.findOneAsync({ itemId: item.id, status: 'waiting' });
    if (!waiting || waiting.patronId !== patron._id) throw new HttpError(409, 'This copy is on the hold shelf for another student');
  }

  const open = openLoansFor(patron._id);
  if (open.length >= s.maxLoans) throw new HttpError(409, `Loan limit reached (${s.maxLoans} books)`);
  if (open.some((l) => l.biblioId === item.biblio_id)) throw new HttpError(409, 'Student already has a copy of this title');

  const owed = await unpaidTotal(patron._id);
  if (owed >= s.blockCheckoutAtFines) {
    if (!override) throw new HttpError(409, `Unpaid fines of ${s.currency}${owed} block new loans`);
    warnings.push(`Fine block overridden (${s.currency}${owed} unpaid)`);
  }
  if (open.some((l) => l.overdue)) warnings.push('Student has overdue books');

  if (!myHold && item.status === 'available') {
    const queue = await pendingHolds(item.biblio_id);
    const free = sql.prepare(`SELECT COUNT(*) c FROM items WHERE biblio_id=? AND status='available'`).get(item.biblio_id).c;
    if (queue.filter((h) => h.status === 'pending').length >= free) {
      if (!override) throw new HttpError(409, 'Other students are waiting for this title');
      warnings.push('Hold queue overridden');
    }
  }

  const now = new Date();
  const due = endOfDay(addDays(now, s.loanDays));
  const info = sql.transaction(() => {
    sql.prepare(`UPDATE items SET status='checked_out' WHERE id=?`).run(item.id);
    return sql.prepare(`INSERT INTO loans (item_id,patron_id,patron_name,out_at,due_at,issued_by) VALUES (?,?,?,?,?,?)`)
      .run(item.id, patron._id, patron.name, now.toISOString(), due.toISOString(), staff.name);
  })();
  if (myHold) await nosql.holds.updateAsync({ _id: myHold._id }, { $set: { status: 'fulfilled', fulfilledAt: now.toISOString() } });
  return { loanId: info.lastInsertRowid, title: item.title, patron: patron.name, dueAt: due.toISOString(), warnings };
}

/* ---------- checkin ---------- */
async function checkin({ barcode }) {
  const row = sql.prepare(`${LOAN_SELECT} WHERE i.barcode=? AND l.returned_at IS NULL`).get(barcode);
  if (!row) {
    const it = sql.prepare(`SELECT status FROM items WHERE barcode=?`).get(barcode);
    if (!it) throw new HttpError(404, 'No item with that barcode');
    throw new HttpError(409, 'That item is not checked out');
  }
  const s = settings.get();
  const now = new Date();
  sql.transaction(() => {
    sql.prepare(`UPDATE loans SET returned_at=? WHERE id=?`).run(now.toISOString(), row.id);
    sql.prepare(`UPDATE items SET status='available' WHERE id=?`).run(row.item_id);
  })();

  let fine = null;
  const f = fineFor(row.due_at, now, s);
  if (f.amount > 0) {
    fine = await nosql.fines.insertAsync({
      patronId: row.patron_id, patronName: row.patron_name, loanId: row.id, kind: 'overdue',
      title: row.title, barcode, dueAt: row.due_at, returnedAt: now.toISOString(),
      daysOverdue: f.days, billableDays: f.billable, ratePerDay: s.finePerDay,
      amount: f.amount, status: 'unpaid', createdAt: now.toISOString(),
    });
  }
  const hold = await promoteNextHold(row.biblio_id);
  return {
    title: row.title, patron: row.patron_name, daysOverdue: f.days, fine,
    holdFor: hold ? { patronName: hold.patronName, barcode: hold.barcode, expiresAt: hold.expiresAt } : null,
  };
}

/* ---------- renew ---------- */
async function renew(loanId, { patronId } = {}) {
  const s = settings.get();
  const row = sql.prepare(`${LOAN_SELECT} WHERE l.id=? AND l.returned_at IS NULL`).get(loanId);
  if (!row || (patronId && row.patron_id !== patronId)) throw new HttpError(404, 'Loan not found');
  if (row.renewals >= s.maxRenewals) throw new HttpError(409, `Renewal limit reached (${s.maxRenewals})`);
  if (overdueDays(row.due_at, new Date()) > 0) throw new HttpError(409, 'Overdue books must be returned first');
  const others = (await pendingHolds(row.biblio_id)).filter((h) => h.patronId !== row.patron_id);
  if (others.length) throw new HttpError(409, 'Another student has reserved this title');
  const due = endOfDay(addDays(row.due_at, s.loanDays));
  sql.prepare(`UPDATE loans SET due_at=?, renewals=renewals+1 WHERE id=?`).run(due.toISOString(), loanId);
  return { title: row.title, dueAt: due.toISOString(), renewals: row.renewals + 1 };
}

async function annotateRenewable(loans) {
  const s = settings.get();
  for (const l of loans) {
    if (l.returnedAt) continue;
    const others = (await pendingHolds(l.biblioId)).filter((h) => h.patronId !== l.patronId);
    l.canRenew = !l.overdue && l.renewals < s.maxRenewals && others.length === 0;
    l.renewalsLeft = Math.max(0, s.maxRenewals - l.renewals);
  }
  return loans;
}

/* ---------- catalogue availability ---------- */
function availabilityMap(ids) {
  if (!ids.length) return {};
  const q = ids.map(() => '?').join(',');
  const rows = sql.prepare(`
    SELECT i.biblio_id id, COUNT(*) copies,
           SUM(i.status='available') available,
           MIN(CASE WHEN i.status='checked_out' THEN (SELECT due_at FROM loans WHERE item_id=i.id AND returned_at IS NULL) END) nextDue
    FROM items i WHERE i.biblio_id IN (${q}) AND i.status NOT IN ('withdrawn') GROUP BY i.biblio_id`).all(...ids);
  return Object.fromEntries(rows.map((r) => [r.id, { copies: r.copies, available: r.available || 0, nextDue: r.nextDue }]));
}

module.exports = {
  fineFor, overdueDays, unpaidTotal, decorateLoan, openLoansFor, historyFor, annotateRenewable,
  pendingHolds, sweepHolds, promoteNextHold, checkout, checkin, renew, availabilityMap, LOAN_SELECT,
};
