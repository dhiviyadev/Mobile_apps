/**
 * Client entry. Loads only the hub (DOM + CSS); games and three.js are
 * fetched lazily when a game is opened.
 */
import './styles/base.css';
import './styles/hub.css';
import './styles/overlays.css';
import './styles/game.css';
import { audio } from './core/audio/audio';
import { installGestureGuards, isIOS, isTouchDevice } from './core/device';
import { HubApp } from './hub/HubApp';

installGestureGuards();
document.documentElement.classList.toggle('touch', isTouchDevice());
document.documentElement.classList.toggle('ios', isIOS());

// Unlock WebAudio on the very first interaction (iOS requirement).
const unlock = () => {
  audio.unlock();
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
