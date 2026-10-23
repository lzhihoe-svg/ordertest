const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const { db, nextInvoiceNo, priceFor } = require('./src/db');
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

const uploadReceipt = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (/\.(pdf|jpe?g|png|webp)$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Receipt must be a PDF or image file (pdf, jpg, png, webp).'));
  },
}).single('receipt');

function runUpload(middleware) {
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (err) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'File is too large. Artwork zip max 500MB, receipt max 20MB.'
            : err.message || 'Upload failed.';
        flash(req, 'error', msg);
        return res.redirect(req.get('referer') || '/');
      }
      next();
    });
}

function render(req, res, opts) {
  res.send(V.layout({ flash: popFlash(req), ...opts }));
}

const fileCard = (f, canDelete, order) => `
  <li class="file-row">
    <a href="/files/${f.id}" class="file-link">&#128206; ${V.esc(f.original_name)}</a>
    <span class="muted">${f.size >= 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(2) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'} &middot; ${V.esc(V.fmtDate(f.uploaded_at))}</span>
  </li>`;

// ---------- auth ----------

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

// ---------- customer: dashboard ----------

app.get('/', requireCustomer, (req, res) => {
  const orders = db
    .prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC')
    .all(req.user.id);
  const body = `
  <div class="page-head">
    <div><h1>My Orders</h1><p class="muted">Welcome back, ${V.esc(req.user.name)}.</p></div>
    <a class="btn btn-primary" href="/orders/new">+ New Order</a>
  </div>
  ${V.ordersTable(orders)}`;
  render(req, res, { title: 'My Orders', user: req.user, body, active: 'home' });
});

// ---------- customer: new order ----------

app.get('/orders/new', requireCustomer, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all();
  const rows = products
    .map((p) => {
      const price = priceFor(req.user.id, p.id);
      return `<tr>
        <td data-label="Product"><strong>${V.esc(p.name)}</strong><div class="muted small">${V.esc(p.description)}</div></td>
        <td data-label="Your Price" class="num price-cell" data-price="${price}">${V.rm(price)} / ${V.esc(p.unit)}</td>
        <td data-label="Quantity" class="qty-cell">
          <input class="qty-input" type="number" name="qty_${p.id}" min="0" step="1" value="0" inputmode="numeric">
        </td>
        <td data-label="Subtotal" class="num subtotal-cell">RM 0.00</td>
      </tr>`;
    })
    .join('');
  const body = `
  <div class="page-head"><div><h1>New Order</h1>
  <p class="muted">Select products and quantities. Your invoice is generated automatically when you submit.</p></div></div>
  <form method="post" action="/orders" enctype="multipart/form-data" id="order-form" class="stack">
    <div class="card">
      <h2>1. Products &amp; Quantity</h2>
      <div class="table-wrap"><table class="table order-table">
        <thead><tr><th>Product</th><th class="num">Your Price</th><th>Quantity</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3" class="num total-label"><strong>Order Total</strong></td>
        <td class="num"><strong id="order-total">RM 0.00</strong></td></tr></tfoot>
      </table></div>
    </div>
    <div class="card">
      <h2>2. Artwork Files</h2>
      <p class="muted">Upload your artwork as a <strong>.zip file (up to 500MB)</strong>, or paste a WeTransfer link. You can also add this later from the order page.</p>
      <label>Artwork zip file
        <input type="file" name="artwork" accept=".zip">
      </label>
      <div class="or-divider"><span>OR</span></div>
      <label>WeTransfer link
        <input type="url" name="wetransfer_link" placeholder="https://we.tl/...">
      </label>
    </div>
    <div class="card">
      <h2>3. Notes (optional)</h2>
      <label>Order notes
        <textarea name="notes" rows="3" placeholder="Sizes breakdown, colours, delivery instructions..."></textarea>
      </label>
    </div>
    <button class="btn btn-primary btn-lg" type="submit">Submit Order &amp; Generate Invoice</button>
  </form>
  <script>
    const form = document.getElementById('order-form');
    function recalc() {
      let total = 0;
      form.querySelectorAll('tbody tr').forEach(tr => {
        const price = parseFloat(tr.querySelector('.price-cell').dataset.price);
        const qty = parseInt(tr.querySelector('.qty-input').value || '0', 10);
        const sub = price * (qty > 0 ? qty : 0);
        total += sub;
        tr.querySelector('.subtotal-cell').textContent = 'RM ' + sub.toLocaleString('en-MY', {minimumFractionDigits: 2, maximumFractionDigits: 2});
      });
      document.getElementById('order-total').textContent = 'RM ' + total.toLocaleString('en-MY', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }
    form.addEventListener('input', recalc);
    form.addEventListener('submit', (e) => {
      const anyQty = [...form.querySelectorAll('.qty-input')].some(i => parseInt(i.value || '0', 10) > 0);
      if (!anyQty) { e.preventDefault(); alert('Please enter a quantity for at least one product.'); }
    });
  </script>`;
  render(req, res, { title: 'New Order', user: req.user, body, active: 'new' });
});

app.post('/orders', requireCustomer, runUpload(uploadArtwork), (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const items = [];
  for (const p of products) {
    const qty = parseInt(req.body[`qty_${p.id}`] || '0', 10);
    if (qty > 0) {
      const unitPrice = priceFor(req.user.id, p.id);
      items.push({ product: p, qty, unitPrice, lineTotal: Math.round(unitPrice * qty * 100) / 100 });
    }
  }
  if (!items.length) {
    if (req.file) fs.unlink(req.file.path, () => {});
    flash(req, 'error', 'Please select at least one product with a quantity.');
    return res.redirect('/orders/new');
  }
  const total = Math.round(items.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;

  const orderId = db.transaction(() => {
    const invNum = nextInvoiceNo();
    const info = db
      .prepare(
        `INSERT INTO orders (order_no, invoice_no, customer_id, total, notes, wetransfer_link)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        `ORD-${invNum}`,
        `INV-${invNum}`,
        req.user.id,
        total,
        String(req.body.notes || '').slice(0, 2000),
        String(req.body.wetransfer_link || '').slice(0, 500)
      );
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
    return id;
  })();

  flash(req, 'success', 'Order submitted! Your invoice has been generated below.');
  res.redirect(`/orders/${orderId}`);
});

// ---------- customer: order detail ----------

function orderDetailBody(order, { isAdmin }) {
  const items = getItems(order.id);
  const artwork = getFiles(order.id, 'artwork');
  const receipts = getFiles(order.id, 'receipt');
  const base = isAdmin ? `/admin/orders/${order.id}` : `/orders/${order.id}`;

  const itemsTable = `<div class="table-wrap"><table class="table">
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
    <tfoot><tr><td colspan="3" class="num total-label"><strong>Total</strong></td><td class="num"><strong>${V.rm(order.total)}</strong></td></tr></tfoot>
  </table></div>`;

  const artworkSection = `
  <div class="card">
    <h2>Artwork</h2>
    ${artwork.length ? `<ul class="file-list">${artwork.map((f) => fileCard(f)).join('')}</ul>` : ''}
    ${order.wetransfer_link ? `<p>WeTransfer link: <a href="${V.esc(order.wetransfer_link)}" target="_blank" rel="noopener noreferrer">${V.esc(order.wetransfer_link)}</a></p>` : ''}
    ${!artwork.length && !order.wetransfer_link ? '<p class="muted">No artwork provided yet.</p>' : ''}
    ${!isAdmin && order.status === 'submitted' ? `
    <details class="upload-details">
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

  const receiptSection = `
  <div class="card">
    <h2>Payment Proof (Bank Receipt)</h2>
    ${receipts.length ? `<ul class="file-list">${receipts.map((f) => fileCard(f)).join('')}</ul>` : '<p class="muted">No receipt uploaded yet.</p>'}
    ${order.payment_ref ? `<p>Bank reference: <strong>${V.esc(order.payment_ref)}</strong></p>` : ''}
    ${!isAdmin && (order.status === 'submitted' || order.status === 'confirmed') ? `
    <form method="post" action="/orders/${order.id}/receipt" enctype="multipart/form-data" class="stack">
      <label>Receipt file (PDF or image, max 20MB)
        <input type="file" name="receipt" accept=".pdf,.jpg,.jpeg,.png,.webp" required>
      </label>
      <label>Bank reference number (optional)
        <input name="payment_ref" value="${V.esc(order.payment_ref)}" placeholder="e.g. CIMB ref no.">
      </label>
      <button class="btn btn-outline" type="submit">Upload Receipt</button>
    </form>` : ''}
  </div>`;

  return { itemsTable, artworkSection, receiptSection, base };
}

app.get('/orders/:id', requireCustomer, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  const { itemsTable, artworkSection, receiptSection } = orderDetailBody(order, { isAdmin: false });
  const body = `
  <div class="page-head">
    <div><h1>Order ${V.esc(order.order_no)}</h1><p class="muted">Placed ${V.esc(V.fmtDate(order.created_at))}</p></div>
    <div class="head-actions">
      ${V.statusBadge(order.status)}
      <a class="btn btn-primary" href="/orders/${order.id}/invoice" target="_blank">View Invoice</a>
    </div>
  </div>
  <div class="card"><h2>Order Status</h2>${V.timeline(order)}</div>
  <div class="card"><h2>Items</h2>${itemsTable}
    ${order.notes ? `<p class="muted"><strong>Notes:</strong> ${V.esc(order.notes)}</p>` : ''}</div>
  <div class="grid-2">
    ${artworkSection}
    ${receiptSection}
  </div>`;
  render(req, res, { title: `Order ${order.order_no}`, user: req.user, body, active: 'home' });
});

app.post('/orders/:id/artwork', requireCustomer, runUpload(uploadArtwork), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  if (!req.file) {
    flash(req, 'error', 'No file selected.');
    return res.redirect(`/orders/${order.id}`);
  }
  db.prepare('INSERT INTO files (order_id, kind, stored_name, original_name, size) VALUES (?,?,?,?,?)').run(
    order.id, 'artwork', req.file.filename, req.file.originalname, req.file.size
  );
  flash(req, 'success', 'Artwork uploaded.');
  res.redirect(`/orders/${order.id}`);
});

app.post('/orders/:id/wetransfer', requireCustomer, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  const link = String(req.body.wetransfer_link || '').trim().slice(0, 500);
  if (!/^https?:\/\//i.test(link)) {
    flash(req, 'error', 'Please enter a valid link (must start with http:// or https://).');
    return res.redirect(`/orders/${order.id}`);
  }
  db.prepare('UPDATE orders SET wetransfer_link = ? WHERE id = ?').run(link, order.id);
  flash(req, 'success', 'WeTransfer link saved.');
  res.redirect(`/orders/${order.id}`);
});

app.post('/orders/:id/receipt', requireCustomer, runUpload(uploadReceipt), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  if (!req.file) {
    flash(req, 'error', 'No file selected.');
    return res.redirect(`/orders/${order.id}`);
  }
  db.prepare('INSERT INTO files (order_id, kind, stored_name, original_name, size) VALUES (?,?,?,?,?)').run(
    order.id, 'receipt', req.file.filename, req.file.originalname, req.file.size
  );
  const ref = String(req.body.payment_ref || '').trim().slice(0, 200);
  if (ref) db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(ref, order.id);
  flash(req, 'success', 'Receipt uploaded. Our team will verify your payment.');
  res.redirect(`/orders/${order.id}`);
});

// ---------- invoice (customer owner or admin) ----------

app.get(['/orders/:id/invoice', '/admin/orders/:id/invoice'], (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  if (user.role !== 'admin' && order.customer_id !== user.id) return res.status(404).send('Order not found');
  const items = getItems(order.id);
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
        <tr><td>Date</td><td>${V.esc(V.fmtDate(order.created_at))}</td></tr>
        <tr><td>Status</td><td>${order.chk_payment ? '<strong class="paid">PAYMENT RECEIVED</strong>' : '<strong class="unpaid">AWAITING PAYMENT</strong>'}</td></tr>
      </table>
    </div>
  </header>
  <section class="inv-billto">
    <h3>Bill To</h3>
    <p><strong>${V.esc(customerLabel)}</strong><br>
    ${V.esc(order.customer_name)}${order.customer_phone ? '<br>' + V.esc(order.customer_phone) : ''}</p>
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
    <tfoot><tr><td colspan="4" class="num total-label"><strong>TOTAL</strong></td><td class="num inv-total"><strong>${V.rm(order.total)}</strong></td></tr></tfoot>
  </table>
  <section class="inv-payinfo">
    <h3>Payment Info:</h3>
    <p>Bank Name: CIMB<br>
    Beneficiary Name: Aramega Textile Sdn Bhd<br>
    Account Number: 8605494198</p>
    <p class="muted small">Please upload your bank receipt on the order page after making payment.</p>
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
  const order = getOrder(f.order_id);
  if (user.role !== 'admin' && order.customer_id !== user.id) return res.status(404).send('File not found');
  res.download(path.join(UPLOAD_DIR, f.stored_name), f.original_name);
});

// ---------- admin: orders ----------

app.get('/admin', requireAdmin, (req, res) => {
  const filter = String(req.query.status || '');
  const valid = V.STATUS_ORDER.includes(filter);
  const orders = db
    .prepare(
      `SELECT o.*, u.name AS customer_name, u.company AS customer_company
       FROM orders o JOIN users u ON u.id = o.customer_id
       ${valid ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC`
    )
    .all(...(valid ? [filter] : []));
  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all()) counts[r.status] = r.n;
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const tabs = `<div class="tabs">
    <a href="/admin" class="${!valid ? 'active' : ''}">All (${totalCount})</a>
    ${V.STATUS_ORDER.map(
      (s) => `<a href="/admin?status=${s}" class="${filter === s ? 'active' : ''}">${V.esc(V.STATUS[s].label)} (${counts[s] || 0})</a>`
    ).join('')}
  </div>`;
  const body = `
  <div class="page-head"><div><h1>All Orders</h1><p class="muted">Review, verify and update customer orders.</p></div></div>
  ${tabs}
  ${V.ordersTable(orders, { adminView: true })}`;
  render(req, res, { title: 'Admin - Orders', user: req.user, body, active: 'orders' });
});

app.get('/admin/orders/:id', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const { itemsTable, artworkSection, receiptSection } = orderDetailBody(order, { isAdmin: true });
  const allChecked = order.chk_artwork && order.chk_product && order.chk_payment;

  let actionBtn = '';
  if (order.status === 'submitted') {
    actionBtn = `<button class="btn btn-primary btn-lg" type="submit" name="action" value="confirm" ${allChecked ? '' : 'disabled'}>
      Confirm Order</button>
      ${allChecked ? '' : '<p class="muted small">Complete all three verification checks (and save) to enable confirmation.</p>'}`;
  } else if (order.status === 'confirmed') {
    actionBtn = `<button class="btn btn-primary btn-lg" type="submit" name="action" value="complete">Mark as Order Complete</button>`;
  } else if (order.status === 'completed') {
    actionBtn = `<button class="btn btn-primary btn-lg" type="submit" name="action" value="deliver">Mark as Delivered</button>`;
  } else {
    actionBtn = `<p class="muted">This order has been delivered. Nothing further to do.</p>`;
  }

  const body = `
  <div class="page-head">
    <div><h1>Order ${V.esc(order.order_no)}</h1>
      <p class="muted">${V.esc(order.customer_company || order.customer_name)} (${V.esc(order.customer_name)}) &middot; ${V.esc(V.fmtDate(order.created_at))}</p></div>
    <div class="head-actions">
      ${V.statusBadge(order.status)}
      <a class="btn btn-outline" href="/admin/orders/${order.id}/invoice" target="_blank">View Invoice</a>
    </div>
  </div>
  <div class="card"><h2>Order Status</h2>${V.timeline(order)}</div>
  <div class="card"><h2>Items</h2>${itemsTable}
    ${order.notes ? `<p class="muted"><strong>Customer notes:</strong> ${V.esc(order.notes)}</p>` : ''}</div>
  <div class="grid-2">
    ${artworkSection}
    ${receiptSection}
  </div>
  <div class="card verify-card">
    <h2>Admin Verification</h2>
    <form method="post" action="/admin/orders/${order.id}/checks" class="stack">
      <label class="check"><input type="checkbox" name="chk_artwork" ${order.chk_artwork ? 'checked' : ''}>
        Artwork checked and correct</label>
      <label class="check"><input type="checkbox" name="chk_product" ${order.chk_product ? 'checked' : ''}>
        Product &amp; quantity checked and correct</label>
      <label class="check"><input type="checkbox" name="chk_payment" ${order.chk_payment ? 'checked' : ''}>
        Payment received and verified</label>
      <label>Bank reference number
        <input name="payment_ref" value="${V.esc(order.payment_ref)}" placeholder="e.g. CIMB ref no.">
      </label>
      <button class="btn btn-outline" type="submit">Save Verification</button>
    </form>
    <hr class="divider">
    <form method="post" action="/admin/orders/${order.id}/status">
      ${actionBtn}
    </form>
  </div>`;
  render(req, res, { title: `Admin - ${order.order_no}`, user: req.user, body, active: 'orders' });
});

app.post('/admin/orders/:id/checks', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  db.prepare(
    'UPDATE orders SET chk_artwork = ?, chk_product = ?, chk_payment = ?, payment_ref = ? WHERE id = ?'
  ).run(
    req.body.chk_artwork ? 1 : 0,
    req.body.chk_product ? 1 : 0,
    req.body.chk_payment ? 1 : 0,
    String(req.body.payment_ref || '').trim().slice(0, 200),
    order.id
  );
  flash(req, 'success', 'Verification saved.');
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
    db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?").run(order.id);
    flash(req, 'success', `Order ${order.order_no} confirmed.`);
  } else if (action === 'complete' && order.status === 'confirmed') {
    db.prepare("UPDATE orders SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(order.id);
    flash(req, 'success', `Order ${order.order_no} marked as complete.`);
  } else if (action === 'deliver' && order.status === 'completed') {
    db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(order.id);
    flash(req, 'success', `Order ${order.order_no} marked as delivered.`);
  } else {
    flash(req, 'error', 'Invalid status change.');
  }
  res.redirect(`/admin/orders/${order.id}`);
});

// ---------- admin: products ----------

app.get('/admin/products', requireAdmin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY active DESC, name').all();
  const rows = products
    .map(
      (p) => `<form method="post" action="/admin/products/${p.id}" class="product-row card ${p.active ? '' : 'inactive'}">
      <div class="grid-fields">
        <label>Name<input name="name" value="${V.esc(p.name)}" required></label>
        <label>Unit<input name="unit" value="${V.esc(p.unit)}" required></label>
        <label>Base Price (RM)<input name="base_price" type="number" step="0.01" min="0" value="${p.base_price}" required></label>
      </div>
      <label>Description<input name="description" value="${V.esc(p.description)}"></label>
      <div class="row-actions">
        <button class="btn btn-outline btn-sm" type="submit" name="action" value="save">Save</button>
        <button class="btn btn-ghost btn-sm" type="submit" name="action" value="${p.active ? 'deactivate' : 'activate'}">
          ${p.active ? 'Deactivate' : 'Reactivate'}</button>
      </div>
    </form>`
    )
    .join('');
  const body = `
  <div class="page-head"><div><h1>Products</h1><p class="muted">Base prices apply unless a customer-specific price is set.</p></div></div>
  <div class="card">
    <h2>Add Product</h2>
    <form method="post" action="/admin/products" class="stack">
      <div class="grid-fields">
        <label>Name<input name="name" required></label>
        <label>Unit<input name="unit" value="pcs" required></label>
        <label>Base Price (RM)<input name="base_price" type="number" step="0.01" min="0" required></label>
      </div>
      <label>Description<input name="description"></label>
      <button class="btn btn-primary" type="submit">Add Product</button>
    </form>
  </div>
  <h2 class="section-title">Existing Products</h2>
  ${rows}`;
  render(req, res, { title: 'Admin - Products', user: req.user, body, active: 'products' });
});

app.post('/admin/products', requireAdmin, (req, res) => {
  const price = parseFloat(req.body.base_price);
  if (!req.body.name || isNaN(price) || price < 0) {
    flash(req, 'error', 'Please provide a product name and a valid price.');
    return res.redirect('/admin/products');
  }
  db.prepare('INSERT INTO products (name, description, unit, base_price) VALUES (?,?,?,?)').run(
    String(req.body.name).trim().slice(0, 200),
    String(req.body.description || '').trim().slice(0, 500),
    String(req.body.unit || 'pcs').trim().slice(0, 30),
    price
  );
  flash(req, 'success', 'Product added.');
  res.redirect('/admin/products');
});

app.post('/admin/products/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Product not found');
  if (req.body.action === 'deactivate' || req.body.action === 'activate') {
    db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.action === 'activate' ? 1 : 0, p.id);
    flash(req, 'success', `Product ${req.body.action === 'activate' ? 'reactivated' : 'deactivated'}.`);
  } else {
    const price = parseFloat(req.body.base_price);
    if (!req.body.name || isNaN(price) || price < 0) {
      flash(req, 'error', 'Please provide a product name and a valid price.');
      return res.redirect('/admin/products');
    }
    db.prepare('UPDATE products SET name = ?, description = ?, unit = ?, base_price = ? WHERE id = ?').run(
      String(req.body.name).trim().slice(0, 200),
      String(req.body.description || '').trim().slice(0, 500),
      String(req.body.unit || 'pcs').trim().slice(0, 30),
      price,
      p.id
    );
    flash(req, 'success', 'Product updated.');
  }
  res.redirect('/admin/products');
});

// ---------- admin: customers & pricing ----------

app.get('/admin/customers', requireAdmin, (req, res) => {
  const customers = db.prepare("SELECT * FROM users WHERE role = 'customer' ORDER BY active DESC, name").all();
  const rows = customers
    .map(
      (c) => `<tr class="${c.active ? '' : 'inactive'}">
      <td data-label="Name"><strong>${V.esc(c.name)}</strong><div class="muted small">${V.esc(c.company)}</div></td>
      <td data-label="Username"><code>${V.esc(c.username)}</code></td>
      <td data-label="Phone">${V.esc(c.phone || '-')}</td>
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
    </tr>`
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
    <thead><tr><th>Customer</th><th>Username</th><th>Phone</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">No customers yet.</td></tr>'}</tbody>
  </table></div>`;
  render(req, res, { title: 'Admin - Customers', user: req.user, body, active: 'customers' });
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
      <td data-label="Product"><strong>${V.esc(p.name)}</strong><div class="muted small">per ${V.esc(p.unit)}</div></td>
      <td data-label="Base Price" class="num">${V.rm(p.base_price)}</td>
      <td data-label="Customer Price" class="num">
        <input name="price_${p.id}" type="number" step="0.01" min="0"
          value="${overrides[p.id] != null ? overrides[p.id] : ''}" placeholder="use base">
      </td>
      <td data-label="Effective" class="num"><strong>${V.rm(overrides[p.id] != null ? overrides[p.id] : p.base_price)}</strong></td>
    </tr>`
    )
    .join('');
  const body = `
  <div class="page-head"><div><h1>Pricing: ${V.esc(c.name)}</h1>
  <p class="muted">${V.esc(c.company)} &middot; Leave a field blank to use the base price.</p></div>
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
