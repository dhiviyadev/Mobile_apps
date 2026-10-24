/**
 * How this browser can install the hub (pure decision table, unit-tested).
 * The live state and the prompt itself are in install.ts.
 */
import type { PlatformInfo } from './detect';

export type InstallMode =
  | 'installed' // running as an installed app, or installed during this visit
  | 'prompt' // a captured beforeinstallprompt is ready (Chrome, Edge, Samsung, Opera)
  | 'ios-safari' // Share → Add to Home Screen
  | 'ios-other' // Chrome/Firefox/Edge on iOS: their share sheet, or Safari
  | 'in-app' // the Google app, WebViews, social apps: open in Chrome/Safari first
  | 'android-custom-tab' // Chrome Custom Tab opened from the Google app: ⋮ → Open in Chrome
  | 'android-manual' // an Android browser without a prompt right now
  | 'desktop-manual' // desktop Chromium without a prompt yet (address-bar install icon)
  | 'mac-safari' // File → Add to Dock
  | 'unsupported'; // no way to install (e.g. desktop Firefox): the button is hidden

/** Pure decision table (unit-tested). */
export function decideInstallMode(p: Pick<PlatformInfo, 'os' | 'browser' | 'host' | 'displayMode' | 'openedFromGoogleApp'>, hasPrompt: boolean, installedThisSession: boolean): InstallMode {
  if (installedThisSession || p.displayMode !== 'browser') return 'installed';
  if (hasPrompt) return 'prompt';
  if (p.host !== null) return 'in-app';
  if (p.os === 'ios') return p.browser === 'safari' ? 'ios-safari' : 'ios-other';
  if (p.os === 'android') return p.openedFromGoogleApp ? 'android-custom-tab' : 'android-manual';
  if (p.browser === 'chrome' || p.browser === 'edge' || p.browser === 'opera' || p.browser === 'samsung') return 'desktop-manual';
  if (p.browser === 'safari') return 'mac-safari';
  return 'unsupported';
}

/** Modes in which the hub offers to install (header button, settings row). */
export const canOfferInstall = (mode: InstallMode): boolean => mode !== 'installed' && mode !== 'unsupported';
