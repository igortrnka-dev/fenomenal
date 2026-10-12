import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import Stripe from 'stripe';

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY,
  ADMIN_EMAILS = '', CORS_ORIGINS = '', PORT = 3000,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SITE_URL = 'http://localhost:5173'
} = process.env;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
  console.error('Chýbajú SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const admins = ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const origins = CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);

/* Whitelist stĺpcov pre každý zdroj (+ poradie) */
const RESOURCES = {
  members:   { fields: ['name', 'bio', 'img', 'sort', 'published'], order: 'sort' },
  playlists: { fields: ['title', 'sub', 'type', 'spotify_id', 'sort', 'published'], order: 'sort' },
  events:    { fields: ['title', 'date', 'venue', 'city', 'ticket_url', 'sort', 'published'], order: 'date' },
  news:      { fields: ['title', 'body', 'date', 'img', 'sort', 'published'], order: 'date', desc: true },
  products:  { fields: ['name', 'sub', 'price', 'img', 'badge', 'sizes', 'payment_link', 'sort', 'published'], order: 'sort' },
  gallery:   { fields: ['src', 'cat', 'cap', 'sort', 'published'], order: 'sort' }
};

const app = express();

/* ---------- Stripe webhook (needs the raw body, so it is registered before express.json) ---------- */
// Stripe → Developers → Webhooks → endpoint https://<api>/api/stripe/webhook, event checkout.session.completed
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook nie je nastavený' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: `Neplatný podpis: ${e.message}` });
  }
  try {
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const s = event.data.object;
      if (s.payment_status === 'paid') {
        const { data: lines } = await stripe.checkout.sessions.listLineItems(s.id, { limit: 100 });
        const { error } = await db.from('orders').upsert({
          stripe_session_id: s.id,
          status: 'paid',
          email: s.customer_details?.email,
          name: s.customer_details?.name,
          phone: s.customer_details?.phone,
          shipping: s.collected_information?.shipping_details ?? s.shipping_details ?? null,
          items: lines.map(l => ({ name: l.description, qty: l.quantity, amount: l.amount_total / 100 })),
          amount_total: s.amount_total / 100,
          currency: s.currency
        }, { onConflict: 'stripe_session_id' });
        if (error) throw error;
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook:', e);
    res.status(500).json({ error: 'Webhook error' }); // Stripe retries on 5xx
  }
});

app.use(cors({ origin: origins.length ? origins : true }));
app.use(express.json({ limit: '1mb' }));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
});
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
const resource = (req, res, next) => {
  const r = RESOURCES[req.params.res];
  if (!r) return res.status(404).json({ error: 'Unknown resource' });
  req.cfg = r; next();
};

/* ---------- Health ---------- */
app.get('/health', (_, res) => res.json({ ok: true }));

/* ---------- Public ---------- */
// Read with the anon key: RLS only exposes published rows, so public pages never need the service_role key
app.get('/api/:res', resource, wrap(async (req, res) => {
  const { data, error } = await authClient.from(req.params.res).select('*')
    .eq('published', true).order(req.cfg.order, { ascending: !req.cfg.desc });
  if (error) throw error;
  res.set('Cache-Control', 'public, max-age=30').json(data);
}));

/* ---------- Checkout (Stripe) ---------- */
// Prices always come from the database, never from the browser.
app.post('/api/checkout', wrap(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Platby zatiaľ nie sú nastavené' });
  const wanted = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map(i => ({ id: Number(i.id), qty: Math.floor(Number(i.qty)) }))
    .filter(i => Number.isInteger(i.id) && i.qty >= 1 && i.qty <= 10);
  if (!wanted.length) return res.status(400).json({ error: 'Košík je prázdny' });
  const { data: products, error } = await authClient.from('products')
    .select('id, name, sub, price, img').in('id', wanted.map(i => i.id));
  if (error) throw error;
  const line_items = wanted.map(w => {
    const p = products.find(x => x.id === w.id);
    if (!p) throw Object.assign(new Error('Produkt v košíku už neexistuje'), { status: 400 });
    const images = SITE_URL.startsWith('https://') && p.img ? [new URL(p.img, SITE_URL + '/').href] : undefined;
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

/* ---------- Auth ---------- */
app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !admins.includes((data.user.email || '').toLowerCase()))
    return res.status(401).json({ error: 'Neplatné prihlásenie' });
  res.json({ token: data.session.access_token, email: data.user.email });
}));

const adminOnly = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  db.auth.getUser(token).then(({ data, error }) => {
    if (error || !data.user || !admins.includes((data.user.email || '').toLowerCase()))
      return res.status(401).json({ error: 'Unauthorized' });
    next();
  }).catch(() => res.status(401).json({ error: 'Unauthorized' }));
};

/* ---------- Admin ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.post('/api/admin/upload', adminOnly, upload.single('file'), wrap(async (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/'))
    return res.status(400).json({ error: 'Očakáva sa obrázok' });
  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error } = await db.storage.from('media').upload(path, req.file.buffer, { contentType: req.file.mimetype });
  if (error) throw error;
  res.json({ url: db.storage.from('media').getPublicUrl(path).data.publicUrl });
}));

app.get('/api/admin/:res', adminOnly, resource, wrap(async (req, res) => {
  const { data, error } = await db.from(req.params.res).select('*').order(req.cfg.order, { ascending: !req.cfg.desc });
  if (error) throw error;
  res.json(data);
}));
app.post('/api/admin/:res', adminOnly, resource, wrap(async (req, res) => {
  const { data, error } = await db.from(req.params.res).insert(pick(req.body, req.cfg.fields)).select().single();
  if (error) throw error;
  res.status(201).json(data);
}));
app.put('/api/admin/:res/:id', adminOnly, resource, wrap(async (req, res) => {
  const { data, error } = await db.from(req.params.res).update(pick(req.body, req.cfg.fields)).eq('id', req.params.id).select().single();
  if (error) throw error;
  res.json(data);
}));
app.delete('/api/admin/:res/:id', adminOnly, resource, wrap(async (req, res) => {
  const { error } = await db.from(req.params.res).delete().eq('id', req.params.id);
  if (error) throw error;
  res.status(204).end();
}));

app.listen(PORT, () => console.log(`API beží na :${PORT}`));
