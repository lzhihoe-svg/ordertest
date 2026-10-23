const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'orders.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','customer')),
  name TEXT NOT NULL,
  company TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'pcs',
  base_price REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customer_prices (
  customer_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  price REAL NOT NULL,
  PRIMARY KEY (customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  invoice_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','confirmed','completed','delivered')),
  total REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  wetransfer_link TEXT DEFAULT '',
  payment_ref TEXT DEFAULT '',
  chk_artwork INTEGER NOT NULL DEFAULT 0,
  chk_product INTEGER NOT NULL DEFAULT 0,
  chk_payment INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  completed_at TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('artwork','receipt')),
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---- seed ----
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const ins = db.prepare(
    'INSERT INTO users (username, password_hash, role, name, company, phone) VALUES (?,?,?,?,?,?)'
  );
  ins.run('admin', bcrypt.hashSync('admin123', 10), 'admin', 'Administrator', 'Aramega Textile Sdn Bhd', '');
  ins.run('demo', bcrypt.hashSync('demo123', 10), 'customer', 'Demo Customer', 'Demo Trading Sdn Bhd', '012-3456789');
}

const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (productCount === 0) {
  const ins = db.prepare('INSERT INTO products (name, description, unit, base_price) VALUES (?,?,?,?)');
  ins.run('Cotton T-Shirt (Custom Print)', 'Full-colour custom printed cotton t-shirt', 'pcs', 25.0);
  ins.run('Microfiber Towel (Custom)', 'Custom dyed/printed microfiber towel', 'pcs', 12.5);
  ins.run('Tote Bag (Silkscreen)', 'Canvas tote bag with silkscreen print', 'pcs', 8.0);
  ins.run('Lanyard (Full Sublimation)', '20mm full sublimation lanyard with hook', 'pcs', 3.5);
  ins.run('Banner (Per Metre)', 'Heavy-duty printed fabric banner', 'metre', 45.0);
}

if (!db.prepare("SELECT value FROM settings WHERE key = 'invoice_seq'").get()) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('invoice_seq', '10000')").run();
}

function nextInvoiceNo() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'invoice_seq'").get();
  const next = parseInt(row.value, 10) + 1;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'invoice_seq'").run(String(next));
  return next;
}

// Price for a customer: customer-specific override, otherwise product base price.
function priceFor(customerId, productId) {
  const row = db
    .prepare('SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?')
    .get(customerId, productId);
  if (row) return row.price;
  return db.prepare('SELECT base_price FROM products WHERE id = ?').get(productId).base_price;
}

module.exports = { db, nextInvoiceNo, priceFor };
