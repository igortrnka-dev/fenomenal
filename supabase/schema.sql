-- Spusti v Supabase → SQL Editor.
-- Backend používa service_role key (obchádza RLS); RLS zapíname, aby anon key nemal prístup.

create table if not exists members   (id bigint generated always as identity primary key, name text not null, bio text, img text, instagram text, sort int default 0, published bool default true, created_at timestamptz default now());
create table if not exists playlists (id bigint generated always as identity primary key, title text not null, sub text, type text default 'playlist', spotify_id text not null, sort int default 0, published bool default true, created_at timestamptz default now());
create table if not exists events    (id bigint generated always as identity primary key, title text not null, date date not null, venue text, city text, ticket_url text, sort int default 0, published bool default true, created_at timestamptz default now());
create table if not exists news      (id bigint generated always as identity primary key, title text not null, body text, date date default current_date, img text, sort int default 0, published bool default true, created_at timestamptz default now());
create table if not exists products  (id bigint generated always as identity primary key, name text not null, sub text, price numeric not null, img text, badge text, payment_link text, sizes jsonb default '["CD"]', sort int default 0, published bool default true, created_at timestamptz default now());
create table if not exists gallery   (id bigint generated always as identity primary key, src text not null, cat text default 'crew', cap text, sort int default 0, published bool default true, created_at timestamptz default now());

alter table members   enable row level security;
alter table playlists enable row level security;
alter table events    enable row level security;
alter table news      enable row level security;
alter table products  enable row level security;
alter table gallery   enable row level security;

-- Storage bucket pre obrázky (public čítanie, zápis len cez backend)
insert into storage.buckets (id, name, public) values ('media', 'media', true) on conflict do nothing;

-- Seed (aktuálne dáta webu)
insert into playlists (title, sub, type, spotify_id, sort) values
 ('FENOMENAL','Album','album','20yUeympd1xdHKamKavuJb',1);
insert into members (name, bio, img, instagram, sort) values
 ('Komarko',null,'img/komarko.jpg','https://www.instagram.com/komarko_official/',1),
 ('Mash1k',null,'img/mash1k.jpg','https://www.instagram.com/mash_1k/',2),
 ('BADMAN',null,'img/badman.jpg','https://www.instagram.com/bando.badman/',3);
insert into products (name, sub, price, img, payment_link, sizes, sort) values
 ('FENOMENAL','Album na CD',15,'img/cd.png','https://buy.stripe.com/14AcN47dAcadb7p6kX2sM00','["CD"]',1);

-- Zaplatené objednávky (zapisuje Stripe webhook cez backend; bez RLS pravidiel = súkromné)
create table if not exists orders (id bigint generated always as identity primary key, stripe_session_id text not null unique, status text not null default 'paid', email text, name text, phone text, shipping jsonb, items jsonb not null default '[]', amount_total numeric, currency text, created_at timestamptz default now());
alter table orders enable row level security;
-- Kedy odišiel zákazníkovi ďakovný e-mail (zabraňuje dvojitému odoslaniu)
alter table orders add column if not exists confirmation_sent_at timestamptz;
-- Spôsoby dopravy (ceny a poradie sa menia v admine → Doprava); kind: pickup | address | packeta
create table if not exists shipping_methods (id bigint generated always as identity primary key, name text not null, description text, price numeric not null default 0 check (price >= 0 and price <= 1000), kind text not null default 'address' check (kind in ('pickup', 'address', 'packeta')), sort int default 0, published boolean default true, created_at timestamptz default now());
alter table shipping_methods enable row level security;
create policy "Public can read published shipping_methods" on shipping_methods for select to anon, authenticated using (published = true);
alter table orders add column if not exists shipping_method jsonb;
alter table orders add column if not exists reference text;
alter table orders add column if not exists billing jsonb;
alter table orders add column if not exists note text;
create unique index if not exists orders_reference_key on orders (reference) where reference is not null;

-- =====================================================================================
-- RLS politiky: anon/authenticated smú ČÍTAŤ len zverejnené riadky (žiadny zápis).
-- orders zámerne bez politiky = deny-all (číta/píše len backend cez service_role).
-- =====================================================================================
create policy "Public can read published members"   on members   for select to anon, authenticated using (published = true);
create policy "Public can read published playlists"  on playlists  for select to anon, authenticated using (published = true);
create policy "Public can read published events"     on events     for select to anon, authenticated using (published = true);
create policy "Public can read published news"       on news       for select to anon, authenticated using (published = true);
create policy "Public can read published products"   on products   for select to anon, authenticated using (published = true);
create policy "Public can read published gallery"    on gallery    for select to anon, authenticated using (published = true);
-- (shipping_methods politika je definovaná vyššie)

-- =====================================================================================
-- Objednávka pred platbou: validuje a throttluje priamo v DB; cena sa berie z products,
-- nikdy zo vstupu. SECURITY DEFINER + pevný search_path. Volá ju LEN backend (service_role);
-- EXECUTE pre anon/authenticated je odobraté, aby sa RPC nedalo volať priamo mimo backendu.
-- =====================================================================================
create or replace function public.create_order_request(p jsonb)
returns text language plpgsql security definer set search_path = 'public', 'pg_temp'
as $$
declare
  v_email   text := lower(btrim(coalesce(p->>'email', '')));
  v_name    text := btrim(coalesce(p->'billing'->>'name', ''));
  v_phone   text := btrim(coalesce(p->>'phone', ''));
  v_product public.products%rowtype;
  v_ship    public.shipping_methods%rowtype;
  v_ref     text;
begin
  if length(p::text) > 6000 then raise exception 'invalid' using errcode = '22023'; end if;
  if v_email !~ '^[^@[:space:]<>]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$'
     or length(v_name) not between 1 and 120
     or v_phone !~ '^\+?[0-9 ()/-]{6,20}$'
     or jsonb_typeof(p->'billing') <> 'object'
     or jsonb_typeof(p->'shipping') <> 'object'
     or length(coalesce(p->>'note', '')) > 500
  then raise exception 'invalid' using errcode = '22023'; end if;

  select * into v_product from public.products
   where id = (p->>'product_id')::bigint and published and payment_link like 'https://buy.stripe.com/%';
  if not found then raise exception 'invalid_product' using errcode = '22023'; end if;

  if p ? 'shipping_method_id' then
    select * into v_ship from public.shipping_methods
     where id = (p->>'shipping_method_id')::bigint and published;
    if not found then raise exception 'invalid_shipping' using errcode = '22023'; end if;
  end if;
  if v_ship.kind = 'packeta' and coalesce(p->'shipping'->>'packeta_id', '') !~ '^[0-9]{1,12}$'
  then raise exception 'invalid_shipping' using errcode = '22023'; end if;

  -- abuse throttling
  if (select count(*) from public.orders where email = v_email and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.orders where created_at > now() - interval '1 hour') >= 300
  then raise exception 'rate_limited' using errcode = '22023'; end if;

  loop
    v_ref := 'FEN-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from public.orders where reference = v_ref);
  end loop;

  insert into public.orders (reference, status, email, name, phone, billing, shipping, note, items, currency, shipping_method)
  values (v_ref, 'pending_payment', v_email, v_name, v_phone, p->'billing', p->'shipping', nullif(btrim(p->>'note'), ''),
          jsonb_build_array(jsonb_build_object('product_id', v_product.id,
            'name', v_product.name || coalesce(' — ' || v_product.sub, ''), 'price', v_product.price)),
          'eur',
          case when v_ship.id is null then null else jsonb_build_object('id', v_ship.id, 'name', v_ship.name, 'price', v_ship.price, 'kind', v_ship.kind) end);
  return v_ref;
end;
$$;
-- RPC je volateľná len backendom (service_role), nie priamo cez verejný anon kľúč:
revoke execute on function public.create_order_request(jsonb) from anon, authenticated, public;
grant  execute on function public.create_order_request(jsonb) to service_role;
