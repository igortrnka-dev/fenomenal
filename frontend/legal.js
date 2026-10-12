// Legal page: only the cookie-consent banner/settings (no inline scripts, so CSP can stay strict)
import { springEasing } from './motion.js';
import { initConsent } from './consent.js';

document.documentElement.style.setProperty('--s05', springEasing(0.5, 0));
initConsent();
