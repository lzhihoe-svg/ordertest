# Aramega Order Portal

A mobile/tablet/desktop-friendly order portal for Aramega Textile Sdn Bhd customers, with an admin backend for order verification.

## Features

**Customer side**
- Login with username & password provided by admin
- Place orders: pick products + quantities with live totals; **bulk tier prices** apply automatically and **per-customer prices** override everything
- Invoice auto-generated on submission (printable / save as PDF, named `INV-xxxxx - Customer - RMamount`), including full CIMB payment info and optional SST line
- Upload artwork as a **.zip up to 500MB**, or paste a **WeTransfer link**
- Delivery choice (self pickup / courier with address), needed-by date, per-product artwork specs
- Upload bank receipt (PDF/image) as proof of payment, with bank reference number
- Order discussion thread with admin, re-order button, cancel while awaiting confirmation
- Home page: table of all their orders; each order has its own detail page with a status timeline
- Floating WhatsApp contact button (number set by admin)

**Admin side**
- Dashboard stats (awaiting verification / in production / ready / total order value), status filter tabs incl. Cancelled, and search
- Order verification checklist: artwork correct, product & quantity correct, payment received — **all three required before the order can be confirmed**
- Status flow: `Order Submitted → Order Confirmed → Order Complete → Order Delivered` (+ Cancelled)
- Manage products: base price, **bulk price tiers**, **minimum order quantity**, artwork requirements
- Create customer logins (you set the username & password), reset passwords, enable/disable accounts
- Set **per-customer pricing** per product (blank = base price + tiers)
- Portal settings: WhatsApp number, SST %, production lead time
- Order discussion thread, admin cancellation with reason

**Payments, revisions & money handling**
- **Payments ledger**: customers submit each payment with an amount + receipt file; admin verifies or rejects (with a reason); admin can also record bank-statement/cash payments manually. Orders show Total / Paid / Balance Due
- **Deposit rule**: a configurable deposit % (default 50%) in verified payments is required before an order can be confirmed; **full payment is required before delivery**
- **Revision requests**: instead of cancelling a problematic order, admin sends it back as *Revision Requested* with a reason; the customer fixes artwork and **resubmits**
- **Cancelled-with-payment resolution**: if a cancelled order has verified payments, admin must resolve it — record a **bank refund** (with transfer ref) or convert it to **store credit**
- **Store credit**: credited amounts live on the customer's account and can be applied automatically to the next order (counts toward the deposit)
- **Order history log**: every event (submit, revision, payments, confirm, cancel, refund, delivery proof) is recorded with actor and time, visible on the order
- **Delivery proof**: admin uploads the DO / delivery photo to the order
- **Customer account page**: credit balance + self-service password change
- **CSV export** of all orders (with paid/balance figures) for accounting

**Enforced business rules**
1. An order **cannot be submitted without artwork** — a .zip upload or a WeTransfer link is mandatory (client + server validated)
2. Quantities must meet each product's **minimum order quantity**
3. Needed-by date must respect the configurable **production lead time**
4. **Courier delivery requires an address**; marking a courier order delivered requires a **tracking number**
5. A customer payment submission requires an **amount + receipt file**, and cannot exceed the balance due
6. Admin cannot tick "payment received" (or confirm) until **verified payments cover the deposit %**
7. Confirming an order requires all 3 verification checks **and an estimated ready date**; the deposit is re-checked at confirm time
8. **Full payment before delivery** — a courier order additionally needs a tracking number
9. Rejecting a payment requires a reason (shown to the customer); a bank refund requires the transfer reference
10. Customers can cancel (with a reason) **only before confirmation**; admin can cancel before completion; money on a cancelled order must be resolved (refund or credit) exactly once
11. SST %, deposit % and lead time are snapshotted/validated per order — changing settings never alters old invoices

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
