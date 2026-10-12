import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY,
  ADMIN_EMAILS = '', CORS_ORIGINS = '', PORT = 3000
} = process.env;

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
  products:  { fields: ['name', 'sub', 'price', 'img', 'badge', 'sizes', 'sort', 'published'], order: 'sort' },
  gallery:   { fields: ['src', 'cat', 'cap', 'sort', 'published'], order: 'sort' }
};

const app = express();
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
