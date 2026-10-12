# Fenomenal — architektúra

```
frontend/   verejná stránka (statická)   → Vercel / Netlify / Render Static
admin/      admin panel (statický SPA)   → Vercel / Netlify / Render Static
backend/    Express REST API             → Render (Web Service)
supabase/   schema.sql                   → Supabase (Postgres + Storage)
```

```
frontend ──GET /api/*──┐
                       ├─► backend (Render) ──service key──► Supabase (DB + Storage)
admin ──/api/admin/*───┘      ▲ overuje admin secret key (ADMIN_KEY_HASHES)
```

## Nasadenie (Render)

1. **GitHub**: nahraj projekt do repozitára (`.gitignore` vynecháva `.env`, `node_modules`, `.backup`).
2. **Render** → *New* → *Blueprint* → vyber repozitár. Render podľa `render.yaml` vytvorí 3 služby:
   `fenomenal-api` (backend, Frankfurt), `fenomenal-web` (web), `fenomenal-admin` (admin).
3. Pri vytváraní zadaj jedinú tajnú hodnotu **`SUPABASE_SERVICE_KEY`** (Supabase → Project Settings → API Keys → `service_role` / secret).
4. Over adresy služieb. Ak Render pridal k názvu príponu (napr. `fenomenal-api-x1y2.onrender.com`), uprav:
   - `frontend/config.js` a `admin/config.js` → `API_URL` (a `SITE_URL` v admine),
   - `CORS_ORIGINS` pri `fenomenal-api` (v Render → Environment).
5. Admin: prihlásenie secret keyom. Na serveri sú len SHA-256 hashe kľúčov v `ADMIN_KEY_HASHES`; kľúč zneplatníš odstránením jeho hashu.

Free plán uspí backend po ~15 min nečinnosti. Prvé načítanie potom trvá ~30 s, web medzitým zobrazí statické dáta.

## Lokálne

```
cd backend && cp .env.example .env && npm i && npm run dev   # :3000
cd frontend && npx serve .     # alebo hocijaký statický server
cd admin && npx serve .
```
(Uprav `CORS_ORIGINS` o lokálne porty.)

> Render free tier uspí backend po nečinnosti — prvé načítanie môže trvať ~30 s; frontend má preto fallback na statické dáta.
