-- Spusti v Supabase → SQL Editor.
-- Backend používa service_role key (obchádza RLS); RLS zapíname, aby anon key nemal prístup.

create table if not exists members   (id bigint generated always as identity primary key, name text not null, bio text, img text, sort int default 0, published bool default true, created_at timestamptz default now());
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
insert into members (name, bio, img, sort) values
 ('Komarko',null,'img/komarko.jpg',1),
 ('Mash1k',null,'img/mash1k.jpg',2),
 ('BADMAN',null,'img/badman.jpg',3);
insert into products (name, sub, price, img, payment_link, sizes, sort) values
 ('FENOMENAL','Album na CD',15,'img/cd.png','https://buy.stripe.com/14AcN47dAcadb7p6kX2sM00','["CD"]',1);

-- Zaplatené objednávky (zapisuje Stripe webhook cez backend; bez RLS pravidiel = súkromné)
create table if not exists orders (id bigint generated always as identity primary key, stripe_session_id text not null unique, status text not null default 'paid', email text, name text, phone text, shipping jsonb, items jsonb not null default '[]', amount_total numeric, currency text, created_at timestamptz default now());
alter table orders enable row level security;
