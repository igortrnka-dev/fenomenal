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

/* ---------- Scroll-linked transforms (Framer "Scroll Transform", trigger: in view) ---------- */

// progress 0 when the element's top hits the viewport bottom, 1 when its bottom does
const tracked = [];

function parsePair(v) { return v.split(',').map(Number); }

export function initScrollTransforms(root = document) {
  root.querySelectorAll('[data-st-y],[data-st-opacity],[data-st-scale]').forEach(el => {
    if (el._st) return;
    const [dur = 0.3, bounce = 0, k, c] = (el.dataset.stSpring || '').split(',').map(Number);
    // durationBasedSpring:false in Framer → raw stiffness/damping; otherwise solve from duration/bounce
    const spring = k ? { stiffness: k, damping: c } : solveSpring(dur, bounce);
    el._st = {
      y: el.dataset.stY && parsePair(el.dataset.stY),
      opacity: el.dataset.stOpacity && parsePair(el.dataset.stOpacity),
      scale: el.dataset.stScale && parsePair(el.dataset.stScale),
      spring, p: null, v: 0, target: 0
    };
    tracked.push(el);
  });
}

function layoutTop(el) {
  // untransformed document top (ignores our own translate)
  let top = 0, n = el;
  while (n) { top += n.offsetTop; n = n.offsetParent; }
  return top;
}

function measure() {
  for (const el of tracked) {
    const s = el._st;
    s.top = layoutTop(el);
    s.height = el.offsetHeight || 1;
  }
  for (const r of reveals) { r.top = layoutTop(r.el); r.height = r.el.offsetHeight; r.last = -1; }
  wake();
}

function applyST(el) {
  const s = el._st, p = s.p;
  const lerp = ([a, b]) => a + (b - a) * p;
  if (s.opacity) el.style.opacity = lerp(s.opacity).toFixed(3);
  const tf = [];
  if (s.y) tf.push(`translateY(${lerp(s.y).toFixed(2)}px)`);
  if (s.scale) tf.push(`scale(${lerp(s.scale).toFixed(4)})`);
  if (tf.length) el.style.transform = tf.join(' ');
}

/* ---------- Word-by-word scroll reveal (TextReveal component) ---------- */

const reveals = [];
export function initTextReveal(root = document) {
  root.querySelectorAll('[data-reveal]:not([data-split])').forEach(el => {
    el.dataset.split = '1';
    const text = el.textContent.trim();
    el.setAttribute('aria-label', text);
    el.textContent = '';
    const words = [];
    text.split(/\n{2,}/).forEach((para, pi) => {
      const p = document.createElement('span');
      p.className = 'tr-p';
      p.setAttribute('aria-hidden', 'true');
      para.trim().split(/\s+/).forEach((w, wi, arr) => {
        const s = document.createElement('span');
        s.className = 'tr-w';
        s.textContent = w;
        if (wi === arr.length - 1) s.style.marginRight = '0';
        p.appendChild(s);
        words.push(s);
      });
      el.appendChild(p);
    });
    const cs = getComputedStyle(el);
    reveals.push({ el, words, from: parseColor(cs.getPropertyValue('--tr-from') || 'rgb(230,230,230)'), to: parseColor(cs.getPropertyValue('--tr-to') || 'rgb(10,10,10)'), last: -1 });
  });
}

function parseColor(c) {
  const m = c.match(/\d+(\.\d+)?/g) || [0, 0, 0];
  return m.slice(0, 3).map(Number);
}

function updateReveals(vh, sy) {
  for (const r of reveals) {
    // offset ["start end", "end center"], from cached layout position
    const p = clamp((vh - (r.top - sy)) / (vh / 2 + r.height));
    if (Math.abs(p - r.last) < 0.0005) continue;
    r.last = p;
    const n = r.words.length;
    r.words.forEach((w, i) => {
      const t = clamp((p - i / n) * n);
      const c = r.from.map((a, k) => Math.round(a + (r.to[k] - a) * t));
      w.style.color = `rgb(${c})`;
    });
  }
}

/* ---------- Counters (NumberCounter component) ---------- */

export function initCounters(root = document) {
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    runCounter(e.target);
  }));
  root.querySelectorAll('[data-count]').forEach(el => {
    el.textContent = format(+el.dataset.start || 0, el);
    io.observe(el);
  });
}

function format(v, el) {
  const sep = el.dataset.sep ?? ',';
  let s = String(Math.round(v));
  if (sep) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  if (el.dataset.pad) s = s.padStart(+el.dataset.pad, '0');
  return s;
}

function runCounter(el) {
  const start = +el.dataset.start || 0, end = +el.dataset.count, dur = (+el.dataset.duration || 2) * 1000;
  if (reduced) { el.textContent = format(end, el); return; }
  el.animate([{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 300, easing: 'ease-out', fill: 'both' });
  const t0 = performance.now();
  const tick = now => {
    const s = Math.min((now - t0) / dur, 1);
    el.textContent = format(start + (end - start) * (1 - (1 - s) ** 4), el);
    if (s < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- Main loop: smoothed scroll transforms + reveals + parallax ---------- */

let parallax = [];
export function initParallax(els) { parallax = els; }

// The loop only runs while something moves: scroll, resize or an unsettled spring wake it up,
// and it goes to sleep once every value has settled (no idle rAF burning battery).
let lastT = performance.now(), running = false, lastSy = -1, lastVh = -1;
function wake() {
  if (running) return;
  running = true;
  lastT = performance.now();
  requestAnimationFrame(frame);
}
addEventListener('scroll', wake, { passive: true });

function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 1 / 20);
  lastT = now;
  const vh = innerHeight, sy = scrollY;
  let moving = false;
  for (const el of tracked) {
    const s = el._st;
    const top = s.top - sy;
    s.target = clamp((vh - top) / s.height);
    if (s.p === null || reduced) { s.p = s.target; s.v = 0; applyST(el); continue; }
    const dx = s.p - s.target;
    if (Math.abs(dx) < 0.0004 && Math.abs(s.v) < 0.001) {
      if (s.p !== s.target) { s.p = s.target; applyST(el); }
      continue;
    }
    moving = true;
    // semi-implicit Euler, sub-stepped for stiff springs
    const steps = 4, h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -s.spring.stiffness * (s.p - s.target) - s.spring.damping * s.v;
      s.v += a * h;
      s.p += s.v * h;
    }
    applyST(el);
  }
  const scrolled = sy !== lastSy || vh !== lastVh;
  if (scrolled) {
    updateReveals(vh, sy);
    for (const { el, speed } of parallax) el.style.translate = `0 ${(sy * (1 - speed)).toFixed(1)}px`;
    lastSy = sy; lastVh = vh;
  }
  if (moving || scrolled) requestAnimationFrame(frame);
  else running = false;
}

export function refresh(root = document) {
  initScrollTransforms(root);
  initTextReveal(root);
  initButtons(root);
  measure();
}

export function startLoop() {
  measure();
  addEventListener('resize', measure);
  new ResizeObserver(measure).observe(document.body);
}

export { reduced };
