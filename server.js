const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const { db, nextInvoiceNo, priceFor, tiersFor, setting, setSetting } = require('./src/db');
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

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
  res.send(V.layout({ flash: popFlash(req), whatsapp: setting('whatsapp', ''), ...opts }));
}

const fileCard = (f) => `
  <li class="file-row">
    <a href="/files/${f.id}" class="file-link">&#128206; ${V.esc(f.original_name)}</a>
    <span class="muted">${f.size >= 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(2) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'} &middot; ${V.esc(V.fmtDate(f.uploaded_at))}</span>
  </li>`;

function commentsSection(order, postUrl) {
  const comments = getComments(order.id);
  return `
  <div class="card">
    <h2>Order Discussion</h2>
    ${comments.length ? `<ul class="comment-list">${comments
      .map(
        (c) => `<li class="comment ${c.author_role === 'admin' ? 'comment-admin' : ''}">
        <div class="comment-head"><strong>${V.esc(c.author_name)}</strong>
          <span class="badge ${c.author_role === 'admin' ? 'badge-completed' : 'badge-confirmed'}">${c.author_role === 'admin' ? 'Aramega' : 'Customer'}</span>
          <span class="muted small">${V.esc(V.fmtDate(c.created_at))}</span></div>
        <p>${V.esc(c.body)}</p></li>`
      )
      .join('')}</ul>` : '<p class="muted">No messages yet. Use this to discuss artwork, sizes or delivery for this order.</p>'}
    <form method="post" action="${postUrl}" class="stack">
      <label>Message
        <textarea name="body" rows="2" required maxlength="2000" placeholder="Write a message about this order..."></textarea>
      </label>
      <button class="btn btn-outline" type="submit">Send Message</button>
    </form>
  </div>`;
}

function deliveryCard(order) {
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
  </div>`;
}

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
  const leadDays = parseInt(setting('lead_days', '3'), 10);
  const minDate = klDatePlus(leadDays);

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
      const tierInfo = override
        ? '<span class="tier-chip">Your special price</span>'
        : tiers.map((t) => `<span class="tier-chip">${t.min_qty}+ : ${V.rm(t.price)}</span>`).join(' ');
      return `<tr>
        <td data-label="Product"><strong>${V.esc(p.name)}</strong>
          <div class="muted small">${V.esc(p.description)}</div>
          ${p.artwork_spec ? `<div class="spec-note">Artwork: ${V.esc(p.artwork_spec)}</div>` : ''}
          ${tierInfo ? `<div class="tier-row">${tierInfo}</div>` : ''}
        </td>
        <td data-label="Your Price" class="num price-cell" id="price_${p.id}">${V.rm(startPrice)} / ${V.esc(p.unit)}</td>
        <td data-label="Min Order" class="num">${p.moq} ${V.esc(p.unit)}</td>
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
  <p class="muted">Select products and quantities. Your invoice is generated automatically when you submit.</p></div></div>
  <form method="post" action="/orders" enctype="multipart/form-data" id="order-form" class="stack">
    <div class="card">
      <h2>1. Products &amp; Quantity</h2>
      <p class="muted small">Each product has a minimum order quantity. Bulk prices apply automatically when your quantity reaches a tier.</p>
      <div class="table-wrap"><table class="table order-table">
        <thead><tr><th>Product</th><th class="num">Your Price</th><th class="num">Min Order</th><th>Quantity</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="4" class="num total-label">Subtotal</td><td class="num" id="f-subtotal">RM 0.00</td></tr>
          ${sst > 0 ? `<tr><td colspan="4" class="num total-label">SST (${sst}%)</td><td class="num" id="f-sst">RM 0.00</td></tr>` : ''}
          <tr><td colspan="4" class="num total-label"><strong>Order Total</strong></td>
          <td class="num"><strong id="order-total">RM 0.00</strong></td></tr>
        </tfoot>
      </table></div>
    </div>
    <div class="card">
      <h2>2. Artwork Files <span class="req-chip">Required</span></h2>
      <p class="muted">Upload your artwork as a <strong>.zip file (up to 500MB)</strong>, or paste a WeTransfer link.
      <strong>Your order cannot be submitted without artwork.</strong></p>
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
        <textarea name="delivery_address" id="delivery-address" rows="2" placeholder="Full delivery address including postcode"></textarea>
      </label>
      <label>Needed by date <span class="req-chip">Required</span>
        <input type="date" name="needed_by" id="needed-by" min="${minDate}" required>
      </label>
      <p class="muted small">Earliest available date is ${V.esc(fmtDay(minDate))} (production lead time: ${leadDays} days).</p>
    </div>
    <div class="card">
      <h2>4. Notes (optional)</h2>
      <label>Order notes
        <textarea name="notes" rows="3" placeholder="Sizes breakdown, colours, delivery instructions..."></textarea>
      </label>
    </div>
    <button class="btn btn-primary btn-lg" type="submit">Submit Order &amp; Generate Invoice</button>
  </form>
  <script>
    const PRICING = ${JSON.stringify(pricing)};
    const SST = ${sst};
    const form = document.getElementById('order-form');
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
      const sstAmt = subtotal * SST / 100;
      const elS = document.getElementById('f-subtotal');
      if (elS) elS.textContent = fmt(subtotal);
      const elT = document.getElementById('f-sst');
      if (elT) elT.textContent = fmt(sstAmt);
      document.getElementById('order-total').textContent = fmt(subtotal + sstAmt);
    }
    form.addEventListener('input', recalc);
    recalc();
    form.addEventListener('submit', (e) => {
      const problems = [];
      let any = false;
      form.querySelectorAll('.qty-input').forEach(inp => {
        const qty = parseInt(inp.value || '0', 10);
        if (qty > 0) {
          any = true;
          const moq = PRICING[inp.dataset.pid].moq;
          if (qty < moq) problems.push('Minimum order quantity not met (minimum ' + moq + ') for one of your products.');
        }
      });
      if (!any) problems.push('Please enter a quantity for at least one product.');
      const hasFile = document.getElementById('artwork-file').files.length > 0;
      const hasLink = document.getElementById('wetransfer-link').value.trim().length > 0;
      if (!hasFile && !hasLink) problems.push('Artwork is required: upload a .zip file or paste a WeTransfer link.');
      const courier = form.querySelector('input[name="delivery_method"]:checked').value === 'courier';
      if (courier && !document.getElementById('delivery-address').value.trim()) problems.push('Delivery address is required for courier delivery.');
      if (!document.getElementById('needed-by').value) problems.push('Please choose a needed-by date.');
      if (problems.length) { e.preventDefault(); alert(problems.join('\\n')); }
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

  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const items = [];
  for (const p of products) {
    const qty = parseInt(req.body[`qty_${p.id}`] || '0', 10);
    if (qty > 0) {
      // Rule: quantity must meet the product's minimum order quantity.
      if (qty < p.moq) return fail(`Minimum order for ${p.name} is ${p.moq} ${p.unit}. You entered ${qty}.`);
      const unitPrice = priceFor(req.user.id, p.id, qty);
      items.push({ product: p, qty, unitPrice, lineTotal: round2(unitPrice * qty) });
    }
  }
  if (!items.length) return fail('Please select at least one product with a quantity.');

  // Rule: artwork is mandatory — a zip upload OR a WeTransfer link.
  const wetransfer = String(req.body.wetransfer_link || '').trim().slice(0, 500);
  if (!req.file && !wetransfer) {
    return fail('Artwork is required: upload a .zip file (max 500MB) or paste a WeTransfer link before submitting.');
  }
  if (wetransfer && !/^https?:\/\//i.test(wetransfer)) {
    return fail('The WeTransfer link must start with http:// or https://.');
  }

  // Rule: courier delivery needs an address.
  const method = req.body.delivery_method === 'courier' ? 'courier' : 'pickup';
  const address = String(req.body.delivery_address || '').trim().slice(0, 500);
  if (method === 'courier' && !address) return fail('Delivery address is required for courier delivery.');

  // Rule: needed-by date is required and must respect the production lead time.
  const leadDays = parseInt(setting('lead_days', '3'), 10);
  const minDate = klDatePlus(leadDays);
  const neededBy = String(req.body.needed_by || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) return fail('Please choose a needed-by date.');
  if (neededBy < minDate) return fail(`The earliest available date is ${fmtDay(minDate)} (production lead time: ${leadDays} days).`);

  const subtotal = round2(items.reduce((s, i) => s + i.lineTotal, 0));
  const sstPercent = parseFloat(setting('sst_percent', '0')) || 0;
  const sstAmount = round2((subtotal * sstPercent) / 100);
  const total = round2(subtotal + sstAmount);

  const orderId = db.transaction(() => {
    const invNum = nextInvoiceNo();
    const info = db
      .prepare(
        `INSERT INTO orders (order_no, invoice_no, customer_id, subtotal, sst_percent, sst_amount, total,
          notes, wetransfer_link, delivery_method, delivery_address, needed_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        `ORD-${invNum}`, `INV-${invNum}`, req.user.id, subtotal, sstPercent, sstAmount, total,
        String(req.body.notes || '').slice(0, 2000), wetransfer, method, address, neededBy
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

  flash(req, 'success', 'Order submitted! Your invoice has been generated. Please make payment and upload your bank receipt.');
  res.redirect(`/orders/${orderId}`);
});

// ---------- customer: order detail ----------

function orderDetailBody(order, { isAdmin }) {
  const items = getItems(order.id);
  const artwork = getFiles(order.id, 'artwork');
  const receipts = getFiles(order.id, 'receipt');

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
    <tfoot>
      <tr><td colspan="3" class="num total-label">Subtotal</td><td class="num">${V.rm(order.subtotal)}</td></tr>
      ${order.sst_percent > 0 ? `<tr><td colspan="3" class="num total-label">SST (${order.sst_percent}%)</td><td class="num">${V.rm(order.sst_amount)}</td></tr>` : ''}
      <tr><td colspan="3" class="num total-label"><strong>Total</strong></td><td class="num"><strong>${V.rm(order.total)}</strong></td></tr>
    </tfoot>
  </table></div>`;

  const canEdit = !isAdmin && (order.status === 'submitted' || order.status === 'confirmed');

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
    ${canEdit ? `
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

  return { itemsTable, artworkSection, receiptSection };
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
      ${order.status !== 'cancelled' ? `<a class="btn btn-primary" href="/orders/${order.id}/invoice" target="_blank">View Invoice</a>` : ''}
      <a class="btn btn-outline" href="/orders/new?reorder=${order.id}">Re-order</a>
    </div>
  </div>
  <div class="card"><h2>Order Status</h2>${V.timeline(order)}</div>
  <div class="grid-2">
    <div class="card"><h2>Items</h2>${itemsTable}
      ${order.notes ? `<p class="muted"><strong>Notes:</strong> ${V.esc(order.notes)}</p>` : ''}</div>
    ${deliveryCard(order)}
  </div>
  ${order.status !== 'cancelled' ? `<div class="grid-2">
    ${artworkSection}
    ${receiptSection}
  </div>` : ''}
  ${commentsSection(order, `/orders/${order.id}/comment`)}
  ${order.status === 'submitted' ? `
  <div class="card cancel-card">
    <h2>Cancel Order</h2>
    <p class="muted small">You can cancel this order while it is still awaiting confirmation. Once our team confirms it and production starts, cancellation is no longer possible from here — contact us instead.</p>
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
  if (order.status !== 'submitted') {
    flash(req, 'error', 'Artwork can only be changed while the order is awaiting confirmation.');
    return res.redirect(`/orders/${order.id}`);
  }
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
  if (order.status !== 'submitted') {
    flash(req, 'error', 'Artwork can only be changed while the order is awaiting confirmation.');
    return res.redirect(`/orders/${order.id}`);
  }
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
  if (order.status === 'cancelled' || order.status === 'delivered') {
    flash(req, 'error', 'Receipts can no longer be added to this order.');
    return res.redirect(`/orders/${order.id}`);
  }
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
  flash(req, 'success', `Order ${order.order_no} has been cancelled.`);
  res.redirect(`/orders/${order.id}`);
});

app.post('/orders/:id/comment', requireCustomer, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).send('Order not found');
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (body) {
    db.prepare('INSERT INTO comments (order_id, author_id, author_name, author_role, body) VALUES (?,?,?,?,?)')
      .run(order.id, req.user.id, req.user.name, 'customer', body);
  }
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
        <tr><td>Needed by</td><td>${V.esc(fmtDay(order.needed_by))}</td></tr>
        <tr><td>Delivery</td><td>${order.delivery_method === 'courier' ? 'Courier' : 'Self Pickup'}</td></tr>
        <tr><td>Status</td><td>${order.chk_payment ? '<strong class="paid">PAYMENT RECEIVED</strong>' : '<strong class="unpaid">AWAITING PAYMENT</strong>'}</td></tr>
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
      ${order.sst_percent > 0 ? `<tr><td colspan="4" class="num total-label">SST (${order.sst_percent}%)</td><td class="num">${V.rm(order.sst_amount)}</td></tr>` : ''}
      <tr><td colspan="4" class="num total-label"><strong>TOTAL</strong></td><td class="num inv-total"><strong>${V.rm(order.total)}</strong></td></tr>
    </tfoot>
  </table>
  <section class="inv-payinfo">
    <h3>Payment Info:</h3>
    <p>Bank Name: CIMB<br>
    Beneficiary Name: Aramega Textile Sdn Bhd<br>
    Account Number: 8605494198</p>
    <p class="muted small">Orders are processed only after payment is received and verified. Please upload your bank receipt on the order page after making payment.</p>
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
  const q = String(req.query.q || '').trim();
  const allStatuses = [...V.STATUS_ORDER, 'cancelled'];
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

  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all()) counts[r.status] = r.n;
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  const sales = db.prepare("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status != 'cancelled'").get().s;
  const unverified = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'submitted'").get().n;

  const stats = `<div class="stat-row">
    <div class="stat-card"><span class="stat-num">${unverified}</span><span class="stat-label">Awaiting verification</span></div>
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
  </form>`;
  const body = `
  <div class="page-head"><div><h1>All Orders</h1><p class="muted">Review, verify and update customer orders.</p></div></div>
  ${stats}
  ${tabs}
  ${V.ordersTable(orders, { adminView: true })}`;
  render(req, res, { title: 'Admin - Orders', user: req.user, body, active: 'orders' });
});

app.get('/admin/orders/:id', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const { itemsTable, artworkSection, receiptSection } = orderDetailBody(order, { isAdmin: true });
  const allChecked = order.chk_artwork && order.chk_product && order.chk_payment;
  const receipts = getFiles(order.id, 'receipt');
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
  } else if (order.status === 'confirmed') {
    actionBtn = `<button class="btn btn-primary btn-lg" type="submit" name="action" value="complete">Mark as Order Complete</button>`;
  } else if (order.status === 'completed') {
    actionBtn = `
      ${order.delivery_method === 'courier' ? `
      <label>Courier tracking number <span class="req-chip">Required for courier delivery</span>
        <input name="tracking_no" value="${V.esc(order.tracking_no)}" required placeholder="e.g. J&amp;T / GDEX tracking no.">
      </label>` : ''}
      <button class="btn btn-primary btn-lg" type="submit" name="action" value="deliver">Mark as Delivered</button>`;
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
        ${!receipts.length && !order.payment_ref ? '<span class="req-chip">needs a receipt or bank ref</span>' : ''}</label>
      <label>Bank reference number
        <input name="payment_ref" value="${V.esc(order.payment_ref)}" placeholder="e.g. CIMB ref no.">
      </label>
      <button class="btn btn-outline" type="submit">Save Verification</button>
    </form>
    <hr class="divider">
    <form method="post" action="/admin/orders/${order.id}/status" class="stack">
      ${actionBtn}
    </form>
    ${order.status === 'submitted' || order.status === 'confirmed' ? `
    <hr class="divider">
    <details>
      <summary class="muted">Cancel this order (admin)</summary>
      <form method="post" action="/admin/orders/${order.id}/cancel" class="stack" style="margin-top:0.75rem"
        onsubmit="return confirm('Cancel this order? This cannot be undone.')">
        <label>Reason <input name="reason" required maxlength="300" placeholder="Reason shown to the customer"></label>
        <button class="btn btn-danger" type="submit">Cancel Order</button>
      </form>
    </details>` : ''}
  </div>`;

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
  <div class="grid-2">
    <div class="card"><h2>Items</h2>${itemsTable}
      ${order.notes ? `<p class="muted"><strong>Customer notes:</strong> ${V.esc(order.notes)}</p>` : ''}</div>
    ${deliveryCard(order)}
  </div>
  <div class="grid-2">
    ${artworkSection}
    ${receiptSection}
  </div>
  ${verifySection}
  ${commentsSection(order, `/admin/orders/${order.id}/comment`)}`;
  render(req, res, { title: `Admin - ${order.order_no}`, user: req.user, body, active: 'orders' });
});

app.post('/admin/orders/:id/checks', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const payRef = String(req.body.payment_ref || '').trim().slice(0, 200);
  // Rule: "payment received" can only be ticked when there is proof —
  // an uploaded receipt or a bank reference number.
  const hasReceipt = getFiles(order.id, 'receipt').length > 0;
  if (req.body.chk_payment && !hasReceipt && !payRef) {
    flash(req, 'error', 'Cannot mark payment as received: there is no receipt uploaded and no bank reference number. Enter the bank reference or wait for the customer\'s receipt.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare(
    'UPDATE orders SET chk_artwork = ?, chk_product = ?, chk_payment = ?, payment_ref = ? WHERE id = ?'
  ).run(
    req.body.chk_artwork ? 1 : 0,
    req.body.chk_product ? 1 : 0,
    req.body.chk_payment ? 1 : 0,
    payRef,
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
    // Rule: confirming requires an estimated ready date for the customer.
    const eta = String(req.body.eta_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eta)) {
      flash(req, 'error', 'Please set an estimated ready date before confirming the order.');
      return res.redirect(`/admin/orders/${order.id}`);
    }
    db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = datetime('now'), eta_date = ? WHERE id = ?")
      .run(eta, order.id);
    flash(req, 'success', `Order ${order.order_no} confirmed. Estimated ready: ${fmtDay(eta)}.`);
  } else if (action === 'complete' && order.status === 'confirmed') {
    db.prepare("UPDATE orders SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(order.id);
    flash(req, 'success', `Order ${order.order_no} marked as complete.`);
  } else if (action === 'deliver' && order.status === 'completed') {
    // Rule: courier orders need a tracking number before they can be marked delivered.
    const tracking = String(req.body.tracking_no || '').trim().slice(0, 100);
    if (order.delivery_method === 'courier' && !tracking) {
      flash(req, 'error', 'Enter the courier tracking number before marking this order as delivered.');
      return res.redirect(`/admin/orders/${order.id}`);
    }
    db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now'), tracking_no = ? WHERE id = ?")
      .run(tracking, order.id);
    flash(req, 'success', `Order ${order.order_no} marked as delivered.`);
  } else {
    flash(req, 'error', 'Invalid status change.');
  }
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/cancel', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  // Rule: admin can cancel before production is finished (submitted or confirmed).
  if (order.status !== 'submitted' && order.status !== 'confirmed') {
    flash(req, 'error', 'Only submitted or confirmed orders can be cancelled.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) {
    flash(req, 'error', 'Please give a reason for the cancellation.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?")
    .run(reason, order.id);
  flash(req, 'success', `Order ${order.order_no} cancelled.`);
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/comment', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (body) {
    db.prepare('INSERT INTO comments (order_id, author_id, author_name, author_role, body) VALUES (?,?,?,?,?)')
      .run(order.id, req.user.id, req.user.name, 'admin', body);
  }
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
      (p) => `<form method="post" action="/admin/products/${p.id}" class="product-row card ${p.active ? '' : 'inactive'}">
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
    <form method="post" action="/admin/products" class="stack">
      <div class="grid-fields">
        <label>Name<input name="name" required></label>
        <label>Unit<input name="unit" value="pcs" required></label>
        <label>Base Price (RM)<input name="base_price" type="number" step="0.01" min="0" required></label>
        <label>Min Order Qty<input name="moq" type="number" step="1" min="1" value="1" required></label>
      </div>
      <label>Description<input name="description"></label>
      <label>Artwork requirements<input name="artwork_spec" placeholder="e.g. 300dpi PNG or AI file"></label>
      <label>Bulk price tiers <span class="muted small">(minQty=price, comma separated)</span><input name="tiers" placeholder="50=22.50, 100=19.90"></label>
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

app.post('/admin/products', requireAdmin, (req, res) => {
  const v = productFieldsValid(req);
  if (!v) {
    flash(req, 'error', 'Check the product fields: name, valid price, min order qty of at least 1, and tiers in the form 50=22.50, 100=19.90.');
    return res.redirect('/admin/products');
  }
  const info = db.prepare('INSERT INTO products (name, description, unit, base_price, moq, artwork_spec) VALUES (?,?,?,?,?,?)').run(
    String(req.body.name).trim().slice(0, 200),
    String(req.body.description || '').trim().slice(0, 500),
    String(req.body.unit || 'pcs').trim().slice(0, 30),
    v.price, v.moq,
    String(req.body.artwork_spec || '').trim().slice(0, 300)
  );
  saveTiers(info.lastInsertRowid, v.tiers);
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
    const v = productFieldsValid(req);
    if (!v) {
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
      </div>
      <button class="btn btn-primary" type="submit">Save Settings</button>
    </form>
  </div>`;
  render(req, res, { title: 'Admin - Customers', user: req.user, body, active: 'customers' });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const wa = String(req.body.whatsapp || '').replace(/[^\d+]/g, '').slice(0, 20);
  const sst = parseFloat(req.body.sst_percent);
  const lead = parseInt(req.body.lead_days, 10);
  setSetting('whatsapp', wa);
  setSetting('sst_percent', isNaN(sst) || sst < 0 ? '0' : String(Math.min(sst, 50)));
  setSetting('lead_days', isNaN(lead) || lead < 0 ? '3' : String(Math.min(lead, 60)));
  flash(req, 'success', 'Settings saved. SST and lead time apply to new orders only.');
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
