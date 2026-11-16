'use strict';
/**
 * Demo data: npm run seed   (refuses to touch existing data unless --force)
 * Demo logins (all use the password below): admin, librarian, student
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const { sql, nosql, initIndexes } = require('./db');
const settings = require('./settings');
const A = require('./auth');
const { endOfDay, addDays } = require('./util');

const DEMO_PASSWORD = 'Library@2026';

const isbn13 = (n) => {
  const body = '97899' + String(n).padStart(7, '0');
  const sum = [...body].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
};

// title, author, year, publisher, language, subjects, call number, copies, description
const BOOKS = [
  ['Gitanjali', 'Rabindranath Tagore', 1910, 'Macmillan', 'English', 'Poetry|Indian Literature', '891.4 TAG', 2, 'A collection of devotional poems that carried Bengali verse to a worldwide audience.'],
  ['Wings of Fire', 'A. P. J. Abdul Kalam', 1999, 'Universities Press', 'English', 'Biography|Science|India', '629.1 KAL', 3, 'The life of a rocket scientist told through his years at ISRO and DRDO.'],
  ['Chemmeen', 'Thakazhi Sivasankara Pillai', 1956, 'DC Books', 'Malayalam', 'Fiction|Indian Literature|Kerala', 'M 894.8 THA', 2, 'A fishing-village love story on the Kerala coast, and a landmark of Malayalam fiction.'],
  ['Randamoozham', 'M. T. Vasudevan Nair', 1984, 'Current Books', 'Malayalam', 'Fiction|Indian Literature|Kerala', 'M 894.8 VAS', 2, 'The Mahabharata retold through the eyes of Bhima.'],
  ['The God of Small Things', 'Arundhati Roy', 1997, 'IndiaInk', 'English', 'Fiction|Kerala|Indian Literature', '823 ROY', 2, 'A family in Ayemenem and the small events that change its course.'],
  ['The Discovery of India', 'Jawaharlal Nehru', 1946, 'Signet Press', 'English', 'History|India|Politics', '954 NEH', 2, 'A reflective survey of India\'s past, written during imprisonment.'],
  ['Sapiens', 'Yuval Noah Harari', 2011, 'Harvill Secker', 'English', 'History|Anthropology', '909 HAR', 3, 'A sweeping account of how humans came to dominate the planet.'],
  ['A Brief History of Time', 'Stephen Hawking', 1988, 'Bantam', 'English', 'Physics|Cosmology|Science', '523.1 HAW', 3, 'The big bang, black holes and the nature of time for general readers.'],
  ['Clean Code', 'Robert C. Martin', 2008, 'Prentice Hall', 'English', 'Computer Science|Programming', '005.1 MAR', 3, 'Practical habits for writing software that other people can read and change.'],
  ['Introduction to Algorithms', 'Thomas H. Cormen et al.', 2009, 'MIT Press', 'English', 'Computer Science|Algorithms|Mathematics', '005.1 COR', 4, 'The standard university text on algorithm design and analysis.'],
  ['Python Crash Course', 'Eric Matthes', 2019, 'No Starch Press', 'English', 'Computer Science|Programming', '005.13 MAT', 3, 'A hands-on introduction to Python through three real projects.'],
  ['Artificial Intelligence: A Modern Approach', 'Stuart Russell, Peter Norvig', 2020, 'Pearson', 'English', 'Computer Science|Artificial Intelligence', '006.3 RUS', 2, 'A broad textbook covering search, learning, logic and language.'],
  ['Pride and Prejudice', 'Jane Austen', 1813, 'T. Egerton', 'English', 'Fiction|Classics', '823 AUS', 2, 'Manners, money and misjudgement in Regency England.'],
  ['Nineteen Eighty-Four', 'George Orwell', 1949, 'Secker & Warburg', 'English', 'Fiction|Classics|Politics', '823 ORW', 2, 'A bleak vision of surveillance and the manipulation of truth.'],
  ['To Kill a Mockingbird', 'Harper Lee', 1960, 'J. B. Lippincott', 'English', 'Fiction|Classics', '813 LEE', 2, 'A child\'s view of justice and prejudice in a small Southern town.'],
  ['The Alchemist', 'Paulo Coelho', 1988, 'HarperCollins', 'English', 'Fiction|Philosophy', '869 COE', 3, 'A shepherd travels toward a treasure and learns what he was really after.'],
  ['Atomic Habits', 'James Clear', 2018, 'Avery', 'English', 'Self Help|Psychology', '158.1 CLE', 3, 'How very small changes in routine add up to large results.'],
  ['Thinking, Fast and Slow', 'Daniel Kahneman', 2011, 'Farrar, Straus and Giroux', 'English', 'Psychology|Economics', '153.4 KAH', 2, 'Two modes of thought and the mistakes each one makes.'],
  ['The Selfish Gene', 'Richard Dawkins', 1976, 'Oxford University Press', 'English', 'Biology|Science', '576.5 DAW', 2, 'Evolution seen from the point of view of genes.'],
  ['Cosmos', 'Carl Sagan', 1980, 'Random House', 'English', 'Astronomy|Science', '520 SAG', 2, 'A tour of the universe and of how we came to understand it.'],
  ['Feynman Lectures on Physics, Vol. 1', 'Richard P. Feynman', 1963, 'Addison-Wesley', 'English', 'Physics|Science', '530 FEY', 2, 'Mechanics, radiation and heat from a famously clear teacher.'],
  ['Concepts of Physics, Part 1', 'H. C. Verma', 1992, 'Bharati Bhawan', 'English', 'Physics|Science', '530 VER', 4, 'A problem-rich physics text widely used for entrance preparation.'],
  ['Higher Engineering Mathematics', 'B. S. Grewal', 1965, 'Khanna Publishers', 'English', 'Mathematics|Engineering', '510 GRE', 4, 'Core mathematics for engineering students: calculus, algebra and transforms.'],
  ['Principles of Economics', 'N. Gregory Mankiw', 1997, 'Cengage', 'English', 'Economics', '330 MAN', 3, 'A clear introduction to micro and macroeconomics.'],
  ['The Wealth of Nations', 'Adam Smith', 1776, 'W. Strahan', 'English', 'Economics|Classics', '330.153 SMI', 1, 'The founding work of classical economics.'],
  ['Indian Polity', 'M. Laxmikanth', 1998, 'McGraw Hill', 'English', 'Politics|India|Law', '320.954 LAX', 4, 'The Indian constitution and political system, chapter by chapter.'],
  ['Mathilukal', 'Vaikom Muhammad Basheer', 1965, 'DC Books', 'Malayalam', 'Fiction|Indian Literature|Kerala', 'M 894.8 BAS', 2, 'A prison love story told through a wall, and Basheer\'s gentle humour.'],
  ['Khasakkinte Itihasam', 'O. V. Vijayan', 1969, 'DC Books', 'Malayalam', 'Fiction|Indian Literature|Kerala', 'M 894.8 VIJ', 2, 'A young man arrives in a village and the legend of Khasak unfolds.'],
  ['Balyakalasakhi', 'Vaikom Muhammad Basheer', 1944, 'DC Books', 'Malayalam', 'Fiction|Indian Literature|Kerala', 'M 894.8 BAS', 2, 'Childhood friends and the cost of a love that cannot be spoken.'],
  ['Mahabharata (Abridged)', 'C. Rajagopalachari', 1951, 'Bharatiya Vidya Bhavan', 'English', 'Epics|Indian Literature|Mythology', '294.5 RAJ', 2, 'A compact retelling of the great epic.'],
  ['Arthashastra', 'Kautilya, tr. R. Shamasastry', 1915, 'Government Press, Mysore', 'English', 'Politics|History|India', '320.1 KAU', 1, 'The ancient treatise on statecraft, economy and strategy.'],
  ['The Immortals of Meluha', 'Amish Tripathi', 2010, 'Westland', 'English', 'Fiction|Mythology', '823 TRI', 2, 'Shiva\'s story reimagined as historical fantasy.'],
  ['Discrete Mathematics and Its Applications', 'Kenneth H. Rosen', 2011, 'McGraw Hill', 'English', 'Mathematics|Computer Science', '511 ROS', 3, 'Logic, proofs, graphs and counting for computing students.'],
  ['Operating System Concepts', 'Silberschatz, Galvin, Gagne', 2018, 'Wiley', 'English', 'Computer Science|Operating Systems', '005.43 SIL', 3, 'Processes, memory, storage and security in modern operating systems.'],
  ['Database System Concepts', 'Silberschatz, Korth, Sudarshan', 2019, 'McGraw Hill', 'English', 'Computer Science|Databases', '005.74 SIL', 3, 'Relational design, SQL, transactions and storage engines.'],
  ['Computer Networking: A Top-Down Approach', 'Kurose, Ross', 2021, 'Pearson', 'English', 'Computer Science|Networks', '004.6 KUR', 2, 'The internet explained layer by layer, from applications down.'],
  ['Cryptography and Network Security', 'William Stallings', 2016, 'Pearson', 'English', 'Computer Science|Security', '005.8 STA', 2, 'Ciphers, hashing, authentication and the protocols built on them.'],
  ['Hands-On Machine Learning', 'Aurélien Géron', 2022, 'O\'Reilly', 'English', 'Computer Science|Artificial Intelligence', '006.31 GER', 2, 'Building learning systems with Scikit-Learn and neural networks.'],
  ['Organic Chemistry', 'Morrison and Boyd', 1959, 'Prentice Hall', 'English', 'Chemistry|Science', '547 MOR', 2, 'The classic textbook on structure and reaction in carbon compounds.'],
  ['Biology: Concepts and Connections', 'Campbell et al.', 2015, 'Pearson', 'English', 'Biology|Science', '570 CAM', 2, 'A broad introduction to cells, genetics, evolution and ecology.'],
  ['The Story of Philosophy', 'Will Durant', 1926, 'Simon & Schuster', 'English', 'Philosophy|History', '109 DUR', 2, 'Great thinkers from Plato to Dewey, told as biography.'],
  ['Meditations', 'Marcus Aurelius', 180, 'Penguin Classics', 'English', 'Philosophy|Classics', '188 MAR', 2, 'Private notes on duty, temperance and living with what you cannot control.'],
  ['Letters to a Young Poet', 'Rainer Maria Rilke', 1929, 'Insel Verlag', 'English', 'Poetry|Letters', '831 RIL', 2, 'Ten letters of advice on solitude, patience and writing.'],
  ['Kerala: A Cultural History', 'A. Sreedhara Menon', 1967, 'DC Books', 'English', 'History|Kerala|Culture', '954.83 MEN', 2, 'A survey of Kerala from early trade to modern society.'],
];

async function seed(options = {}) {
  const { force = false, quiet = false } = options;
  await initIndexes();
  await settings.load();

  // If force is requested and files exist, clean them
  if (force) {
    try {
      await sql.exec('DELETE FROM loans; DELETE FROM items; DELETE FROM biblio;');
      await nosql.users.removeAsync({}, { multi: true });
      await nosql.holds.removeAsync({}, { multi: true });
      await nosql.fines.removeAsync({}, { multi: true });
      await nosql.sessions.removeAsync({}, { multi: true });
      await nosql.challenges.removeAsync({}, { multi: true });
    } catch (e) {
      // Ignore if table doesn't exist yet
    }
  }

  const mk = async (o) => nosql.users.insertAsync({
    passHash: await A.hashPassword(DEMO_PASSWORD), mustChangePassword: false, active: true, passkeys: [],
    createdAt: new Date().toISOString(), ...o,
  });
  await mk({ role: 'admin', name: 'Library Admin', username: 'admin', email: 'admin@example.org' });
  await mk({ role: 'librarian', name: 'Fathima Rahman', username: 'librarian', email: 'librarian@example.org' });

  const STUDENTS = [
    ['Aisha Noor', 'student', 'BSc Computer Science', 'Year 2'], ['Mohammed Fayiz', 'fayiz', 'BA English', 'Year 3'],
    ['Nandana Menon', 'nandana', 'BSc Physics', 'Year 1'], ['Rahul Krishnan', 'rahul', 'BCom Finance', 'Year 2'],
    ['Safa Abdulla', 'safa', 'BA Economics', 'Year 3'], ['Anjali Varma', 'anjali', 'BSc Chemistry', 'Year 1'],
    ['Irfan Basheer', 'irfan', 'BCA', 'Year 2'], ['Devika Nair', 'devika', 'BA Malayalam', 'Year 2'],
    ['Yusuf Ali', 'yusuf', 'BSc Mathematics', 'Year 3'], ['Meera Pillai', 'meera', 'BBA', 'Year 1'],
    ['Hiba Fathima', 'hiba', 'BSc Biology', 'Year 2'], ['Arjun Das', 'arjun', 'BSc Computer Science', 'Year 3'],
  ];
  const students = [];
  for (const [i, [name, username, department, className]] of STUDENTS.entries()) {
    students.push(await mk({ role: 'student', name, username, cardNumber: `S2026${String(i + 1).padStart(4, '0')}`, department, className, email: `${username}@example.org` }));
  }

  const insB = sql.prepare(`INSERT INTO biblio (title,author,isbn,publisher,year,language,subjects,call_number,description) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insI = sql.prepare(`INSERT INTO items (biblio_id,barcode,location) VALUES (?,?,?)`);
  let n = 0, bc = 0;
  const locs = ['Main Shelves', 'Reference', 'Malayalam Section', 'Science Wing'];
  for (const b of BOOKS) {
    const res = await insB.run(b[0], b[1], isbn13(++n), b[3], b[2], b[4], b[5], b[6], b[8]);
    const id = res.lastInsertRowid;
    for (let c = 0; c < b[7]; c++) {
      await insI.run(id, 'B' + String(++bc).padStart(6, '0'), b[4] === 'Malayalam' ? locs[2] : /Science|Physics|Chemistry|Biology/.test(b[5]) ? locs[3] : locs[0]);
    }
  }

  // Loans with back-dated dates so the desk shows realistic activity.
  const s = settings.get();
  const lend = async (stu, title, daysAgo, returnedDaysAgo) => {
    const item = await sql.prepare(`SELECT i.id FROM items i JOIN biblio b ON b.id=i.biblio_id WHERE b.title=? AND i.status='available' LIMIT 1`).get(title);
    if (!item) return;
    const out = addDays(new Date(), -daysAgo), due = endOfDay(addDays(out, s.loanDays));
    const ret = returnedDaysAgo == null ? null : addDays(new Date(), -returnedDaysAgo).toISOString();
    await sql.prepare(`INSERT INTO loans (item_id,patron_id,patron_name,out_at,due_at,returned_at,issued_by) VALUES (?,?,?,?,?,?,?)`)
      .run(item.id, stu._id, stu.name, out.toISOString(), due.toISOString(), ret, 'Fathima Rahman');
    if (!ret) await sql.prepare(`UPDATE items SET status='checked_out' WHERE id=?`).run(item.id);
  };
  await lend(students[0], 'Clean Code', 5); await lend(students[0], 'Atomic Habits', 20);           // one overdue (6 days)
  await lend(students[0], 'Wings of Fire', 40, 30);
  await lend(students[1], 'Pride and Prejudice', 3); await lend(students[1], 'Nineteen Eighty-Four', 27); // overdue 13
  await lend(students[2], 'Cosmos', 10); await lend(students[2], 'A Brief History of Time', 12);
  await lend(students[3], 'Principles of Economics', 8); await lend(students[4], 'The Wealth of Nations', 15); // overdue 1 (inside grace)
  await lend(students[5], 'Organic Chemistry', 2); await lend(students[6], 'Operating System Concepts', 6);
  await lend(students[6], 'Database System Concepts', 6); await lend(students[7], 'Chemmeen', 11);
  await lend(students[8], 'Discrete Mathematics and Its Applications', 1); await lend(students[11], 'Hands-On Machine Learning', 4);
  await lend(students[11], 'Hands-On Machine Learning', 5);
  await lend(students[10], 'The Selfish Gene', 19, 9);

  const fine = (stu, title, days, status = 'unpaid') => nosql.fines.insertAsync({
    patronId: stu._id, patronName: stu.name, loanId: 0, kind: 'overdue', title, barcode: '', dueAt: addDays(new Date(), -days - 3).toISOString(),
    returnedAt: addDays(new Date(), -3).toISOString(), daysOverdue: days, billableDays: Math.max(0, days - s.graceDays), ratePerDay: s.finePerDay,
    amount: Math.min(Math.max(0, days - s.graceDays) * s.finePerDay, s.maxFine), status, createdAt: addDays(new Date(), -3).toISOString(),
    ...(status === 'paid' ? { paidAt: addDays(new Date(), -2).toISOString(), receivedBy: 'Fathima Rahman' } : {}),
  });
  await fine(students[3], 'Indian Polity', 9); await fine(students[1], 'The Alchemist', 16);
  await fine(students[4], 'Cosmos', 5, 'paid'); await fine(students[2], 'Sapiens', 4);

  const hold = async (stu, title) => {
    const b = await sql.prepare('SELECT id FROM biblio WHERE title=?').get(title);
    return nosql.holds.insertAsync({ patronId: stu._id, patronName: stu.name, biblioId: b.id, status: 'pending', createdAt: new Date().toISOString() });
  };
  await hold(students[3], 'Hands-On Machine Learning'); await hold(students[9], 'Hands-On Machine Learning');

  if (!quiet) {
    console.log(`Seeded ${BOOKS.length} titles, ${bc} copies, ${students.length} students.`);
    console.log(`Demo logins (password ${DEMO_PASSWORD}):\n  admin / librarian / student (card S20260001)`);
  }
}

if (require.main === module) {
  const existing = fs.readdirSync(cfg.DATA_DIR).filter((f) => /\.(db|sqlite)/.test(f));
  if (existing.length && !process.argv.includes('--force')) {
    console.error('Data already exists in ' + cfg.DATA_DIR + '.\nRun "npm run seed -- --force" to wipe it and load demo data.');
    process.exit(1);
  }
  existing.forEach((f) => {
    try { fs.rmSync(path.join(cfg.DATA_DIR, f), { force: true }); } catch (_) {}
  });
  seed({ force: true }).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  module.exports = { seed, DEMO_PASSWORD };
}
