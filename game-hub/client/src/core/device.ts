/**
 * Device detection and browser-chrome management for tablets:
 * fullscreen, orientation lock, and blocking scroll / zoom / selection gestures.
 */

export const isTouchDevice = (): boolean =>
  (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) ||
  (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);

/** iPadOS 13+ pretends to be a Mac, so also check for touch support. */
export const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isAndroid = (): boolean => /Android/i.test(navigator.userAgent);

/** Pointer lock exists on desktop browsers but not on iOS Safari. */
export const supportsPointerLock = (): boolean =>
  'pointerLockElement' in document && typeof document.body.requestPointerLock === 'function' && !isIOS();

type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

export function isFullscreen(): boolean {
  const d = document as FullscreenDocument;
  return !!(document.fullscreenElement ?? d.webkitFullscreenElement);
}

/**
 * Enters fullscreen and locks to landscape where supported (Android Chrome).
 * Must be called from a user gesture. Failures are silently ignored: iPhone
 * Safari has no element fullscreen, and that is fine.
 */
export async function enterFullscreen(el: HTMLElement = document.documentElement): Promise<void> {
  const target = el as FullscreenElement;
  try {
    if (!isFullscreen()) {
      if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
      else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
    }
  } catch {
    /* not allowed or not supported */
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await orientation?.lock?.('landscape');
  } catch {
    /* orientation lock is only allowed in fullscreen on some browsers */
  }
}

export async function exitFullscreen(): Promise<void> {
  const d = document as FullscreenDocument;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (d.webkitFullscreenElement && d.webkitExitFullscreen) await d.webkitExitFullscreen();
  } catch {
    /* ignore */
  }
  try {
    screen.orientation?.unlock?.();
  } catch {
    /* ignore */
  }
}

export const fullscreenSupported = (): boolean => {
  const el = document.documentElement as FullscreenElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
};

/**
 * Installs global guards against browser gestures that fight with game input:
 * pinch zoom (iOS gesture events), double-tap zoom, long-press callouts,
 * pull-to-refresh / rubber-band scrolling while a game is running.
 */
export function installGestureGuards(): void {
  const inGame = () => document.body.classList.contains('in-game');
  // iOS Safari pinch-zoom ignores user-scalable=no; block its proprietary gesture events.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  // Block page scroll / overscroll while playing. Inputs in menus still scroll.
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!inGame()) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('.scrollable')) return;
      e.preventDefault();
    },
    { passive: false },
  );
  // Double-tap-to-zoom fallback for browsers that ignore touch-action.
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = performance.now();
      if (inGame() && now - lastTouchEnd < 300 && e.cancelable) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );
  document.addEventListener('dblclick', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => {
    if (inGame()) e.preventDefault();
  });
  document.addEventListener('selectstart', (e) => {
    const t = e.target as HTMLElement | null;
    if (inGame() && !t?.closest?.('input, textarea')) e.preventDefault();
  });
}

/** Asks the browser to keep the screen on while playing (Wake Lock API, best effort). */
export class ScreenWakeLock {
  private sentinel: { release: () => Promise<void> } | null = null;
  private onVisibility = () => {
    if (document.visibilityState === 'visible' && this.wanted) void this.acquire();
  };
  private wanted = false;

  async enable(): Promise<void> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    await this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    try {
      await this.sentinel?.release();
    } catch {
      /* ignore */
    }
    this.sentinel = null;
  }

  private async acquire(): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    try {
      this.sentinel = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      this.sentinel = null;
    }
  }
}
