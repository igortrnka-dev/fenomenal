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

// Mobile: looping video background (loaded only when the mobile layout is active)
{
  const video = $('#heroVideo'), mq = matchMedia('(max-width: 809.98px)');
  video.muted = video.defaultMuted = true; // muted is required for autoplay (iOS reads the property, not just the attribute)
  const play = () => { if (mq.matches && !document.hidden && video.paused) video.play().catch(() => {}); };
  const sync = () => {
    if (!mq.matches) { video.pause(); return; }
    if (!video.src) { video.src = video.canPlayType('video/mp4; codecs="hvc1"') ? video.dataset.srcHevc : video.dataset.src; /* HEVC: plné 1080p pri menšej veľkosti */ video.preload = 'auto'; video.load(); }
    play();
  };
  mq.addEventListener('change', sync);
  video.addEventListener('canplay', play);
  document.addEventListener('visibilitychange', play);
  // if the browser blocked autoplay (e.g. iOS Low Power Mode), start on the first touch or scroll
  ['touchstart', 'scroll', 'click'].forEach(ev => addEventListener(ev, play, { passive: true }));
  sync();
}

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
// Only the album on CD for now. payment_link = Stripe Payment Link where the order is placed.
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
  // only well-formed Spotify entries make it into the embed URL
  const spotifyOk = p => ['playlist', 'album', 'artist', 'track'].includes(p.type) && /^[A-Za-z0-9]{10,40}$/.test(p.spotify_id || '');
  if (pl.status === 'fulfilled' && pl.value.filter(spotifyOk).length) PLAYLISTS = pl.value.filter(spotifyOk).map(p => ({ title: p.title, sub: p.sub, type: p.type, id: p.spotify_id }));
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
// Instagram link: only real instagram.com profile URLs, shown as @handle
const IG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.4" cy="6.6" r="1.2" fill="currentColor"/></svg>';
const igLink = (href, name) => {
  let u;
  try { u = new URL(href); } catch { return ''; }
  const handle = u.pathname.split('/').filter(Boolean)[0] || '';
  if (u.protocol !== 'https:' || !/^(www\.)?instagram\.com$/.test(u.hostname) || !/^[A-Za-z0-9._]{1,30}$/.test(handle)) return '';
  const clean = `https://www.instagram.com/${handle}/`;
  return `<a class="member-ig" href="${clean}" target="_blank" rel="noopener noreferrer" aria-label="Instagram – ${esc(name)} (otvorí sa v novom okne)">${IG_ICON}<span>@${handle}</span></a>`;
};
const bioBlock = text => `<div class="member-bio">${text.trim().split(/\n\s*\n/).map(p => `<p>${esc(p.trim())}</p>`).join('')}</div>`
  + '<button type="button" class="member-more">Čítať viac</button>';
if (MEMBERS.length) { // members from the DB replace the static cards
  $('#crewGrid').innerHTML = MEMBERS.map((m, i) => `
  <article class="member" data-theme="dark">
    <div class="member-bg">${blurBg(m.img)}</div>
    <div class="grid-lines four"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="member-inner">
      <div class="member-text"><small>Člen ${num(i)}</small><h3>${esc(m.name)}</h3>${m.instagram ? igLink(m.instagram, m.name) : ''}${m.bio ? bioBlock(m.bio) : ''}</div>
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
  const ig = $('.member-ig', card);
  $('#bioIg').replaceChildren(...(ig ? [ig.cloneNode(true)] : []));
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

/* ---------- Shop ----------
   "Objednať" opens our billing/shipping form first. The backend stores the order and returns the
   product's Stripe Payment Link with our order number (client_reference_id) and the e-mail prefilled. */
['fen-cart', 'fen-pending-order'].forEach(k => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } }); // leftovers of the old checkout
// Only real Stripe payment links (no javascript:, no look-alike domains)
const isStripeLink = u => { try { const x = new URL(u); return x.origin === 'https://buy.stripe.com' && !x.username && !x.password; } catch { return false; } };
const fmt = n => `${String(n).replace('.', ',')} €`;
const toast = (msg, ms = 2000) => {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
};
$('#shopGrid').innerHTML = PRODUCTS.map(p => `
  <article class="product" data-id="${Number(p.id)}" data-st-opacity="0,1" data-st-spring="1,0,500,60">
    <div class="product-pic">${img(p.img, `alt="${esc(p.name)} — ${esc(p.sub || '')}"`)}</div>
    <div class="product-info">
      <small>${esc(p.sub || '')}</small>
      <h3>${esc(p.name)}</h3>
      <p class="price">${fmt(p.price)}</p>
      ${isStripeLink(p.payment_link)
        ? '<button class="fx-btn std ink order-btn" type="button">Objednať</button>'
        : '<button class="fx-btn std ink" type="button" disabled>Čoskoro</button>'}
      <p class="product-note">Najprv vyplníš fakturačné údaje, potom zaplatíš na zabezpečenej stránke Stripe.</p>
    </div>
  </article>`).join('');

const coDlg = $('#checkoutDlg'), coForm = $('#coForm');
const coErr = msg => { $('#coError').textContent = msg || ''; };
const CO_LABELS = { name: 'meno', email: 'e-mail', phone: 'telefón', street: 'ulica', zip: 'PSČ', city: 'mesto', country: 'krajina',
  ship_name: 'meno príjemcu', ship_street: 'doručovacia ulica', ship_zip: 'doručovacie PSČ', ship_city: 'doručovacie mesto', ship_country: 'doručovacia krajina',
  terms: 'súhlas so zásadami' };
// mark the bad fields, name them in the message and bring the first one into view
function coInvalid(keys, prefix) {
  const f = coForm.elements;
  keys.forEach(k => f[k]?.classList.add('invalid'));
  const names = [...new Set(keys)].map(k => CO_LABELS[k] || k);
  coErr(`${prefix}: ${names.join(', ')}.`);
  const first = f[keys[0]];
  if (first) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus({ preventScroll: true }); }
}
coForm.addEventListener('input', e => { e.target.classList?.remove('invalid'); });
let coProduct = null;
$('#shopGrid').addEventListener('click', e => {
  if (!e.target.closest('.order-btn')) return;
  coProduct = PRODUCTS.find(p => String(p.id) === e.target.closest('.product').dataset.id);
  if (!coProduct) return;
  $('#coProduct').textContent = `${coProduct.name}${coProduct.sub ? ' — ' + coProduct.sub : ''}, ${fmt(coProduct.price)}/ks`;
  coErr();
  coForm.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  coDlg.showModal();
  coDlg.scrollTop = 0;
  appear($('.co-card', coDlg), { y: 24, duration: 0.8 });
});
coForm.elements.ship_different.addEventListener('change', e => { $('#coShip').hidden = !e.target.checked; });
$('#coClose').onclick = () => coDlg.close();
coDlg.addEventListener('click', e => { if (e.target === coDlg) coDlg.close(); });
coForm.addEventListener('submit', async e => {
  e.preventDefault();
  coForm.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  const f = coForm.elements, data = {};
  for (const el of f) if (el.name) data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  if (!data.ship_different) for (const k of Object.keys(data)) if (k.startsWith('ship_') && k !== 'ship_different') delete data[k];
  data.product_id = coProduct.id;
  // quick client-side check (the server validates again)
  const req = ['name', 'email', 'phone', 'street', 'zip', 'city', ...(data.ship_different ? ['ship_name', 'ship_street', 'ship_zip', 'ship_city'] : [])];
  const empty = req.filter(k => !String(data[k] || '').trim());
  if (!data.terms) empty.push('terms');
  if (empty.length) return coInvalid(empty, 'Doplň prosím');
  const btn = $('#coSubmit'); btn.disabled = true; coErr('Ukladám objednávku…');
  try {
    const r = await fetch(`${API}/api/order-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(45000)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 400 && d.missing?.length) { btn.disabled = false; return coInvalid(d.missing, 'Skontroluj prosím'); }
      throw new Error(r.status < 500 && d.error ? d.error : 'Objednávku sa nepodarilo uložiť. Skús to prosím o chvíľu znova.');
    }
    if (!isStripeLink(d.url)) throw new Error('Platbu sa nepodarilo spustiť.');
    try { sessionStorage.setItem('fen-last-order', d.reference); } catch { /* ignore */ }
    coErr(`Objednávka ${d.reference} uložená, presmerovávam na platbu…`);
    location.href = d.url;
  } catch (err) {
    btn.disabled = false;
    coErr(err.name === 'TimeoutError' || err instanceof TypeError ? 'Server sa práve prebúdza, skús to prosím o chvíľu znova.' : err.message);
  }
});

// Back from Stripe (Payment Link → "After payment" redirect to /?order=success)
{
  const q = new URLSearchParams(location.search);
  if (q.get('order') === 'success') {
    let ref = ''; try { ref = sessionStorage.getItem('fen-last-order') || ''; sessionStorage.removeItem('fen-last-order'); } catch { /* ignore */ }
    toast(`Ďakujeme za objednávku${ref ? ' ' + ref : ''}! Potvrdenie ti príde e-mailom a CD čoskoro posielame.`, 8000);
  }
  if (q.has('order') || q.has('session_id')) history.replaceState(null, '', location.pathname + location.hash);
}

addEventListener('keydown', e => {
  if (e.key === 'Escape') setMenu(false);
});

// Crosshair cursor (React Bits) — only for real mouse pointers; difference blend keeps it visible on light and dark sections
if (matchMedia('(pointer: fine)').matches) {
  createCrosshair({ color: '#ffffff', blendMode: 'difference', targetEffect: 'lock', thickness: 1, opacity: 0.85, smoothing: 0.35, showCoordinates: true });
}

initConsent();

// Wire effects onto everything rendered from data
refresh();
