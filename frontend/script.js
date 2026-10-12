'use strict';
import {
  springEasing, EASE_IN_OUT, appear, charsAppear, refresh, initParallax, startLoop, reduced
} from './motion.js';
import { createCrosshair } from './crosshair.js';
import { initConsent, hasConsent, setConsent, onConsentChange } from './consent.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- Spring easings as CSS variables (used by CSS transitions) ---------- */
const rootStyle = document.documentElement.style;
rootStyle.setProperty('--s05', springEasing(0.5, 0));
rootStyle.setProperty('--s07', springEasing(0.7, 0));
rootStyle.setProperty('--s1', springEasing(1, 0));

/* ---------- Grain texture (Noise component: 128px tile, opacity .5) ---------- */
{
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d'), img = ctx.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = Math.random() * 28;
  }
  ctx.putImageData(img, 0, 0);
  $('.noise').style.backgroundImage = `url(${c.toDataURL()})`;
}

/* ---------- Live clock ---------- */
function tickClock() {
  const d = new Date();
  const date = d.toLocaleDateString('sk-SK', { day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $$('[data-date]').forEach(el => { el.textContent = date; });
  $$('[data-time]').forEach(el => { el.textContent = time; });
}
tickClock();
setInterval(tickClock, 1000);

/* ---------- Preloader + hero entrance (timings from the original page) ---------- */
const loader = $('#loader');
if (reduced) {
  loader.classList.add('done');
} else {
  // letters: x 50 → 0, stagger .1s, spring .45s bounce .25
  charsAppear($('.loader-word'), { x: 50, stagger: 0.1, duration: 0.45, bounce: 0.25 });
  // curtain: y 0 → -2400px, 2s ease-in-out, delay 1.8s
  $('#loaderCurtain').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-2400px)' }],
    { duration: 2000, delay: 1800, easing: EASE_IN_OUT, fill: 'both' })
    .finished.then(() => loader.classList.add('done'));
}
$$('[data-appear]').forEach(el => appear(el, { delay: +el.dataset.appear }));
appear($('#heroBg'), { y: 24, duration: 6, from: 1 });
$$('.hero .plus.rot').forEach(p => appear(p, { delay: 2.6, y: 0, rotate: -90, from: 1 }));
initParallax([{ el: $('#heroBg'), speed: 0.8 }]);

// Glitch flashes: other photos break through the main one in sliced, jittering bursts
if (!reduced) {
  const box = $('#heroGlitch'), hero = $('#hero');
  const SHOTS = ['img/glitch-1', 'img/glitch-2'];
  const MAIN = { base: 'img/hero-blur', avif: false, pos: '50% 4%', baked: true }; // matches the visible blurred layer
  const layer = cls => {
    const d = document.createElement('div');
    d.className = cls;
    d.innerHTML = '<picture><source type="image/avif"><img alt="" decoding="async"></picture>';
    box.append(d);
    return d;
  };
  const full = layer('g-full'), slices = [layer('g-slice'), layer('g-slice g-diff'), layer('g-slice')];
  const setSrc = (d, shot) => {
    d.querySelector('source').srcset = shot.avif === false ? '' : shot.base + '.avif';
    const im = d.querySelector('img');
    im.src = shot.base + '.jpg';
    d.classList.toggle('baked', !!shot.baked);
    d.style.setProperty('--gpos', shot.pos || '50% 15%');
    return im;
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  // one burst: slices of `shot` tear across the frame; the full layer flickers and lands on `endOpacity`
  const burst = (shot, endOpacity, ms) => {
    slices.forEach((sl, i) => {
      setSrc(sl, shot);
      const frames = [];
      for (let k = 0; k < 8; k++) {
        const top = rnd(0, 92), h = rnd(2, i === 1 ? 10 : 22);
        frames.push({
          clipPath: `inset(${top.toFixed(1)}% 0 ${Math.max(0, 100 - top - h).toFixed(1)}% 0)`,
          transform: `translateX(${rnd(-48, 48).toFixed(0)}px)`,
          opacity: Math.random() < 0.8 ? 1 : 0,
          easing: 'steps(1, end)'
        });
      }
      frames.push({ clipPath: 'inset(50% 0 50% 0)', transform: 'none', opacity: 0 });
      sl.animate(frames, { duration: ms, delay: i * 40, fill: 'forwards' });
    });
    const flick = endOpacity ? [0, 1, 0, 0, 1, 0, 1, 1] : [1, 0, 1, 1, 0, 1, 0, 0];
    full.animate(flick.map(o => ({ opacity: o, transform: `translateX(${o ? rnd(-12, 12).toFixed(0) : 0}px)`, easing: 'steps(1, end)' }))
      .concat({ opacity: endOpacity, transform: 'none' }), { duration: ms, fill: 'forwards' });
    return new Promise(r => setTimeout(r, ms + 120));
  };
  const visible = () => !document.hidden && hero.getBoundingClientRect().bottom > 0;
  let next = 0;
  const cycle = async () => {
    if (visible()) {
      const shot = { base: SHOTS[next++ % SHOTS.length] };
      const im = setSrc(full, shot);
      await im.decode().catch(() => {});
      await burst(shot, 1, 520);   // main → photo
      await new Promise(r => setTimeout(r, 1400));
      await burst(MAIN, 0, 460);   // photo → main
    }
    setTimeout(cycle, rnd(3500, 6000));
  };
  setTimeout(cycle, 6000); // after the preloader and hero entrance
}

// Focus spotlight: the photo sharpens in a soft circle that trails the cursor
{
  const hero = $('#hero'), focus = $('#heroFocus'), RADIUS = 260;
  const cur = { x: 0, y: 0, r: 0 }, target = { x: 0, y: 0, r: 0 };
  let running = false, primed = false;
  const step = () => {
    // critically-damped-ish follow: position trails a little, radius eases in/out
    cur.x += (target.x - cur.x) * 0.16;
    cur.y += (target.y - cur.y) * 0.16;
    cur.r += (target.r - cur.r) * 0.12;
    focus.style.setProperty('--fx', cur.x.toFixed(1) + 'px');
    focus.style.setProperty('--fy', cur.y.toFixed(1) + 'px');
    focus.style.setProperty('--fr', cur.r.toFixed(1) + 'px');
    const settled = Math.abs(target.x - cur.x) < 0.3 && Math.abs(target.y - cur.y) < 0.3 && Math.abs(target.r - cur.r) < 0.3;
    running = !settled;
    if (running) requestAnimationFrame(step);
  };
  const kick = () => { if (!running) { running = true; requestAnimationFrame(step); } };
  hero.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const r = focus.getBoundingClientRect();
    target.x = e.clientX - r.left;
    target.y = e.clientY - r.top;
    target.r = RADIUS;
    if (!primed) { cur.x = target.x; cur.y = target.y; primed = true; } // grow from the cursor, don't slide in from a corner
    kick();
  });
  hero.addEventListener('pointerleave', () => { target.r = 0; primed = false; kick(); });
}

/* ---------- Nav: hide on scroll down, theme follows the section underneath ---------- */
const nav = $('#nav');
nav.style.transition = `color .4s ease, transform 1s ${springEasing(1, 0)}`;
let lastY = scrollY;
function updateNav() {
  const y = scrollY;
  if (!nav.classList.contains('menu-open')) {
    const down = y > lastY && y > 120;
    nav.style.transform = down ? 'translateY(-101px)' : 'none';
  }
  lastY = y;
  const hit = document.elementsFromPoint(innerWidth / 2, 48).find(el => el.closest('[data-theme]'));
  const theme = hit ? hit.closest('[data-theme]').dataset.theme : 'light';
  nav.classList.toggle('on-light', theme === 'light');
}
addEventListener('scroll', updateNav, { passive: true });
updateNav();

/* ---------- Fullscreen menu ---------- */
const menu = $('#menu'), menuBtn = $('#menuOpen');
function setMenu(open) {
  menu.classList.toggle('open', open);
  menu.setAttribute('aria-hidden', !open);
  menuBtn.setAttribute('aria-expanded', open);
  nav.classList.toggle('menu-open', open);
  $('.menu-txt').textContent = open ? 'Zavrieť' : 'Menu';
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) {
    nav.style.transform = 'none';
    $$('[data-menu-appear]', menu).forEach(el => appear(el, { delay: +el.dataset.menuAppear }));
    $$('.plus.rot', menu).forEach(p => appear(p, { delay: 0.4, y: 0, rotate: -90, from: 1 }));
  }
}
menuBtn.onclick = () => setMenu(!menu.classList.contains('open'));
$$('a', menu).forEach(a => a.addEventListener('click', () => setMenu(false)));

/* ---------- DATA (fallback; live data comes from the API) ---------- */
let PLAYLISTS = [
  { title: 'FENOMENAL', sub: 'Album', type: 'album', id: '20yUeympd1xdHKamKavuJb' }
];
// Only the album on CD for now. payment_link = Stripe Payment Link used when the API checkout is unreachable.
let PRODUCTS = [
  { id: 101, name: 'FENOMENAL', sub: 'Album na CD', price: 15, img: 'img/cd.png', payment_link: 'https://buy.stripe.com/14AcN47dAcadb7p6kX2sM00' }
];
let MEMBERS = [];

startLoop();
refresh();

const API = (window.FEN_CONFIG && window.FEN_CONFIG.API_URL) || '';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Timeout: pomalý/uspatý backend nesmie zablokovať vykreslenie stránky (fallback na statické dáta)
const get = r => fetch(`${API}/api/${r}`, { signal: AbortSignal.timeout(3000) }).then(x => x.ok ? x.json() : Promise.reject(x.status));
if (API) {
  const [pl, pr, me] = await Promise.allSettled(['playlists', 'products', 'members'].map(get));
  if (pl.status === 'fulfilled' && pl.value.length) PLAYLISTS = pl.value.map(p => ({ title: p.title, sub: p.sub, type: p.type, id: p.spotify_id }));
  if (pr.status === 'fulfilled' && pr.value.length) PRODUCTS = pr.value.map(p => ({ ...p, price: +p.price, sizes: p.sizes || ['OS'] }));
  if (me.status === 'fulfilled') MEMBERS = me.value;
}
const num = i => String(i + 1).padStart(2, '0');
// Local photos ship as AVIF (+ recompressed JPG fallback) and pre-blurred variants
const LOCAL = /^img\/(komarko|mash1k|badman|hero)\.jpg$/;
const img = (src, attrs = '') => {
  const tag = `<img src="${esc(src)}" ${attrs} loading="lazy" decoding="async">`;
  if (src === 'img/cd.png') return `<picture><source type="image/webp" srcset="img/cd.webp">${tag}</picture>`;
  return LOCAL.test(src) ? `<picture><source type="image/avif" srcset="${esc(src.replace(/\.jpg$/, '.avif'))}">${tag}</picture>` : tag;
};
const blurBg = src => /^img\/(komarko|mash1k|badman)\.jpg$/.test(src)
  ? `<img src="${src.replace(/\.jpg$/, '-blur.jpg')}" alt="" loading="lazy" decoding="async" data-st-scale="1.4,1" data-st-spring=".3,0,200,60">`
  : `<img class="live-blur" src="${esc(src)}" alt="" loading="lazy" decoding="async" data-st-scale="1.4,1" data-st-spring=".3,0,200,60">`;

/* ---------- Crew ---------- */
// Bio: the card shows a faded preview, "Čítať viac" opens the full text with the photo
const bioBlock = text => `<div class="member-bio">${text.trim().split(/\n\s*\n/).map(p => `<p>${esc(p.trim())}</p>`).join('')}</div>`
  + '<button type="button" class="member-more">Čítať viac</button>';
if (MEMBERS.length) { // members from the DB replace the static cards
  $('#crewGrid').innerHTML = MEMBERS.map((m, i) => `
  <article class="member" data-theme="dark">
    <div class="member-bg">${blurBg(m.img)}</div>
    <div class="grid-lines four"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="member-inner">
      <div class="member-text"><small>Člen ${num(i)}</small><h3>${esc(m.name)}</h3>${m.bio ? bioBlock(m.bio) : ''}</div>
      <div class="member-pic">${img(m.img, `alt="${esc(m.name)}" data-st-scale="1.2,1" data-st-spring=".3,0,200,60"`)}</div>
      <div class="member-side"><span>Fenomenal</span><b>${num(i)}</b></div>
    </div>
  </article>`).join('');
}

const bioDlg = $('#bio');
$('#crewGrid').addEventListener('click', e => {
  const card = e.target.closest('.member-more')?.closest('.member');
  if (!card) return;
  $('#bioRole').textContent = $('.member-text small', card).textContent;
  $('#bioTitle').textContent = $('.member-text h3', card).textContent;
  $('#bioText').innerHTML = $('.member-bio', card).innerHTML;
  const pic = $('.member-pic', card).cloneNode(true);
  pic.querySelectorAll('[data-st-scale]').forEach(el => { el.removeAttribute('data-st-scale'); el.style.transform = ''; });
  $('#bioPic').replaceChildren(...pic.childNodes);
  bioDlg.showModal();
  bioDlg.scrollTop = 0;
  appear($('.bio-card', bioDlg), { y: 24, duration: 0.8 });
});
$('#bioClose').onclick = () => bioDlg.close();
bioDlg.addEventListener('click', e => { if (e.target === bioDlg) bioDlg.close(); });

/* ---------- Spotify player ----------
   The real embed (~850 KB from 8 domains) loads automatically once the music section gets close,
   not on page load. The CSS look-alike stays on top until the iframe has finished loading. */
const plEl = $('#playlist');
let current = 0, frame = null;
const embedUrl = p => `https://open.spotify.com/embed/${p.type}/${p.id}?theme=0`;
const facade = $('#spotify');
function activateSpotify(autoplay = false) {
  if (frame) return;
  facade.querySelector('.sp-hint').textContent = 'Načítavam prehrávač…';
  frame = document.createElement('iframe');
  frame.title = 'Spotify prehrávač';
  frame.height = 380;
  frame.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  frame.className = 'sp-loading';
  const f = frame;
  f.addEventListener('load', () => { if (frame !== f) return; f.classList.remove('sp-loading'); facade.remove(); }, { once: true });
  frame.src = embedUrl(PLAYLISTS[current]) + (autoplay ? '&autoplay=1' : '');
  facade.after(frame);
}
// Spotify sets third-party cookies, so the real embed needs "media" consent.
// With consent it loads ~1.5 screens before the player scrolls into view; without it, clicking the
// look-alike is an explicit opt-in (stored as consent) and loads it right away.
const spHint = () => $('#spotify .sp-hint');
const updateSpHint = () => {
  if (!frame && spHint()) spHint().textContent = hasConsent('media')
    ? 'Klikni pre načítanie prehrávača'
    : 'Kliknutím povolíš prehrávač Spotify (nastavuje vlastné cookies)';
};
updateSpHint();
$('#spotify').addEventListener('click', () => {
  if (!hasConsent('media')) setConsent({ media: true });
  activateSpotify(true);
});
let spNear = false;
const spIO = new IntersectionObserver(entries => {
  spNear = entries.some(e => e.isIntersecting);
  if (spNear && hasConsent('media')) { spIO.disconnect(); activateSpotify(); }
}, { rootMargin: '150% 0px' });
spIO.observe($('.player-embed'));
onConsentChange(() => {
  if (!hasConsent('media') && frame) { frame.replaceWith(facade); frame = null; } // consent withdrawn → drop the embed
  updateSpHint();
  if (hasConsent('media') && spNear) activateSpotify();
});
function loadPlaylist(i) {
  const p = PLAYLISTS[i];
  current = i;
  if (frame) frame.src = embedUrl(p);
  else { $('#spTitle').textContent = p.title; $('#spSub').textContent = p.sub || 'Playlist'; }
  $$('.track', plEl).forEach((b, j) => {
    b.classList.toggle('active', j === i);
    b.setAttribute('aria-selected', j === i);
  });
}
PLAYLISTS.forEach((p, i) => {
  const b = document.createElement('button');
  b.className = 'track';
  b.setAttribute('role', 'tab');
  b.innerHTML = `<span class="t-num">${num(i)}</span><span class="t-title">${esc(p.title)}</span><small>${esc(p.sub)}</small>`;
  b.onclick = () => loadPlaylist(i);
  plEl.append(b);
});
loadPlaylist(0);

/* ---------- Shop & cart ---------- */
let cart = JSON.parse(localStorage.getItem('fen-cart') || '[]');
const fmt = n => n + ' €';
const toast = (msg, ms = 2000) => {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
};
$('#shopGrid').innerHTML = PRODUCTS.map(p => `
  <article class="product" data-id="${p.id}" data-st-opacity="0,1" data-st-spring="1,0,500,60">
    <div class="product-pic">${img(p.img, `alt="${esc(p.name)} — ${esc(p.sub || '')}"`)}</div>
    <div class="product-info">
      <small>${esc(p.sub || '')}</small>
      <h3>${esc(p.name)}</h3>
      <p class="price">${fmt(p.price)}</p>
      <button class="fx-btn std ink order-btn" type="button">Objednať</button>
    </div>
  </article>`).join('');

// "Objednať" opens the order card where the quantity is chosen
const order = $('#order'), MAX_QTY = 10;
let ordering = null, qty = 1;
const syncOrder = () => {
  $('#orderQty').textContent = qty;
  $('#orderTotal').textContent = fmt(qty * ordering.price);
  $('[data-step="-1"]', order).disabled = qty <= 1;
  $('[data-step="1"]', order).disabled = qty >= MAX_QTY;
};
function openOrder(product) {
  ordering = product; qty = 1;
  $('#orderTitle').textContent = product.name;
  $('#orderSub').textContent = `${product.sub || ''} • ${fmt(product.price)} / ks`;
  $('#orderPic').innerHTML = img(product.img, 'alt=""');
  syncOrder();
  order.showModal();
  appear($('.order-card', order), { y: 24, duration: 0.8 });
}
$('#shopGrid').addEventListener('click', e => {
  if (!e.target.closest('.order-btn')) return;
  openOrder(PRODUCTS.find(p => p.id === +e.target.closest('.product').dataset.id));
});
order.addEventListener('click', e => {
  const step = e.target.closest('[data-step]');
  if (step) { qty = Math.min(MAX_QTY, Math.max(1, qty + +step.dataset.step)); syncOrder(); }
  if (e.target === order) order.close(); // click on the backdrop
});
$('#orderClose').onclick = () => order.close();
$('#orderAdd').onclick = () => {
  const found = cart.find(i => i.id === ordering.id);
  found ? (found.qty = Math.min(MAX_QTY, found.qty + qty)) : cart.push({ id: ordering.id, qty });
  saveCart();
  order.close();
  setDrawer(true);
  toast(`Pridané do košíka: ${qty} ks ✓`);
};

function saveCart() {
  localStorage.setItem('fen-cart', JSON.stringify(cart));
  renderCart();
}
function renderCart() {
  cart = cart.filter(c => PRODUCTS.some(x => x.id === c.id));
  const ul = $('#cartItems');
  ul.innerHTML = cart.length ? cart.map((c, i) => {
    const p = PRODUCTS.find(x => x.id === c.id);
    return `<li>${img(p.img, 'alt=""')}<div>${esc(p.name)}<br><small>${esc(p.sub || '')} • ${fmt(p.price)}</small></div>
      <div class="qty"><button data-a="-" data-i="${i}" aria-label="Menej">−</button> ${c.qty} <button data-a="+" data-i="${i}" aria-label="Viac">+</button></div></li>`;
  }).join('') : '<li class="empty">Košík je prázdny</li>';
  $('#cartCount').textContent = cart.reduce((s, c) => s + c.qty, 0);
  $('#cartTotal').textContent = fmt(cart.reduce((s, c) => s + c.qty * PRODUCTS.find(x => x.id === c.id).price, 0));
}
$('#cartItems').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const i = +b.dataset.i;
  b.dataset.a === '+' ? (cart[i].qty = Math.min(MAX_QTY, cart[i].qty + 1)) : --cart[i].qty <= 0 && cart.splice(i, 1);
  saveCart();
});
const setDrawer = open => {
  $('#drawer').classList.toggle('open', open);
  $('#drawer').setAttribute('aria-hidden', !open);
  $('#overlay').classList.toggle('on', open);
};
$('#cartOpen').onclick = () => setDrawer(true);
$('#cartClose').onclick = $('#overlay').onclick = () => setDrawer(false);
// Stripe Checkout: the backend creates the session from DB prices (exact quantities, shipping address).
// If the API is unreachable, fall back to the product's Stripe Payment Link.
$('#checkout').onclick = async () => {
  if (!cart.length) return toast('Košík je prázdny');
  const btn = $('#checkout');
  btn.disabled = true;
  toast('Presmerovávam na platbu…', 8000);
  try {
    const r = await fetch(`${API}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cart.map(c => ({ id: c.id, qty: c.qty })) }),
      signal: AbortSignal.timeout(20000)
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.url) { location.href = d.url; return; }
    if (r.status >= 400 && r.status < 500) throw Object.assign(new Error(d.error || 'Objednávku sa nepodarilo spracovať'), { user: true });
    throw new Error(d.error || 'API nedostupné');
  } catch (e) {
    const link = PRODUCTS.find(p => cart.some(c => c.id === p.id) && p.payment_link)?.payment_link;
    if (!e.user && link) { location.href = link; return; }
    toast(e.user ? e.message : 'Platbu sa teraz nepodarilo spustiť, skús to o chvíľu.', 4000);
    btn.disabled = false;
  }
};
// Back from Stripe. A paid order still needs a shipping address: the form opens now and on every
// next visit until it is confirmed (the session id waits in localStorage).
const PENDING = 'fen-pending-order';
const ship = $('#ship'), shipForm = $('#shipForm');
const shipErr = msg => { $('#shipError').textContent = msg || ''; };
async function openShipping(sessionId) {
  let info = null;
  try {
    const r = await fetch(`${API}/api/order/${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(30000) });
    info = await r.json().catch(() => ({}));
    if (r.status === 400 || r.status === 404) { localStorage.removeItem(PENDING); return toast('Objednávku sa nepodarilo overiť. Napíš nám prosím.', 6000); }
    if (!r.ok) throw new Error(info.error);
  } catch { info = null; } // API asleep/unreachable: show the form anyway, submit will retry
  if (info?.confirmed) { localStorage.removeItem(PENDING); return toast('Ďakujeme! Adresu už máme, CD čoskoro posielame.', 5000); }
  shipForm.reset();
  shipErr();
  const sh = info?.shipping || {};
  for (const k of ['name', 'street', 'zip', 'city', 'phone']) if (sh[k]) shipForm.elements[k].value = sh[k];
  if (sh.country) shipForm.elements.country.value = sh.country;
  $('#shipSub').textContent = info?.email
    ? `Platba ${String(info.amount).replace('.', ',')} € prebehla. Potvrdenie sme poslali na ${info.email}. Vyplň, kam ti máme CD poslať.`
    : 'Vyplň doručovacie údaje, nech vieme, kam zásielku poslať.';
  ship.dataset.session = sessionId;
  if (!ship.open) { ship.showModal(); appear($('.ship-card', ship), { y: 24, duration: 0.8 }); }
}
shipForm.addEventListener('submit', async e => {
  e.preventDefault();
  shipForm.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  const data = Object.fromEntries(new FormData(shipForm));
  const empty = ['name', 'street', 'zip', 'city', 'phone'].filter(k => !data[k].trim());
  if (empty.length) { empty.forEach(k => shipForm.elements[k].classList.add('invalid')); return shipErr('Vyplň prosím všetky povinné údaje.'); }
  const btn = $('#shipSubmit'); btn.disabled = true; shipErr();
  try {
    const r = await fetch(`${API}/api/order/${encodeURIComponent(ship.dataset.session)}/shipping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      (d.missing || []).forEach(k => shipForm.elements[k]?.classList.add('invalid'));
      throw new Error(r.status < 500 && d.error ? d.error : 'Adresu sa nepodarilo uložiť. Skús to prosím o chvíľu znova.');
    }
    localStorage.removeItem(PENDING);
    ship.close();
    toast('Ďakujeme! Adresu máme, CD čoskoro posielame.', 6000);
  } catch (err) {
    shipErr(err.name === 'TimeoutError' || err instanceof TypeError ? 'Server sa práve prebúdza, skús to o chvíľu znova.' : err.message);
  } finally { btn.disabled = false; }
});
$('#shipLater').onclick = () => { ship.close(); toast('Adresu ti pripomenieme pri ďalšej návšteve.', 4000); };
ship.addEventListener('cancel', e => e.preventDefault()); // Esc must not silently drop the form
{
  const q = new URLSearchParams(location.search);
  if (q.get('order') === 'success') {
    cart = []; saveCart();
    if (q.get('session_id')) localStorage.setItem(PENDING, q.get('session_id'));
  }
  if (q.get('order') === 'cancel') toast('Platba bola zrušená, košík ti ostal.', 4000);
  if (q.has('order')) history.replaceState(null, '', location.pathname + location.hash);
  const pending = localStorage.getItem(PENDING);
  if (pending) setTimeout(() => openShipping(pending), q.get('order') === 'success' ? 600 : 4200);
}
renderCart();

addEventListener('keydown', e => {
  if (e.key === 'Escape') { setDrawer(false); setMenu(false); }
});

// Crosshair cursor (React Bits) — only for real mouse pointers; difference blend keeps it visible on light and dark sections
if (matchMedia('(pointer: fine)').matches) {
  createCrosshair({ color: '#ffffff', blendMode: 'difference', targetEffect: 'lock', thickness: 1, opacity: 0.85, smoothing: 0.35, showCoordinates: true });
}

initConsent();

// Wire effects onto everything rendered from data
refresh();
