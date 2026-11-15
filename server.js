import express from "express";

const {
  PORT = 3000, BASE_URL, STORE_ORIGIN,
  ENKASH_ENV = "uat", ENKASH_ACCESS_KEY, ENKASH_SECRET_KEY,
  SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = "2026-07", SHIPPING_FLAT = "0",
  CRON_KEY, CANCEL_AFTER_MINUTES = "60", MANUAL_GATEWAY_MATCH = "enkash",
} = process.env;

for (const [k, v] of Object.entries({ BASE_URL, STORE_ORIGIN, ENKASH_ACCESS_KEY, ENKASH_SECRET_KEY, SHOPIFY_SHOP })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

const ENKASH_BASE = ENKASH_ENV === "live" ? "https://olympus-pg.enkash.in" : "https://olympus-pg-uat.enkash.in";
const gatewayRe = new RegExp(MANUAL_GATEWAY_MATCH, "i"); // manual payment method ke naam se match

/* ================= Enkash client ================= */
let ekToken = { value: null, exp: 0 };
let authPrefix = ""; // 117 error aaye to "Bearer " par auto-switch

async function getEnkashToken() {
  if (ekToken.value && Date.now() < ekToken.exp - 60_000) return ekToken.value;
  const r = await fetch(`${ENKASH_BASE}/api/v0/merchant/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: ENKASH_ACCESS_KEY, secretKey: ENKASH_SECRET_KEY }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.token) throw new Error("Enkash token failed: " + (d.resultMessage || r.status));
  ekToken = { value: d.token, exp: Number(d.expiry) || Date.now() + 10 * 60_000 };
  return ekToken.value;
}

async function enkash(path, { method = "GET", body } = {}) {
  let d;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getEnkashToken();
    const r = await fetch(ENKASH_BASE + path, {
      method,
      headers: { "Content-Type": "application/json", merchantAccessKey: ENKASH_ACCESS_KEY, Authorization: authPrefix + token },
      body: body ? JSON.stringify(body) : undefined,
    });
    d = await r.json().catch(() => ({}));
    if (d.response_code === 117 && attempt === 0) { authPrefix = authPrefix ? "" : "Bearer "; continue; }
    break;
  }
  return d;
}

async function enkashStatus(merchantOrderId) {
  const st = await enkash(`/api/v0/orders?merchantOrderId=${encodeURIComponent(merchantOrderId)}`);
  const p = st.payload;
  return p && p.merchantOrderId === merchantOrderId ? p : null;
}

/* ================= Shopify client ================= */
let shopTok = SHOPIFY_ADMIN_TOKEN ? { value: SHOPIFY_ADMIN_TOKEN, exp: Infinity } : { value: null, exp: 0 };

async function shopifyToken() {
  if (shopTok.value && Date.now() < shopTok.exp - 60_000) return shopTok.value;
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Shopify token failed: " + JSON.stringify(d));
  shopTok = { value: d.access_token, exp: Date.now() + (d.expires_in || 86399) * 1000 };
  return shopTok.value;
}

async function shopify(path, method = "GET", body) { // REST (draft orders)
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await shopifyToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

async function gql(query, variables = {}) { // GraphQL (orders)
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await shopifyToken() },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (d.errors) throw new Error("Shopify GraphQL: " + JSON.stringify(d.errors));
  return d.data;
}

const gidOf = (n) => `gid://shopify/Order/${n}`;
const numOf = (gid) => String(gid).split("/").pop();
const ORDER_FIELDS = `id name email phone cancelledAt createdAt displayFinancialStatus tags paymentGatewayNames
  totalPriceSet { shopMoney { amount currencyCode } }
  shippingAddress { firstName lastName address1 city province zip phone }`;

async function addTags(id, tags) {
  const d = await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id, tags });
  if (d.tagsAdd.userErrors.length) throw new Error("tagsAdd: " + JSON.stringify(d.tagsAdd.userErrors));
}

async function findOrderByName(raw) {
  let name = clean(raw, 30);
  if (/^\d+$/.test(name)) name = "#" + name;
  const d = await gql(`query($q:String!){ orders(first:5, query:$q){ nodes{ ${ORDER_FIELDS} } } }`, { q: `name:${name}` });
  return d.orders.nodes.find((o) => o.name.toLowerCase() === name.toLowerCase()) || null;
}

/* ================= Helpers ================= */
const clean = (s, max = 120) => String(s ?? "").trim().slice(0, max);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const hits = new Map();
function limited(ip, max = 15, windowMs = 10 * 60_000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#222}
input,button{width:100%;padding:12px;margin:6px 0;font-size:16px;box-sizing:border-box}
button{background:#111;color:#fff;border:0;border-radius:6px}.err{color:#b00}</style></head>
<body><h2>${esc(title)}</h2>${body}</body></html>`;

const payForm = (msg = "") => page("Pay for your order",
  `${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<form method="get" action="/pay">
<input name="order" placeholder="Order number (e.g. #1001)" required>
<input name="email" type="email" placeholder="Email used at checkout" required>
<button type="submit">Continue to payment</button></form>`);

/* ================= App ================= */
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "50kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", STORE_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- A) Checkout page se bane pending order ke liye: /pay ---------- */
async function startEnkashForOrder(o, ip) {
  const { amount, currencyCode } = o.totalPriceSet.shopMoney;
  if (currencyCode !== "INR") throw new Error("Store currency must be INR");
  const merchantOrderId = `SHO${numOf(o.id)}T${Date.now().toString(36)}`;
  const a = o.shippingAddress || {};
  const phone = clean(a.phone || o.phone, 20).replace(/\D/g, "").slice(-10);

  const res = await enkash("/api/v0/orders", {
    method: "POST",
    body: {
      orderId: merchantOrderId,
      amount: { value: parseFloat(amount), currency: "INR" },
      returnUrl: `${BASE_URL}/payment/return?m=${merchantOrderId}`,
      notifyUrl: `${BASE_URL}/webhook/enkash?m=${merchantOrderId}`,
      customerInfo: {
        firstName: a.firstName || "Customer", lastName: a.lastName || "-",
        ...(o.email && { email: o.email }),
        ...(phone.length === 10 && { phoneNumber: phone }),
        ...(a.address1 && { address: { streetName: a.address1, city: a.city || "NA", state: a.province || "NA", country: "India", zipcode: a.zip || "000000" } }),
        customerIpAddress: ip,
      },
      description: `Shopify order ${o.name}`,
    },
  });
  if (res.response_code !== 0 || !res.payload?.redirectionUrl) {
    console.error("Enkash create order failed:", res);
    throw new Error("Payment could not be started");
  }
  await addTags(o.id, [`ek:${merchantOrderId}`]); // cron cancel se pehle isse status check hota hai
  return res.payload.redirectionUrl;
}

app.get("/pay", async (req, res) => {
  const order = clean(req.query.order, 30), email = clean(req.query.email).toLowerCase();
  if (!order || !email) return res.send(payForm());
  if (limited(req.ip)) return res.status(429).send(payForm("Too many attempts. Please try again in a few minutes."));
  try {
    const o = await findOrderByName(order);
    if (!o || (o.email || "").toLowerCase() !== email)
      return res.status(404).send(payForm("Order not found. Please check the order number and email."));
    if (o.cancelledAt) return res.send(payForm("This order was cancelled. Please place a new order."));
    if (o.displayFinancialStatus === "PAID") return res.send(page("Already paid", "<p>This order is already paid. Thank you!</p>"));
    if (o.displayFinancialStatus !== "PENDING" || !o.paymentGatewayNames.some((n) => gatewayRe.test(n)))
      return res.send(payForm("This order is not waiting for an Enkash payment."));
    res.redirect(await startEnkashForOrder(o, req.ip));
  } catch (e) {
    console.error(e);
    res.status(500).send(payForm("Something went wrong. Please try again."));
  }
});

/* ---------- B) Cart page flow (draft order) ---------- */
app.post("/api/pay", async (req, res) => {
  try {
    const { items, customer: c = {} } = req.body || {};
    if (!Array.isArray(items) || !items.length || items.length > 50) return res.status(400).json({ error: "Cart empty" });
    const lines = items.map((i) => ({ variant_id: Number(i.variant_id), quantity: Number(i.quantity) }));
    if (lines.some((l) => !Number.isInteger(l.variant_id) || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 100))
      return res.status(400).json({ error: "Invalid items" });

    const phone = clean(c.phone, 20).replace(/\D/g, "").slice(-10);
    const email = clean(c.email);
    if (!clean(c.name) || !/^\S+@\S+\.\S+$/.test(email) || phone.length !== 10 || !clean(c.address1) || !clean(c.city) || !clean(c.state) || !clean(c.zip))
      return res.status(400).json({ error: "Please fill all details correctly" });

    const [firstName, ...rest] = clean(c.name).split(/\s+/);
    const lastName = rest.join(" ") || "-";
    const addr = { first_name: firstName, last_name: lastName, address1: clean(c.address1, 200), city: clean(c.city), province: clean(c.state), zip: clean(c.zip, 10), country: "India", phone };
    const ship = parseFloat(SHIPPING_FLAT) || 0;

    const { draft_order: draft } = await shopify("/draft_orders.json", "POST", {
      draft_order: {
        line_items: lines, email, shipping_address: addr, billing_address: addr, tags: "enkash-pending",
        ...(ship > 0 && { shipping_line: { title: "Shipping", price: ship.toFixed(2) } }),
      },
    });
    if (draft.currency !== "INR") return res.status(500).json({ error: "Store currency must be INR" });

    const merchantOrderId = `SHD${draft.id}T${Date.now().toString(36)}`;
    const o = await enkash("/api/v0/orders", {
      method: "POST",
      body: {
        orderId: merchantOrderId,
        amount: { value: parseFloat(draft.total_price), currency: "INR" },
        returnUrl: `${BASE_URL}/payment/return?m=${merchantOrderId}`,
        notifyUrl: `${BASE_URL}/webhook/enkash?m=${merchantOrderId}`,
        customerInfo: {
          firstName, lastName, email, phoneNumber: phone,
          address: { streetName: addr.address1, city: addr.city, state: addr.province, country: "India", zipcode: addr.zip },
          customerIpAddress: req.ip,
        },
        description: `Shopify draft ${draft.name}`,
      },
    });
    if (o.response_code !== 0 || !o.payload?.redirectionUrl) {
      console.error("Enkash create order failed:", o);
      return res.status(502).json({ error: "Payment could not be started" });
    }
    res.json({ url: o.payload.redirectionUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- Settle: Enkash se verify karke Shopify me paid mark karo ---------- */
const inflight = new Map();
function settle(id) {
  if (!inflight.has(id)) {
    const p = _settle(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return inflight.get(id);
}

async function _settle(id) {
  let m;
  if ((m = /^SHD(\d+)T[a-z0-9]+$/.exec(id || ""))) return settleDraft(id, m[1]);
  if ((m = /^SHO(\d+)T[a-z0-9]+$/.exec(id || ""))) return settleOrder(id, m[1]);
  return { ok: false, kind: "draft", reason: "bad id" };
}

async function settleDraft(id, draftId) {
  const p = await enkashStatus(id);
  if (!p) return { ok: false, kind: "draft", reason: "order not found" };
  if (p.status !== "PAID") return { ok: false, kind: "draft", reason: p.status };
  const { draft_order: draft } = await shopify(`/draft_orders/${draftId}.json`);
  if (draft.status === "completed") return { ok: true, kind: "draft", already: true };
  if (Math.abs(parseFloat(draft.total_price) - Number(p.amount)) > 0.01) {
    console.error("AMOUNT MISMATCH (draft)", id, draft.total_price, p.amount);
    return { ok: false, kind: "draft", reason: "amount mismatch" };
  }
  await shopify(`/draft_orders/${draftId}.json`, "PUT", {
    draft_order: { id: Number(draftId), note: `Paid via Enkash. Enkash orderId: ${p.orderId}`, tags: "enkash-paid" },
  });
  await shopify(`/draft_orders/${draftId}/complete.json?payment_pending=false`, "PUT");
  return { ok: true, kind: "draft" };
}

async function settleOrder(id, numId) {
  const p = await enkashStatus(id);
  if (!p) return { ok: false, kind: "order", reason: "order not found" };
  if (p.status !== "PAID") return { ok: false, kind: "order", reason: p.status };

  const { order: o } = await gql(`query($id:ID!){ order(id:$id){ ${ORDER_FIELDS} } }`, { id: gidOf(numId) });
  if (!o) return { ok: false, kind: "order", reason: "shopify order missing" };
  const ekTag = `enkash-id:${p.orderId}`;

  if (o.displayFinancialStatus === "PAID") {
    if (!o.tags.includes(ekTag)) {
      console.error("EXTRA PAYMENT - refund needed:", o.name, "Enkash orderId", p.orderId);
      await addTags(o.id, [`enkash-extra:${p.orderId}`]);
    }
    return { ok: true, kind: "order", already: true };
  }
  if (o.cancelledAt) {
    console.error("PAID BUT ORDER CANCELLED - refund or recreate:", o.name, "Enkash orderId", p.orderId);
    await addTags(o.id, [`enkash-paid-but-cancelled:${p.orderId}`]);
    return { ok: false, kind: "order", reason: "cancelled" };
  }
  if (Math.abs(parseFloat(o.totalPriceSet.shopMoney.amount) - Number(p.amount)) > 0.01) {
    console.error("AMOUNT MISMATCH (order)", o.name, o.totalPriceSet.shopMoney.amount, p.amount);
    return { ok: false, kind: "order", reason: "amount mismatch" };
  }
  const d = await gql(`mutation($id:ID!){ orderMarkAsPaid(input:{id:$id}){ userErrors{ message } } }`, { id: o.id });
  if (d.orderMarkAsPaid.userErrors.length) throw new Error("orderMarkAsPaid: " + JSON.stringify(d.orderMarkAsPaid.userErrors));
  await addTags(o.id, ["enkash-paid", ekTag]);
  return { ok: true, kind: "order" };
}

app.post("/webhook/enkash", async (req, res) => {
  try { await settle(String(req.query.m || "")); res.sendStatus(200); }
  catch (e) { console.error(e); res.sendStatus(500); }
});

app.get("/payment/return", async (req, res) => {
  let r = { ok: false, kind: "draft" };
  try { r = await settle(String(req.query.m || "")); } catch (e) { console.error(e); }
  const fail = r.kind === "order" ? "/pages/payment-failed" : "/cart?payment=failed";
  res.redirect(`${STORE_ORIGIN}${r.ok ? "/pages/payment-success" : fail}`);
});

/* ---------- Unpaid orders auto-cancel (cron-job.org se har 15 min call karo) ---------- */
app.get("/cron/cancel-unpaid", async (req, res) => {
  if (!CRON_KEY || req.query.key !== CRON_KEY) return res.sendStatus(403);
  try {
    const cutoff = new Date(Date.now() - (Number(CANCEL_AFTER_MINUTES) || 60) * 60_000).toISOString();
    const d = await gql(
      `query($q:String!){ orders(first:50, query:$q, sortKey:CREATED_AT){ nodes{ ${ORDER_FIELDS} } } }`,
      { q: `financial_status:pending status:open created_at:<${cutoff}` }
    );
    const out = { cancelled: [], paid: [], skipped: [] };
    for (const o of d.orders.nodes) {
      if (o.cancelledAt || !o.paymentGatewayNames.some((n) => gatewayRe.test(n))) { out.skipped.push(o.name); continue; }
      // Cancel se pehle check: kisi attempt ka paisa to nahi aaya?
      let paid = false;
      for (const t of o.tags.filter((t) => t.startsWith("ek:"))) {
        const r = await settle(t.slice(3));
        if (r.ok) { paid = true; break; }
      }
      if (paid) { out.paid.push(o.name); continue; }
      const c = await gql(
        `mutation($id:ID!){ orderCancel(orderId:$id, reason:OTHER, refund:false, restock:true, notifyCustomer:false, staffNote:"Enkash payment not received"){ orderCancelUserErrors{ message } } }`,
        { id: o.id }
      );
      if (c.orderCancel.orderCancelUserErrors.length) { console.error("cancel failed", o.name, c.orderCancel.orderCancelUserErrors); out.skipped.push(o.name); }
      else out.cancelled.push(o.name);
    }
    res.json(out);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log(`Listening on ${PORT} (Enkash ${ENKASH_ENV})`));
