import { describe, expect, it } from 'vitest';
import type { PlatformInfo } from '../src/platform/detect';
import { decideInstallMode } from '../src/platform/installMode';

const tab = (p: Partial<PlatformInfo>): PlatformInfo => ({
  os: 'desktop',
  browser: 'chrome',
  host: null,
  displayMode: 'browser',
  framed: false,
  openedFromGoogleApp: false,
  ...p,
});

describe('decideInstallMode', () => {
  it('an installed app never offers to install, even with a prompt', () => {
    expect(decideInstallMode(tab({ displayMode: 'fullscreen' }), true, false)).toBe('installed');
    expect(decideInstallMode(tab({ displayMode: 'standalone', os: 'ios', browser: 'safari' }), false, false)).toBe('installed');
    expect(decideInstallMode(tab({}), false, true)).toBe('installed');
  });

  it('uses the browser prompt when Chromium offered one', () => {
    expect(decideInstallMode(tab({ os: 'android' }), true, false)).toBe('prompt');
  });

  it('sends in-app browsers to Chrome or Safari', () => {
    expect(decideInstallMode(tab({ os: 'android', host: 'google-app' }), false, false)).toBe('in-app');
    expect(decideInstallMode(tab({ os: 'ios', host: 'facebook', browser: 'other' }), false, false)).toBe('in-app');
  });

  it('explains Add to Home Screen on iOS', () => {
    expect(decideInstallMode(tab({ os: 'ios', browser: 'safari' }), false, false)).toBe('ios-safari');
    expect(decideInstallMode(tab({ os: 'ios', browser: 'chrome' }), false, false)).toBe('ios-other');
  });

  it('handles Android tabs with no prompt', () => {
    expect(decideInstallMode(tab({ os: 'android', openedFromGoogleApp: true }), false, false)).toBe('android-custom-tab');
    expect(decideInstallMode(tab({ os: 'android', browser: 'firefox' }), false, false)).toBe('android-manual');
  });

  it('desktop: Chromium menus, Safari Add to Dock, nothing for Firefox', () => {
    expect(decideInstallMode(tab({}), false, false)).toBe('desktop-manual');
    expect(decideInstallMode(tab({ browser: 'safari' }), false, false)).toBe('mac-safari');
    expect(decideInstallMode(tab({ browser: 'firefox' }), false, false)).toBe('unsupported');
  });
});
