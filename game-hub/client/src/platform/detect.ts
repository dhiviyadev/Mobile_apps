/**
 * Where the hub is running: OS, browser, in-app browser host (the Google app,
 * Android WebViews, social apps), display mode (tab or installed app), and
 * which web platform features actually work here. Features are detected,
 * never assumed from the user agent: the UA only picks wording and the
 * "Open in Chrome" escape hatch.
 */
import type { GameId } from '@hub/shared';
import { appDisplayMode, fullscreenSupported, supportsPointerLock } from '../core/device';
import { safeSession, storagePersists } from './storage';

export type OsKind = 'ios' | 'android' | 'desktop';
export type BrowserKind = 'chrome' | 'edge' | 'samsung' | 'opera' | 'firefox' | 'safari' | 'other';
export type InAppHost = 'google-app' | 'android-webview' | 'facebook' | 'instagram' | 'tiktok' | 'snapchat' | 'line' | 'other-in-app';
export type DisplayMode = 'browser' | 'standalone' | 'fullscreen' | 'minimal-ui' | 'twa';

export interface UaInfo {
  os: OsKind;
  browser: BrowserKind;
  host: InAppHost | null;
}

export interface PlatformInfo extends UaInfo {
  displayMode: DisplayMode;
  /** Inside an iframe (e.g. embedded in Google Sites or Classroom). */
  framed: boolean;
  /** Opened from the Google app on Android (it opens results in a Chrome Custom Tab). */
  openedFromGoogleApp: boolean;
}

export interface Capabilities {
  /** null until probed (probing creates a context / a worker, so it only runs when needed). */
  webgl2: boolean | null;
  moduleWorkers: boolean | null;
  serviceWorker: boolean;
  localStorage: boolean;
  fullscreen: boolean;
  orientationLock: boolean;
  wakeLock: boolean;
  pointerLock: boolean;
  broadcastChannel: boolean;
}

/** Pure: classifies a user agent string. The order of the checks matters. */
export function classifyUserAgent(ua: string, maxTouchPoints: number): UaInfo {
  // iPadOS 13+ asks for desktop sites with a Mac user agent; only touch support gives it away.
  const os: OsKind = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? 'ios' : /Android/i.test(ua) ? 'android' : 'desktop';
  let host: InAppHost | null = null;
  if (/\bGSA\/\d/.test(ua)) host = 'google-app';
  else if (/FBAN|FBAV|FB_IAB|FBIOS/.test(ua)) host = 'facebook';
  else if (/Instagram/.test(ua)) host = 'instagram';
  else if (/BytedanceWebview|musical_ly|TikTok/i.test(ua)) host = 'tiktok';
  else if (/Snapchat/.test(ua)) host = 'snapchat';
  else if (/\bLine\//.test(ua)) host = 'line';
  else if (os === 'android' && /; wv\)/.test(ua)) host = 'android-webview';
  else if (os === 'ios' && !/Safari\//.test(ua)) host = 'other-in-app';
  let browser: BrowserKind = 'other';
  if (/EdgA?\/|EdgiOS\//.test(ua)) browser = 'edge';
  else if (/SamsungBrowser\//.test(ua)) browser = 'samsung';
  else if (/OPR\/|OPiOS\//.test(ua)) browser = 'opera';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'firefox';
  else if (/CriOS\/|Chrome\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) && (/Version\/[\d.]+/.test(ua) || os === 'ios')) browser = 'safari';
  return { os, browser, host };
}

/** Android intent link that opens `href` in Chrome; other apps fall back to loading `href`. */
export function chromeIntentUrl(href: string): string {
  const u = new URL(href);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.slice(0, -1)};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`;
}

export const HOST_LABELS: Record<InAppHost, string> = {
  'google-app': 'the Google app',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  line: 'LINE',
  'android-webview': "an app's built-in browser",
  'other-in-app': "an app's built-in browser",
};

/** The public address of the hub (for "Open in Chrome" and "Copy link"). */
export function siteHref(): string {
  return (import.meta.env.VITE_SITE_URL as string | undefined) || new URL(import.meta.env.BASE_URL, location.href).href;
}

const GOOGLE_APP_REFERRER = 'android-app://com.google.android.googlequicksearchbox';
const FROM_GOOGLE_KEY = 'cobalt-hub.from-google-app';

function displayMode(): DisplayMode {
  const mode = appDisplayMode();
  // A Trusted Web Activity launch carries its own app package as referrer (the Google app's is a search tap).
  const twa = document.referrer.startsWith('android-app://') && !document.referrer.startsWith(GOOGLE_APP_REFERRER);
  return twa && (mode === 'fullscreen' || mode === 'standalone') ? 'twa' : mode;
}

let info: PlatformInfo | null = null;

export function platform(): PlatformInfo {
  if (info) return info;
  const ua = classifyUserAgent(navigator.userAgent, navigator.maxTouchPoints || 0);
  let framed = false;
  try {
    framed = window.self !== window.top;
  } catch {
    framed = true; // cross-origin parent
  }
  let fromGoogle = document.referrer.startsWith(GOOGLE_APP_REFERRER);
  if (fromGoogle) safeSession.set(FROM_GOOGLE_KEY, '1');
  else fromGoogle = safeSession.get(FROM_GOOGLE_KEY) === '1'; // survives reloads in the same tab
  info = { ...ua, displayMode: displayMode(), framed, openedFromGoogleApp: fromGoogle && ua.os === 'android' };
  return info;
}

/** True when running as an installed app (home screen, app window or TWA). */
export const isInstalledDisplay = (): boolean => platform().displayMode !== 'browser';

let webgl2: boolean | null = null;
let moduleWorkers: boolean | null = null;

/** Creates a WebGL 2 context once and releases it straight away (mobile browsers limit live contexts). */
export function probeWebGL2(): boolean {
  if (webgl2 !== null) return webgl2;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

/** Module workers (Voxelvale's world mesher): supported browsers read the `type` option. */
export function probeModuleWorkers(): boolean {
  if (moduleWorkers !== null) return moduleWorkers;
  let ok = false;
  try {
    const url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    new Worker(url, {
      get type() {
        ok = true;
        return 'module';
      },
    } as WorkerOptions).terminate();
    URL.revokeObjectURL(url);
  } catch {
    /* unsupported */
  }
  return (moduleWorkers = ok);
}

/** Runs the WebGL 2 probe when the browser is idle; resolves with the result. */
export function probeWebGL2WhenIdle(): Promise<boolean> {
  if (webgl2 !== null) return Promise.resolve(webgl2);
  return new Promise((resolve) => {
    const run = () => resolve(probeWebGL2());
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 500);
  });
}

/** What works here. Doesn't run the WebGL 2 / module worker probes (see gameSupport). */
export function capabilities(): Capabilities {
  const nav = navigator as Navigator & { wakeLock?: unknown };
  return {
    webgl2,
    moduleWorkers,
    serviceWorker: typeof navigator.serviceWorker?.register === 'function' && window.isSecureContext,
    localStorage: storagePersists(),
    fullscreen: fullscreenSupported(),
    orientationLock: typeof (screen.orientation as ScreenOrientation & { lock?: unknown } | undefined)?.lock === 'function',
    wakeLock: !!nav.wakeLock,
    pointerLock: supportsPointerLock(),
    broadcastChannel: typeof BroadcastChannel === 'function',
  };
}

export type UnsupportedReason = 'webgl2' | 'module-workers';

/** Whether a game can start here. With no game (joining by code) only WebGL 2 is checked. */
export function gameSupport(game: GameId | undefined): { ok: true } | { ok: false; reason: UnsupportedReason } {
  if (!probeWebGL2()) return { ok: false, reason: 'webgl2' };
  if (game === 'voxel' && !probeModuleWorkers()) return { ok: false, reason: 'module-workers' };
  return { ok: true };
}

/** Marks <html> for CSS: data-host, data-display and the classes standalone, in-app and framed. */
export function applyPlatformAttributes(): void {
  const p = platform();
  const root = document.documentElement;
  if (p.host) root.dataset.host = p.host;
  root.dataset.display = p.displayMode;
  root.classList.toggle('standalone', p.displayMode !== 'browser');
  root.classList.toggle('in-app', p.host !== null);
  root.classList.toggle('framed', p.framed);
}
