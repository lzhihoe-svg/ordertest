// Server-rendered HTML views.

const STATUS = {
  submitted: { label: 'Order Submitted', step: 1 },
  confirmed: { label: 'Order Confirmed', step: 2 },
  completed: { label: 'Order Complete', step: 3 },
  delivered: { label: 'Order Delivered', step: 4 },
};
const STATUS_ORDER = ['submitted', 'confirmed', 'completed', 'delivered'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rm(n) {
  return 'RM ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function statusBadge(status) {
  const s = STATUS[status] || { label: status };
  return `<span class="badge badge-${esc(status)}">${esc(s.label)}</span>`;
}

function timeline(order) {
  const current = STATUS_ORDER.indexOf(order.status);
  const dates = {
    submitted: order.created_at,
    confirmed: order.confirmed_at,
    completed: order.completed_at,
    delivered: order.delivered_at,
  };
  return `<ol class="timeline">${STATUS_ORDER.map((s, i) => `
    <li class="${i < current ? 'done' : i === current ? 'current' : ''}">
      <span class="dot">${i < current ? '&#10003;' : i === current ? '&#9679;' : ''}</span>
      <span class="tl-label">${esc(STATUS[s].label)}</span>
      <span class="tl-date">${i <= current ? esc(fmtDate(dates[s])) : ''}</span>
    </li>`).join('')}
  </ol>`;
}

function flashBlock(flash) {
  if (!flash) return '';
  return `<div class="flash flash-${esc(flash.type)}">${esc(flash.msg)}</div>`;
}

function layout({ title, user, body, flash, active = '' }) {
  const nav = user
    ? user.role === 'admin'
      ? `
        <a href="/admin" class="${active === 'orders' ? 'active' : ''}">Orders</a>
        <a href="/admin/products" class="${active === 'products' ? 'active' : ''}">Products</a>
        <a href="/admin/customers" class="${active === 'customers' ? 'active' : ''}">Customers &amp; Pricing</a>`
      : `
        <a href="/" class="${active === 'home' ? 'active' : ''}">My Orders</a>
        <a href="/orders/new" class="${active === 'new' ? 'active' : ''}">New Order</a>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Aramega Order Portal</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="${user && user.role === 'admin' ? '/admin' : '/'}">
      <span class="brand-mark">A</span> Aramega <span class="brand-sub">Order Portal</span>
    </a>
    ${user ? `
    <input type="checkbox" id="nav-toggle" class="nav-toggle">
    <label for="nav-toggle" class="nav-burger" aria-label="Menu"><span></span><span></span><span></span></label>
    <nav class="nav">
      ${nav}
      <form method="post" action="/logout" class="logout-form">
        <span class="nav-user">${esc(user.name)}${user.role === 'admin' ? ' (Admin)' : ''}</span>
        <button type="submit" class="btn btn-ghost btn-sm">Log out</button>
      </form>
    </nav>` : ''}
  </div>
</header>
<main class="container">
${flashBlock(flash)}
${body}
</main>
<footer class="footer">Aramega Textile Sdn Bhd &middot; Order Portal</footer>
</body>
</html>`;
}

// ---------- auth ----------

function loginPage({ error }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login - Aramega Order Portal</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="login-body">
<div class="login-card">
  <div class="login-logo"><span class="brand-mark big">A</span></div>
  <h1>Aramega Order Portal</h1>
  <p class="muted">Sign in with the username and password provided to you.</p>
  ${error ? `<div class="flash flash-error">${esc(error)}</div>` : ''}
  <form method="post" action="/login" class="stack">
    <label>Username
      <input name="username" required autocomplete="username" autofocus>
    </label>
    <label>Password
      <input type="password" name="password" required autocomplete="current-password">
    </label>
    <button class="btn btn-primary btn-block" type="submit">Sign in</button>
  </form>
</div>
</body>
</html>`;
}

// ---------- shared order table ----------

function ordersTable(orders, { adminView = false } = {}) {
  if (!orders.length) {
    return `<div class="empty">No orders yet.${adminView ? '' : ' <a href="/orders/new">Place your first order</a>.'}</div>`;
  }
  const base = adminView ? '/admin/orders/' : '/orders/';
  return `<div class="table-wrap"><table class="table">
<thead><tr>
  <th>Order #</th><th>Invoice #</th>${adminView ? '<th>Customer</th>' : ''}
  <th>Date</th><th class="num">Total</th><th>Status</th><th></th>
</tr></thead>
<tbody>
${orders.map((o) => `<tr>
  <td data-label="Order #"><a href="${base}${o.id}">${esc(o.order_no)}</a></td>
  <td data-label="Invoice #">${esc(o.invoice_no)}</td>
  ${adminView ? `<td data-label="Customer">${esc(o.customer_name)}</td>` : ''}
  <td data-label="Date">${esc(fmtDate(o.created_at))}</td>
  <td data-label="Total" class="num">${rm(o.total)}</td>
  <td data-label="Status">${statusBadge(o.status)}</td>
  <td data-label=""><a class="btn btn-sm btn-outline" href="${base}${o.id}">View</a></td>
</tr>`).join('')}
</tbody></table></div>`;
}

module.exports = { esc, rm, fmtDate, layout, loginPage, statusBadge, timeline, ordersTable, STATUS, STATUS_ORDER };
