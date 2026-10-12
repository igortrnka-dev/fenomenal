/**
 * Cookie consent (GDPR / ePrivacy).
 * Categories: "necessary" (always on: cart + this consent record, both in localStorage)
 * and "media" (third-party embeds that set their own cookies — Spotify).
 * Nothing optional loads before the visitor decides. The choice is kept for 12 months.
 */
const KEY = 'fen-consent';
const VERSION = 1;
const MAX_AGE = 365 * 24 * 60 * 60 * 1000;
const listeners = new Set();

function read() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!c || c.v !== VERSION || Date.now() - c.ts > MAX_AGE) return null;
    return c;
  } catch { return null; }
}

let state = read();

export const hasConsent = category => category === 'necessary' || !!state?.[category];
export const onConsentChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

export function setConsent(choice) {
  state = { v: VERSION, ts: Date.now(), necessary: true, media: !!choice.media };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode: keep for this visit */ }
  listeners.forEach(fn => fn(state));
  hideBanner();
}

/* ---------- Banner ---------- */
let banner = null;

function build() {
  banner = document.createElement('section');
  banner.className = 'consent';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-labelledby', 'consentTitle');
  banner.setAttribute('aria-describedby', 'consentText');
  banner.innerHTML = `
    <h2 id="consentTitle">Nastavenia cookies</h2>
    <p id="consentText">Nevyhnutné úložisko používame na fungovanie košíka. So súhlasom načítame aj prehrávač Spotify, ktorý si ukladá vlastné cookies. Viac v <a href="ochrana-osobnych-udajov.html#cookies">zásadách ochrany osobných údajov</a>.</p>
    <div class="consent-prefs" hidden>
      <label class="consent-opt">
        <span><b>Nevyhnutné</b><small>Košík a uloženie tejto voľby. Bez nich web nefunguje.</small></span>
        <input type="checkbox" checked disabled role="switch" aria-label="Nevyhnutné (vždy zapnuté)">
      </label>
      <label class="consent-opt">
        <span><b>Externé médiá</b><small>Prehrávač Spotify v sekcii Hudba (Spotify AB nastavuje vlastné cookies).</small></span>
        <input type="checkbox" name="media" role="switch">
      </label>
    </div>
    <div class="consent-actions">
      <button type="button" class="consent-btn" data-act="reject">Odmietnuť všetko</button>
      <button type="button" class="consent-btn" data-act="customize">Prispôsobiť</button>
      <button type="button" class="consent-btn primary" data-act="accept">Prijať všetko</button>
    </div>`;
  banner.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'accept') setConsent({ media: true });
    if (act === 'reject') setConsent({ media: false });
    if (act === 'customize') {
      const prefs = banner.querySelector('.consent-prefs');
      if (prefs.hidden) {
        prefs.hidden = false;
        banner.querySelector('[name="media"]').checked = hasConsent('media');
        e.target.textContent = 'Uložiť výber';
      } else {
        setConsent({ media: banner.querySelector('[name="media"]').checked });
      }
    }
  });
  document.body.append(banner);
}

export function showBanner({ customize = false } = {}) {
  if (!banner) build();
  banner.hidden = false;
  banner.classList.remove('out');
  const prefs = banner.querySelector('.consent-prefs');
  prefs.hidden = !customize;
  banner.querySelector('[name="media"]').checked = hasConsent('media');
  banner.querySelector('[data-act="customize"]').textContent = customize ? 'Uložiť výber' : 'Prispôsobiť';
  requestAnimationFrame(() => banner.classList.add('in'));
  if (customize) banner.querySelector('[name="media"]').focus();
}

function hideBanner() {
  if (!banner) return;
  banner.classList.remove('in');
  banner.classList.add('out');
  setTimeout(() => { banner.hidden = true; }, 400);
}

export function initConsent() {
  // any element with [data-cookie-settings] reopens the settings
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-cookie-settings]')) return;
    e.preventDefault();
    showBanner({ customize: true });
  });
  if (!state) showBanner();
}
