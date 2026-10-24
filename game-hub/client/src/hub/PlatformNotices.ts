/**
 * Hub UI for the installable app and for limited browsers: the Install app
 * button and promo card, the platform banner (no 3D graphics, in-app
 * browsers, no storage, embedded in a frame), the "Update ready" bar, and the
 * dialogs for games that can't start here.
 */
import { audio } from '../core/audio/audio';
import { isTouchDevice } from '../core/device';
import { h, svg } from '../core/ui/dom';
import { dialog, toast } from '../core/ui/overlays';
import { chromeIntentUrl, HOST_LABELS, platform, probeWebGL2WhenIdle, siteHref, type UnsupportedReason } from '../platform/detect';
import { canOfferInstall, installMode, type InstallMode, onInstallChange, startInstall } from '../platform/install';
import { pwa } from '../platform/register';
import { pwaPrefs, safeSession, storagePersists, updatePwaPrefs } from '../platform/storage';
import { CUBE_MARK, ICONS } from './art';

const DAY = 24 * 60 * 60 * 1000;
const BANNER_DISMISSED_KEY = 'cobalt-hub.banner-dismissed';

function openInstall(): void {
  audio.unlock();
  audio.play('click');
  void startInstall();
}

/** Copies the site's address (Clipboard API, or a selected input + execCommand in older WebViews). */
export async function copyLink(): Promise<void> {
  const href = siteHref();
  let ok = false;
  try {
    await navigator.clipboard.writeText(href);
    ok = true;
  } catch {
    const input = h('input', { type: 'text', value: href, readonly: true, style: 'position:fixed;opacity:0;left:0;top:0' });
    document.body.appendChild(input);
    input.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    input.remove();
  }
  if (ok) toast('Link copied', 'success');
  else toast(href, 'info', 8000); // last resort: show it so it can be copied by hand
}

/** Header button: shown while this browser can install the hub. */
export function installButton(): HTMLElement {
  const btn = h('button', { class: 'btn btn-sm install-btn', 'aria-label': 'Install app', 'data-testid': 'install-app', onclick: openInstall },
    svg(ICONS.download), h('span', { class: 'label' }, 'Install app'));
  const sync = () => btn.classList.toggle('hidden', !canOfferInstall(installMode()));
  onInstallChange(sync);
  sync();
  return btn;
}

const PROMO_MODES: readonly InstallMode[] = ['prompt', 'ios-safari', 'ios-other', 'in-app', 'android-custom-tab', 'android-manual'];

/** "Play it like an app" card for tablets and phones (and anywhere Chrome offers the prompt). */
export function appPromoCard(): HTMLElement {
  const label = h('span', null, 'Install');
  const card = h('section', { class: 'app-promo', 'data-testid': 'app-promo' },
    svg(CUBE_MARK, 'app-promo-mark'),
    h('div', { class: 'app-promo-text' },
      h('h2', null, 'Play it like an app'),
      h('p', null, 'Install Cobalt Hub to open it from your home screen, full screen and offline, with no browser bar.'),
    ),
    h('div', { class: 'app-promo-actions' },
      h('button', { class: 'btn btn-primary', 'data-testid': 'app-promo-install', onclick: openInstall }, svg(ICONS.download), label),
      h('button', {
        class: 'btn btn-ghost',
        'data-testid': 'app-promo-dismiss',
        onclick: () => {
          audio.play('click');
          updatePwaPrefs({ promoSnoozedUntil: Date.now() + 14 * DAY });
          sync();
        },
      }, 'Not now'),
    ),
  );
  const sync = () => {
    const mode = installMode();
    const snoozed = (pwaPrefs().promoSnoozedUntil ?? 0) > Date.now();
    const show = PROMO_MODES.includes(mode) && (isTouchDevice() || mode === 'prompt') && !snoozed;
    card.classList.toggle('hidden', !show);
    label.textContent = mode === 'prompt' ? 'Install' : 'Show me how';
  };
  onInstallChange(sync);
  sync();
  return card;
}

/** The most important notice about this browser, if any (role=status). */
export function platformBanner(): HTMLElement {
  const banner = h('div', { class: 'platform-banner hidden', role: 'status', 'data-testid': 'platform-banner' });
  let noWebGL2 = false;
  const p = platform();
  const android = p.os === 'android';
  const dismiss = h('button', {
    class: 'icon-btn banner-close',
    'aria-label': 'Dismiss',
    onclick: () => {
      safeSession.set(BANNER_DISMISSED_KEY, '1');
      render();
    },
  }, svg(ICONS.close));
  const button = (text: string, onclick: () => void, icon?: string) => h('button', { class: 'btn btn-sm', onclick }, icon ? svg(icon) : null, text);
  const chromeLink = () => h('a', { class: 'btn btn-sm', 'data-testid': 'open-in-chrome', href: chromeIntentUrl(siteHref()) }, svg(ICONS.external), 'Open in Chrome');

  const render = () => {
    banner.className = 'platform-banner';
    let content: (Node | string)[] | null = null;
    if (noWebGL2) {
      banner.classList.add('danger');
      content = [
        h('span', { class: 'banner-text' }, "This browser can't show 3D graphics, so the games can't start here. Open Cobalt Hub in Chrome, Safari, Edge or Firefox."),
        android && p.host ? chromeLink() : button('Copy link', () => void copyLink(), ICONS.copy),
      ];
    } else if (p.displayMode === 'browser' && safeSession.get(BANNER_DISMISSED_KEY) !== '1') {
      if (p.host) {
        content = [
          h('span', { class: 'banner-text' },
            `You're in ${HOST_LABELS[p.host]}. The games work here, but to install Cobalt Hub, play full screen and keep your saves, open it in ${p.os === 'ios' ? 'Safari' : 'Chrome'}.`),
          android ? chromeLink() : button('How?', () => void startInstall()),
          dismiss,
        ];
      } else if (!storagePersists()) {
        content = [
          h('span', { class: 'banner-text' },
            "This browser isn't saving anything: your settings and offline worlds will be lost when you close it. Open Cobalt Hub in your browser, or install it, to keep them."),
          button('How?', () => void startInstall()),
          dismiss,
        ];
      } else if (p.framed) {
        content = [
          h('span', { class: 'banner-text' }, 'Cobalt Hub is embedded in another page.'),
          button('Open full screen ↗', openFullPage),
          dismiss,
        ];
      }
    }
    banner.classList.toggle('hidden', !content);
    banner.replaceChildren(...(content ?? []));
  };
  render();
  void probeWebGL2WhenIdle().then((ok) => {
    noWebGL2 = !ok;
    if (noWebGL2) render();
  });
  return banner;
}

/** Leaves an iframe: a new tab, or the whole window if popups are blocked. */
function openFullPage(): void {
  const href = siteHref();
  if (window.open(href, '_blank', 'noopener')) return;
  try {
    if (window.top) window.top.location.href = href;
  } catch {
    location.href = href;
  }
}

/** "A new version is ready" pill with Restart. Hidden during games (CSS) and while deferred. */
export function updateBar(): HTMLElement {
  const bar = h('div', { class: 'update-bar hidden', role: 'status', 'data-testid': 'update-ready' },
    h('span', null, 'A new version of Cobalt Hub is ready'),
    h('button', {
      class: 'btn btn-sm btn-primary',
      'data-testid': 'update-restart',
      onclick: () => {
        audio.play('click');
        pwa.applyUpdate();
      },
    }, svg(ICONS.refresh), 'Restart'),
  );
  const sync = () => bar.classList.toggle('hidden', !(pwa.status.state === 'update-ready' && !pwa.status.updateDeferred));
  pwa.subscribe(sync);
  sync();
  return bar;
}

/** After a game on a touch device where full screen didn't work: suggest installing (at most weekly). */
export function maybeShowFullscreenTip(fullscreenFailed: boolean): void {
  if (!fullscreenFailed || !isTouchDevice() || platform().displayMode !== 'browser') return;
  if (!canOfferInstall(installMode())) return;
  if (Date.now() - (pwaPrefs().fsTipShownAt ?? 0) < 7 * DAY) return;
  updatePwaPrefs({ fsTipShownAt: Date.now() });
  toast('Tip: install Cobalt Hub to play full screen.', 'info', 6000, { label: 'How?', onClick: () => void startInstall() });
}

/** Explains why a game can't start in this browser instead of letting it crash. */
export async function showUnsupported(reason: UnsupportedReason): Promise<void> {
  if (reason === 'webgl2') {
    const p = platform();
    const chrome = p.os === 'android' && p.host !== null;
    const choice = await dialog(
      "3D graphics aren't available",
      "This browser can't run WebGL 2, which the games need. Open Cobalt Hub in an up-to-date Chrome, Safari, Edge or Firefox, or turn on hardware acceleration in your browser's settings.",
      [...(chrome ? [{ label: 'Open in Chrome', value: 'chrome' }] : []), { label: 'OK', value: '', primary: true }],
      { testId: 'unsupported-dialog' },
    );
    if (choice === 'chrome') location.href = chromeIntentUrl(siteHref());
  } else {
    await dialog(
      'Voxelvale needs a newer browser',
      "This browser can't run the background workers that build Voxelvale's worlds. Update it, or open Cobalt Hub in Chrome or Safari. Arcfire Arena still works here.",
      [{ label: 'OK', value: '', primary: true }],
      { testId: 'unsupported-dialog' },
    );
  }
}

/** A game's code couldn't be downloaded: offline before it was cached, or a deploy replaced it. */
export async function showChunkLoadError(): Promise<void> {
  if (navigator.onLine === false) {
    toast("You're offline and this game hasn't been downloaded yet. Connect once and it will work offline.", 'error', 5000);
    return;
  }
  const choice = await dialog(
    'Cobalt Hub was updated',
    'A newer version is on the server. Reload to keep playing.',
    [{ label: 'Not now', value: '' }, { label: 'Reload', value: 'reload', primary: true }],
    { testId: 'update-dialog' },
  );
  if (choice === 'reload') location.reload();
}
