# Aramega Order Portal

A mobile/tablet/desktop-friendly order portal for Aramega Textile Sdn Bhd customers, with an admin backend for order verification.

## Features

**Customer side**
- Login with username & password provided by admin
- Place orders: pick products + quantities with live order total (prices are per-customer)
- Invoice auto-generated on submission (printable / save as PDF, named `INV-xxxxx - Customer - RMamount`), including full CIMB payment info
- Upload artwork as a **.zip up to 500MB**, or paste a **WeTransfer link** (at order time or later)
- Upload bank receipt (PDF/image) as proof of payment, with bank reference number
- Home page: table of all their orders; each order has its own detail page with a status timeline

**Admin side**
- All orders table with status filter tabs
- Order verification checklist: artwork correct, product & quantity correct, payment received — **all three required before the order can be confirmed**
- Status flow: `Order Submitted → Order Confirmed → Order Complete → Order Delivered`
- Manage products (name, unit, base price, activate/deactivate)
- Create customer logins (you set the username & password), reset passwords, enable/disable accounts
- Set **per-customer pricing** per product (blank = use base price)

## Run

```bash
npm install
npm start          # http://localhost:3000
```

Default logins (change the passwords after first login via admin):

| Role     | Username | Password  |
|----------|----------|-----------|
| Admin    | `admin`  | `admin123`|
| Customer | `demo`   | `demo123` |

Data is stored in `data/orders.db` (SQLite) and uploaded files in `uploads/` — both are created automatically and excluded from git.

## Stack

Node.js + Express 5, better-sqlite3, multer (uploads), bcryptjs (password hashing), express-session. Server-rendered HTML with a lime-green responsive theme (`public/style.css`) — no build step required.
