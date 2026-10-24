/**
 * Client entry. Loads only the hub (DOM + CSS); games and three.js are
 * fetched lazily when a game is opened.
 */
import './styles/base.css';
import './styles/hub.css';
import './styles/overlays.css';
import './styles/game.css';
import './styles/pwa.css';
// First: catches Chromium's install prompt even if it fires before the hub is up.
import './platform/install';
import { audio } from './core/audio/audio';
import { installGestureGuards, isIOS, isTouchDevice } from './core/device';
import { HubApp } from './hub/HubApp';
import { isGameRunning } from './hub/launcher';
import { applyPlatformAttributes, capabilities, isInstalledDisplay, platform, probeWebGL2WhenIdle } from './platform/detect';
import { pwa } from './platform/register';
import { installStorageFallback } from './platform/storage';

void (async () => {
  // In-app browsers may have no localStorage at all: give everything a memory copy instead of crashing.
  installStorageFallback();
  // ?sw=off / ?sw=on: remove or restore the offline copy, then reload without the parameter.
  if (await pwa.handleKillSwitchParam()) return;

  installGestureGuards();
  applyPlatformAttributes();
  document.documentElement.classList.toggle('touch', isTouchDevice());
  document.documentElement.classList.toggle('ios', isIOS());

  // Unlock WebAudio on the very first interaction (iOS requirement).
  const unlock = () => {
    audio.unlock();
    // Gentle menu music in the hub (games switch to their own track).
    if (!document.body.classList.contains('in-game')) audio.playMusic('menu');
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // Keep a CSS variable with the real visible height (100vh is wrong on mobile Safari).
  const setVh = () => document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  setVh();
  window.addEventListener('resize', setVh);

  new HubApp(document.getElementById('app')!);
  document.documentElement.dataset.booted = '1';

  // Offline play: register the service worker after load (production builds only).
  pwa.configure({ isGameRunning });
  pwa.start();
  // Installed apps get storage that the browser won't clear under pressure (no prompt there).
  if (isInstalledDisplay()) void navigator.storage?.persist?.().catch(() => false);
  void probeWebGL2WhenIdle().then(() => console.info('[platform]', JSON.stringify({ ...platform(), ...capabilities() })));
})();
