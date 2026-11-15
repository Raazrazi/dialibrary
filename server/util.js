'use strict';
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function str(v, { max = 200, min = 0, name = 'value' } = {}) {
  if (typeof v !== 'string') v = v == null ? '' : String(v);
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (v.length < min) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is too long (max ${max})`);
  return v;
}
function int(v, { min = 0, max = 1e9, name = 'value', def } = {}) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}`);
  return n;
}
const DAY = 86400000;
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 0, 0); return x; };
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);

module.exports = { HttpError, bad, wrap, str, int, DAY, endOfDay, addDays };
