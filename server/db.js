'use strict';
/**
 * Two databases, on purpose:
 *   SQL   (SQLite)  -> the catalogue: bibliographic records, physical items, loans
 *   NoSQL (NeDB)    -> everything else: users, passkeys, sessions, settings,
 *                      holds, fines, audit trail, shelves
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+, nothing to compile
const Datastore = require('@seald-io/nedb');
const { DATA_DIR, SQL_FILENAME } = require('./config');

// ---------- SQL ----------
const raw = new DatabaseSync(path.join(DATA_DIR, SQL_FILENAME || 'catalogue.sqlite'));
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Small wrapper giving node:sqlite the prepare/exec/transaction shape the rest of the app uses.
const sql = {
  exec: (q) => raw.exec(q),
  prepare: (q) => raw.prepare(q),
  transaction: (fn) => (...args) => {
    raw.exec('BEGIN');
    try { const out = fn(...args); raw.exec('COMMIT'); return out; }
    catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
  },
};

sql.exec(`
CREATE TABLE IF NOT EXISTS biblio (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  author       TEXT NOT NULL DEFAULT '',
  isbn         TEXT NOT NULL DEFAULT '',
  publisher    TEXT NOT NULL DEFAULT '',
  year         INTEGER,
  language     TEXT NOT NULL DEFAULT 'English',
  subjects     TEXT NOT NULL DEFAULT '',          -- pipe separated: "Physics|Cosmology"
  call_number  TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_biblio_isbn ON biblio(isbn);

CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  biblio_id  INTEGER NOT NULL REFERENCES biblio(id) ON DELETE CASCADE,
  barcode    TEXT NOT NULL UNIQUE,
  location   TEXT NOT NULL DEFAULT 'Main Shelves',
  status     TEXT NOT NULL DEFAULT 'available'
             CHECK (status IN ('available','checked_out','on_hold','lost','withdrawn','repair')),
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_biblio ON items(biblio_id);

CREATE TABLE IF NOT EXISTS loans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  patron_id     TEXT NOT NULL,                    -- NoSQL user _id
  patron_name   TEXT NOT NULL,
  out_at        TEXT NOT NULL,
  due_at        TEXT NOT NULL,
  returned_at   TEXT,
  renewals      INTEGER NOT NULL DEFAULT 0,
  issued_by     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_loans_patron ON loans(patron_id);
CREATE INDEX IF NOT EXISTS idx_loans_open ON loans(returned_at);

CREATE VIRTUAL TABLE IF NOT EXISTS biblio_fts USING fts5(
  title, author, subjects, isbn, call_number, publisher, description,
  content='biblio', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS biblio_ai AFTER INSERT ON biblio BEGIN
  INSERT INTO biblio_fts(rowid,title,author,subjects,isbn,call_number,publisher,description)
  VALUES (new.id,new.title,new.author,new.subjects,new.isbn,new.call_number,new.publisher,new.description);
END;
CREATE TRIGGER IF NOT EXISTS biblio_ad AFTER DELETE ON biblio BEGIN
  INSERT INTO biblio_fts(biblio_fts,rowid,title,author,subjects,isbn,call_number,publisher,description)
  VALUES ('delete',old.id,old.title,old.author,old.subjects,old.isbn,old.call_number,old.publisher,old.description);
END;
CREATE TRIGGER IF NOT EXISTS biblio_au AFTER UPDATE ON biblio BEGIN
  INSERT INTO biblio_fts(biblio_fts,rowid,title,author,subjects,isbn,call_number,publisher,description)
  VALUES ('delete',old.id,old.title,old.author,old.subjects,old.isbn,old.call_number,old.publisher,old.description);
  INSERT INTO biblio_fts(rowid,title,author,subjects,isbn,call_number,publisher,description)
  VALUES (new.id,new.title,new.author,new.subjects,new.isbn,new.call_number,new.publisher,new.description);
END;
`);

// ---------- NoSQL ----------
const store = (name) =>
  new Datastore({ filename: path.join(DATA_DIR, `${name}.db`), autoload: true });

const nosql = {
  users: store('users'),         // students, librarians, admins (+ embedded passkeys)
  sessions: store('sessions'),
  challenges: store('challenges'),
  settings: store('settings'),
  holds: store('holds'),
  fines: store('fines'),
  audit: store('audit'),
  shelves: store('shelves'),     // per-student saved lists
};

async function initIndexes() {
  await nosql.users.ensureIndexAsync({ fieldName: 'username', unique: true });
  await nosql.users.ensureIndexAsync({ fieldName: 'cardNumber', unique: true, sparse: true });
  await nosql.sessions.ensureIndexAsync({ fieldName: 'expireAt', expireAfterSeconds: 0 });
  await nosql.challenges.ensureIndexAsync({ fieldName: 'expireAt', expireAfterSeconds: 0 });
  await nosql.holds.ensureIndexAsync({ fieldName: 'patronId' });
  await nosql.fines.ensureIndexAsync({ fieldName: 'patronId' });
}

module.exports = { sql, nosql, initIndexes };
