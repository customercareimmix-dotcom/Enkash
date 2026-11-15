import express from "express";

const {
  PORT = 3000, BASE_URL, STORE_ORIGIN,
  ENKASH_ENV = "uat", ENKASH_ACCESS_KEY, ENKASH_SECRET_KEY,
  SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = "2026-07", SHIPPING_FLAT = "0",
} = process.env;

for (const [k, v] of Object.entries({ BASE_URL, STORE_ORIGIN, ENKASH_ACCESS_KEY, ENKASH_SECRET_KEY, SHOPIFY_SHOP })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

const ENKASH_BASE = ENKASH_ENV === "live" ? "https://olympus-pg.enkash.in" : "https://olympus-pg-uat.enkash.in";

/* ---------- Enkash client ---------- */
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
      headers: {
        "Content-Type": "application/json",
        merchantAccessKey: ENKASH_ACCESS_KEY,
        Authorization: authPrefix + token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    d = await r.json().catch(() => ({}));
    if (d.response_code === 117 && attempt === 0) { authPrefix = authPrefix ? "" : "Bearer "; continue; }
    break;
  }
  return d;
}

/* ---------- Shopify client ---------- */
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

async function shopify(path, method = "GET", body) {
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await shopifyToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "50kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", STORE_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const clean = (s, max = 120) => String(s ?? "").trim().slice(0, max);

// 1) Checkout start: cart -> Shopify draft order -> Enkash order
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

    // Price Shopify decide karta hai, frontend nahi
    const { draft_order: draft } = await shopify("/draft_orders.json", "POST", {
      draft_order: {
        line_items: lines, email, shipping_address: addr, billing_address: addr, tags: "enkash-pending",
        ...(ship > 0 && { shipping_line: { title: "Shipping", price: ship.toFixed(2) } }),
      },
    });
    if (draft.currency !== "INR") return res.status(500).json({ error: "Store currency must be INR" });

    const total = parseFloat(draft.total_price);
    const merchantOrderId = `SHD${draft.id}T${Date.now().toString(36)}`; // alphanumeric only

    const o = await enkash("/api/v0/orders", {
      method: "POST",
      body: {
        orderId: merchantOrderId,
        amount: { value: total, currency: "INR" },
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

// 2) Enkash se status verify karke Shopify order paid banao (idempotent)
const inflight = new Map();
function settle(merchantOrderId) {
  if (!inflight.has(merchantOrderId)) {
    const p = _settle(merchantOrderId).finally(() => inflight.delete(merchantOrderId));
    inflight.set(merchantOrderId, p);
  }
  return inflight.get(merchantOrderId);
}

async function _settle(merchantOrderId) {
  const m = /^SHD(\d+)T[a-z0-9]+$/.exec(merchantOrderId || "");
  if (!m) return { ok: false, reason: "bad id" };
  const draftId = m[1];

  // Webhook body pe bharosa nahi: Enkash se direct status poochho
  const st = await enkash(`/api/v0/orders?merchantOrderId=${encodeURIComponent(merchantOrderId)}`);
  const p = st.payload;
  if (!p || p.merchantOrderId !== merchantOrderId) return { ok: false, reason: "order not found" };
  if (p.status !== "PAID") return { ok: false, reason: p.status };

  const { draft_order: draft } = await shopify(`/draft_orders/${draftId}.json`);
  if (draft.status === "completed") return { ok: true, already: true };
  if (Math.abs(parseFloat(draft.total_price) - Number(p.amount)) > 0.01) {
    console.error("AMOUNT MISMATCH", merchantOrderId, draft.total_price, p.amount);
    return { ok: false, reason: "amount mismatch" };
  }

  await shopify(`/draft_orders/${draftId}.json`, "PUT", {
    draft_order: { id: Number(draftId), note: `Paid via Enkash. Enkash orderId: ${p.orderId}`, tags: "enkash-paid" },
  });
  await shopify(`/draft_orders/${draftId}/complete.json?payment_pending=false`, "PUT");
  return { ok: true };
}

app.post("/webhook/enkash", async (req, res) => {
  try { await settle(req.query.m); res.sendStatus(200); }
  catch (e) { console.error(e); res.sendStatus(500); }
});

// 3) Customer wapas aata hai
app.get("/payment/return", async (req, res) => {
  let r = { ok: false };
  try { r = await settle(String(req.query.m || "")); } catch (e) { console.error(e); }
  res.redirect(r.ok ? `${STORE_ORIGIN}/pages/payment-success` : `${STORE_ORIGIN}/cart?payment=failed`);
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log(`Listening on ${PORT} (Enkash ${ENKASH_ENV})`));
