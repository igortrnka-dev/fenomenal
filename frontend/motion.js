/**
 * Motion engine for the Reelio-style effects.
 * Springs use the same duration/bounce → stiffness/damping solve as Framer Motion,
 * so CSS/WAAPI timings match the original 1:1.
 */
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/* ---------- Springs ---------- */

// Framer Motion's findSpring(): duration (s) + bounce → undamped angular frequency
function solveSpring(duration, bounce) {
  const zeta = clamp(1 - bounce, 0.05, 1);
  const d = clamp(duration, 0.01, 10);
  let w;
  if (zeta < 1) {
    w = -Math.log(0.001 * Math.sqrt(1 - zeta * zeta) / zeta) / (zeta * d);
  } else {
    let u = 5; // Newton on u = w·d for e^-u (u + 1) = 0.001
    for (let i = 0; i < 12; i++) u -= (Math.exp(-u) * (u + 1) - 0.001) / (-u * Math.exp(-u));
    w = u / d;
  }
  return { zeta, w, stiffness: w * w, damping: 2 * zeta * w };
}

function springAt(t, zeta, w) {
  if (zeta < 1) {
    const wd = w * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w * t) * (1 + w * t);
}

const easingCache = new Map();
/** CSS linear() easing for a duration-based spring; total time equals `duration`. */
export function springEasing(duration, bounce = 0) {
  const key = duration + '|' + bounce;
  if (!easingCache.has(key)) {
    const { zeta, w } = solveSpring(duration, bounce);
    const n = 64, pts = [];
    for (let i = 0; i <= n; i++) pts.push(+springAt((i / n) * duration, zeta, w).toFixed(4));
    pts[n] = 1;
    easingCache.set(key, `linear(${pts.join(',')})`);
  }
  return easingCache.get(key);
}

export const EASE_IN_OUT = 'cubic-bezier(.44,0,.56,1)';

/* ---------- Appear (fade + slide) ---------- */

export function appear(el, { delay = 0, y = 24, x = 0, duration = 2, bounce = 0, rotate = 0, from = 0.001 } = {}) {
  if (reduced) return;
  const start = `translate(${x}px, ${y}px)${rotate ? ` rotate(${rotate}deg)` : ''}`;
  return el.animate(
    [{ opacity: from, transform: start }, { opacity: 1, transform: 'none' }],
    { duration: duration * 1000, delay: delay * 1000, easing: springEasing(duration, bounce), fill: 'both' }
  );
}

/* ---------- Per-character text effect (Framer "appear" text effect) ---------- */

export function splitChars(el) {
  if (el.dataset.split) return [...el.querySelectorAll('.ch')];
  const text = el.textContent;
  el.setAttribute('aria-label', text);
  el.textContent = '';
  const wrap = document.createElement('span');
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.whiteSpace = 'nowrap';
  const chars = [...text].map(c => {
    const s = document.createElement('span');
    s.className = 'ch';
    s.textContent = c === ' ' ? ' ' : c;
    wrap.appendChild(s);
    return s;
  });
  el.appendChild(wrap);
  el.dataset.split = '1';
  return chars;
}

export function charsAppear(el, { x = 0, y = 0, stagger = 0.1, duration = 0.45, bounce = 0, startDelay = 0 } = {}) {
  const chars = splitChars(el);
  if (reduced) return;
  chars.forEach((c, i) => c.animate(
    [{ opacity: 0.001, transform: `translate(${x}px, ${y}px)` }, { opacity: 1, transform: 'none' }],
    { duration: duration * 1000, delay: (startDelay + i * stagger) * 1000, easing: springEasing(duration, bounce), fill: 'both' }
  ));
}

/* ---------- Buttons: caret ">>" slide + character roll on hover ---------- */

const CARET = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function initButtons(root = document) {
  root.querySelectorAll('.fx-btn:not([data-fx])').forEach(btn => {
    btn.dataset.fx = '1';
    const label = btn.textContent.trim();
    btn.setAttribute('aria-label', label);
    btn.innerHTML =
      `<span class="fx-label" aria-hidden="true"><span class="fx-t1">${label}</span><span class="fx-t2">${label}</span></span>` +
      `<span class="fx-caret" aria-hidden="true"><i class="c-l">${CARET}</i><i class="c-c">${CARET}</i><i class="c-r">${CARET}</i></span>`;
    const t2 = btn.querySelector('.fx-t2');
    btn.addEventListener('mouseenter', () => {
      // Framer re-mounts the hover text, replaying y:10 → 0 per character (stagger .075s, spring .2s)
      delete t2.dataset.split;
      t2.textContent = label;
      charsAppear(t2, { y: 10, stagger: 0.075, duration: 0.2, bounce: 0 });
    });
  });
}

/* Scroll-linked effects (scale/fade on scroll, hero parallax) are CSS scroll-driven animations in style.css. */

export function refresh(root = document) {
  initButtons(root);
}

export { reduced };
