import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import Stripe from 'stripe';

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY,
  ADMIN_KEY_HASHES = '', ADMIN_SESSION_SECRET = '', CORS_ORIGINS = '', PORT = 3000,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SITE_URL = 'http://localhost:5173',
  RESEND_API_KEY, MAIL_FROM = 'FENOMENAL <objednavky@fenomenal.wtf>', MAIL_REPLY_TO
} = process.env;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
  console.error('Chýbajú SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const ANON_OPTS = { auth: { persistSession: false, autoRefreshToken: false } };
const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, ANON_OPTS); // stateless: never holds a user session
// SHA-256 hashes of the admin secret keys; the keys themselves never live on the server
const adminKeys = ADMIN_KEY_HASHES.split(',').map(s => s.trim().toLowerCase()).filter(s => /^[0-9a-f]{64}$/.test(s));
if (adminKeys.length && ADMIN_SESSION_SECRET.length < 32) {
  console.error('ADMIN_SESSION_SECRET musí mať aspoň 32 znakov');
  process.exit(1);
}
const origins = CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);

/* ---------- Validation helpers ---------- */
const fail = (status, message, extra) => Object.assign(new Error(message), { status, expose: true, ...extra });
const isStr = v => typeof v === 'string';
const URL_IMG = /^(https:\/\/[^\s"'<>\\]{1,2000}|img\/[A-Za-z0-9._-]{1,120})$/; // https URL or bundled img/…
const URL_HTTPS = /^https:\/\/[^\s"'<>\\]{1,2000}$/;
const STRIPE_LINK = /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]{6,100}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{10,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTAGRAM = /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._]{1,30}\/?$/;

// Per-column rules for admin writes: anything not listed in a resource is dropped, anything malformed is rejected.
const text = max => v => v === null || (isStr(v) && v.length <= max) ? v : undefined;
const url = re => v => v === null || (isStr(v) && re.test(v)) ? v : undefined;
const int = (min, max) => v => v === null || (Number.isInteger(v) && v >= min && v <= max) ? v : undefined;
const num = (min, max) => v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : undefined;
const bool = v => typeof v === 'boolean' ? v : undefined;
const oneOf = list => v => list.includes(v) ? v : undefined;
const date = v => v === null || (isStr(v) && DATE.test(v) && !Number.isNaN(Date.parse(v))) ? v : undefined;
const sizes = v => Array.isArray(v) && v.length <= 20 && v.every(s => isStr(s) && s.length <= 20) ? v : undefined;
const required = rule => v => v === null || v === '' ? undefined : rule(v);

const RESOURCES = {
  members:   { order: 'sort', fields: { name: required(text(120)), bio: text(5000), img: url(URL_IMG), instagram: url(INSTAGRAM), sort: int(0, 9999), published: bool } },
  playlists: { order: 'sort', fields: { title: required(text(200)), sub: text(200), type: oneOf(['playlist', 'album', 'artist', 'track']), spotify_id: required(url(SPOTIFY_ID)), sort: int(0, 9999), published: bool } },
  events:    { order: 'date', fields: { title: required(text(200)), date: required(date), venue: text(200), city: text(120), ticket_url: url(URL_HTTPS), sort: int(0, 9999), published: bool } },
  news:      { order: 'date', desc: true, fields: { title: required(text(200)), body: text(10000), date, img: url(URL_IMG), sort: int(0, 9999), published: bool } },
  products:  { order: 'sort', fields: { name: required(text(120)), sub: text(200), price: num(0, 100000), img: url(URL_IMG), badge: text(40), sizes, payment_link: url(STRIPE_LINK), sort: int(0, 9999), published: bool } },
  gallery:   { order: 'sort', fields: { src: required(url(URL_IMG)), cat: oneOf(['crew', 'street']), cap: text(120), sort: int(0, 9999), published: bool } },
  // orders come from the shop / Stripe; the admin only moves them through statuses (or deletes test ones)
  shipping_methods: { order: 'sort', fields: { name: required(text(120)), description: text(200), price: num(0, 1000), kind: oneOf(['pickup', 'address', 'packeta']), sort: int(0, 9999), published: bool } },
  orders:    { order: 'created_at', desc: true, noCreate: true, adminOnly: true, fields: { status: oneOf(['pending_payment', 'paid', 'shipped', 'done', 'cancelled']) } }
};

function validate(body, cfg) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Neplatné údaje');
  const out = {}, bad = [];
  for (const [k, rule] of Object.entries(cfg.fields)) {
    if (!(k in body)) continue;
    let v = body[k];
    if (isStr(v)) v = v.trim();
    const ok = rule(v === '' ? null : v);
    if (ok === undefined) bad.push(k); else out[k] = ok;
  }
  if (bad.length) throw fail(400, `Neplatné pole: ${bad.join(', ')}`, { fields: bad });
  return out;
}

/* ---------- Rate limiting (in memory, per IP and bucket) ---------- */
const hits = new Map();
const limit = (bucket, max, windowMs) => (req, res, next) => {
  const key = `${bucket}:${req.ip}`, now = Date.now();
  const h = hits.get(key);
  if (!h || now > h.reset) { hits.set(key, { n: 1, reset: now + windowMs }); return next(); }
  if (++h.n > max) {
    res.set('Retry-After', Math.ceil((h.reset - now) / 1000));
    return res.status(429).json({ error: 'Príliš veľa pokusov, skús to o chvíľu.' });
  }
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60_000).unref();

/* ---------- App + security headers ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render terminates TLS in front of us → real client IP for rate limits
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  });
  next();
});

/* ---------- Stripe webhook (needs the raw body, so it is registered before express.json) ---------- */
// Stripe → Developers → Webhooks → endpoint https://<api>/api/stripe/webhook, event checkout.session.completed
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '512kb' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook nie je nastavený' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).json({ error: 'Neplatný podpis' });
  }
  try {
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const s = event.data.object;
      if (s.payment_status === 'paid' && REF_RE.test(s.client_reference_id || '')) await finalizeOrder(s);
      else if (s.payment_status === 'paid') {
        const { data: lines } = await stripe.checkout.sessions.listLineItems(s.id, { limit: 100 });
        const { data: existing } = await db.from('orders').select('shipping').eq('stripe_session_id', s.id).maybeSingle();
        const row = {
          stripe_session_id: s.id,
          status: 'paid',
          email: s.customer_details?.email,
          items: lines.map(l => ({ name: l.description, qty: l.quantity, amount: l.amount_total / 100 })),
          amount_total: s.amount_total / 100,
          currency: s.currency
        };
        // never overwrite an address the customer already confirmed in the shipping form
        if (!existing?.shipping?.confirmed) {
          Object.assign(row, { name: s.customer_details?.name, phone: s.customer_details?.phone, shipping: fromStripe(s) });
        }
        const { error } = await db.from('orders').upsert(row, { onConflict: 'stripe_session_id' });
        if (error) throw error;
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook:', e);
    res.status(500).json({ error: 'Webhook error' }); // Stripe retries on 5xx
  }
});

// No configured origins → no cross-origin access at all (never "allow everyone")
app.use(cors({
  origin: origins.length ? origins : false,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
}));
app.use(express.json({ limit: '100kb' }));

// Only errors we raised on purpose reach the client; everything else is logged and answered generically
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e.expose) return res.status(e.status).json({ error: e.message, ...(e.fields && { missing: e.fields }) });
  console.error(e);
  res.status(500).json({ error: 'Nastala chyba servera' });
});
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
const resource = (req, res, next) => {
  const r = Object.hasOwn(RESOURCES, req.params.res) ? RESOURCES[req.params.res] : null;
  if (!r) return res.status(404).json({ error: 'Nenájdené' });
  req.cfg = r; next();
};
const idParam = (req, res, next) => /^\d{1,12}$/.test(req.params.id) ? next() : res.status(400).json({ error: 'Neplatné ID' });

/* ---------- Health ---------- */
// db = whether the backend can write orders (service_role key valid); cached for a minute
let dbCheck = { at: 0, ok: false };
app.get('/health', async (_, res) => {
  if (Date.now() - dbCheck.at > 60_000) {
    const { error } = await db.from('orders').select('id', { head: true, count: 'exact' }).limit(1);
    dbCheck = { at: Date.now(), ok: !error };
  }
  res.json({ ok: true, db: dbCheck.ok });
});

/* ---------- Public ---------- */
// Read with the anon key: RLS only exposes published rows, so public pages never need the service_role key
app.get('/api/:res', limit('public', 300, 60_000), resource, wrap(async (req, res) => {
  if (req.cfg.adminOnly) throw fail(404, 'Nenájdené');
  const { data, error } = await authClient.from(req.params.res).select('*')
    .eq('published', true).order(req.cfg.order, { ascending: !req.cfg.desc });
  if (error) throw error;
  res.set('Cache-Control', 'public, max-age=30').json(data);
}));

/* ---------- Order request before payment (Stripe Payment Link) ---------- */
// The customer fills billing/shipping details on our site first; we store them with an order number
// and send the customer to the product's Payment Link with that number as client_reference_id.
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const clean = (v, max) => (isStr(v) ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function address(src, prefix = '') {
  const a = {
    name: clean(src[prefix + 'name'], 120), street: clean(src[prefix + 'street'], 200), city: clean(src[prefix + 'city'], 100),
    zip: clean(src[prefix + 'zip'], 12), country: ['SK', 'CZ'].includes(src[prefix + 'country']) ? src[prefix + 'country'] : ''
  };
  a.zip = a.zip.replace(/[\s-]/g, '');
  if (/^\d{5}$/.test(a.zip)) a.zip = `${a.zip.slice(0, 3)} ${a.zip.slice(3)}`; // SK/CZ format "811 02"
  const missing = ['name', 'street', 'city', 'zip', 'country'].filter(k => !a[k]).map(k => prefix + k);
  if (a.zip && !/^\d{3} \d{2}$/.test(a.zip)) missing.push(prefix + 'zip');
  return { a, missing };
}
app.post('/api/order-request', limit('orderreq', 10, 10 * 60_000), noStore, wrap(async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const bill = address(b);
  const email = clean(b.email, 254).toLowerCase(), company = clean(b.company, 120), note = clean(b.note, 500);
  // phone: accept any common formatting, store digits with an optional leading +
  let phone = clean(b.phone, 30).replace(/[\s().\/-]/g, '');
  if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  const missing = [...bill.missing];
  if (!EMAIL.test(email)) missing.push('email');
  if (!/^\+?\d{6,15}$/.test(phone)) missing.push('phone');
  const methodId = Number(b.shipping_method_id);
  const { data: method, error: mErr } = Number.isSafeInteger(methodId) && methodId > 0
    ? await authClient.from('shipping_methods').select('id, name, price, kind').eq('id', methodId).eq('published', true).maybeSingle()
    : { data: null };
  if (mErr) throw mErr;
  if (!method) missing.push('shipping_method_id');
  // Packeta: the pickup point chosen in the Packeta widget; pickup: no delivery address needed
  const packeta = method?.kind === 'packeta'
    ? { id: clean(String(b.packeta_id ?? ''), 12), name: clean(b.packeta_name, 300) } : null;
  if (packeta && (!/^\d{1,12}$/.test(packeta.id) || !packeta.name)) missing.push('packeta_id');
  const ship = method?.kind === 'address' && b.ship_different === true ? address(b, 'ship_') : null;
  if (ship) missing.push(...ship.missing);
  if (b.terms !== true) missing.push('terms');
  if (missing.length) throw fail(400, 'Skontroluj prosím zvýraznené údaje', { fields: [...new Set(missing)] });

  const productId = Number(b.product_id);
  if (!Number.isSafeInteger(productId) || productId < 1) throw fail(400, 'Neplatný produkt');
  const { data: product, error: pErr } = await authClient.from('products').select('id, name, sub, price, payment_link').eq('id', productId).maybeSingle();
  if (pErr) throw pErr;
  if (!product || !STRIPE_LINK.test(product.payment_link || '')) throw fail(400, 'Tento produkt sa momentálne nedá objednať');
  // a Payment Link cannot charge the shipping, so paid shipping needs the Stripe API key
  if (!stripe && Number(method.price) > 0) throw fail(503, 'Tento spôsob dopravy je dočasne nedostupný, vyber prosím iný.');

  // Stored through a validated, throttled DB function. Called with the service key (not anon) so that
  // EXECUTE can be revoked from anon/authenticated — the RPC is then reachable only through this backend,
  // which rate-limits per IP. The function still validates and throttles as defense in depth.
  const billing = { ...bill.a, company: company || undefined, email, phone };
  const { data: reference, error } = await db.rpc('create_order_request', {
    p: {
      email, phone, billing, note, product_id: product.id, shipping_method_id: method.id,
      shipping: packeta ? { name: bill.a.name, packeta_id: packeta.id, packeta_name: packeta.name, country: bill.a.country }
        : method.kind === 'pickup' ? { name: bill.a.name, pickup: true } : ship ? ship.a : bill.a
    }
  });
  if (error) {
    if (/rate_limited/.test(error.message)) throw fail(429, 'Príliš veľa objednávok naraz, skús to prosím neskôr.');
    if (/invalid/.test(error.message)) throw fail(400, 'Skontroluj prosím zadané údaje');
    throw error;
  }

  if (stripe) {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'sk',
      client_reference_id: reference,
      customer_email: email,
      line_items: [{ quantity: 1, adjustable_quantity: { enabled: true, minimum: 1, maximum: 10 }, price_data: {
        currency: 'eur', unit_amount: Math.round(Number(product.price) * 100),
        product_data: { name: product.sub ? `${product.name} — ${product.sub}` : product.name }
      } }],
      shipping_options: [{ shipping_rate_data: {
        type: 'fixed_amount', display_name: method.name, fixed_amount: { amount: Math.round(Number(method.price) * 100), currency: 'eur' }
      } }],
      success_url: `${SITE_URL}/?order=success&session_id={CHECKOUT_SESSION_ID}#shop`,
      cancel_url: `${SITE_URL}/?order=cancel#shop`
    });
    return res.json({ reference, url: session.url });
  }
  // without a Stripe key: the product's Payment Link (its "after payment" redirect is set in Stripe)
  const url = new URL(product.payment_link);
  url.searchParams.set('client_reference_id', reference);
  url.searchParams.set('prefilled_email', email);
  url.searchParams.set('locale', 'sk');
  res.json({ reference, url: url.href });
}));

/* ---------- Checkout (Stripe) ---------- */
// Prices always come from the database, never from the browser.
app.post('/api/checkout', limit('checkout', 20, 10 * 60_000), noStore, wrap(async (req, res) => {
  if (!stripe) throw fail(503, 'Platby zatiaľ nie sú nastavené');
  const raw = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
  const wanted = raw
    .map(i => ({ id: Number(i?.id), qty: Number(i?.qty) }))
    .filter(i => Number.isSafeInteger(i.id) && i.id > 0 && Number.isInteger(i.qty) && i.qty >= 1 && i.qty <= 10);
  if (!wanted.length) throw fail(400, 'Košík je prázdny');
  const { data: products, error } = await authClient.from('products')
    .select('id, name, sub, price, img').in('id', wanted.map(i => i.id));
  if (error) throw error;
  const line_items = wanted.map(w => {
    const p = products.find(x => x.id === w.id);
    if (!p) throw fail(400, 'Produkt v košíku už neexistuje');
    const images = SITE_URL.startsWith('https://') && p.img && URL_IMG.test(p.img) ? [new URL(p.img, SITE_URL + '/').href] : undefined;
    return {
      quantity: w.qty,
      price_data: {
        currency: 'eur',
        unit_amount: Math.round(Number(p.price) * 100),
        product_data: { name: p.sub ? `${p.name} — ${p.sub}` : p.name, ...(images && { images }) }
      }
    };
  });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    locale: 'sk',
    line_items,
    shipping_address_collection: { allowed_countries: ['SK', 'CZ'] },
    phone_number_collection: { enabled: true },
    success_url: `${SITE_URL}/?order=success&session_id={CHECKOUT_SESSION_ID}#shop`,
    cancel_url: `${SITE_URL}/?order=cancel#shop`
  });
  res.json({ url: session.url });
}));

/* ---------- Paid order: status + thank-you e-mail ---------- */
const REF_RE = /^FEN-[0-9A-F]{8}$/;
const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => `${Number(n || 0).toFixed(2).replace('.', ',')} €`;

function thankYouMail(o) {
  const a = o.shipping || {};
  const items = o.items || [];
  const sm = o.shipping_method;
  const addr = a.packeta_id ? [a.name, `Packeta – ${a.packeta_name}`]
    : a.pickup ? ['Osobný odber v Bratislave – ozveme sa ti a dohodneme sa.']
    : [a.name, a.street, [a.zip, a.city].filter(Boolean).join(' '), a.country === 'CZ' ? 'Česko' : 'Slovensko'].filter(Boolean);
  const rows = items.map(i => `<tr><td style="padding:10px 0;border-bottom:1px dashed #ddd">${i.qty > 1 ? `${i.qty}× ` : ''}${escHtml(i.name)}</td><td style="padding:10px 0;border-bottom:1px dashed #ddd;text-align:right;white-space:nowrap">${eur(i.amount ?? i.price)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="sk"><body style="margin:0;background:#f2f2f2;font-family:Helvetica,Arial,sans-serif;color:#0a0a0a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:#0a0a0a;color:#fff;border-radius:20px 20px 0 0;padding:32px">
  <div style="font-size:20px;font-weight:600;letter-spacing:.02em">FENOMENAL®</div>
  <div style="margin-top:28px;font-size:13px;color:#999">Objednávka ${escHtml(o.reference)}</div>
  <div style="margin-top:8px;font-size:32px;line-height:1.05;font-weight:700;text-transform:uppercase">Ďakujeme za nákup!</div>
</td></tr>
<tr><td style="background:#fff;border-radius:0 0 20px 20px;padding:32px;font-size:15px;line-height:1.55">
  <p style="margin:0 0 16px">Ahoj${a.name ? ' ' + escHtml(a.name.split(' ')[0]) : ''},</p>
  <p style="margin:0 0 16px">platba prebehla úspešne a tvoja objednávka je u nás. Vďaka, že podporuješ slovenskú scénu – bez vás by to nešlo.</p>
  <p style="margin:0 0 24px">${a.pickup ? 'Ozveme sa ti a dohodneme odovzdanie.' : 'CD ti zabalíme a pošleme na adresu nižšie.'} Keby niečo nesedelo, stačí odpovedať na tento e-mail.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">${rows}
    ${sm ? `<tr><td style="padding:10px 0;border-bottom:1px dashed #ddd">Doprava: ${escHtml(sm.name)}</td><td style="padding:10px 0;border-bottom:1px dashed #ddd;text-align:right;white-space:nowrap">${eur(sm.price)}</td></tr>` : ''}
    <tr><td style="padding:12px 0;font-weight:700">Spolu</td><td style="padding:12px 0;text-align:right;font-weight:700">${eur(o.amount_total)}</td></tr></table>
  <div style="margin-top:24px;font-size:13px;color:#808080">${a.pickup ? 'Prevzatie' : 'Doručíme na'}</div>
  <div style="margin-top:6px">${addr.map(escHtml).join('<br>')}</div>
  <p style="margin:32px 0 0">Ďakujeme,<br><b>FENOMENAL crew</b></p>
</td></tr>
<tr><td style="padding:20px 8px;font-size:12px;color:#999;text-align:center"><a href="${escHtml(SITE_URL)}" style="color:#999">${escHtml(SITE_URL.replace(/^https?:\/\//, ''))}</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Ďakujeme za nákup! Objednávka ${o.reference}`, '', 'Platba prebehla úspešne a tvoja objednávka je u nás.',
    'Keby niečo nesedelo, stačí odpovedať na tento e-mail.', '', ...items.map(i => `${i.qty > 1 ? `${i.qty}× ` : ''}${i.name} – ${eur(i.amount ?? i.price)}`),
    ...(sm ? [`Doprava: ${sm.name} – ${eur(sm.price)}`] : []), `Spolu: ${eur(o.amount_total)}`, '', a.pickup ? 'Prevzatie:' : 'Doručíme na:', ...addr, '', 'Ďakujeme,', 'FENOMENAL crew', SITE_URL].join('\n');
  return { subject: `Ďakujeme za nákup – objednávka ${o.reference}`, html, text };
}

async function sendMail(to, { subject, html, text }, idempotencyKey) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text, ...(MAIL_REPLY_TO && { reply_to: MAIL_REPLY_TO }) }),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// Called from the webhook and from the customer's return to the site; safe to run any number of times.
async function finalizeOrder(s) {
  const ref = s.client_reference_id;
  const { data: lines } = await stripe.checkout.sessions.listLineItems(s.id, { limit: 100 });
  const { error } = await db.from('orders').update({
    status: 'paid', stripe_session_id: s.id, amount_total: s.amount_total / 100, currency: s.currency,
    items: lines.map(l => ({ name: l.description, qty: l.quantity, amount: l.amount_total / 100 }))
  }).eq('reference', ref).eq('status', 'pending_payment');
  if (error) throw error;
  if (!RESEND_API_KEY) return;
  // claim the e-mail first, so parallel calls never send it twice
  const { data: claimed, error: cErr } = await db.from('orders').update({ confirmation_sent_at: new Date().toISOString() })
    .eq('reference', ref).is('confirmation_sent_at', null).select('*').maybeSingle();
  if (cErr) throw cErr;
  if (!claimed?.email) return;
  try { await sendMail(claimed.email, thankYouMail(claimed), `order-${ref}`); }
  catch (e) {
    await db.from('orders').update({ confirmation_sent_at: null }).eq('reference', ref);
    console.error('Mail:', e.message);
  }
}

/* ---------- Shipping details after payment ---------- */
// The customer comes back from Stripe with ?session_id=… — we verify the payment with Stripe
// before showing or saving anything, so only paid, recent orders can read or submit an address.
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds
async function paidSession(id) {
  if (!stripe) throw fail(503, 'Platby zatiaľ nie sú nastavené');
  if (!SESSION_RE.test(id || '')) throw fail(400, 'Neplatná objednávka');
  let s;
  try { s = await stripe.checkout.sessions.retrieve(id); }
  catch { throw fail(404, 'Objednávka sa nenašla'); }
  if (s.payment_status !== 'paid') throw fail(409, 'Objednávka zatiaľ nie je zaplatená');
  if (Date.now() / 1000 - s.created > SESSION_MAX_AGE) throw fail(410, 'Objednávka je príliš stará, napíš nám prosím');
  return s;
}
const fromStripe = s => {
  const sh = s.collected_information?.shipping_details ?? s.shipping_details;
  if (!sh?.address?.line1) return null;
  const a = sh.address;
  return { name: sh.name || s.customer_details?.name || '', street: [a.line1, a.line2].filter(Boolean).join(', '),
    city: a.city || '', zip: a.postal_code || '', country: a.country || 'SK', phone: s.customer_details?.phone || '' };
};

app.get('/api/order/:session', limit('order', 30, 10 * 60_000), noStore, wrap(async (req, res) => {
  const s = await paidSession(req.params.session);
  if (REF_RE.test(s.client_reference_id || '')) {
    await finalizeOrder(s).catch(e => console.error('Finalize:', e.message));
    return res.json({ reference: s.client_reference_id, email: s.customer_details?.email || '', amount: s.amount_total / 100, currency: s.currency });
  }
  const { data: saved } = await db.from('orders').select('shipping').eq('stripe_session_id', s.id).maybeSingle();
  res.json({
    email: s.customer_details?.email || '',
    amount: s.amount_total / 100,
    currency: s.currency,
    shipping: saved?.shipping?.street ? saved.shipping : fromStripe(s),
    confirmed: !!saved?.shipping?.confirmed
  });
}));

app.post('/api/order/:session/shipping', limit('order', 30, 10 * 60_000), noStore, wrap(async (req, res) => {
  const s = await paidSession(req.params.session);
  const b = req.body || {};
  // strip control characters, trim, cap length
  const str = (v, max) => (isStr(v) ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const shipping = {
    name: str(b.name, 120), street: str(b.street, 200), city: str(b.city, 100),
    zip: str(b.zip, 12).replace(/\s+/g, ' '), country: ['SK', 'CZ'].includes(b.country) ? b.country : '',
    phone: str(b.phone, 30), note: str(b.note, 500), confirmed: true, confirmed_at: new Date().toISOString()
  };
  const missing = ['name', 'street', 'city', 'zip', 'country', 'phone'].filter(k => !shipping[k]);
  if (missing.length) throw fail(400, 'Vyplň všetky povinné údaje', { fields: missing });
  if (!/^[0-9 ]{4,8}$/.test(shipping.zip)) throw fail(400, 'Neplatné PSČ', { fields: ['zip'] });
  if (!/^\+?[0-9 ()/-]{6,20}$/.test(shipping.phone)) throw fail(400, 'Neplatné telefónne číslo', { fields: ['phone'] });
  const { data: lines } = await stripe.checkout.sessions.listLineItems(s.id, { limit: 100 });
  const { error } = await db.from('orders').upsert({
    stripe_session_id: s.id, status: 'paid',
    email: s.customer_details?.email, name: shipping.name, phone: shipping.phone, shipping,
    items: lines.map(l => ({ name: l.description, qty: l.quantity, amount: l.amount_total / 100 })),
    amount_total: s.amount_total / 100, currency: s.currency
  }, { onConflict: 'stripe_session_id' });
  if (error) throw error;
  res.json({ ok: true });
}));

/* ---------- Auth ---------- */
const SESSION_TTL = 12 * 60 * 60_000; // ms
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const sign = v => crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(v).digest('base64url');
const sameStr = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

app.post('/api/auth/login', limit('login', 5, 15 * 60_000), noStore, wrap(async (req, res) => {
  const { key } = req.body || {};
  if (!isStr(key) || key.length > 200) throw fail(400, 'Neplatný kľúč');
  const hash = sha256(key.trim());
  if (!adminKeys.some(h => sameStr(h, hash))) throw fail(401, 'Neplatný kľúč');
  // token = <key id>.<expiry>.<hmac>; the key id lets a removed key revoke its sessions
  const payload = `${hash.slice(0, 16)}.${Date.now() + SESSION_TTL}`;
  res.json({ token: `${payload}.${sign(payload)}` });
}));

// Signature, expiry, and that the key is still listed in ADMIN_KEY_HASHES
const adminOnly = (req, res, next) => {
  const m = /^Bearer ([0-9a-f]{16})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
  const ok = m && sameStr(sign(`${m[1]}.${m[2]}`), m[3]) && +m[2] > Date.now() && adminKeys.some(h => h.startsWith(m[1]));
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
app.use('/api/admin', limit('admin', 300, 5 * 60_000), noStore, adminOnly);

/* ---------- Admin ---------- */
// Only raster images; the real type is read from the file's bytes, never from the name or the browser
const IMAGE_TYPES = [
  { mime: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', test: b => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/avif', ext: 'avif', test: b => b.toString('ascii', 4, 8) === 'ftyp' && /^avi[fs]$/.test(b.toString('ascii', 8, 12)) },
  { mime: 'image/gif', ext: 'gif', test: b => /^GIF8[79]a$/.test(b.toString('ascii', 0, 6)) }
];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 5 } });
app.post('/api/admin/upload', upload.single('file'), wrap(async (req, res) => {
  const buf = req.file?.buffer;
  const type = buf && buf.length > 12 && IMAGE_TYPES.find(t => t.test(buf));
  if (!type) throw fail(400, 'Povolené sú len obrázky JPG, PNG, WebP, AVIF alebo GIF');
  const path = `${Date.now()}-${crypto.randomUUID()}.${type.ext}`;
  const { error } = await db.storage.from('media').upload(path, buf, { contentType: type.mime, upsert: false });
  if (error) throw error;
  res.json({ url: db.storage.from('media').getPublicUrl(path).data.publicUrl });
}));

app.get('/api/admin/:res', resource, wrap(async (req, res) => {
  const { data, error } = await db.from(req.params.res).select('*').order(req.cfg.order, { ascending: !req.cfg.desc });
  if (error) throw error;
  res.json(data);
}));
app.post('/api/admin/:res', resource, wrap(async (req, res) => {
  if (req.cfg.noCreate) throw fail(405, 'Sem sa nedá pridávať');
  const { data, error } = await db.from(req.params.res).insert(validate(req.body, req.cfg)).select().single();
  if (error) throw error;
  res.status(201).json(data);
}));
app.put('/api/admin/:res/:id', resource, idParam, wrap(async (req, res) => {
  const { data, error } = await db.from(req.params.res).update(validate(req.body, req.cfg)).eq('id', req.params.id).select().single();
  if (error) throw error;
  res.json(data);
}));
app.delete('/api/admin/:res/:id', resource, idParam, wrap(async (req, res) => {
  const { error } = await db.from(req.params.res).delete().eq('id', req.params.id);
  if (error) throw error;
  res.status(204).end();
}));

/* ---------- Fallbacks: no stack traces, no framework error pages ---------- */
app.use((req, res) => res.status(404).json({ error: 'Nenájdené' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Neplatná požiadavka' });
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Príliš veľká požiadavka' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Neplatný súbor' });
  console.error(err);
  res.status(500).json({ error: 'Nastala chyba servera' });
});

app.listen(PORT, () => console.log(`API beží na :${PORT}`));
