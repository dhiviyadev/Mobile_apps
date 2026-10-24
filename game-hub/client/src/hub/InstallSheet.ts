/**
 * Step-by-step "install the app" instructions for browsers without a
 * one-tap install prompt (iPad/iPhone, the Google app and other in-app
 * browsers, Firefox, Samsung Internet, Safari on the Mac). Lazy-loaded.
 */
import { audio } from '../core/audio/audio';
import { h, removeWithTransition, svg } from '../core/ui/dom';
import { chromeIntentUrl, HOST_LABELS, platform, siteHref } from '../platform/detect';
import type { InstallMode } from '../platform/installMode';
import { ICONS } from './art';
import { copyLink } from './PlatformNotices';

type IconName = keyof typeof ICONS;
type Step = [icon: IconName, text: string];

interface SheetContent {
  title: string;
  intro?: string;
  steps?: Step[];
  outro?: string;
  chrome?: boolean;
  copy?: boolean;
}

/** Text with **bold** runs. */
function rich(text: string): (string | HTMLElement)[] {
  return text.split('**').map((part, i) => (i % 2 ? h('strong', null, part) : part));
}

function content(mode: InstallMode): SheetContent {
  const p = platform();
  const host = p.host ? HOST_LABELS[p.host] : "an app's built-in browser";
  switch (mode) {
    case 'ios-safari':
      return {
        title: 'Add Cobalt Hub to your Home Screen',
        steps: [
          ['share', "Tap the **Share** button in Safari's toolbar (at the bottom on iPhone, top right on iPad)."],
          ['plusSquare', 'Scroll down and tap **Add to Home Screen**.'],
          ['download', 'If you see **Open as Web App**, keep it on, then tap **Add**.'],
          ['refresh', "Open Cobalt Hub from your Home Screen: it starts full screen, works offline and keeps your worlds safe from Safari's automatic clean-up."],
        ],
      };
    case 'ios-other':
      return {
        title: 'Add Cobalt Hub to your Home Screen',
        steps: [
          ['share', 'Tap the **Share** button next to the address bar.'],
          ['plusSquare', "Tap **Add to Home Screen**. If you don't see it, open this page in Safari and add it from there."],
        ],
        copy: true,
      };
    case 'in-app':
      return p.os === 'ios'
        ? {
            title: 'Open Cobalt Hub in Safari',
            intro: `You're inside ${host}. The games run here, but to install Cobalt Hub, open this page in Safari: tap ••• or the share icon, then **Open in Safari**. Then add it to your Home Screen.`,
            copy: true,
          }
        : {
            title: 'Open Cobalt Hub in Chrome',
            intro: `You're inside ${host}. The games run here, but installing, full screen and keeping your saves work best in Chrome.`,
            chrome: p.os === 'android',
            copy: true,
          };
    case 'android-custom-tab':
      return {
        title: 'Install from Chrome',
        steps: [
          ['kebab', 'Tap ⋮ at the top right and choose **Open in Chrome**.'],
          ['download', 'Tap **Install app** (or **Add to Home screen**).'],
        ],
        copy: true,
      };
    case 'android-manual': {
      const line =
        p.browser === 'samsung' ? 'Tap ☰ → **Add page to** → **Home screen**.' :
        p.browser === 'firefox' ? 'Tap ⋮ → **Install** (or **Add to Home screen**).' :
        'Tap ⋮ → **Install app** (or **Add to Home screen**).';
      return {
        title: 'Install Cobalt Hub',
        steps: [
          ['kebab', line],
          ['plusSquare', 'Other browsers: look for **Install** or **Add to Home screen** in the menu.'],
        ],
      };
    }
    case 'mac-safari':
      return { title: 'Add Cobalt Hub to your Dock', steps: [['plusSquare', 'In Safari, choose **File → Add to Dock**.']] };
    case 'desktop-manual':
    default:
      return {
        title: 'Install Cobalt Hub',
        steps: [
          ['download', 'Click the **Install** icon at the right end of the address bar, or open the browser menu and choose **Install Cobalt Hub** (Chrome: Cast, save and share → Install page as app; Edge: Apps → Install this site as an app).'],
        ],
      };
  }
}

let open: HTMLElement | null = null;

export function openInstallSheet(mode: InstallMode): void {
  if (open) return;
  const c = content(mode);
  const titleId = 'install-sheet-title';
  const close = () => {
    if (!open) return;
    document.removeEventListener('keydown', onKey);
    removeWithTransition(open);
    open = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const actions: HTMLElement[] = [];
  if (c.chrome) {
    actions.push(h('a', { class: 'btn btn-primary', 'data-testid': 'open-in-chrome', href: chromeIntentUrl(siteHref()) }, svg(ICONS.external), 'Open in Chrome'));
  }
  if (c.copy) actions.push(h('button', { class: 'btn', 'data-testid': 'copy-link', onclick: () => void copyLink() }, svg(ICONS.copy), 'Copy link'));
  actions.push(h('button', { class: 'btn', onclick: () => { audio.play('click'); close(); } }, 'Close'));

  open = h('div', { class: 'modal-backdrop entering', onclick: (e: Event) => e.target === open && close() },
    h('div', { class: 'modal install-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'data-testid': 'install-sheet' },
      h('h3', { id: titleId }, c.title),
      c.intro ? h('p', null, ...rich(c.intro)) : null,
      c.steps ? h('ol', { class: 'install-steps' }, c.steps.map(([icon, text]) => h('li', null, svg(ICONS[icon], 'step-icon'), h('span', null, ...rich(text))))) : null,
      c.outro ? h('p', null, ...rich(c.outro)) : null,
      h('div', { class: 'modal-actions' }, actions),
    ),
  );
  document.body.appendChild(open);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => open?.classList.remove('entering'));
  open.querySelector<HTMLElement>('.modal-actions a, .modal-actions button')?.focus();
}
