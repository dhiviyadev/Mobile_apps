/**
 * Settings → App: version, offline play, install, updates, storage and the
 * offline-copy reset. Re-renders itself while open as the worker's state changes.
 */
import { version } from '../../package.json';
import { h } from '../core/ui/dom';
import { dialog, toast } from '../core/ui/overlays';
import { canOfferInstall, installMode, onInstallChange, startInstall } from './install';
import { type OfflineState, pwa } from './register';
import { storagePersists } from './storage';

const OFFLINE_TEXT: Record<OfflineState, string> = {
  'offline-ready': 'Ready: the hub and both games open without internet. Online matches still need a connection.',
  installing: 'Downloading for offline play…',
  'update-ready': 'Update ready.',
  unsupported: "Not available in this browser (it doesn't support offline storage).",
  disabled: 'Turned off.',
  error: "Couldn't download for offline play. It will try again next time.",
};

/** "0.1.0 · abc1234" (the commit comes from VITE_BUILD_SHA in the Pages build). */
const clientVersion = () => `${version} · ${(import.meta.env.VITE_BUILD_SHA || 'dev').slice(0, 7)}`;

function row(label: string, hint: string | null, control: HTMLElement | null, testId: string): HTMLElement {
  return h('div', { class: 'setting-row', 'data-testid': testId },
    h('div', { class: 'setting-label' }, label, hint ? h('small', null, hint) : null),
    control,
  );
}

export function appSettingsRows(): HTMLElement {
  const box = h('div', { class: 'app-settings' });
  let persisted: boolean | null = null;

  const render = () => {
    const status = pwa.status;
    const build = status.info ? ` · offline build ${status.info.buildId}` : '';
    let offline = OFFLINE_TEXT[status.state];
    if (status.state === 'unsupported' && !import.meta.env.PROD) offline = 'Not used in development builds.';
    else if (status.state === 'unsupported' && !storagePersists()) offline = "Not available here: this browser doesn't keep data after it closes.";
    const offlineAction =
      status.state === 'update-ready'
        ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => pwa.applyUpdate() }, 'Restart')
        : status.state === 'disabled' && import.meta.env.VITE_SW !== 'off'
          ? h('button', { class: 'btn btn-sm', onclick: () => pwa.enable() }, 'Turn on')
          : null;
    const rows: HTMLElement[] = [
      row('Version', `${clientVersion()}${build}`, null, 'settings-app-version'),
      row('Offline play', offline, offlineAction, 'offline-status'),
    ];
    if (canOfferInstall(installMode())) {
      rows.push(row('Install app', 'Open Cobalt Hub from your home screen, full screen and offline.',
        h('button', { class: 'btn btn-sm', onclick: () => void startInstall() }, 'Install'), 'settings-install'));
    }
    if (status.state !== 'unsupported' && status.state !== 'disabled') {
      rows.push(row('Check for updates', null, h('button', {
        class: 'btn btn-sm',
        onclick: async () => {
          const r = await pwa.checkForUpdate();
          toast(r === 'update-ready' ? 'Update ready' : r === 'offline' ? "You're offline" : 'You have the latest version', r === 'offline' ? 'error' : 'success');
        },
      }, 'Check'), 'check-updates'));
    }
    if (typeof navigator.storage?.persisted === 'function') {
      const protect = persisted === false
        ? h('button', {
            class: 'btn btn-sm',
            onclick: async () => {
              persisted = (await navigator.storage.persist?.().catch(() => false)) ?? false;
              if (!persisted) toast('The browser decides this; installing the app usually allows it.', 'info', 4500);
              render();
            },
          }, 'Protect')
        : null;
      rows.push(row('Storage', persisted === null ? 'Checking…' : persisted ? 'Protected from automatic clearing.' : 'The browser may clear it when space is low.', protect, 'storage-status'));
    }
    if (status.state !== 'unsupported') {
      rows.push(row('Reset offline copy', 'Downloads the games again. Your settings and saved worlds are kept.', h('button', {
        class: 'btn btn-sm btn-danger',
        'data-testid': 'reset-offline',
        onclick: async () => {
          const ok = await dialog('Remove the offline copy?', 'Your settings and saved worlds are kept.', [
            { label: 'Cancel', value: '' },
            { label: 'Reset', value: 'reset', danger: true },
          ]);
          if (ok === 'reset') await pwa.resetOfflineCache();
        },
      }, 'Reset'), 'reset-offline-row'));
    }
    box.replaceChildren(...rows);
  };

  // Live updates while the tab is open; listeners drop themselves once it is closed.
  const offPwa = pwa.subscribe(() => (box.isConnected ? render() : cleanup()));
  const offInstall = onInstallChange(() => (box.isConnected ? render() : cleanup()));
  const cleanup = () => {
    offPwa();
    offInstall();
  };
  void navigator.storage?.persisted?.().then((p) => {
    persisted = p;
    if (box.isConnected) render();
  }).catch(() => undefined);
  render();
  return box;
}
