'use strict';
const { nosql } = require('./db');

const DEFAULTS = {
  libraryName: 'Crimson Page Library',
  tagline: 'Every shelf, one gentle search away.',
  currency: '₹',
  loanDays: 14,            // loan period
  maxRenewals: 2,
  graceDays: 1,            // days late before a fine starts
  finePerDay: 2,           // fine for each billable overdue day
  maxFine: 200,            // cap per item
  lostAfterDays: 30,       // overdue this long = presumed lost
  lostCharge: 300,         // charge when an item is marked lost
  blockCheckoutAtFines: 100, // unpaid fines at or above this block new loans
  maxLoans: 5,
  maxHolds: 3,
  holdWaitDays: 5,         // days a held book waits on the hold shelf
  publicSearch: true,      // anyone may search the catalogue without signing in
};

let cache = null;

async function load() {
  const doc = await nosql.settings.findOneAsync({ _id: 'main' });
  cache = { ...DEFAULTS, ...(doc ? doc.values : {}) };
  return cache;
}
const get = () => cache || { ...DEFAULTS };

async function update(patch) {
  const next = { ...get(), ...patch };
  await nosql.settings.updateAsync({ _id: 'main' }, { _id: 'main', values: next }, { upsert: true });
  cache = next;
  return next;
}

module.exports = { DEFAULTS, load, get, update };
