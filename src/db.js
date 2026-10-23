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
  address TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'pcs',
  base_price REAL NOT NULL DEFAULT 0,
  moq INTEGER NOT NULL DEFAULT 1,
  artwork_spec TEXT DEFAULT '',
  template_stored TEXT DEFAULT '',
  template_name TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS price_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  min_qty INTEGER NOT NULL,
  price REAL NOT NULL
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
    CHECK (status IN ('submitted','needs_revision','confirmed','completed','delivered','cancelled')),
  subtotal REAL NOT NULL DEFAULT 0,
  is_express INTEGER NOT NULL DEFAULT 0,
  express_percent REAL NOT NULL DEFAULT 0,
  express_amount REAL NOT NULL DEFAULT 0,
  sst_percent REAL NOT NULL DEFAULT 0,
  sst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  credit_applied REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  wetransfer_link TEXT DEFAULT '',
  payment_ref TEXT DEFAULT '',
  delivery_method TEXT NOT NULL DEFAULT 'pickup' CHECK (delivery_method IN ('pickup','courier')),
  delivery_address TEXT DEFAULT '',
  tracking_no TEXT DEFAULT '',
  needed_by TEXT DEFAULT '',
  eta_date TEXT DEFAULT '',
  cancel_reason TEXT DEFAULT '',
  revision_reason TEXT DEFAULT '',
  proof_status TEXT NOT NULL DEFAULT '' CHECK (proof_status IN ('','pending','approved','changes')),
  proof_note TEXT DEFAULT '',
  proof_decided_at TEXT,
  quote_id INTEGER REFERENCES quotes(id),
  refund_status TEXT NOT NULL DEFAULT '' CHECK (refund_status IN ('','refunded','credited')),
  refund_ref TEXT DEFAULT '',
  refund_note TEXT DEFAULT '',
  refund_resolved_at TEXT,
  chk_artwork INTEGER NOT NULL DEFAULT 0,
  chk_product INTEGER NOT NULL DEFAULT 0,
  chk_payment INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  completed_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  ref_link TEXT DEFAULT '',
  needed_by TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','quoted','accepted','declined')),
  valid_until TEXT DEFAULT '',
  admin_note TEXT DEFAULT '',
  decline_reason TEXT DEFAULT '',
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  quoted_at TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id),
  description TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  qty INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  quote_id INTEGER REFERENCES quotes(id),
  kind TEXT NOT NULL CHECK (kind IN ('artwork','receipt','delivery','proof','quote_ref')),
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount REAL NOT NULL,
  bank_ref TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  source TEXT NOT NULL DEFAULT 'customer' CHECK (source IN ('customer','admin')),
  file_id INTEGER REFERENCES files(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  event TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---- lightweight migrations for databases created before these columns existed ----
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'address', "address TEXT DEFAULT ''");
ensureColumn('products', 'moq', 'moq INTEGER NOT NULL DEFAULT 1');
ensureColumn('products', 'artwork_spec', "artwork_spec TEXT DEFAULT ''");
ensureColumn('products', 'template_stored', "template_stored TEXT DEFAULT ''");
ensureColumn('products', 'template_name', "template_name TEXT DEFAULT ''");
ensureColumn('orders', 'subtotal', 'subtotal REAL NOT NULL DEFAULT 0');
ensureColumn('orders', 'is_express', 'is_express INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'express_percent', 'express_percent REAL NOT NULL DEFAULT 0');
ensureColumn('orders', 'express_amount', 'express_amount REAL NOT NULL DEFAULT 0');
ensureColumn('orders', 'sst_percent', 'sst_percent REAL NOT NULL DEFAULT 0');
ensureColumn('orders', 'sst_amount', 'sst_amount REAL NOT NULL DEFAULT 0');
ensureColumn('orders', 'credit_applied', 'credit_applied REAL NOT NULL DEFAULT 0');
ensureColumn('orders', 'delivery_method', "delivery_method TEXT NOT NULL DEFAULT 'pickup'");
ensureColumn('orders', 'delivery_address', "delivery_address TEXT DEFAULT ''");
ensureColumn('orders', 'tracking_no', "tracking_no TEXT DEFAULT ''");
ensureColumn('orders', 'needed_by', "needed_by TEXT DEFAULT ''");
ensureColumn('orders', 'eta_date', "eta_date TEXT DEFAULT ''");
ensureColumn('orders', 'cancel_reason', "cancel_reason TEXT DEFAULT ''");
ensureColumn('orders', 'cancelled_at', 'cancelled_at TEXT');
ensureColumn('orders', 'revision_reason', "revision_reason TEXT DEFAULT ''");
ensureColumn('orders', 'proof_status', "proof_status TEXT NOT NULL DEFAULT ''");
ensureColumn('orders', 'proof_note', "proof_note TEXT DEFAULT ''");
ensureColumn('orders', 'proof_decided_at', 'proof_decided_at TEXT');
ensureColumn('orders', 'quote_id', 'quote_id INTEGER REFERENCES quotes(id)');
ensureColumn('orders', 'refund_status', "refund_status TEXT NOT NULL DEFAULT ''");
ensureColumn('orders', 'refund_ref', "refund_ref TEXT DEFAULT ''");
ensureColumn('orders', 'refund_note', "refund_note TEXT DEFAULT ''");
ensureColumn('orders', 'refund_resolved_at', 'refund_resolved_at TEXT');
ensureColumn('files', 'quote_id', 'quote_id INTEGER REFERENCES quotes(id)');

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
  const ins = db.prepare(
    'INSERT INTO products (name, description, unit, base_price, moq, artwork_spec) VALUES (?,?,?,?,?,?)'
  );
  const tier = db.prepare('INSERT INTO price_tiers (product_id, min_qty, price) VALUES (?,?,?)');
  let r;
  r = ins.run('Cotton T-Shirt (Custom Print)', 'Full-colour custom printed cotton t-shirt', 'pcs', 25.0, 10,
    'AI/PDF vector or 300dpi PNG, include size breakdown in notes');
  tier.run(r.lastInsertRowid, 50, 22.5);
  tier.run(r.lastInsertRowid, 100, 19.9);
  r = ins.run('Microfiber Towel (Custom)', 'Custom dyed/printed microfiber towel', 'pcs', 12.5, 20,
    '300dpi PNG or AI file, full-bleed with 3mm margin');
  tier.run(r.lastInsertRowid, 100, 11.0);
  r = ins.run('Tote Bag (Silkscreen)', 'Canvas tote bag with silkscreen print', 'pcs', 8.0, 50,
    'Vector AI/PDF only (silkscreen), max 3 colours');
  tier.run(r.lastInsertRowid, 200, 7.0);
  r = ins.run('Lanyard (Full Sublimation)', '20mm full sublimation lanyard with hook', 'pcs', 3.5, 100,
    'AI template available on request, text converted to outlines');
  tier.run(r.lastInsertRowid, 500, 3.0);
  tier.run(r.lastInsertRowid, 1000, 2.6);
  r = ins.run('Banner (Per Metre)', 'Heavy-duty printed fabric banner', 'metre', 45.0, 1,
    '300dpi JPG/PDF at actual size');
}

function setting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
if (!db.prepare("SELECT value FROM settings WHERE key = 'invoice_seq'").get()) {
  setSetting('invoice_seq', '10000');
}
if (setting('quote_seq', null) === null) setSetting('quote_seq', '5000');
if (setting('sst_percent', null) === null) setSetting('sst_percent', '0');
if (setting('lead_days', null) === null) setSetting('lead_days', '3');
if (setting('whatsapp', null) === null) setSetting('whatsapp', '');
if (setting('deposit_percent', null) === null) setSetting('deposit_percent', '50');
if (setting('express_percent', null) === null) setSetting('express_percent', '20');
if (setting('express_lead_days', null) === null) setSetting('express_lead_days', '1');

function nextInvoiceNo() {
  const next = parseInt(setting('invoice_seq', '10000'), 10) + 1;
  setSetting('invoice_seq', next);
  return next;
}
function nextQuoteNo() {
  const next = parseInt(setting('quote_seq', '5000'), 10) + 1;
  setSetting('quote_seq', next);
  return `QUO-${next}`;
}

function tiersFor(productId) {
  return db
    .prepare('SELECT min_qty, price FROM price_tiers WHERE product_id = ? ORDER BY min_qty')
    .all(productId);
}

// Unit price for a customer at a given quantity:
// 1. a customer-specific price set by admin always wins (flat, any qty);
// 2. otherwise the best quantity tier the qty reaches;
// 3. otherwise the product base price.
function priceFor(customerId, productId, qty) {
  const override = db
    .prepare('SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?')
    .get(customerId, productId);
  if (override) return override.price;
  const q = Math.max(1, qty || 1);
  let price = db.prepare('SELECT base_price FROM products WHERE id = ?').get(productId).base_price;
  for (const t of tiersFor(productId)) {
    if (q >= t.min_qty) price = t.price;
  }
  return price;
}

// Verified money on an order: verified bank payments + store credit applied at submission.
function paidFor(order) {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE order_id = ? AND status = 'verified'")
    .get(order.id);
  return Math.round((row.s + (order.credit_applied || 0)) * 100) / 100;
}

function creditBalance(customerId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM credits WHERE customer_id = ?').get(customerId);
  return Math.round(row.s * 100) / 100;
}

function logEvent(orderId, actor, event, note) {
  db.prepare('INSERT INTO status_log (order_id, actor_name, actor_role, event, note) VALUES (?,?,?,?,?)')
    .run(orderId, actor.name, actor.role, event, note || '');
}

module.exports = {
  db, nextInvoiceNo, nextQuoteNo, priceFor, tiersFor, setting, setSetting,
  paidFor, creditBalance, logEvent,
};
