/**
 * "Install app": captures Chromium's beforeinstallprompt as early as possible
 * (main.ts imports this module first) and decides how this browser installs
 * the hub: a one-tap prompt, or step-by-step instructions (InstallSheet).
 */
import { audio } from '../core/audio/audio';
import { toast } from '../core/ui/overlays';
import { platform } from './detect';
import { decideInstallMode, type InstallMode } from './installMode';

export { canOfferInstall, decideInstallMode, type InstallMode } from './installMode';

let deferred: BeforeInstallPromptEvent | null = null;
let installedThisSession = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // no mini-infobar: the hub shows its own button
    deferred = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedThisSession = true;
    void navigator.storage?.persist?.().catch(() => false);
    audio.play('checkpoint');
    toast('Cobalt Hub is installed. Open it from your home screen.', 'success', 4000);
    emit();
  });
}

export function installMode(): InstallMode {
  return decideInstallMode(platform(), deferred !== null, installedThisSession);
}

/** Subscribes to install-state changes (prompt captured or used, app installed). */
export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null; // a prompt can only be used once
  try {
    await e.prompt();
    const { outcome } = await e.userChoice;
    return outcome;
  } catch {
    return 'unavailable';
  } finally {
    emit();
  }
}

/** The install button's action: the browser prompt when there is one, otherwise the instructions sheet. */
export async function startInstall(): Promise<void> {
  if (installMode() === 'prompt' && (await promptInstall()) !== 'unavailable') return;
  const { openInstallSheet } = await import('../hub/InstallSheet');
  openInstallSheet(installMode());
}
