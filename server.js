const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const {
  db, nextInvoiceNo, nextQuoteNo, randomOrderNo, priceFor, tiersFor, setting, setSetting,
  paidFor, creditBalance, logEvent, touchOrder,
} = require('./src/db');
const V = require('./src/views');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Persist a session secret across restarts.
const secretFile = path.join(__dirname, 'data', 'session-secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(secretFile, 'utf8');

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
  })
);

// ---------- helpers ----------

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.userId) || null;
}

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}
function popFlash(req) {
  const f = req.session.flash;
  delete req.session.flash;
  return f;
}

function requireCustomer(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  if (user.role !== 'customer') return res.redirect('/admin');
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  if (user.role !== 'admin') return res.redirect('/');
  req.user = user;
  next();
}

function getOrder(id) {
  return db
    .prepare(
      `SELECT o.*, u.name AS customer_name, u.company AS customer_company,
              u.phone AS customer_phone, u.username AS customer_username
       FROM orders o JOIN users u ON u.id = o.customer_id WHERE o.id = ?`
    )
    .get(id);
}
function getItems(orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
}
function getFiles(orderId, kind) {
  return db.prepare('SELECT * FROM files WHERE order_id = ? AND kind = ? ORDER BY id DESC').all(orderId, kind);
}
function getComments(orderId) {
  return db.prepare('SELECT * FROM comments WHERE order_id = ? ORDER BY id').all(orderId);
}
function getPayments(orderId) {
  return db
    .prepare(`SELECT p.*, f.original_name AS file_name, f.id AS file_id2
              FROM payments p LEFT JOIN files f ON f.id = p.file_id
              WHERE p.order_id = ? ORDER BY p.id`)
    .all(orderId);
}
function getLog(orderId) {
  return db.prepare('SELECT * FROM status_log WHERE order_id = ? ORDER BY id').all(orderId);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Validate a promo code; returns {promo} or {error}.
function checkPromo(code) {
  if (!code) return { promo: null };
  const p = db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(code);
  if (!p || !p.active) return { error: 'That promo code is not valid.' };
  if (p.expires && p.expires < klDatePlus(0)) return { error: 'That promo code has expired.' };
  if (p.max_uses > 0 && p.used_count >= p.max_uses) return { error: 'That promo code has been fully used.' };
  return { promo: p };
}

// Rule: full payment must be VERIFIED within 3 hours of submission or the order
// is cancelled automatically. Orders with a payment still awaiting verification
// are spared so a slow admin check never cancels a customer who already paid.
function sweepUnpaidOrders() {
  const SYSTEM = { name: 'System', role: 'admin' };
  const candidates = db
    .prepare(`SELECT * FROM orders WHERE status = 'submitted'
              AND datetime(created_at) <= datetime('now', '-3 hours')`)
    .all();
  for (const o of candidates) {
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'pending'")
      .get(o.id).n;
    if (pending > 0) continue;
    if (paidFor(o) + 0.005 >= o.total) continue;
    db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now'),
                cancel_reason = 'Full payment was not verified within 3 hours of submission (automatic cancellation)'
                WHERE id = ?`).run(o.id);
    logEvent(o.id, SYSTEM, 'cancelled', 'Automatic: full payment not verified within 3 hours');
  }
}
setInterval(sweepUnpaidOrders, 10 * 60 * 1000);
sweepUnpaidOrders();

// Today in Kuala Lumpur as YYYY-MM-DD, plus N days.
function klDatePlus(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
}
function fmtDay(iso) {
  if (!iso) return '-';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function sanitizeName(name) {
  return String(name).replace(/[^\w.\- ()]/g, '_').slice(-120);
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizeName(file.originalname)}`),
});

const uploadArtwork = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => {
    if (/\.zip$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Artwork must be a .zip file (max 500MB).'));
  },
}).single('artwork');

const docFilter = (req, file, cb) => {
  if (/\.(pdf|jpe?g|png|webp)$/i.test(file.originalname)) return cb(null, true);
  cb(new Error('File must be a PDF or image (pdf, jpg, png, webp).'));
};
const uploadReceipt = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: docFilter }).single('receipt');
const uploadDelivery = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: docFilter }).single('proof');
const uploadTemplate = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    if (/\.(zip|pdf|ai|psd|jpe?g|png)$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Template must be zip, pdf, ai, psd or image (max 50MB).'));
  },
}).single('template');

function runUpload(middleware) {
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (err) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'File is too large. Artwork zip max 500MB, documents max 20MB.'
            : err.message || 'Upload failed.';
        flash(req, 'error', msg);
        return res.redirect(req.get('referer') || '/');
      }
      next();
    });
}

function render(req, res, opts) {
  res.send(V.layout({ flash: popFlash(req), whatsapp: setting('whatsapp', ''), ...opts }));
}

const fileCard = (f) => `
  <li class="file-row">
    <a href="/files/${f.id}" class="file-link">&#128206; ${V.esc(f.original_name)}</a>
    <span class="muted">${f.size >= 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(2) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'} &middot; ${V.esc(V.fmtDate(f.uploaded_at))}</span>
  </li>`;

const payChip = (s) =>
  s === 'verified' ? '<span class="badge badge-completed">Verified</span>'
  : s === 'rejected' ? '<span class="badge badge-cancelled">Rejected</span>'
  : '<span class="badge badge-submitted">Pending Review</span>';

function paymentSummary(order) {
  const paid = paidFor(order);
  const balance = round2(order.total - paid);
  return `<div class="pay-summary">
    <div><span class="muted small">Order Total</span><strong>${V.rm(order.total)}</strong></div>
    ${order.credit_applied > 0 ? `<div><span class="muted small">Store Credit Applied</span><strong>${V.rm(order.credit_applied)}</strong></div>` : ''}
    <div><span class="muted small">Paid (verified)</span><strong>${V.rm(paid)}</strong></div>
    <div class="${balance > 0 ? 'pay-due' : 'pay-ok'}"><span class="muted small">Balance Due</span><strong>${V.rm(Math.max(balance, 0))}</strong></div>
  </div>
  ${(order.status === 'submitted' || order.status === 'needs_revision') && balance > 0
    ? '<p class="muted small"><strong>Full payment is required before the order can be confirmed.</strong></p>' : ''}`;
}

function paymentsList(order, { isAdmin }) {
  const payments = getPayments(order.id);
  if (!payments.length) return '<p class="muted">No payments recorded yet.</p>';
  return `<ul class="pay-list">${payments
    .map(
      (p) => `<li class="pay-row">
      <div class="pay-row-main">
        <strong>${V.rm(p.amount)}</strong> ${payChip(p.status)}
        <span class="muted small">${V.esc(V.fmtDate(p.created_at))}${p.source === 'admin' ? ' &middot; recorded by admin' : ''}</span>
      </div>
      <div class="muted small">
        ${p.bank_ref ? `Ref: <strong>${V.esc(p.bank_ref)}</strong> ` : ''}
        ${p.file_id ? `&middot; <a href="/files/${p.file_id}">receipt file</a>` : ''}
        ${p.note ? `&middot; ${V.esc(p.note)}` : ''}
      </div>
      ${isAdmin && p.status === 'pending' ? `
      <div class="pay-actions">
        <form method="post" action="/admin/orders/${order.id}/payments/${p.id}/verify" class="inline-form">
          <button class="btn btn-primary btn-sm" type="submit">Verify Payment</button>
        </form>
        <form method="post" action="/admin/orders/${order.id}/payments/${p.id}/reject" class="inline-form">
          <input name="note" placeholder="Reason (shown to customer)" required>
          <button class="btn btn-danger btn-sm" type="submit">Reject</button>
        </form>
      </div>` : ''}
    </li>`
    )
    .join('')}</ul>`;
}

function historySection(order) {
  const log = getLog(order.id);
  if (!log.length) return '';
  const EVENTS = {
    submitted: 'Order submitted', resubmitted: 'Order resubmitted after revision',
    revision_requested: 'Revision requested', confirmed: 'Order confirmed',
    completed: 'Order marked complete', delivered: 'Order delivered',
    cancelled: 'Order cancelled', payment_submitted: 'Payment submitted',
    payment_recorded: 'Payment recorded', payment_verified: 'Payment verified',
    payment_rejected: 'Payment rejected', refund_resolved: 'Payment resolution',
    delivery_proof: 'Delivery proof uploaded',
  };
  return `
  <div class="card">
    <h2>Order History</h2>
    <ul class="history-list">${log
      .map(
        (l) => `<li><span class="muted small">${V.esc(V.fmtDate(l.created_at))}</span>
        <strong>${V.esc(EVENTS[l.event] || l.event)}</strong>
        <span class="muted small">by ${V.esc(l.actor_name)}${l.actor_role === 'admin' ? ' (Aramega)' : ''}</span>
        ${l.note ? `<div class="muted small">${V.esc(l.note)}</div>` : ''}</li>`
      )
      .join('')}</ul>
  </div>`;
}

function deliveryCard(order, deliveryFiles) {
  return `
  <div class="card">
    <h2>Delivery</h2>
    <table class="kv-table">
      <tr><td>Method</td><td><strong>${order.delivery_method === 'courier' ? 'Courier Delivery' : 'Self Pickup'}</strong></td></tr>
      ${order.delivery_method === 'courier' ? `<tr><td>Address</td><td>${V.esc(order.delivery_address)}</td></tr>` : ''}
      <tr><td>Needed by</td><td>${V.esc(fmtDay(order.needed_by))}</td></tr>
      <tr><td>Estimated ready</td><td>${order.eta_date ? V.esc(fmtDay(order.eta_date)) : '<span class="muted">Set when the order is confirmed</span>'}</td></tr>
      ${order.tracking_no ? `<tr><td>Tracking No</td><td><strong>${V.esc(order.tracking_no)}</strong></td></tr>` : ''}
    </table>
    ${deliveryFiles && deliveryFiles.length ? `
    <h3 class="sub-h">Delivery Proof / DO</h3>
    <ul class="file-list">${deliveryFiles.map((f) => fileCard(f)).join('')}</ul>` : ''}
  </div>`;
}

// ---------- auth & account ----------

app.get('/login', (req, res) => {
  const user = currentUser(req);
  if (user) return res.redirect(user.role === 'admin' ? '/admin' : '/');
  res.send(V.loginPage({ error: null }));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).send(V.loginPage({ error: 'Invalid username or password.' }));
  }
  req.session.userId = user.id;
  res.redirect(user.role === 'admin' ? '/admin' : '/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/account', requireCustomer, (req, res) => {
  const credit = creditBalance(req.user.id);
  const body = `
  <div class="page-head"><div><h1>My Account</h1><p class="muted">${V.esc(req.user.name)} &middot; ${V.esc(req.user.company)}</p></div></div>
  <div class="grid-2">
    <div class="card">
      <h2>Store Credit</h2>
      <p class="credit-big">${V.rm(credit)}</p>
      <p class="muted small">Credit from cancelled orders can be applied to your next order at checkout.</p>
    </div>
    <div class="card">
      <h2>Default Delivery Address</h2>
      <form method="post" action="/account/address" class="stack">
        <label>Address (prefilled on courier orders)
          <textarea name="address" rows="3" maxlength="500" placeholder="Full delivery address including postcode">${V.esc(req.user.address || '')}</textarea>
        </label>
        <button class="btn btn-primary" type="submit">Save Address</button>
      </form>
    </div>
  </div>
  <div class="grid-2">
    <div class="card">
      <h2>Change Password</h2>
      <form method="post" action="/account/password" class="stack">
        <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
        <label>New password (min 6 characters)<input type="password" name="password" minlength="6" required autocomplete="new-password"></label>
        <label>Repeat new password<input type="password" name="password2" minlength="6" required autocomplete="new-password"></label>
        <button class="btn btn-primary" type="submit">Update Password</button>
      </form>
    </div>
    <div class="card">
      <h2>My Price List</h2>
      <p class="muted small">Your prices for each product. Bulk discounts (where set) apply automatically by quantity.</p>
      <div class="table-wrap pricelist-wrap"><table class="table">
        <thead><tr><th>Product</th><th class="num">Your Price</th></tr></thead>
        <tbody>${db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all().map((p) => {
          const price = priceFor(req.user.id, p.id, 1);
          const tiers = tiersFor(p.id);
          return `<tr><td data-label="Product">${V.esc(p.name)}</td>
          <td data-label="Your Price" class="num">${price > 0 ? V.rm(price) + ' / ' + V.esc(p.unit) : '<span class="muted">Not set</span>'}
          ${tiers.length ? `<div class="muted small">${tiers.map((t) => `${t.min_qty}+: ${V.rm(t.price)}`).join(' &middot; ')}</div>` : ''}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>
  </div>`;
  render(req, res, { title: 'My Account', user: req.user, body, active: 'account' });
});

app.post('/account/password', requireCustomer, (req, res) => {
  const { current, password, password2 } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) {
    flash(req, 'error', 'Your current password is incorrect.');
  } else if (String(password || '').length < 6) {
    flash(req, 'error', 'New password must be at least 6 characters.');
  } else if (password !== password2) {
    flash(req, 'error', 'The new passwords do not match.');
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.user.id);
    flash(req, 'success', 'Password updated.');
  }
  res.redirect('/account');
});

app.post('/account/address', requireCustomer, (req, res) => {
  db.prepare('UPDATE users SET address = ? WHERE id = ?')
    .run(String(req.body.address || '').trim().slice(0, 500), req.user.id);
  flash(req, 'success', 'Default delivery address saved.');
  res.redirect('/account');
});

// ---------- customer: dashboard ----------

app.get('/', requireCustomer, (req, res) => {
  sweepUnpaidOrders();
  const orders = db
    .prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC')
    .all(req.user.id);
  for (const o of orders) {
    if (o.status === 'needs_revision') o.action_note = 'Action needed: revise and resubmit';
    else if (['submitted', 'confirmed', 'completed'].includes(o.status)) {
      const balance = round2(o.total - paidFor(o));
      if (balance > 0) o.action_note = `Balance due: ${V.rm(balance)}`;
    }
  }
  const credit = creditBalance(req.user.id);
  const body = `
  <div class="page-head">
    <div><h1>My Orders</h1><p class="muted">Welcome back, ${V.esc(req.user.name)}.${credit > 0 ? ` You have <strong>${V.rm(credit)}</strong> store credit.` : ''}</p></div>
    <a class="btn btn-primary" href="/orders/new">+ New Order</a>
  </div>
  ${V.ordersTable(orders)}`;
  render(req, res, { title: 'My Orders', user: req.user, body, active: 'home' });
});

// ---------- customer: new order ----------

app.get('/orders/new', requireCustomer, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all();
  const leadDays = parseInt(setting('lead_days', '3'), 10);
  const minDate = klDatePlus(leadDays);
  const expressPct = parseFloat(setting('express_percent', '20')) || 0;
  const expressDays = parseInt(setting('express_lead_days', '1'), 10);
  const expressMin = klDatePlus(expressDays);
  const expressAvailable = expressPct > 0 && expressDays < leadDays;
  const credit = creditBalance(req.user.id);

  // Prefill quantities when re-ordering a previous order.
  const prefill = {};
  if (req.query.reorder) {
    const prev = getOrder(req.query.reorder);
    if (prev && prev.customer_id === req.user.id) {
      for (const i of getItems(prev.id)) prefill[i.product_id] = i.qty;
    }
  }

  const pricing = {};
  const rows = products
    .map((p) => {
      const override = db
        .prepare('SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?')
        .get(req.user.id, p.id);
      const tiers = tiersFor(p.id);
      pricing[p.id] = { base: p.base_price, moq: p.moq, override: override ? override.price : null, tiers };
      const startPrice = priceFor(req.user.id, p.id, p.moq);
      return `<tr>
        <td data-label="Product"><strong>${V.esc(p.name)}</strong></td>
        <td data-label="Your Price" class="num price-cell" id="price_${p.id}">${V.rm(startPrice)} / ${V.esc(p.unit)}</td>
        <td data-label="Quantity" class="qty-cell">
          <input class="qty-input" type="number" name="qty_${p.id}" data-pid="${p.id}" min="0" step="1"
            value="${prefill[p.id] || 0}" inputmode="numeric">
        </td>
        <td data-label="Subtotal" class="num subtotal-cell" id="sub_${p.id}">RM 0.00</td>
      </tr>`;
    })
    .join('');

  const sst = parseFloat(setting('sst_percent', '0'));
  const body = `
  <div class="page-head"><div><h1>New Order</h1>
  <p class="muted">Select products and quantities. Your invoice is generated automatically when you submit.
  Full payment is required before production starts.</p></div></div>
  <form method="post" action="/orders" enctype="multipart/form-data" id="order-form" class="stack">
    <div class="card">
      <h2>1. Job Name &amp; Products</h2>
      <label style="max-width:420px; margin-bottom:0.9rem">Job name <span class="req-chip">Required</span>
        <input name="job_name" id="job-name" required maxlength="100" placeholder="e.g. Company Family Day Tees 2026">
      </label>
      <div class="table-wrap"><table class="table order-table">
        <thead><tr><th>Product</th><th class="num">Your Price</th><th>Quantity</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="3" class="num total-label">Subtotal</td><td class="num" id="f-subtotal">RM 0.00</td></tr>
          <tr id="express-row" style="display:none"><td colspan="3" class="num total-label">Rush Order Surcharge (${expressPct}%)</td><td class="num" id="f-express">RM 0.00</td></tr>
          <tr id="disc-row" style="display:none"><td colspan="3" class="num total-label">Promo Discount</td><td class="num" id="f-disc">RM 0.00</td></tr>
          ${sst > 0 ? `<tr><td colspan="3" class="num total-label">SST (${sst}%)</td><td class="num" id="f-sst">RM 0.00</td></tr>` : ''}
          <tr><td colspan="3" class="num total-label"><strong>Order Total</strong></td>
          <td class="num"><strong id="order-total">RM 0.00</strong></td></tr>
        </tfoot>
      </table></div>
    </div>
    <div class="card">
      <h2>2. Artwork Files <span class="req-chip">Required</span></h2>
      <p class="muted">Provide your artwork as <strong>either</strong> a .zip file (up to 500MB) <strong>or</strong> a WeTransfer link — one of the two, not both. Your order cannot be submitted without artwork.</p>
      <label>Artwork zip file
        <input type="file" name="artwork" id="artwork-file" accept=".zip">
      </label>
      <div class="or-divider"><span>OR</span></div>
      <label>WeTransfer link
        <input type="url" name="wetransfer_link" id="wetransfer-link" placeholder="https://we.tl/...">
      </label>
    </div>
    <div class="card">
      <h2>3. Delivery</h2>
      <div class="radio-row">
        <label class="check"><input type="radio" name="delivery_method" value="pickup" checked> Self Pickup</label>
        <label class="check"><input type="radio" name="delivery_method" value="courier"> Courier Delivery</label>
      </div>
      <label id="address-label" style="display:none">Delivery address <span class="req-chip">Required for courier</span>
        <textarea name="delivery_address" id="delivery-address" rows="2" placeholder="Full delivery address including postcode">${V.esc(req.user.address || '')}</textarea>
      </label>
      ${expressAvailable ? `
      <label class="check express-opt"><input type="checkbox" name="is_express" id="is-express" value="1">
        <span><strong>Rush order</strong> (+${expressPct}% surcharge) &mdash; earliest date becomes ${V.esc(fmtDay(expressMin))} (${expressDays} day${expressDays === 1 ? '' : 's'})</span></label>` : ''}
      <label>Needed by date <span class="req-chip">Required</span>
        <input type="date" name="needed_by" id="needed-by" min="${minDate}" required>
      </label>
      <p class="muted small" id="lead-note">Earliest available date is ${V.esc(fmtDay(minDate))} (production lead time: ${leadDays} days).</p>
    </div>
    ${credit > 0 ? `
    <div class="card credit-card">
      <h2>4. Store Credit</h2>
      <label class="check"><input type="checkbox" name="use_credit" value="1" checked>
        Apply my store credit (<strong>${V.rm(credit)}</strong> available) to this order</label>
      <p class="muted small">Credit is applied up to the order total; any remainder stays in your account.</p>
    </div>` : ''}
    <div class="card">
      <h2>${credit > 0 ? '5' : '4'}. Promo Code (optional)</h2>
      <label style="max-width:300px">Promo code
        <input name="promo_code" maxlength="30" placeholder="e.g. SAVE10" style="text-transform:uppercase">
      </label>
      <p class="muted small">If we gave you a promo code, enter it here — the discount is applied on your invoice.</p>
    </div>
    <div class="card">
      <h2>${credit > 0 ? '6' : '5'}. Notes (optional)</h2>
      <label>Order notes
        <textarea name="notes" rows="3" placeholder="Sizes breakdown, colours, delivery instructions..."></textarea>
      </label>
    </div>
    <button class="btn btn-primary btn-lg" type="submit">Submit Order &amp; Generate Invoice</button>
  </form>
  <script>
    const PRICING = ${JSON.stringify(pricing)};
    const SST = ${sst};
    const EXPRESS_PCT = ${expressPct};
    const MIN_DATE = '${minDate}';
    const EXPRESS_MIN = '${expressMin}';
    const form = document.getElementById('order-form');
    const expressBox = document.getElementById('is-express');
    const fmt = n => 'RM ' + n.toLocaleString('en-MY', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    function unitPrice(pid, qty) {
      const p = PRICING[pid];
      if (p.override != null) return p.override;
      let price = p.base;
      for (const t of p.tiers) if (qty >= t.min_qty) price = t.price;
      return price;
    }
    function recalc() {
      let subtotal = 0;
      form.querySelectorAll('.qty-input').forEach(inp => {
        const pid = inp.dataset.pid;
        const qty = Math.max(0, parseInt(inp.value || '0', 10));
        const price = unitPrice(pid, Math.max(qty, PRICING[pid].moq));
        const sub = qty > 0 ? price * qty : 0;
        subtotal += sub;
        document.getElementById('price_' + pid).firstChild.textContent = fmt(price) + ' ';
        document.getElementById('sub_' + pid).textContent = fmt(sub);
        inp.classList.toggle('qty-bad', qty > 0 && qty < PRICING[pid].moq);
      });
      const isExpress = expressBox && expressBox.checked;
      const expressAmt = isExpress ? subtotal * EXPRESS_PCT / 100 : 0;
      const sstAmt = (subtotal + expressAmt) * SST / 100;
      const elS = document.getElementById('f-subtotal');
      if (elS) elS.textContent = fmt(subtotal);
      const rowE = document.getElementById('express-row');
      if (rowE) { rowE.style.display = isExpress ? '' : 'none';
        document.getElementById('f-express').textContent = fmt(expressAmt); }
      const elT = document.getElementById('f-sst');
      if (elT) elT.textContent = fmt(sstAmt);
      document.getElementById('order-total').textContent = fmt(subtotal + expressAmt + sstAmt);
      const nb = document.getElementById('needed-by');
      nb.min = isExpress ? EXPRESS_MIN : MIN_DATE;
    }
    form.addEventListener('input', recalc);
    recalc();
    form.addEventListener('submit', (e) => {
      const problems = [];
      let any = false;
      form.querySelectorAll('.qty-input').forEach(inp => {
        if (parseInt(inp.value || '0', 10) > 0) any = true;
      });
      if (!any) problems.push('Please enter a quantity for at least one product.');
      if (!document.getElementById('job-name').value.trim()) problems.push('Please give this order a job name.');
      const hasFile = document.getElementById('artwork-file').files.length > 0;
      const hasLink = document.getElementById('wetransfer-link').value.trim().length > 0;
      if (!hasFile && !hasLink) problems.push('Artwork is required: upload a .zip file or paste a WeTransfer link.');
      if (hasFile && hasLink) problems.push('Provide EITHER the zip file OR the WeTransfer link, not both.');
      const courier = form.querySelector('input[name="delivery_method"]:checked').value === 'courier';
      if (courier && !document.getElementById('delivery-address').value.trim()) problems.push('Delivery address is required for courier delivery.');
      if (!document.getElementById('needed-by').value) problems.push('Please choose a needed-by date.');
      if (problems.length) { e.preventDefault(); alert(problems.join('\\n')); }
    });
    document.getElementById('artwork-file').addEventListener('change', function(){
      if (this.files.length) document.getElementById('wetransfer-link').value = '';
    });
    document.getElementById('wetransfer-link').addEventListener('input', function(){
      if (this.value.trim()) document.getElementById('artwork-file').value = '';
    });
    form.querySelectorAll('input[name="delivery_method"]').forEach(r => r.addEventListener('change', () => {
      document.getElementById('address-label').style.display =
        form.querySelector('input[name="delivery_method"]:checked').value === 'courier' ? '' : 'none';
    }));
  </script>`;
  render(req, res, { title: 'New Order', user: req.user, body, active: 'new' });
});

app.post('/orders', requireCustomer, runUpload(uploadArtwork), (req, res) => {
  const fail = (msg) => {
    if (req.file) fs.unlink(req.file.path, () => {});
    flash(req, 'error', msg);
    return res.redirect('/orders/new');
  };

  const jobName = String(req.body.job_name || '').trim().slice(0, 100);
  if (!jobName) return fail('Please give this order a job name.');

  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const items = [];
  for (const p of products) {
    const qty = parseInt(req.body[`qty_${p.id}`] || '0', 10);
    if (qty > 0) {
      if (qty < p.moq) return fail(`Minimum order for ${p.name} is ${p.moq} ${p.unit}.`);
      const unitPrice = priceFor(req.user.id, p.id, qty);
      // Rule: products without a price set cannot be ordered.
      if (unitPrice <= 0) return fail(`The price for ${p.name} has not been set yet. Please contact us.`);
      items.push({ product: p, qty, unitPrice, lineTotal: round2(unitPrice * qty) });
    }
  }
  if (!items.length) return fail('Please select at least one product with a quantity.');

  // Rule: artwork is mandatory — EITHER a zip upload OR a WeTransfer link, never both.
  const wetransfer = String(req.body.wetransfer_link || '').trim().slice(0, 500);
  if (!req.file && !wetransfer) {
    return fail('Artwork is required: upload a .zip file (max 500MB) or paste a WeTransfer link before submitting.');
  }
  if (req.file && wetransfer) {
    return fail('Provide EITHER the artwork zip file OR the WeTransfer link — not both.');
  }
  if (wetransfer && !/^https?:\/\//i.test(wetransfer)) {
    return fail('The WeTransfer link must start with http:// or https://.');
  }

  // Promo code (optional).
  const promoCode = String(req.body.promo_code || '').trim().toUpperCase().slice(0, 30);
  const promoCheck = checkPromo(promoCode);
  if (promoCheck.error) return fail(promoCheck.error);
  const promo = promoCheck.promo;

  // Rule: courier delivery needs an address.
  const method = req.body.delivery_method === 'courier' ? 'courier' : 'pickup';
  const address = String(req.body.delivery_address || '').trim().slice(0, 500);
  if (method === 'courier' && !address) return fail('Delivery address is required for courier delivery.');

  // Rush order: shorter lead time, surcharge applied — only when enabled in settings.
  const leadDays = parseInt(setting('lead_days', '3'), 10);
  const expressPct = parseFloat(setting('express_percent', '20')) || 0;
  const expressDays = parseInt(setting('express_lead_days', '1'), 10);
  const isExpress = !!req.body.is_express && expressPct > 0 && expressDays < leadDays;

  // Rule: needed-by date is required and must respect the (rush or normal) lead time.
  const effectiveLead = isExpress ? expressDays : leadDays;
  const minDate = klDatePlus(effectiveLead);
  const neededBy = String(req.body.needed_by || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) return fail('Please choose a needed-by date.');
  if (neededBy < minDate) {
    return fail(`The earliest available date is ${fmtDay(minDate)} (${isExpress ? 'rush' : 'production'} lead time: ${effectiveLead} days).`);
  }

  const subtotal = round2(items.reduce((s, i) => s + i.lineTotal, 0));
  const expressAmount = isExpress ? round2((subtotal * expressPct) / 100) : 0;
  const chargeBase = round2(subtotal + expressAmount);
  const discountAmount = promo
    ? round2(promo.kind === 'percent' ? (chargeBase * promo.value) / 100 : Math.min(promo.value, chargeBase))
    : 0;
  const sstPercent = parseFloat(setting('sst_percent', '0')) || 0;
  const sstAmount = round2(((chargeBase - discountAmount) * sstPercent) / 100);
  const total = round2(chargeBase - discountAmount + sstAmount);

  // Store credit: apply up to the order total if the customer opted in.
  let creditApplied = 0;
  if (req.body.use_credit) {
    creditApplied = Math.min(creditBalance(req.user.id), total);
    creditApplied = round2(Math.max(creditApplied, 0));
  }

  const orderId = db.transaction(() => {
    const invNum = nextInvoiceNo();
    const info = db
      .prepare(
        `INSERT INTO orders (order_no, invoice_no, customer_id, job_name, subtotal, is_express, express_percent,
          express_amount, promo_code, discount_amount, sst_percent, sst_amount, total,
          credit_applied, notes, wetransfer_link, delivery_method, delivery_address, needed_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        randomOrderNo(), `INV-${invNum}`, req.user.id, jobName, subtotal, isExpress ? 1 : 0,
        isExpress ? expressPct : 0, expressAmount, promo ? promo.code : '', discountAmount,
        sstPercent, sstAmount, total,
        creditApplied, String(req.body.notes || '').slice(0, 2000), wetransfer, method, address, neededBy
      );
    if (promo) db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?').run(promo.id);
    const id = info.lastInsertRowid;
    const insItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, product_name, unit, qty, unit_price, line_total)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const i of items) insItem.run(id, i.product.id, i.product.name, i.product.unit, i.qty, i.unitPrice, i.lineTotal);
    if (req.file) {
      db.prepare('INSERT INTO files (order_id, kind, stored_name, original_name, size) VALUES (?,?,?,?,?)').run(
        id, 'artwork', req.file.filename, req.file.originalname, req.file.size
      );
    }
    if (creditApplied > 0) {
      db.prepare('INSERT INTO credits (customer_id, amount, order_id, note) VALUES (?,?,?,?)').run(
        req.user.id, -creditApplied, id, `Credit applied to ORD-${invNum}`
      );
    }
    logEvent(id, req.user, 'submitted', creditApplied > 0 ? `Store credit applied: ${V.rm(creditApplied)}` : '');
    return id;
  })();

  flash(req, 'success', 'Order submitted! Your invoice has been generated. Please make FULL payment and upload your bank receipt — unverified orders are cancelled automatically after 3 hours.');
  res.redirect(`/orders/${orderId}`);
});

// ---------- customer: order detail ----------

function itemsCard(order, notesLabel) {
  const items = getItems(order.id);
  return `<div class="card"><h2>Items</h2><div class="table-wrap"><table class="table">
    <thead><tr><th>Product</th><th class="num">Unit Price</th><th class="num">Qty</th><th class="num">Subtotal</th></tr></thead>
    <tbody>${items
      .map(
        (i) => `<tr>
      <td data-label="Product">${V.esc(i.product_name)}</td>
      <td data-label="Unit Price" class="num">${V.rm(i.unit_price)} / ${V.esc(i.unit)}</td>
      <td data-label="Qty" class="num">${i.qty}</td>
      <td data-label="Subtotal" class="num">${V.rm(i.line_total)}</td></tr>`
      )
      .join('')}</tbody>
    <tfoot>
      <tr><td colspan="3" class="num total-label">Subtotal</td><td class="num">${V.rm(order.subtotal)}</td></tr>
      ${order.is_express ? `<tr><td colspan="3" class="num total-label">Rush Order Surcharge (${order.express_percent}%)</td><td class="num">${V.rm(order.express_amount)}</td></tr>` : ''}
      ${order.discount_amount > 0 ? `<tr><td colspan="3" class="num total-label">Promo Discount (${V.esc(order.promo_code)})</td><td class="num">- ${V.rm(order.discount_amount)}</td></tr>` : ''}
      ${order.sst_percent > 0 ? `<tr><td colspan="3" class="num total-label">SST (${order.sst_percent}%)</td><td class="num">${V.rm(order.sst_amount)}</td></tr>` : ''}
      <tr><td colspan="3" class="num total-label"><strong>Total</strong></td><td class="num"><strong>${V.rm(order.total)}</strong></td></tr>
    </tfoot>
  </table></div>
  ${order.notes ? `<p class="muted"><strong>${notesLabel}:</strong> ${V.esc(order.notes)}</p>` : ''}</div>`;
}

function artworkCard(order, { isAdmin }) {
  const artwork = getFiles(order.id, 'artwork');
  const canEdit = !isAdmin && (order.status === 'submitted' || order.status === 'needs_revision');
  return `
  <div class="card">
    <h2>Artwork</h2>
    ${artwork.length ? `<ul class="file-list">${artwork.map((f) => fileCard(f)).join('')}</ul>` : ''}
    ${order.wetransfer_link ? `<p>WeTransfer link: <a href="${V.esc(order.wetransfer_link)}" target="_blank" rel="noopener noreferrer">${V.esc(order.wetransfer_link)}</a></p>` : ''}
    ${!artwork.length && !order.wetransfer_link ? '<p class="muted">No artwork provided yet.</p>' : ''}
    ${canEdit ? `
    <details class="upload-details" ${order.status === 'needs_revision' ? 'open' : ''}>
      <summary>Upload / replace artwork</summary>
      <form method="post" action="/orders/${order.id}/artwork" enctype="multipart/form-data" class="stack">
        <label>Artwork zip file (max 500MB)
          <input type="file" name="artwork" accept=".zip" required>
        </label>
        <button class="btn btn-outline" type="submit">Upload Artwork Zip</button>
      </form>
      <div class="or-divider"><span>OR</span></div>
      <form method="post" action="/orders/${order.id}/wetransfer" class="stack">
        <label>WeTransfer link
          <input type="url" name="wetransfer_link" placeholder="https://we.tl/..." value="${V.esc(order.wetransfer_link)}" required>
        </label>
        <button class="btn btn-outline" type="submit">Save Link</button>
      </form>
    </details>` : ''}
  </div>`;
}

function paymentsCard(order, { isAdmin }) {
  const canPay = !isAdmin && ['submitted', 'needs_revision', 'confirmed', 'completed'].includes(order.status);
  return `
  <div class="card">
    <h2>Payments</h2>
    ${paymentSummary(order)}
    ${paymentsList(order, { isAdmin })}
    ${canPay ? `
    <details class="upload-details">
      <summary>Submit a payment</summary>
      <form method="post" action="/orders/${order.id}/payment" enctype="multipart/form-data" class="stack">
        <label>Amount paid (RM) <span class="req-chip">Required</span>
          <input name="amount" type="number" step="0.01" min="0.01" required placeholder="e.g. 500.00">
        </label>
        <label>Receipt file (PDF or image, max 20MB) <span class="req-chip">Required</span>
          <input type="file" name="receipt" accept=".pdf,.jpg,.jpeg,.png,.webp" required>
        </label>
        <label>Bank reference number (optional)
          <input name="bank_ref" placeholder="e.g. CIMB ref no.">
        </label>
        <button class="btn btn-outline" type="submit">Submit Payment for Verification</button>
      </form>
    </details>` : ''}
    ${isAdmin && order.status !== 'cancelled' && order.status !== 'delivered' ? `
    <details class="upload-details">
      <summary>Record a payment manually (bank statement / cash)</summary>
      <form method="post" action="/admin/orders/${order.id}/payments" class="stack">
        <label>Amount (RM)<input name="amount" type="number" step="0.01" min="0.01" required></label>
        <label>Bank reference / note <span class="req-chip">Required</span>
          <input name="bank_ref" required placeholder="e.g. CIMB statement ref, or CASH"></label>
        <button class="btn btn-outline" type="submit">Record Verified Payment</button>
      </form>
    </details>` : ''}
  </div>`;
}

function refundBanner(order, { isAdmin }) {
  if (order.status !== 'cancelled') return '';
  const paid = paidFor(order);
  if (order.refund_status === 'refunded') {
    return `<div class="flash">Payment of ${V.rm(paid)} on this cancelled order was <strong>refunded</strong>${order.refund_ref ? ` (ref: ${V.esc(order.refund_ref)})` : ''} on ${V.esc(V.fmtDate(order.refund_resolved_at))}.${order.refund_note ? ' ' + V.esc(order.refund_note) : ''}</div>`;
  }
  if (order.refund_status === 'credited') {
    return `<div class="flash">Payment of ${V.rm(paid)} on this cancelled order was converted to <strong>store credit</strong> on ${V.esc(V.fmtDate(order.refund_resolved_at))}. It will be applied automatically on the next order.</div>`;
  }
  if (paid > 0) {
    return isAdmin
      ? `<div class="card verify-card">
          <h2>Resolve Customer Payment <span class="req-chip">Action needed</span></h2>
          <p>The customer has <strong>${V.rm(paid)}</strong> in verified payments/credit on this cancelled order. Choose how to resolve it:</p>
          <form method="post" action="/admin/orders/${order.id}/resolve-payment" class="stack">
            <div class="radio-row">
              <label class="check"><input type="radio" name="mode" value="credit" checked> Convert to store credit</label>
              <label class="check"><input type="radio" name="mode" value="refund"> Refunded by bank transfer</label>
            </div>
            <label>Bank transfer reference (required for refund)
              <input name="refund_ref" placeholder="e.g. CIMB transfer ref"></label>
            <label>Note (optional)<input name="note" maxlength="300"></label>
            <button class="btn btn-primary" type="submit">Resolve Payment</button>
          </form>
        </div>`
      : `<div class="flash err">This order was cancelled with ${V.rm(paid)} already paid. Our team will contact you to refund it or convert it to store credit — see Order Discussion below.</div>`;
  }
  return '';
}

app.get('/orders/:id', requireCustomer, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  const body = `
  <div class="page-head">
    <div><h1>Order ${V.esc(order.order_no)}</h1><p class="muted">${order.job_name ? `<strong>${V.esc(order.job_name)}</strong> &middot; ` : ''}Submitted ${V.esc(V.fmtDate(order.created_at))} &middot; Last update ${V.esc(V.fmtDate(order.updated_at || order.created_at))}</p></div>
    <div class="head-actions">
      ${V.statusBadge(order.status)}
      ${order.status !== 'cancelled' ? `<a class="btn btn-primary" href="/orders/${order.id}/invoice" target="_blank">View Invoice</a>` : ''}
      <a class="btn btn-outline" href="/orders/new?reorder=${order.id}">Re-order</a>
    </div>
  </div>
  ${order.status === 'needs_revision' ? `
  <div class="card revision-card">
    <h2>Revision Requested <span class="req-chip">Action needed</span></h2>
    <p><strong>Our team found an issue with this order:</strong> ${V.esc(order.revision_reason)}</p>
    <p class="muted small">Fix the issue below (replace the artwork zip, update the WeTransfer link, or reply in the discussion), then resubmit the order for checking.</p>
    <form method="post" action="/orders/${order.id}/resubmit">
      <button class="btn btn-primary" type="submit">I have fixed it &mdash; Resubmit Order</button>
    </form>
  </div>` : ''}
  ${refundBanner(order, { isAdmin: false })}
  ${order.status === 'submitted' && round2(order.total - paidFor(order)) > 0 ? `
  <div class="flash err"><strong>Payment deadline:</strong> full payment must be made and verified within 3 hours of submission, or this order is cancelled automatically.</div>` : ''}
  <div class="card"><h2>Order Status</h2>${V.timeline(order)}</div>
  ${historySection(order)}
  <div class="grid-2">
    ${itemsCard(order, 'Notes')}
    ${deliveryCard(order, getFiles(order.id, 'delivery'))}
  </div>
  ${order.status !== 'cancelled' ? `<div class="grid-2">
    ${artworkCard(order, { isAdmin: false })}
    ${paymentsCard(order, { isAdmin: false })}
  </div>` : ''}
  ${order.status === 'submitted' ? `
  <div class="card cancel-card">
    <h2>Cancel Order</h2>
    <p class="muted small">You can cancel this order while it is still awaiting confirmation. Once our team confirms it and production starts, cancellation is no longer possible from here — contact us instead. Any verified payment will be refunded or converted to store credit.</p>
    <form method="post" action="/orders/${order.id}/cancel" class="stack"
      onsubmit="return confirm('Are you sure you want to cancel this order? This cannot be undone.')">
      <label>Reason for cancellation <span class="req-chip">Required</span>
        <input name="reason" required maxlength="300" placeholder="e.g. wrong quantity, need to change artwork">
      </label>
      <button class="btn btn-danger" type="submit">Cancel This Order</button>
    </form>
  </div>` : ''}`;
  render(req, res, { title: `Order ${order.order_no}`, user: req.user, body, active: 'home' });
});

app.post('/orders/:id/artwork', requireCustomer, runUpload(uploadArtwork), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  if (order.status !== 'submitted' && order.status !== 'needs_revision') {
    flash(req, 'error', 'Artwork can only be changed while the order is awaiting confirmation or revision.');
    return res.redirect(`/orders/${order.id}`);
  }
  if (!req.file) {
    flash(req, 'error', 'No file selected.');
    return res.redirect(`/orders/${order.id}`);
  }
  db.prepare('INSERT INTO files (order_id, kind, stored_name, original_name, size) VALUES (?,?,?,?,?)').run(
    order.id, 'artwork', req.file.filename, req.file.originalname, req.file.size
  );
  touchOrder(order.id);
  flash(req, 'success', 'Artwork uploaded.');
  res.redirect(`/orders/${order.id}`);
});

app.post('/orders/:id/wetransfer', requireCustomer, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  if (order.status !== 'submitted' && order.status !== 'needs_revision') {
    flash(req, 'error', 'Artwork can only be changed while the order is awaiting confirmation or revision.');
    return res.redirect(`/orders/${order.id}`);
  }
  const link = String(req.body.wetransfer_link || '').trim().slice(0, 500);
  if (!/^https?:\/\//i.test(link)) {
    flash(req, 'error', 'Please enter a valid link (must start with http:// or https://).');
    return res.redirect(`/orders/${order.id}`);
  }
  db.prepare('UPDATE orders SET wetransfer_link = ? WHERE id = ?').run(link, order.id);
  touchOrder(order.id);
  flash(req, 'success', 'WeTransfer link saved.');
  res.redirect(`/orders/${order.id}`);
});

// Customer submits a payment with amount + receipt; it goes to admin for verification.
app.post('/orders/:id/payment', requireCustomer, runUpload(uploadReceipt), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  const bad = (msg) => {
    if (req.file) fs.unlink(req.file.path, () => {});
    flash(req, 'error', msg);
    return res.redirect(`/orders/${order.id}`);
  };
  if (!['submitted', 'needs_revision', 'confirmed', 'completed'].includes(order.status)) {
    return bad('Payments can no longer be added to this order.');
  }
  const amount = round2(parseFloat(req.body.amount));
  if (isNaN(amount) || amount <= 0) return bad('Enter the amount you paid (greater than 0).');
  // Rule: a payment submission must include the receipt file as proof.
  if (!req.file) return bad('Please attach your bank receipt file.');
  const balance = round2(order.total - paidFor(order));
  if (amount > balance + 0.005) {
    return bad(`That amount (${V.rm(amount)}) is more than the balance due (${V.rm(balance)}). Enter the correct amount, or contact us if you overpaid.`);
  }
  const ref = String(req.body.bank_ref || '').trim().slice(0, 200);
  db.transaction(() => {
    const fInfo = db
      .prepare('INSERT INTO files (order_id, kind, stored_name, original_name, size) VALUES (?,?,?,?,?)')
      .run(order.id, 'receipt', req.file.filename, req.file.originalname, req.file.size);
    db.prepare(
      "INSERT INTO payments (order_id, amount, bank_ref, status, source, file_id) VALUES (?,?,?,'pending','customer',?)"
    ).run(order.id, amount, ref, fInfo.lastInsertRowid);
    logEvent(order.id, req.user, 'payment_submitted', `${V.rm(amount)}${ref ? ' ref ' + ref : ''}`);
  })();
  flash(req, 'success', `Payment of ${V.rm(amount)} submitted. Our team will verify it shortly.`);
  res.redirect(`/orders/${order.id}`);
});

// Customer resubmits after fixing a revision request.
app.post('/orders/:id/resubmit', requireCustomer, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  if (order.status !== 'needs_revision') {
    flash(req, 'error', 'This order is not waiting for a revision.');
    return res.redirect(`/orders/${order.id}`);
  }
  db.prepare("UPDATE orders SET status = 'submitted' WHERE id = ?").run(order.id);
  logEvent(order.id, req.user, 'resubmitted', '');
  flash(req, 'success', 'Order resubmitted. Our team will check it again.');
  res.redirect(`/orders/${order.id}`);
});

app.post('/orders/:id/cancel', requireCustomer, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  // Rule: customers can cancel only while the order is still awaiting confirmation.
  if (order.status !== 'submitted') {
    flash(req, 'error', 'This order has already been confirmed and can no longer be cancelled from here. Please contact us.');
    return res.redirect(`/orders/${order.id}`);
  }
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) {
    flash(req, 'error', 'Please give a reason for the cancellation.');
    return res.redirect(`/orders/${order.id}`);
  }
  db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?")
    .run(reason, order.id);
  logEvent(order.id, req.user, 'cancelled', reason);
  flash(req, 'success', `Order ${order.order_no} has been cancelled.`);
  res.redirect(`/orders/${order.id}`);
});

// ---------- quotations (instant, auto-priced) ----------

function getQuote(id) {
  return db
    .prepare(
      `SELECT q.*, u.name AS customer_name, u.company AS customer_company, u.phone AS customer_phone
       FROM quotes q JOIN users u ON u.id = q.customer_id WHERE q.id = ?`
    )
    .get(id);
}
function getQuoteItems(quoteId) {
  return db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);
}
const QSTATUS = {
  quoted: { label: 'Active Quotation', badge: 'badge-confirmed' },
  accepted: { label: 'Accepted', badge: 'badge-completed' },
  declined: { label: 'Declined', badge: 'badge-cancelled' },
};
function qBadge(q) {
  if (q.status === 'quoted' && q.valid_until && q.valid_until < klDatePlus(0)) {
    return '<span class="badge badge-cancelled">Expired</span>';
  }
  return `<span class="badge ${QSTATUS[q.status].badge}">${QSTATUS[q.status].label}</span>`;
}

function quotesTable(quotes, admin) {
  if (!quotes.length) return '<div class="empty">No quotations yet.</div>';
  const base = admin ? '/admin/quotes/' : '/quotes/';
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Quote #</th>${admin ? '<th>Customer</th>' : ''}<th>Date</th><th>Valid Until</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
    <tbody>${quotes
      .map(
        (q) => `<tr>
      <td data-label="Quote #"><a href="${base}${q.id}"><strong>${V.esc(q.quote_no)}</strong></a>
        <div class="muted small">${V.esc(q.title)}</div></td>
      ${admin ? `<td data-label="Customer">${V.esc(q.customer_company || q.customer_name)}</td>` : ''}
      <td data-label="Date">${V.esc(V.fmtDate(q.created_at))}</td>
      <td data-label="Valid Until">${V.esc(fmtDay(q.valid_until))}</td>
      <td data-label="Total" class="num">${V.rm(q.total)}</td>
      <td data-label="Status">${qBadge(q)}</td>
      <td data-label=""><a class="btn btn-sm btn-outline" href="${base}${q.id}">View</a></td>
    </tr>`
      )
      .join('')}</tbody></table></div>`;
}

function quoteItemsTable(q) {
  const items = getQuoteItems(q.id);
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Description</th><th class="num">Unit Price</th><th class="num">Qty</th><th class="num">Subtotal</th></tr></thead>
    <tbody>${items
      .map(
        (i) => `<tr><td data-label="Description">${V.esc(i.description)}</td>
      <td data-label="Unit Price" class="num">${V.rm(i.unit_price)} / ${V.esc(i.unit)}</td>
      <td data-label="Qty" class="num">${i.qty}</td>
      <td data-label="Subtotal" class="num">${V.rm(i.line_total)}</td></tr>`
      )
      .join('')}</tbody>
    <tfoot>
      <tr><td colspan="3" class="num total-label">Subtotal</td><td class="num">${V.rm(q.subtotal)}</td></tr>
      ${q.sst_percent > 0 ? `<tr><td colspan="3" class="num total-label">SST (${q.sst_percent}%)</td><td class="num">${V.rm(q.sst_amount)}</td></tr>` : ''}
      <tr><td colspan="3" class="num total-label"><strong>Total</strong></td><td class="num"><strong>${V.rm(q.total)}</strong></td></tr>
    </tfoot>
  </table></div>`;
}

// Customer: list + instant quotation builder.
app.get('/quotes', requireCustomer, (req, res) => {
  const quotes = db
    .prepare(`SELECT q.*, u.name AS customer_name, u.company AS customer_company
              FROM quotes q JOIN users u ON u.id = q.customer_id
              WHERE q.customer_id = ? ORDER BY q.id DESC`)
    .all(req.user.id);
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all();
  const pricing = {};
  const rows = products
    .map((p) => {
      const override = db
        .prepare('SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?')
        .get(req.user.id, p.id);
      const tiers = tiersFor(p.id);
      pricing[p.id] = { base: p.base_price, moq: p.moq, override: override ? override.price : null, tiers };
      return `<tr>
        <td data-label="Product"><strong>${V.esc(p.name)}</strong></td>
        <td data-label="Your Price" class="num" id="qprice_${p.id}">${V.rm(priceFor(req.user.id, p.id, p.moq))} / ${V.esc(p.unit)}</td>
        <td data-label="Quantity"><input class="qty-input" type="number" name="qty_${p.id}" data-pid="${p.id}" min="0" step="1" value="0" inputmode="numeric"></td>
        <td data-label="Subtotal" class="num" id="qsub_${p.id}">RM 0.00</td>
      </tr>`;
    })
    .join('');
  const sst = parseFloat(setting('sst_percent', '0'));
  const validDays = parseInt(setting('quote_valid_days', '14'), 10);
  const body = `
  <div class="page-head"><div><h1>Quotations</h1>
  <p class="muted">Get an instant quotation with your prices — no waiting. Quotations are valid for ${validDays} days and can be converted into an order any time before they expire.</p></div></div>
  <div class="card">
    <h2>Create Instant Quotation</h2>
    <form method="post" action="/quotes" id="quote-form">
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Product</th><th class="num">Your Price</th><th>Quantity</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="3" class="num total-label">Subtotal</td><td class="num" id="q-subtotal">RM 0.00</td></tr>
          ${sst > 0 ? `<tr><td colspan="3" class="num total-label">SST (${sst}%)</td><td class="num" id="q-sst">RM 0.00</td></tr>` : ''}
          <tr><td colspan="3" class="num total-label"><strong>Quotation Total</strong></td>
          <td class="num"><strong id="q-total">RM 0.00</strong></td></tr>
        </tfoot>
      </table></div>
      <label style="margin-top:0.9rem">Notes on the quotation (optional)
        <input name="notes" maxlength="300" placeholder="e.g. for Q1 event budget approval">
      </label>
      <button class="btn btn-primary btn-lg" type="submit" style="margin-top:0.9rem">Generate Quotation</button>
    </form>
  </div>
  <h2 class="section-title">My Quotations</h2>
  ${quotesTable(quotes, false)}
  <script>
    const QPRICING = ${JSON.stringify(pricing)};
    const QSST = ${sst};
    const qform = document.getElementById('quote-form');
    const qfmt = n => 'RM ' + n.toLocaleString('en-MY', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    function qUnitPrice(pid, qty) {
      const p = QPRICING[pid];
      if (p.override != null) return p.override;
      let price = p.base;
      for (const t of p.tiers) if (qty >= t.min_qty) price = t.price;
      return price;
    }
    function qRecalc() {
      let subtotal = 0;
      qform.querySelectorAll('.qty-input').forEach(inp => {
        const pid = inp.dataset.pid;
        const qty = Math.max(0, parseInt(inp.value || '0', 10));
        const price = qUnitPrice(pid, Math.max(qty, QPRICING[pid].moq));
        const sub = qty > 0 ? price * qty : 0;
        subtotal += sub;
        document.getElementById('qprice_' + pid).firstChild.textContent = qfmt(price) + ' ';
        document.getElementById('qsub_' + pid).textContent = qfmt(sub);
        inp.classList.toggle('qty-bad', qty > 0 && qty < QPRICING[pid].moq);
      });
      const sstAmt = subtotal * QSST / 100;
      document.getElementById('q-subtotal').textContent = qfmt(subtotal);
      const es = document.getElementById('q-sst');
      if (es) es.textContent = qfmt(sstAmt);
      document.getElementById('q-total').textContent = qfmt(subtotal + sstAmt);
    }
    qform.addEventListener('input', qRecalc);
    qform.addEventListener('submit', (e) => {
      let any = false;
      qform.querySelectorAll('.qty-input').forEach(inp => {
        if (parseInt(inp.value || '0', 10) > 0) any = true;
      });
      if (!any) { e.preventDefault(); alert('Please enter a quantity for at least one product.'); }
    });
  </script>`;
  render(req, res, { title: 'Quotations', user: req.user, body, active: 'quotes' });
});

// Instant quotation: priced automatically from the customer's own prices and tiers.
app.post('/quotes', requireCustomer, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const items = [];
  for (const p of products) {
    const qty = parseInt(req.body[`qty_${p.id}`] || '0', 10);
    if (qty > 0) {
      if (qty < p.moq) {
        flash(req, 'error', `Minimum order for ${p.name} is ${p.moq} ${p.unit}.`);
        return res.redirect('/quotes');
      }
      const unitPrice = priceFor(req.user.id, p.id, qty);
      if (unitPrice <= 0) {
        flash(req, 'error', `The price for ${p.name} has not been set yet. Please contact us.`);
        return res.redirect('/quotes');
      }
      items.push({ product: p, qty, unitPrice, lineTotal: round2(unitPrice * qty) });
    }
  }
  if (!items.length) {
    flash(req, 'error', 'Please enter a quantity for at least one product.');
    return res.redirect('/quotes');
  }
  const subtotal = round2(items.reduce((s, i) => s + i.lineTotal, 0));
  const sstPercent = parseFloat(setting('sst_percent', '0')) || 0;
  const sstAmount = round2((subtotal * sstPercent) / 100);
  const total = round2(subtotal + sstAmount);
  const validDays = parseInt(setting('quote_valid_days', '14'), 10);
  const title = items.map((i) => `${i.qty} ${i.product.name}`).join(', ').slice(0, 150);

  const quoteId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO quotes (quote_no, customer_id, title, notes, status, subtotal, sst_percent, sst_amount, total, valid_until)
         VALUES (?,?,?,?,'quoted',?,?,?,?,?)`
      )
      .run(
        nextQuoteNo(), req.user.id, title,
        String(req.body.notes || '').trim().slice(0, 300),
        subtotal, sstPercent, sstAmount, total, klDatePlus(validDays)
      );
    const id = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO quote_items (quote_id, product_id, description, unit, qty, unit_price, line_total) VALUES (?,?,?,?,?,?,?)'
    );
    for (const i of items) ins.run(id, i.product.id, i.product.name, i.product.unit, i.qty, i.unitPrice, i.lineTotal);
    return id;
  })();

  flash(req, 'success', `Quotation generated: ${V.rm(total)}, valid for ${validDays} days.`);
  res.redirect(`/quotes/${quoteId}`);
});

app.get('/quotes/:id', requireCustomer, (req, res) => {
  const q = getQuote(req.params.id);
  if (!q || q.customer_id !== req.user.id) return res.status(404).send('Quote not found');
  const expired = q.status === 'quoted' && q.valid_until && q.valid_until < klDatePlus(0);
  const leadDays = parseInt(setting('lead_days', '3'), 10);
  const minDate = klDatePlus(leadDays);
  const body = `
  <div class="page-head">
    <div><h1>Quotation ${V.esc(q.quote_no)}</h1><p class="muted">${V.esc(q.title)} &middot; ${V.esc(V.fmtDate(q.created_at))}</p></div>
    <div class="head-actions">${qBadge(q)}
      <a class="btn btn-primary" href="/quotes/${q.id}/doc" target="_blank">View / Print Quotation</a>
      ${q.order_id ? `<a class="btn btn-outline" href="/orders/${q.order_id}">View Order</a>` : ''}</div>
  </div>
  <div class="card">
    <h2>Quotation</h2>
    ${quoteItemsTable(q)}
    ${q.notes ? `<p class="muted"><strong>Notes:</strong> ${V.esc(q.notes)}</p>` : ''}
    <p class="small">Valid until <strong>${V.esc(fmtDay(q.valid_until))}</strong>${expired ? ' — <strong class="unpaid">expired. Generate a new quotation for current prices.</strong>' : ''}</p>
    ${q.status === 'declined' && q.decline_reason ? `<p class="muted"><strong>Declined:</strong> ${V.esc(q.decline_reason)}</p>` : ''}
  </div>
  ${q.status === 'quoted' && !expired ? `
  <div class="card verify-card">
    <h2>Convert to Order</h2>
    <p class="muted small">This places a real order at the quoted prices and generates the invoice. Artwork is required, same as a normal order.</p>
    <form method="post" action="/quotes/${q.id}/accept" enctype="multipart/form-data" class="stack">
      <label>Job name <span class="req-chip">Required</span>
        <input name="job_name" required maxlength="100" placeholder="e.g. Company Family Day Tees 2026">
      </label>
      <label>Artwork zip file (max 500MB)
        <input type="file" name="artwork" accept=".zip">
      </label>
      <div class="or-divider"><span>OR</span></div>
      <label>WeTransfer link
        <input type="url" name="wetransfer_link" placeholder="https://we.tl/...">
      </label>
      <div class="radio-row">
        <label class="check"><input type="radio" name="delivery_method" value="pickup" checked> Self Pickup</label>
        <label class="check"><input type="radio" name="delivery_method" value="courier"> Courier Delivery</label>
      </div>
      <label>Delivery address (required for courier)
        <textarea name="delivery_address" rows="2" placeholder="Full delivery address including postcode">${V.esc(req.user.address || '')}</textarea>
      </label>
      <label>Needed by date <span class="req-chip">Required</span>
        <input type="date" name="needed_by" min="${minDate}" required>
      </label>
      <button class="btn btn-primary btn-lg" type="submit">Place Order at Quoted Price (${V.rm(q.total)})</button>
    </form>
  </div>
  <div class="card cancel-card">
    <h2>Decline Quotation</h2>
    <form method="post" action="/quotes/${q.id}/decline" class="stack">
      <label>Reason (optional for our records)
        <input name="reason" maxlength="300" placeholder="e.g. over budget">
      </label>
      <button class="btn btn-danger" type="submit">Decline Quotation</button>
    </form>
  </div>` : ''}
  ${expired ? `<a class="btn btn-primary" href="/quotes">Generate a New Quotation</a>` : ''}`;
  render(req, res, { title: `Quotation ${q.quote_no}`, user: req.user, body, active: 'quotes' });
});

// Printable quotation document.
app.get(['/quotes/:id/doc', '/admin/quotes/:id/doc'], (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  const q = getQuote(req.params.id);
  if (!q) return res.status(404).send('Quote not found');
  if (user.role !== 'admin' && q.customer_id !== user.id) return res.status(404).send('Quote not found');
  const items = getQuoteItems(q.id);
  const customerLabel = q.customer_company || q.customer_name;
  const pdfName = `${q.quote_no} - ${customerLabel} - ${V.rm(q.total).replace('RM ', 'RM')}`;
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${V.esc(pdfName)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="invoice-body">
<div class="invoice-actions no-print">
  <a class="btn btn-ghost" href="${user.role === 'admin' ? `/admin/quotes/${q.id}` : `/quotes/${q.id}`}">&larr; Back to Quotation</a>
  <button class="btn btn-primary" onclick="window.print()">Download PDF / Print</button>
</div>
<div class="invoice-sheet">
  <header class="inv-head">
    <div>
      <div class="inv-brand"><span class="brand-mark">A</span> Aramega Textile Sdn Bhd</div>
      <div class="muted small">Order Portal Quotation</div>
    </div>
    <div class="inv-title">
      <h1>QUOTATION</h1>
      <table class="inv-meta">
        <tr><td>Quotation No</td><td><strong>${V.esc(q.quote_no)}</strong></td></tr>
        <tr><td>Date</td><td>${V.esc(V.fmtDate(q.created_at))}</td></tr>
        <tr><td>Valid Until</td><td><strong>${V.esc(fmtDay(q.valid_until))}</strong></td></tr>
      </table>
    </div>
  </header>
  <section class="inv-billto">
    <h3>Prepared For</h3>
    <p><strong>${V.esc(customerLabel)}</strong><br>
    ${V.esc(q.customer_name)}${q.customer_phone ? '<br>' + V.esc(q.customer_phone) : ''}</p>
  </section>
  <table class="table inv-items">
    <thead><tr><th>#</th><th>Description</th><th class="num">Unit Price</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
    <tbody>
    ${items
      .map(
        (i, idx) => `<tr><td>${idx + 1}</td><td>${V.esc(i.description)}</td>
        <td class="num">${V.rm(i.unit_price)} / ${V.esc(i.unit)}</td><td class="num">${i.qty}</td>
        <td class="num">${V.rm(i.line_total)}</td></tr>`
      )
      .join('')}
    </tbody>
    <tfoot>
      <tr><td colspan="4" class="num total-label">Subtotal</td><td class="num">${V.rm(q.subtotal)}</td></tr>
      ${q.sst_percent > 0 ? `<tr><td colspan="4" class="num total-label">SST (${q.sst_percent}%)</td><td class="num">${V.rm(q.sst_amount)}</td></tr>` : ''}
      <tr><td colspan="4" class="num total-label"><strong>TOTAL</strong></td><td class="num inv-total"><strong>${V.rm(q.total)}</strong></td></tr>
    </tfoot>
  </table>
  <section class="inv-payinfo">
    <h3>Terms</h3>
    <p class="small">This quotation is valid until ${V.esc(fmtDay(q.valid_until))}. Prices include your account pricing and bulk discounts.
    To proceed, convert this quotation to an order in the portal — full payment is required before production starts.</p>
    <p style="margin-top:0.5rem">Bank Name: CIMB<br>Beneficiary Name: Aramega Textile Sdn Bhd<br>Account Number: 8605494198</p>
  </section>
</div>
</body>
</html>`);
});

// Accept a quotation: becomes a real order at the quoted prices. Artwork is required.
app.post('/quotes/:id/accept', requireCustomer, runUpload(uploadArtwork), (req, res) => {
  const q = getQuote(req.params.id);
  if (!q || q.customer_id !== req.user.id) return res.status(404).send('Quote not found');
  const bad = (msg) => {
    if (req.file) fs.unlink(req.file.path, () => {});
    flash(req, 'error', msg);
    return res.redirect(`/quotes/${q.id}`);
  };
  // Rule: only an active, unexpired quotation can be converted, and only once.
  if (q.status !== 'quoted') return bad('This quotation has already been decided.');
  if (q.valid_until && q.valid_until < klDatePlus(0)) {
    return bad('This quotation has expired. Generate a new one for current prices.');
  }
  const jobName = String(req.body.job_name || '').trim().slice(0, 100);
  if (!jobName) return bad('Please give this order a job name.');
  // Rule: artwork is mandatory, same as a normal order — either file or link, never both.
  const wetransfer = String(req.body.wetransfer_link || '').trim().slice(0, 500);
  if (!req.file && !wetransfer) return bad('Artwork is required: upload a .zip file or paste a WeTransfer link.');
  if (req.file && wetransfer) return bad('Provide EITHER the artwork zip file OR the WeTransfer link — not both.');
  if (wetransfer && !/^https?:\/\//i.test(wetransfer)) return bad('The WeTransfer link must start with http:// or https://.');
  const method = req.body.delivery_method === 'courier' ? 'courier' : 'pickup';
  const address = String(req.body.delivery_address || '').trim().slice(0, 500);
  if (method === 'courier' && !address) return bad('Delivery address is required for courier delivery.');
  const leadDays = parseInt(setting('lead_days', '3'), 10);
  const minDate = klDatePlus(leadDays);
  const neededBy = String(req.body.needed_by || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy) || neededBy < minDate) {
    return bad(`Please choose a needed-by date of ${fmtDay(minDate)} or later.`);
  }

  const orderId = db.transaction(() => {
    const invNum = nextInvoiceNo();
    const info = db
      .prepare(
        `INSERT INTO orders (order_no, invoice_no, customer_id, job_name, subtotal, sst_percent, sst_amount, total,
          notes, wetransfer_link, delivery_method, delivery_address, needed_by, quote_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        randomOrderNo(), `INV-${invNum}`, req.user.id, jobName, q.subtotal, q.sst_percent, q.sst_amount, q.total,
        `From quotation ${q.quote_no}`, wetransfer, method, address, neededBy, q.id
      );
    const id = info.lastInsertRowid;
    const insItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, product_name, unit, qty, unit_price, line_total)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const i of getQuoteItems(q.id)) insItem.run(id, i.product_id, i.description, i.unit, i.qty, i.unit_price, i.line_total);
    if (req.file) {
      db.prepare('INSERT INTO files (order_id, kind, stored_name, original_name, size) VALUES (?,?,?,?,?)').run(
        id, 'artwork', req.file.filename, req.file.originalname, req.file.size
      );
    }
    db.prepare("UPDATE quotes SET status = 'accepted', decided_at = datetime('now'), order_id = ? WHERE id = ?")
      .run(id, q.id);
    logEvent(id, req.user, 'submitted', `Created from quotation ${q.quote_no} at the quoted prices`);
    return id;
  })();

  flash(req, 'success', 'Order placed at the quoted prices! Your invoice has been generated — please make payment.');
  res.redirect(`/orders/${orderId}`);
});

app.post('/quotes/:id/decline', requireCustomer, (req, res) => {
  const q = getQuote(req.params.id);
  if (!q || q.customer_id !== req.user.id) return res.status(404).send('Quote not found');
  if (q.status !== 'quoted') {
    flash(req, 'error', 'This quotation has already been decided.');
    return res.redirect(`/quotes/${q.id}`);
  }
  db.prepare("UPDATE quotes SET status = 'declined', decline_reason = ?, decided_at = datetime('now') WHERE id = ?")
    .run(String(req.body.reason || '').trim().slice(0, 300), q.id);
  flash(req, 'success', 'Quotation declined. You can generate a new one any time.');
  res.redirect(`/quotes/${q.id}`);
});

// ---- admin: quotations are read-only (they are system-generated) ----

app.get('/admin/quotes', requireAdmin, (req, res) => {
  const filter = String(req.query.status || '');
  const valid = Object.keys(QSTATUS).includes(filter);
  const quotes = db
    .prepare(
      `SELECT q.*, u.name AS customer_name, u.company AS customer_company
       FROM quotes q JOIN users u ON u.id = q.customer_id
       ${valid ? 'WHERE q.status = ?' : ''} ORDER BY q.id DESC`
    )
    .all(...(valid ? [filter] : []));
  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM quotes GROUP BY status').all()) counts[r.status] = r.n;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const tabs = `<div class="tabs">
    <a href="/admin/quotes" class="${!valid ? 'active' : ''}">All (${total})</a>
    ${Object.keys(QSTATUS).map(
      (s) => `<a href="/admin/quotes?status=${s}" class="${filter === s ? 'active' : ''}">${QSTATUS[s].label} (${counts[s] || 0})</a>`
    ).join('')}
  </div>`;
  const body = `
  <div class="page-head"><div><h1>Quotations</h1>
  <p class="muted">Auto-generated by customers at their account prices. An accepted quotation becomes an order automatically.</p></div></div>
  ${tabs}
  ${quotesTable(quotes, true)}`;
  render(req, res, { title: 'Admin - Quotations', user: req.user, body, active: 'quotes' });
});

app.get('/admin/quotes/:id', requireAdmin, (req, res) => {
  const q = getQuote(req.params.id);
  if (!q) return res.status(404).send('Quote not found');
  const body = `
  <div class="page-head">
    <div><h1>Quotation ${V.esc(q.quote_no)}</h1>
      <p class="muted">${V.esc(q.customer_company || q.customer_name)} (${V.esc(q.customer_name)}) &middot; ${V.esc(V.fmtDate(q.created_at))}</p></div>
    <div class="head-actions">${qBadge(q)}
      <a class="btn btn-outline" href="/admin/quotes/${q.id}/doc" target="_blank">View / Print</a>
      ${q.order_id ? `<a class="btn btn-primary" href="/admin/orders/${q.order_id}">View Order</a>` : ''}</div>
  </div>
  <div class="card">
    <h2>Quotation (auto-generated at the customer's prices)</h2>
    ${quoteItemsTable(q)}
    ${q.notes ? `<p class="muted"><strong>Customer notes:</strong> ${V.esc(q.notes)}</p>` : ''}
    <p class="small">Valid until <strong>${V.esc(fmtDay(q.valid_until))}</strong>.</p>
    ${q.decline_reason ? `<p class="muted"><strong>Customer's decline reason:</strong> ${V.esc(q.decline_reason)}</p>` : ''}
  </div>`;
  render(req, res, { title: `Admin - ${q.quote_no}`, user: req.user, body, active: 'quotes' });
});

// ---------- invoice (customer owner or admin) ----------

app.get(['/orders/:id/invoice', '/admin/orders/:id/invoice'], (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  if (user.role !== 'admin' && order.customer_id !== user.id) return res.status(404).send('Order not found');
  const items = getItems(order.id);
  const paid = paidFor(order);
  const balance = round2(order.total - paid);
  const customerLabel = order.customer_company || order.customer_name;
  const pdfName = `${order.invoice_no} - ${customerLabel} - ${V.rm(order.total).replace('RM ', 'RM')}`;
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${V.esc(pdfName)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="invoice-body">
<div class="invoice-actions no-print">
  <a class="btn btn-ghost" href="${user.role === 'admin' ? `/admin/orders/${order.id}` : `/orders/${order.id}`}">&larr; Back to Order</a>
  <button class="btn btn-primary" onclick="window.print()">Download PDF / Print</button>
</div>
<div class="invoice-sheet">
  <header class="inv-head">
    <div>
      <div class="inv-brand"><span class="brand-mark">A</span> Aramega Textile Sdn Bhd</div>
      <div class="muted small">Order Portal Invoice</div>
    </div>
    <div class="inv-title">
      <h1>INVOICE</h1>
      <table class="inv-meta">
        <tr><td>Invoice No</td><td><strong>${V.esc(order.invoice_no)}</strong></td></tr>
        <tr><td>Order No</td><td>${V.esc(order.order_no)}</td></tr>
        ${order.job_name ? `<tr><td>Job</td><td>${V.esc(order.job_name)}</td></tr>` : ''}
        <tr><td>Date</td><td>${V.esc(V.fmtDate(order.created_at))}</td></tr>
        <tr><td>Needed by</td><td>${V.esc(fmtDay(order.needed_by))}</td></tr>
        <tr><td>Delivery</td><td>${order.delivery_method === 'courier' ? 'Courier' : 'Self Pickup'}</td></tr>
        <tr><td>Status</td><td>${balance <= 0 ? '<strong class="paid">PAID IN FULL</strong>' : paid > 0 ? `<strong class="unpaid">PARTIALLY PAID (${V.rm(paid)})</strong>` : '<strong class="unpaid">AWAITING PAYMENT</strong>'}</td></tr>
      </table>
    </div>
  </header>
  <section class="inv-billto">
    <h3>Bill To</h3>
    <p><strong>${V.esc(customerLabel)}</strong><br>
    ${V.esc(order.customer_name)}${order.customer_phone ? '<br>' + V.esc(order.customer_phone) : ''}
    ${order.delivery_method === 'courier' && order.delivery_address ? '<br>' + V.esc(order.delivery_address) : ''}</p>
  </section>
  <table class="table inv-items">
    <thead><tr><th>#</th><th>Description</th><th class="num">Unit Price</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
    <tbody>
    ${items
      .map(
        (i, idx) => `<tr><td>${idx + 1}</td><td>${V.esc(i.product_name)}</td>
        <td class="num">${V.rm(i.unit_price)} / ${V.esc(i.unit)}</td><td class="num">${i.qty}</td>
        <td class="num">${V.rm(i.line_total)}</td></tr>`
      )
      .join('')}
    </tbody>
    <tfoot>
      <tr><td colspan="4" class="num total-label">Subtotal</td><td class="num">${V.rm(order.subtotal)}</td></tr>
      ${order.is_express ? `<tr><td colspan="4" class="num total-label">Rush Order Surcharge (${order.express_percent}%)</td><td class="num">${V.rm(order.express_amount)}</td></tr>` : ''}
      ${order.discount_amount > 0 ? `<tr><td colspan="4" class="num total-label">Promo Discount (${V.esc(order.promo_code)})</td><td class="num">- ${V.rm(order.discount_amount)}</td></tr>` : ''}
      ${order.sst_percent > 0 ? `<tr><td colspan="4" class="num total-label">SST (${order.sst_percent}%)</td><td class="num">${V.rm(order.sst_amount)}</td></tr>` : ''}
      <tr><td colspan="4" class="num total-label"><strong>TOTAL</strong></td><td class="num inv-total"><strong>${V.rm(order.total)}</strong></td></tr>
      ${order.credit_applied > 0 ? `<tr><td colspan="4" class="num total-label">Store Credit Applied</td><td class="num">- ${V.rm(order.credit_applied)}</td></tr>` : ''}
      ${paid > 0 ? `<tr><td colspan="4" class="num total-label">Paid</td><td class="num">${V.rm(paid)}</td></tr>
      <tr><td colspan="4" class="num total-label"><strong>BALANCE DUE</strong></td><td class="num inv-total"><strong>${V.rm(Math.max(balance, 0))}</strong></td></tr>` : ''}
    </tfoot>
  </table>
  <section class="inv-payinfo">
    <h3>Payment Info:</h3>
    <p>Bank Name: CIMB<br>
    Beneficiary Name: Aramega Textile Sdn Bhd<br>
    Account Number: 8605494198</p>
    <p class="muted small">Full payment is required before production starts, and must be verified within 3 hours of order submission or the order is cancelled automatically. Please upload your bank receipt on the order page after making payment.</p>
  </section>
</div>
</body>
</html>`);
});

// ---------- file download (owner or admin) ----------

app.get('/files/:id', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).send('File not found');
  if (user.role !== 'admin') {
    const owner = f.order_id
      ? getOrder(f.order_id)
      : f.quote_id
        ? db.prepare('SELECT customer_id FROM quotes WHERE id = ?').get(f.quote_id)
        : null;
    if (!owner || owner.customer_id !== user.id) return res.status(404).send('File not found');
  }
  res.download(path.join(UPLOAD_DIR, f.stored_name), f.original_name);
});

// Artwork template download (any logged-in user).
app.get('/products/:id/template', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p || !p.template_stored) return res.status(404).send('No template for this product');
  res.download(path.join(UPLOAD_DIR, p.template_stored), p.template_name || 'template');
});

// ---------- admin: orders ----------

app.get('/admin', requireAdmin, (req, res) => {
  sweepUnpaidOrders();
  const filter = String(req.query.status || '');
  const q = String(req.query.q || '').trim();
  const allStatuses = ['submitted', 'needs_revision', 'confirmed', 'completed', 'delivered', 'cancelled'];
  const valid = allStatuses.includes(filter);
  const where = [];
  const params = [];
  if (valid) { where.push('o.status = ?'); params.push(filter); }
  if (q) {
    where.push('(o.order_no LIKE ? OR o.invoice_no LIKE ? OR u.name LIKE ? OR u.company LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const orders = db
    .prepare(
      `SELECT o.*, u.name AS customer_name, u.company AS customer_company
       FROM orders o JOIN users u ON u.id = o.customer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC`
    )
    .all(...params);
  const pendingPayments = db
    .prepare("SELECT order_id, COUNT(*) AS n FROM payments WHERE status = 'pending' GROUP BY order_id")
    .all();
  const pendingByOrder = Object.fromEntries(pendingPayments.map((p) => [p.order_id, p.n]));
  for (const o of orders) {
    if (pendingByOrder[o.id]) o.action_note = `${pendingByOrder[o.id]} payment(s) to verify`;
    else if (o.status === 'cancelled' && o.refund_status === '' && paidFor(o) > 0) o.action_note = 'Payment to resolve';
  }

  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all()) counts[r.status] = r.n;
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const sales = db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status != 'cancelled'").get().s;
  const unverified = (counts.submitted || 0) + (counts.needs_revision || 0);
  const pendingPayCount = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").get().n;
  const toResolve = db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled' AND refund_status = ''")
    .all()
    .reduce((s, r) => s + r.n, 0);

  const quoteRequests = db
    .prepare("SELECT COUNT(*) AS n FROM quotes WHERE status = 'quoted' AND valid_until >= ?")
    .get(klDatePlus(0)).n;
  const stats = `<div class="stat-row">
    <div class="stat-card"><span class="stat-num">${unverified}</span><span class="stat-label">Awaiting verification</span></div>
    <div class="stat-card"><span class="stat-num">${pendingPayCount}</span><span class="stat-label">Payments to verify</span></div>
    <div class="stat-card"><a href="/admin/quotes?status=quoted" class="stat-link"><span class="stat-num">${quoteRequests}</span><span class="stat-label">Active quotations</span></a></div>
    <div class="stat-card"><span class="stat-num">${counts.confirmed || 0}</span><span class="stat-label">In production</span></div>
    <div class="stat-card"><span class="stat-num">${counts.completed || 0}</span><span class="stat-label">Ready / to deliver</span></div>
    <div class="stat-card"><span class="stat-num">${V.rm(sales)}</span><span class="stat-label">Total order value</span></div>
  </div>`;

  const tabs = `<div class="tabs">
    <a href="/admin" class="${!valid && !q ? 'active' : ''}">All (${totalCount})</a>
    ${allStatuses.map(
      (s) => `<a href="/admin?status=${s}" class="${filter === s ? 'active' : ''}">${V.esc(V.STATUS[s].label)} (${counts[s] || 0})</a>`
    ).join('')}
  </div>
  <form method="get" action="/admin" class="search-form">
    ${valid ? `<input type="hidden" name="status" value="${V.esc(filter)}">` : ''}
    <input name="q" value="${V.esc(q)}" placeholder="Search order no, invoice no or customer...">
    <button class="btn btn-outline" type="submit">Search</button>
    ${q ? `<a class="btn btn-ghost" href="/admin">Clear</a>` : ''}
    <a class="btn btn-ghost" href="/admin/export.csv">Export CSV</a>
  </form>`;
  const body = `
  <div class="page-head"><div><h1>All Orders</h1><p class="muted">Review, verify and update customer orders.</p></div></div>
  ${stats}
  ${tabs}
  ${V.ordersTable(orders, { adminView: true })}`;
  render(req, res, { title: 'Admin - Orders', user: req.user, body, active: 'orders' });
});

app.get('/admin/export.csv', requireAdmin, (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.*, u.name AS customer_name, u.company AS customer_company
       FROM orders o JOIN users u ON u.id = o.customer_id ORDER BY o.id`
    )
    .all();
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = ['Order No', 'Invoice No', 'Job Name', 'Customer', 'Company', 'Status', 'Created', 'Subtotal', 'SST %', 'SST', 'Total',
    'Credit Applied', 'Paid (verified)', 'Balance Due', 'Delivery', 'Needed By', 'ETA', 'Tracking No', 'Refund Resolution'];
  const lines = [head.map(esc).join(',')];
  for (const o of orders) {
    const paid = paidFor(o);
    lines.push([
      o.order_no, o.invoice_no, o.job_name, o.customer_name, o.customer_company, V.STATUS[o.status].label, o.created_at,
      o.subtotal.toFixed(2), o.sst_percent, o.sst_amount.toFixed(2), o.total.toFixed(2),
      o.credit_applied.toFixed(2), paid.toFixed(2), Math.max(round2(o.total - paid), 0).toFixed(2),
      o.delivery_method, o.needed_by, o.eta_date, o.tracking_no, o.refund_status,
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="aramega-orders-${klDatePlus(0)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

app.get('/admin/orders/:id', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const allChecked = order.chk_artwork && order.chk_product && order.chk_payment;
  const paid = paidFor(order);
  const balance = round2(order.total - paid);
  const minEta = klDatePlus(0);

  let actionBtn = '';
  if (order.status === 'submitted') {
    actionBtn = `
      <label>Estimated ready date <span class="req-chip">Required to confirm</span>
        <input type="date" name="eta_date" min="${minEta}" value="${V.esc(order.eta_date)}" ${allChecked ? 'required' : ''}>
      </label>
      <button class="btn btn-primary btn-lg" type="submit" name="action" value="confirm" ${allChecked ? '' : 'disabled'}>
      Confirm Order</button>
      ${allChecked ? '' : '<p class="muted small">Complete all three verification checks (and save) to enable confirmation.</p>'}`;
  } else if (order.status === 'needs_revision') {
    actionBtn = `<p class="muted">Waiting for the customer to fix the issue and resubmit. Reason sent: <strong>${V.esc(order.revision_reason)}</strong></p>`;
  } else if (order.status === 'confirmed') {
    actionBtn = `<button class="btn btn-primary btn-lg" type="submit" name="action" value="complete">Mark as Order Complete</button>`;
  } else if (order.status === 'completed') {
    actionBtn = `
      ${balance > 0 ? `<p class="muted small"><strong>Balance due: ${V.rm(balance)}.</strong> Full payment is required before the order can be marked as delivered.</p>` : ''}
      ${order.delivery_method === 'courier' ? `
      <label>Courier tracking number <span class="req-chip">Required for courier delivery</span>
        <input name="tracking_no" value="${V.esc(order.tracking_no)}" required placeholder="e.g. J&amp;T / GDEX tracking no.">
      </label>` : ''}
      <button class="btn btn-primary btn-lg" type="submit" name="action" value="deliver" ${balance > 0 ? 'disabled' : ''}>Mark as Delivered</button>`;
  } else if (order.status === 'delivered') {
    actionBtn = `<p class="muted">This order has been delivered. Nothing further to do.</p>`;
  } else {
    actionBtn = `<p class="muted">This order was cancelled.</p>`;
  }

  const verifySection = order.status === 'cancelled' ? '' : `
  <div class="card verify-card">
    <h2>Admin Verification</h2>
    <form method="post" action="/admin/orders/${order.id}/checks" class="stack">
      <label class="check"><input type="checkbox" name="chk_artwork" ${order.chk_artwork ? 'checked' : ''}>
        Artwork checked and correct</label>
      <label class="check"><input type="checkbox" name="chk_product" ${order.chk_product ? 'checked' : ''}>
        Product &amp; quantity checked and correct</label>
      <label class="check"><input type="checkbox" name="chk_payment" ${order.chk_payment ? 'checked' : ''}>
        Payment received and verified
        ${balance > 0.005 ? `<span class="req-chip">needs full payment (${V.rm(order.total)}) verified &mdash; currently ${V.rm(paid)}</span>` : ''}</label>
      <button class="btn btn-outline" type="submit">Save Verification</button>
    </form>
    ${order.status === 'submitted' ? `
    <hr class="divider">
    <h3 class="sub-h">Found a problem? Send it back instead of cancelling</h3>
    <form method="post" action="/admin/orders/${order.id}/request-revision" class="stack">
      <label>What must the customer fix? <span class="req-chip">Required</span>
        <input name="reason" required maxlength="300" placeholder="e.g. artwork is low resolution — please re-upload at 300dpi">
      </label>
      <button class="btn btn-outline" type="submit">Request Revision from Customer</button>
    </form>` : ''}
    <hr class="divider">
    <form method="post" action="/admin/orders/${order.id}/status" class="stack">
      ${actionBtn}
    </form>
    ${['submitted', 'needs_revision', 'confirmed'].includes(order.status) ? `
    <hr class="divider">
    <details>
      <summary class="muted">Cancel this order (admin)</summary>
      <form method="post" action="/admin/orders/${order.id}/cancel" class="stack" style="margin-top:0.75rem"
        onsubmit="return confirm('Cancel this order? This cannot be undone.')">
        <label>Reason <input name="reason" required maxlength="300" placeholder="Reason shown to the customer"></label>
        <button class="btn btn-danger" type="submit">Cancel Order</button>
      </form>
      <p class="muted small">If the customer has verified payments, you will be asked to refund or convert them to store credit after cancelling.</p>
    </details>` : ''}
  </div>`;

  const deliveryProof = ['completed', 'delivered'].includes(order.status) ? `
  <div class="card">
    <h2>Delivery Proof / DO</h2>
    ${getFiles(order.id, 'delivery').length ? `<ul class="file-list">${getFiles(order.id, 'delivery').map((f) => fileCard(f)).join('')}</ul>` : '<p class="muted">No delivery proof uploaded yet.</p>'}
    <form method="post" action="/admin/orders/${order.id}/delivery-proof" enctype="multipart/form-data" class="stack">
      <label>Upload DO / delivery photo (PDF or image, max 20MB)
        <input type="file" name="proof" accept=".pdf,.jpg,.jpeg,.png,.webp" required>
      </label>
      <button class="btn btn-outline" type="submit">Upload Delivery Proof</button>
    </form>
  </div>` : '';

  const body = `
  <div class="page-head">
    <div><h1>Order ${V.esc(order.order_no)}</h1>
      <p class="muted">${order.job_name ? `<strong>${V.esc(order.job_name)}</strong> &middot; ` : ''}${V.esc(order.customer_company || order.customer_name)} &middot; Submitted ${V.esc(V.fmtDate(order.created_at))} &middot; Last update ${V.esc(V.fmtDate(order.updated_at || order.created_at))}</p></div>
    <div class="head-actions">
      ${V.statusBadge(order.status)}
      <a class="btn btn-outline" href="/admin/orders/${order.id}/invoice" target="_blank">View Invoice</a>
    </div>
  </div>
  ${refundBanner(order, { isAdmin: true })}
  <div class="card"><h2>Order Status</h2>${V.timeline(order)}</div>
  ${historySection(order)}
  <div class="grid-2">
    ${itemsCard(order, 'Customer notes')}
    ${deliveryCard(order, getFiles(order.id, 'delivery'))}
  </div>
  <div class="grid-2">
    ${artworkCard(order, { isAdmin: true })}
    ${paymentsCard(order, { isAdmin: true })}
  </div>
  ${verifySection}
  ${deliveryProof}`;
  render(req, res, { title: `Admin - ${order.order_no}`, user: req.user, body, active: 'orders' });
});

app.post('/admin/orders/:id/checks', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  // Rule: "payment received" can only be ticked once verified payments (plus credit)
  // cover the full order total.
  const paid = paidFor(order);
  if (req.body.chk_payment && paid + 0.005 < order.total) {
    flash(req, 'error', `Cannot mark payment as received: verified payments are ${V.rm(paid)} but full payment of ${V.rm(order.total)} is required. Verify the customer's payment first (Payments section).`);
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare('UPDATE orders SET chk_artwork = ?, chk_product = ?, chk_payment = ? WHERE id = ?').run(
    req.body.chk_artwork ? 1 : 0,
    req.body.chk_product ? 1 : 0,
    req.body.chk_payment ? 1 : 0,
    order.id
  );
  touchOrder(order.id);
  flash(req, 'success', 'Verification saved.');
  res.redirect(`/admin/orders/${order.id}`);
});

// Admin sends the order back to the customer with a reason instead of cancelling.
app.post('/admin/orders/:id/request-revision', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  if (order.status !== 'submitted') {
    flash(req, 'error', 'Revisions can only be requested on submitted orders.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) {
    flash(req, 'error', 'Tell the customer what they need to fix.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  // The artwork check is reset — it must be re-checked after the fix.
  db.prepare("UPDATE orders SET status = 'needs_revision', revision_reason = ?, chk_artwork = 0 WHERE id = ?")
    .run(reason, order.id);
  logEvent(order.id, req.user, 'revision_requested', reason);
  flash(req, 'success', 'Revision requested. The customer sees the reason and can resubmit after fixing it.');
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/payments', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const amount = round2(parseFloat(req.body.amount));
  const ref = String(req.body.bank_ref || '').trim().slice(0, 200);
  if (isNaN(amount) || amount <= 0 || !ref) {
    flash(req, 'error', 'A positive amount and a bank reference / note are required to record a payment.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const balance = round2(order.total - paidFor(order));
  if (amount > balance + 0.005) {
    flash(req, 'error', `That amount (${V.rm(amount)}) exceeds the balance due (${V.rm(balance)}).`);
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare(
    "INSERT INTO payments (order_id, amount, bank_ref, status, source, resolved_at) VALUES (?,?,?,'verified','admin',datetime('now'))"
  ).run(order.id, amount, ref);
  logEvent(order.id, req.user, 'payment_recorded', `${V.rm(amount)} ref ${ref}`);
  flash(req, 'success', `Payment of ${V.rm(amount)} recorded as verified.`);
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/payments/:pid/verify', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  const p = db.prepare('SELECT * FROM payments WHERE id = ? AND order_id = ?').get(req.params.pid, req.params.id);
  if (!order || !p) return res.status(404).send('Not found');
  if (p.status !== 'pending') {
    flash(req, 'error', 'This payment has already been resolved.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare("UPDATE payments SET status = 'verified', resolved_at = datetime('now') WHERE id = ?").run(p.id);
  logEvent(order.id, req.user, 'payment_verified', V.rm(p.amount));
  flash(req, 'success', `Payment of ${V.rm(p.amount)} verified.`);
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/payments/:pid/reject', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  const p = db.prepare('SELECT * FROM payments WHERE id = ? AND order_id = ?').get(req.params.pid, req.params.id);
  if (!order || !p) return res.status(404).send('Not found');
  if (p.status !== 'pending') {
    flash(req, 'error', 'This payment has already been resolved.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const note = String(req.body.note || '').trim().slice(0, 300);
  if (!note) {
    flash(req, 'error', 'Give a reason for rejecting the payment (shown to the customer).');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare("UPDATE payments SET status = 'rejected', note = ?, resolved_at = datetime('now') WHERE id = ?").run(note, p.id);
  logEvent(order.id, req.user, 'payment_rejected', `${V.rm(p.amount)} — ${note}`);
  flash(req, 'success', 'Payment rejected. The customer can see the reason and submit again.');
  res.redirect(`/admin/orders/${order.id}`);
});

// Resolve verified money on a cancelled order: refund by bank, or convert to store credit.
app.post('/admin/orders/:id/resolve-payment', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const paid = paidFor(order);
  if (order.status !== 'cancelled' || order.refund_status !== '' || paid <= 0) {
    flash(req, 'error', 'There is nothing to resolve on this order.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const mode = req.body.mode === 'refund' ? 'refunded' : 'credited';
  const ref = String(req.body.refund_ref || '').trim().slice(0, 200);
  const note = String(req.body.note || '').trim().slice(0, 300);
  // Rule: a bank refund must carry the transfer reference.
  if (mode === 'refunded' && !ref) {
    flash(req, 'error', 'Enter the bank transfer reference for the refund.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.transaction(() => {
    db.prepare(
      "UPDATE orders SET refund_status = ?, refund_ref = ?, refund_note = ?, refund_resolved_at = datetime('now') WHERE id = ?"
    ).run(mode, ref, note, order.id);
    if (mode === 'credited') {
      db.prepare('INSERT INTO credits (customer_id, amount, order_id, note) VALUES (?,?,?,?)').run(
        order.customer_id, paid, order.id, `Credit from cancelled ${order.order_no}`
      );
    }
    logEvent(order.id, req.user, 'refund_resolved',
      mode === 'refunded' ? `Refunded ${V.rm(paid)} (ref ${ref})` : `Converted ${V.rm(paid)} to store credit`);
  })();
  flash(req, 'success', mode === 'refunded'
    ? `Refund of ${V.rm(paid)} recorded.`
    : `${V.rm(paid)} converted to store credit for ${order.customer_name}.`);
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/delivery-proof', requireAdmin, runUpload(uploadDelivery), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  if (!['completed', 'delivered'].includes(order.status)) {
    flash(req, 'error', 'Delivery proof can be added once the order is complete.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  if (!req.file) {
    flash(req, 'error', 'No file selected.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare('INSERT INTO files (order_id, kind, stored_name, original_name, size) VALUES (?,?,?,?,?)').run(
    order.id, 'delivery', req.file.filename, req.file.originalname, req.file.size
  );
  logEvent(order.id, req.user, 'delivery_proof', req.file.originalname);
  flash(req, 'success', 'Delivery proof uploaded.');
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/status', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const action = req.body.action;
  if (action === 'confirm' && order.status === 'submitted') {
    if (!(order.chk_artwork && order.chk_product && order.chk_payment)) {
      flash(req, 'error', 'All three verification checks must be completed before confirming.');
      return res.redirect(`/admin/orders/${order.id}`);
    }
    // Rule: re-verify full payment at confirmation time (a payment may have been rejected since).
    const paid = paidFor(order);
    if (paid + 0.005 < order.total) {
      flash(req, 'error', `Cannot confirm: verified payments are ${V.rm(paid)} but full payment of ${V.rm(order.total)} is required.`);
      return res.redirect(`/admin/orders/${order.id}`);
    }
    // Rule: confirming requires an estimated ready date for the customer.
    const eta = String(req.body.eta_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eta)) {
      flash(req, 'error', 'Please set an estimated ready date before confirming the order.');
      return res.redirect(`/admin/orders/${order.id}`);
    }
    db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = datetime('now'), eta_date = ? WHERE id = ?")
      .run(eta, order.id);
    logEvent(order.id, req.user, 'confirmed', `Estimated ready ${fmtDay(eta)}`);
    flash(req, 'success', `Order ${order.order_no} confirmed. Estimated ready: ${fmtDay(eta)}.`);
  } else if (action === 'complete' && order.status === 'confirmed') {
    db.prepare("UPDATE orders SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(order.id);
    logEvent(order.id, req.user, 'completed', '');
    flash(req, 'success', `Order ${order.order_no} marked as complete.`);
  } else if (action === 'deliver' && order.status === 'completed') {
    // Rule: full payment before delivery.
    const balance = round2(order.total - paidFor(order));
    if (balance > 0.005) {
      flash(req, 'error', `Cannot mark as delivered: balance of ${V.rm(balance)} is still due. Full payment is required before delivery.`);
      return res.redirect(`/admin/orders/${order.id}`);
    }
    // Rule: courier orders need a tracking number before they can be marked delivered.
    const tracking = String(req.body.tracking_no || '').trim().slice(0, 100);
    if (order.delivery_method === 'courier' && !tracking) {
      flash(req, 'error', 'Enter the courier tracking number before marking this order as delivered.');
      return res.redirect(`/admin/orders/${order.id}`);
    }
    db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now'), tracking_no = ? WHERE id = ?")
      .run(tracking, order.id);
    logEvent(order.id, req.user, 'delivered', tracking ? `Tracking ${tracking}` : '');
    flash(req, 'success', `Order ${order.order_no} marked as delivered.`);
  } else {
    flash(req, 'error', 'Invalid status change.');
  }
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/cancel', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  // Rule: admin can cancel before production is finished.
  if (!['submitted', 'needs_revision', 'confirmed'].includes(order.status)) {
    flash(req, 'error', 'Only submitted, revision or confirmed orders can be cancelled.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) {
    flash(req, 'error', 'Please give a reason for the cancellation.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?")
    .run(reason, order.id);
  logEvent(order.id, req.user, 'cancelled', reason);
  const paid = paidFor(order);
  flash(req, 'success', `Order ${order.order_no} cancelled.${paid > 0 ? ` The customer has ${V.rm(paid)} paid — resolve it as refund or store credit below.` : ''}`);
  res.redirect(`/admin/orders/${order.id}`);
});

// ---------- admin: products ----------

function tiersText(productId) {
  return tiersFor(productId).map((t) => `${t.min_qty}=${t.price}`).join(', ');
}
function parseTiers(text) {
  const tiers = [];
  for (const part of String(text || '').split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const m = piece.match(/^(\d+)\s*[=:]\s*(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    tiers.push({ min_qty: parseInt(m[1], 10), price: parseFloat(m[2]) });
  }
  return tiers;
}
function saveTiers(productId, tiers) {
  db.prepare('DELETE FROM price_tiers WHERE product_id = ?').run(productId);
  const ins = db.prepare('INSERT INTO price_tiers (product_id, min_qty, price) VALUES (?,?,?)');
  for (const t of tiers) ins.run(productId, t.min_qty, t.price);
}

app.get('/admin/products', requireAdmin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY active DESC, name').all();
  const rows = products
    .map(
      (p) => `<form method="post" action="/admin/products/${p.id}" enctype="multipart/form-data" class="product-row card ${p.active ? '' : 'inactive'}">
      <div class="grid-fields">
        <label>Name<input name="name" value="${V.esc(p.name)}" required></label>
        <label>Unit<input name="unit" value="${V.esc(p.unit)}" required></label>
        <label>Base Price (RM)<input name="base_price" type="number" step="0.01" min="0" value="${p.base_price}" required></label>
        <label>Min Order Qty<input name="moq" type="number" step="1" min="1" value="${p.moq}" required></label>
      </div>
      <label>Description<input name="description" value="${V.esc(p.description)}"></label>
      <label>Artwork requirements (shown to customers)<input name="artwork_spec" value="${V.esc(p.artwork_spec)}" placeholder="e.g. 300dpi PNG or AI file"></label>
      <label>Bulk price tiers <span class="muted small">(format: minQty=price, e.g. 50=22.50, 100=19.90 — blank for none)</span>
        <input name="tiers" value="${V.esc(tiersText(p.id))}" placeholder="50=22.50, 100=19.90"></label>
      <label>Artwork template file ${p.template_stored ? `<span class="muted small">(current: <a href="/products/${p.id}/template">${V.esc(p.template_name)}</a> — upload to replace)</span>` : '<span class="muted small">(customers can download this from the order form)</span>'}
        <input type="file" name="template" accept=".zip,.pdf,.ai,.psd,.jpg,.jpeg,.png"></label>
      <div class="row-actions">
        <button class="btn btn-outline btn-sm" type="submit" name="action" value="save">Save</button>
        <button class="btn btn-ghost btn-sm" type="submit" name="action" value="${p.active ? 'deactivate' : 'activate'}">
          ${p.active ? 'Deactivate' : 'Reactivate'}</button>
      </div>
    </form>`
    )
    .join('');
  const body = `
  <div class="page-head"><div><h1>Products</h1><p class="muted">Base prices apply unless a bulk tier or a customer-specific price applies. A customer-specific price always wins.</p></div></div>
  <div class="card">
    <h2>Add Product</h2>
    <form method="post" action="/admin/products" enctype="multipart/form-data" class="stack">
      <div class="grid-fields">
        <label>Name<input name="name" required></label>
        <label>Unit<input name="unit" value="pcs" required></label>
        <label>Base Price (RM)<input name="base_price" type="number" step="0.01" min="0" required></label>
        <label>Min Order Qty<input name="moq" type="number" step="1" min="1" value="1" required></label>
      </div>
      <label>Description<input name="description"></label>
      <label>Artwork requirements<input name="artwork_spec" placeholder="e.g. 300dpi PNG or AI file"></label>
      <label>Bulk price tiers <span class="muted small">(minQty=price, comma separated)</span><input name="tiers" placeholder="50=22.50, 100=19.90"></label>
      <label>Artwork template file (optional — customers can download it)
        <input type="file" name="template" accept=".zip,.pdf,.ai,.psd,.jpg,.jpeg,.png"></label>
      <button class="btn btn-primary" type="submit">Add Product</button>
    </form>
  </div>
  <h2 class="section-title">Existing Products</h2>
  ${rows}`;
  render(req, res, { title: 'Admin - Products', user: req.user, body, active: 'products' });
});

function productFieldsValid(req) {
  const price = parseFloat(req.body.base_price);
  const moq = parseInt(req.body.moq, 10);
  if (!req.body.name || isNaN(price) || price < 0 || isNaN(moq) || moq < 1) return null;
  const tiers = parseTiers(req.body.tiers);
  if (tiers === null) return null;
  return { price, moq, tiers };
}

app.post('/admin/products', requireAdmin, runUpload(uploadTemplate), (req, res) => {
  const v = productFieldsValid(req);
  if (!v) {
    if (req.file) fs.unlink(req.file.path, () => {});
    flash(req, 'error', 'Check the product fields: name, valid price, min order qty of at least 1, and tiers in the form 50=22.50, 100=19.90.');
    return res.redirect('/admin/products');
  }
  const info = db.prepare(
    'INSERT INTO products (name, description, unit, base_price, moq, artwork_spec, template_stored, template_name) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    String(req.body.name).trim().slice(0, 200),
    String(req.body.description || '').trim().slice(0, 500),
    String(req.body.unit || 'pcs').trim().slice(0, 30),
    v.price, v.moq,
    String(req.body.artwork_spec || '').trim().slice(0, 300),
    req.file ? req.file.filename : '',
    req.file ? req.file.originalname : ''
  );
  saveTiers(info.lastInsertRowid, v.tiers);
  flash(req, 'success', 'Product added.');
  res.redirect('/admin/products');
});

app.post('/admin/products/:id', requireAdmin, runUpload(uploadTemplate), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Product not found');
  if (req.body.action === 'deactivate' || req.body.action === 'activate') {
    db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.action === 'activate' ? 1 : 0, p.id);
    flash(req, 'success', `Product ${req.body.action === 'activate' ? 'reactivated' : 'deactivated'}.`);
  } else {
    const v = productFieldsValid(req);
    if (!v) {
      if (req.file) fs.unlink(req.file.path, () => {});
      flash(req, 'error', 'Check the product fields: name, valid price, min order qty of at least 1, and tiers in the form 50=22.50, 100=19.90.');
      return res.redirect('/admin/products');
    }
    db.prepare('UPDATE products SET name = ?, description = ?, unit = ?, base_price = ?, moq = ?, artwork_spec = ? WHERE id = ?').run(
      String(req.body.name).trim().slice(0, 200),
      String(req.body.description || '').trim().slice(0, 500),
      String(req.body.unit || 'pcs').trim().slice(0, 30),
      v.price, v.moq,
      String(req.body.artwork_spec || '').trim().slice(0, 300),
      p.id
    );
    if (req.file) {
      db.prepare('UPDATE products SET template_stored = ?, template_name = ? WHERE id = ?')
        .run(req.file.filename, req.file.originalname, p.id);
    }
    saveTiers(p.id, v.tiers);
    flash(req, 'success', 'Product updated.');
  }
  res.redirect('/admin/products');
});

// ---------- admin: customers, pricing & settings ----------

app.get('/admin/customers', requireAdmin, (req, res) => {
  const customers = db.prepare("SELECT * FROM users WHERE role = 'customer' ORDER BY active DESC, name").all();
  const rows = customers
    .map(
      (c) => {
        const credit = creditBalance(c.id);
        return `<tr class="${c.active ? '' : 'inactive'}">
      <td data-label="Name"><strong>${V.esc(c.name)}</strong><div class="muted small">${V.esc(c.company)}</div></td>
      <td data-label="Username"><code>${V.esc(c.username)}</code></td>
      <td data-label="Phone">${V.esc(c.phone || '-')}</td>
      <td data-label="Credit" class="num">${credit > 0 ? `<strong>${V.rm(credit)}</strong>` : '-'}</td>
      <td data-label="Status">${c.active ? '<span class="badge badge-confirmed">Active</span>' : '<span class="badge">Disabled</span>'}</td>
      <td data-label="Actions" class="row-actions">
        <a class="btn btn-outline btn-sm" href="/admin/customers/${c.id}/pricing">Set Pricing</a>
        <details class="inline-details">
          <summary class="btn btn-ghost btn-sm">Reset Password</summary>
          <form method="post" action="/admin/customers/${c.id}/password" class="inline-form">
            <input name="password" type="text" minlength="6" placeholder="New password" required>
            <button class="btn btn-outline btn-sm" type="submit">Save</button>
          </form>
        </details>
        <form method="post" action="/admin/customers/${c.id}/active" class="inline-form">
          <button class="btn btn-ghost btn-sm" type="submit">${c.active ? 'Disable' : 'Enable'}</button>
        </form>
      </td>
    </tr>`;
      }
    )
    .join('');
  const body = `
  <div class="page-head"><div><h1>Customers &amp; Pricing</h1>
  <p class="muted">Create customer logins (give them the username &amp; password), and set each customer's prices.</p></div></div>
  <div class="card">
    <h2>Add Customer</h2>
    <form method="post" action="/admin/customers" class="stack">
      <div class="grid-fields">
        <label>Contact Name<input name="name" required></label>
        <label>Company<input name="company"></label>
        <label>Phone<input name="phone"></label>
      </div>
      <div class="grid-fields">
        <label>Username<input name="username" required autocomplete="off"></label>
        <label>Password<input name="password" type="text" minlength="6" required autocomplete="off"></label>
      </div>
      <button class="btn btn-primary" type="submit">Create Customer Login</button>
    </form>
  </div>
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Customer</th><th>Username</th><th>Phone</th><th class="num">Store Credit</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">No customers yet.</td></tr>'}</tbody>
  </table></div>
  <div class="card">
    <h2>Portal Settings</h2>
    <form method="post" action="/admin/settings" class="stack">
      <div class="grid-fields">
        <label>WhatsApp number <span class="muted small">(shown to customers as a floating button, e.g. 60123456789)</span>
          <input name="whatsapp" value="${V.esc(setting('whatsapp', ''))}" placeholder="60123456789"></label>
        <label>SST % <span class="muted small">(0 = no SST line on invoices)</span>
          <input name="sst_percent" type="number" step="0.1" min="0" max="50" value="${V.esc(setting('sst_percent', '0'))}"></label>
        <label>Production lead time (days) <span class="muted small">(earliest needed-by date)</span>
          <input name="lead_days" type="number" step="1" min="0" max="60" value="${V.esc(setting('lead_days', '3'))}"></label>
        <label>Quotation validity (days) <span class="muted small">(auto-generated quotes expire after this)</span>
          <input name="quote_valid_days" type="number" step="1" min="1" max="90" value="${V.esc(setting('quote_valid_days', '14'))}"></label>
        <label>Rush order surcharge % <span class="muted small">(0 = rush orders off)</span>
          <input name="express_percent" type="number" step="1" min="0" max="100" value="${V.esc(setting('express_percent', '20'))}"></label>
        <label>Rush order lead time (days) <span class="muted small">(must be shorter than normal lead time)</span>
          <input name="express_lead_days" type="number" step="1" min="0" max="30" value="${V.esc(setting('express_lead_days', '1'))}"></label>
      </div>
      <button class="btn btn-primary" type="submit">Save Settings</button>
    </form>
  </div>
  <div class="card">
    <h2>Promo Codes</h2>
    <p class="muted small">Give a customer a code instead of negotiating discounts. "% off order" discounts the whole order (same effect as reducing all product prices); "RM off order" takes a fixed amount off.</p>
    <form method="post" action="/admin/promos" class="stack">
      <div class="grid-fields">
        <label>Code<input name="code" required maxlength="30" placeholder="SAVE10" style="text-transform:uppercase"></label>
        <label>Type
          <select name="kind"><option value="percent">% off order</option><option value="fixed">RM off order</option></select></label>
        <label>Value<input name="value" type="number" step="0.01" min="0.01" required placeholder="10"></label>
        <label>Expires (optional)<input name="expires" type="date" min="${klDatePlus(1)}"></label>
        <label>Max uses (0 = unlimited)<input name="max_uses" type="number" step="1" min="0" value="0"></label>
      </div>
      <button class="btn btn-primary" type="submit">Create Promo Code</button>
    </form>
    ${(() => {
      const promos = db.prepare('SELECT * FROM promo_codes ORDER BY active DESC, id DESC').all();
      if (!promos.length) return '';
      return `<div class="table-wrap" style="margin-top:1rem"><table class="table">
        <thead><tr><th>Code</th><th>Discount</th><th>Expires</th><th class="num">Used</th><th>Status</th><th></th></tr></thead>
        <tbody>${promos.map((p) => `<tr class="${p.active ? '' : 'inactive'}">
          <td data-label="Code"><code>${V.esc(p.code)}</code></td>
          <td data-label="Discount">${p.kind === 'percent' ? p.value + '% off order' : V.rm(p.value) + ' off order'}</td>
          <td data-label="Expires">${p.expires ? V.esc(fmtDay(p.expires)) : 'Never'}</td>
          <td data-label="Used" class="num">${p.used_count}${p.max_uses > 0 ? ' / ' + p.max_uses : ''}</td>
          <td data-label="Status">${p.active ? '<span class="badge badge-confirmed">Active</span>' : '<span class="badge">Disabled</span>'}</td>
          <td data-label=""><form method="post" action="/admin/promos/${p.id}/toggle" class="inline-form">
            <button class="btn btn-ghost btn-sm" type="submit">${p.active ? 'Disable' : 'Enable'}</button></form></td>
        </tr>`).join('')}</tbody></table></div>`;
    })()}
  </div>`;
  render(req, res, { title: 'Admin - Customers', user: req.user, body, active: 'customers' });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const wa = String(req.body.whatsapp || '').replace(/[^\d+]/g, '').slice(0, 20);
  const sst = parseFloat(req.body.sst_percent);
  const lead = parseInt(req.body.lead_days, 10);
  const qvd = parseInt(req.body.quote_valid_days, 10);
  const expPct = parseFloat(req.body.express_percent);
  const expDays = parseInt(req.body.express_lead_days, 10);
  setSetting('whatsapp', wa);
  setSetting('sst_percent', isNaN(sst) || sst < 0 ? '0' : String(Math.min(sst, 50)));
  setSetting('lead_days', isNaN(lead) || lead < 0 ? '3' : String(Math.min(lead, 60)));
  setSetting('quote_valid_days', isNaN(qvd) || qvd < 1 ? '14' : String(Math.min(qvd, 90)));
  setSetting('express_percent', isNaN(expPct) || expPct < 0 ? '0' : String(Math.min(expPct, 100)));
  setSetting('express_lead_days', isNaN(expDays) || expDays < 0 ? '1' : String(Math.min(expDays, 30)));
  flash(req, 'success', 'Settings saved. They apply to new orders and new quotations only.');
  res.redirect('/admin/customers');
});

app.post('/admin/promos', requireAdmin, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 30).replace(/[^A-Z0-9-]/g, '');
  const kind = req.body.kind === 'fixed' ? 'fixed' : 'percent';
  const value = round2(parseFloat(req.body.value));
  const maxUses = Math.max(0, parseInt(req.body.max_uses, 10) || 0);
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.expires || '')) ? req.body.expires : '';
  if (!code || isNaN(value) || value <= 0 || (kind === 'percent' && value > 100)) {
    flash(req, 'error', 'Promo code needs a code and a valid value (percent must be 1-100).');
    return res.redirect('/admin/customers');
  }
  try {
    db.prepare('INSERT INTO promo_codes (code, kind, value, expires, max_uses) VALUES (?,?,?,?,?)')
      .run(code, kind, value, expires, maxUses);
    flash(req, 'success', `Promo code ${code} created: ${kind === 'percent' ? value + '% off' : V.rm(value) + ' off'} the order.`);
  } catch (e) {
    flash(req, 'error', 'That promo code already exists.');
  }
  res.redirect('/admin/customers');
});

app.post('/admin/promos/:id/toggle', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Not found');
  db.prepare('UPDATE promo_codes SET active = ? WHERE id = ?').run(p.active ? 0 : 1, p.id);
  flash(req, 'success', `Promo code ${p.code} ${p.active ? 'disabled' : 'enabled'}.`);
  res.redirect('/admin/customers');
});

app.post('/admin/customers', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || password.length < 6 || !req.body.name) {
    flash(req, 'error', 'Username, name and a password of at least 6 characters are required.');
    return res.redirect('/admin/customers');
  }
  try {
    db.prepare('INSERT INTO users (username, password_hash, role, name, company, phone) VALUES (?,?,?,?,?,?)').run(
      username,
      bcrypt.hashSync(password, 10),
      'customer',
      String(req.body.name).trim().slice(0, 100),
      String(req.body.company || '').trim().slice(0, 150),
      String(req.body.phone || '').trim().slice(0, 50)
    );
    flash(req, 'success', `Customer created. Give them these credentials - username: ${username}`);
  } catch (e) {
    flash(req, 'error', 'That username is already taken.');
  }
  res.redirect('/admin/customers');
});

app.post('/admin/customers/:id/password', requireAdmin, (req, res) => {
  const c = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
  if (!c) return res.status(404).send('Customer not found');
  const password = String(req.body.password || '');
  if (password.length < 6) {
    flash(req, 'error', 'Password must be at least 6 characters.');
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), c.id);
    flash(req, 'success', `Password updated for ${c.username}.`);
  }
  res.redirect('/admin/customers');
});

app.post('/admin/customers/:id/active', requireAdmin, (req, res) => {
  const c = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
  if (!c) return res.status(404).send('Customer not found');
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(c.active ? 0 : 1, c.id);
  flash(req, 'success', `${c.username} ${c.active ? 'disabled' : 'enabled'}.`);
  res.redirect('/admin/customers');
});

app.get('/admin/customers/:id/pricing', requireAdmin, (req, res) => {
  const c = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
  if (!c) return res.status(404).send('Customer not found');
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all();
  const overrides = {};
  for (const r of db.prepare('SELECT * FROM customer_prices WHERE customer_id = ?').all(c.id)) {
    overrides[r.product_id] = r.price;
  }
  const rows = products
    .map(
      (p) => `<tr>
      <td data-label="Product"><strong>${V.esc(p.name)}</strong><div class="muted small">per ${V.esc(p.unit)}${tiersText(p.id) ? ' &middot; tiers: ' + V.esc(tiersText(p.id)) : ''}</div></td>
      <td data-label="Base Price" class="num">${V.rm(p.base_price)}</td>
      <td data-label="Customer Price" class="num">
        <input name="price_${p.id}" type="number" step="0.01" min="0"
          value="${overrides[p.id] != null ? overrides[p.id] : ''}" placeholder="use base/tiers">
      </td>
      <td data-label="Effective" class="num"><strong>${V.rm(overrides[p.id] != null ? overrides[p.id] : p.base_price)}</strong></td>
    </tr>`
    )
    .join('');
  const body = `
  <div class="page-head"><div><h1>Pricing: ${V.esc(c.name)}</h1>
  <p class="muted">${V.esc(c.company)} &middot; A customer price here overrides base price AND bulk tiers. Leave blank to use base price with bulk tiers.</p></div>
  <a class="btn btn-ghost" href="/admin/customers">&larr; Back</a></div>
  <form method="post" action="/admin/customers/${c.id}/pricing">
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Product</th><th class="num">Base Price</th><th class="num">Customer Price (RM)</th><th class="num">Effective Price</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <button class="btn btn-primary btn-lg" type="submit">Save Pricing</button>
  </form>`;
  render(req, res, { title: `Pricing - ${c.name}`, user: req.user, body, active: 'customers' });
});

app.post('/admin/customers/:id/pricing', requireAdmin, (req, res) => {
  const c = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
  if (!c) return res.status(404).send('Customer not found');
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const upsert = db.prepare(
    `INSERT INTO customer_prices (customer_id, product_id, price) VALUES (?,?,?)
     ON CONFLICT(customer_id, product_id) DO UPDATE SET price = excluded.price`
  );
  const del = db.prepare('DELETE FROM customer_prices WHERE customer_id = ? AND product_id = ?');
  db.transaction(() => {
    for (const p of products) {
      const raw = String(req.body[`price_${p.id}`] ?? '').trim();
      if (raw === '') {
        del.run(c.id, p.id);
      } else {
        const price = parseFloat(raw);
        if (!isNaN(price) && price >= 0) upsert.run(c.id, p.id, price);
      }
    }
  })();
  flash(req, 'success', `Pricing saved for ${c.name}.`);
  res.redirect(`/admin/customers/${c.id}/pricing`);
});

// ---------- start ----------

app.listen(PORT, () => {
  console.log(`Aramega Order Portal running on http://localhost:${PORT}`);
  console.log('Default logins -> admin: admin/admin123, customer: demo/demo123');
});
