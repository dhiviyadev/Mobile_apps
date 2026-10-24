/**
 * Registers the service worker and runs its update flow and kill switches.
 *
 * - Registration waits until 1.5 s after page load, so the offline download
 *   never competes with the hub's first paint.
 * - A new deploy installs in the background and waits; the hub shows
 *   "Update ready" with Restart (never during a game). Restart tells the
 *   waiting worker to take over and reloads once.
 * - Kill switches: ?sw=off (unregister, clear, remember), ?sw=on (undo),
 *   a VITE_SW=off build, and Settings → App → Reset offline copy.
 *
 * Browser objects come in through ServiceWorkerHost so unit tests can fake them.
 */
import { CACHE_PREFIX, precacheCacheName, type SwInfo, type SwMessage } from './sw/routing';
import { pwaPrefs, safeLocal, type SafeStorage, updatePwaPrefs } from './storage';

export type OfflineState = 'unsupported' | 'disabled' | 'installing' | 'offline-ready' | 'update-ready' | 'error';

export interface PwaStatus {
  state: OfflineState;
  /** From the active worker (GET_INFO); null until known. */
  info: SwInfo | null;
  /** An update is ready but a game is running: the bar waits until the game ends. */
  updateDeferred: boolean;
}

export interface ServiceWorkerHost {
  container: ServiceWorkerContainer | undefined;
  caches: CacheStorage | undefined;
  storage: SafeStorage;
  location: Pick<Location, 'href' | 'reload' | 'replace'>;
  document: Pick<Document, 'visibilityState' | 'addEventListener'> | undefined;
  /** import.meta.env.BASE_URL, e.g. '/Mobile_apps/' */
  baseUrl: string;
  mode: 'on' | 'off';
  prod: boolean;
  secure: boolean;
  /** Resolves 1.5 s after the window 'load' event. */
  whenLoaded: () => Promise<void>;
  notify: (message: string) => void;
}

/** Local flag set by ?sw=off. */
export const SW_FLAG_KEY = 'cobalt-hub.sw';
const UPDATE_CHECK_EVERY_MS = 60 * 60 * 1000;
const VISIBLE_CHECK_AFTER_MS = 30 * 60 * 1000;

function browserHost(): ServiceWorkerHost {
  return {
    container: typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
    caches: typeof caches !== 'undefined' ? caches : undefined,
    storage: safeLocal,
    location: window.location,
    document,
    baseUrl: import.meta.env.BASE_URL,
    mode: import.meta.env.VITE_SW === 'off' ? 'off' : 'on',
    prod: import.meta.env.PROD,
    secure: window.isSecureContext,
    whenLoaded: () =>
      new Promise((resolve) => {
        const later = () => setTimeout(resolve, 1500);
        if (document.readyState === 'complete') later();
        else window.addEventListener('load', later, { once: true });
      }),
    notify: (message) => void import('../core/ui/overlays').then(({ toast }) => toast(message, 'success', 4000)),
  };
}

export class PwaController {
  private hostRef: ServiceWorkerHost | null = null;
  private reg: ServiceWorkerRegistration | null = null;
  private listeners = new Set<(s: PwaStatus) => void>();
  private reloading = false;
  private started = false;
  private lastCheck = 0;
  private isGameRunning: () => boolean = () => false;
  readonly status: PwaStatus = { state: 'unsupported', info: null, updateDeferred: false };

  /** Takes the host, or a factory called on first use (no window access at import time). */
  constructor(private readonly hostSource: ServiceWorkerHost | (() => ServiceWorkerHost) = browserHost) {}

  private get host(): ServiceWorkerHost {
    return (this.hostRef ??= typeof this.hostSource === 'function' ? this.hostSource() : this.hostSource);
  }

  configure(opts: { isGameRunning: () => boolean }): void {
    this.isGameRunning = opts.isGameRunning;
  }

  /** Called on every status change; returns an unsubscribe function. */
  subscribe(fn: (s: PwaStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The scope URL of this site's registration, e.g. https://host/Mobile_apps/ */
  private scopeUrl(): string {
    return new URL(this.host.baseUrl, this.host.location.href).href;
  }

  /** Handles ?sw=off / ?sw=on. Resolves true when the page is about to navigate (stop booting). */
  async handleKillSwitchParam(): Promise<boolean> {
    const url = new URL(this.host.location.href);
    const value = url.searchParams.get('sw');
    if (value === null) return false;
    if (value === 'off') {
      await this.removeOfflineCopy();
      this.host.storage.set(SW_FLAG_KEY, 'off');
    } else if (value === 'on') {
      this.host.storage.remove(SW_FLAG_KEY);
    }
    url.searchParams.delete('sw');
    this.host.location.replace(url.href);
    return true;
  }

  /** Registers the worker after load. No-op in dev, when unsupported, or when switched off. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const h = this.host;
    if (h.mode === 'off' && h.prod) {
      // The kill-switch build: also clean up after earlier builds right away.
      this.set({ state: 'disabled' });
      void this.removeOfflineCopy();
      return;
    }
    if (!h.prod || typeof h.container?.register !== 'function' || !h.secure) {
      this.set({ state: 'unsupported' });
      return;
    }
    if (h.storage.get(SW_FLAG_KEY) === 'off') {
      this.set({ state: 'disabled' });
      return;
    }
    // A controlled page already has a complete offline copy (workers activate only after precaching).
    this.set({ state: h.container.controller ? 'offline-ready' : 'installing' });
    void h.whenLoaded().then(() => this.register());
  }

  /** Turns offline play back on after ?sw=off (Settings → App → Turn on). */
  enable(): void {
    this.host.storage.remove(SW_FLAG_KEY);
    this.started = false;
    this.start();
  }

  private async register(): Promise<void> {
    const h = this.host;
    const container = h.container!;
    try {
      const reg = await container.register(`${h.baseUrl}sw.js`, { scope: h.baseUrl, updateViaCache: 'none' });
      this.reg = reg;
      this.lastCheck = Date.now();
      reg.addEventListener('updatefound', () => {
        if (reg.installing) this.track(reg.installing);
      });
      if (reg.waiting && container.controller) this.setUpdateReady();
      if (reg.installing) this.track(reg.installing);
      if (reg.active) await this.refreshActive();
      h.document?.addEventListener('visibilitychange', () => {
        if (h.document?.visibilityState === 'visible' && !this.isGameRunning() && Date.now() - this.lastCheck >= VISIBLE_CHECK_AFTER_MS) {
          this.update();
        }
      });
      setInterval(() => {
        if (h.document?.visibilityState !== 'hidden' && !this.isGameRunning()) this.update();
      }, UPDATE_CHECK_EVERY_MS);
    } catch (err) {
      console.warn('[pwa] service worker registration failed', err);
      this.set({ state: 'error' });
    }
  }

  private update(): void {
    this.lastCheck = Date.now();
    void this.reg?.update().catch(() => undefined);
  }

  private track(worker: ServiceWorker): void {
    const container = this.host.container!;
    // First install (no controller yet) shows progress; an update downloads silently.
    if (!container.controller && this.status.state !== 'update-ready') this.set({ state: 'installing' });
    const onState = () => {
      if (worker.state === 'installed' && container.controller) this.setUpdateReady();
      else if (worker.state === 'activated') void this.refreshActive();
      else if (worker.state === 'redundant' && this.status.state === 'installing') this.set({ state: 'error' });
    };
    worker.addEventListener('statechange', onState);
    onState();
  }

  private setUpdateReady(): void {
    this.set({ state: 'update-ready', updateDeferred: this.isGameRunning() });
  }

  /** Reads the active worker's build and marks offline play ready once its precache exists. */
  private async refreshActive(): Promise<void> {
    const active = this.reg?.active;
    if (!active) return;
    const info = await this.getInfo(active);
    if (!info) return;
    const ready = info.kill ? false : ((await this.host.caches?.has(precacheCacheName(info.buildId))) ?? false);
    if (this.status.state === 'update-ready') {
      this.set({ info });
      return;
    }
    this.set({ info, state: ready ? 'offline-ready' : this.status.state });
    if (ready && !pwaPrefs().offlineToastShown) {
      updatePwaPrefs({ offlineToastShown: true });
      this.host.notify('Ready to play offline: Cobalt Hub now opens without internet.');
    }
  }

  private getInfo(worker: ServiceWorker): Promise<SwInfo | null> {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        resolve(null);
      }, 2000);
      channel.port1.onmessage = (e: MessageEvent<SwInfo>) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(e.data);
      };
      const msg: SwMessage = { type: 'GET_INFO' };
      worker.postMessage(msg, [channel.port2]);
    });
  }

  /** Asks the server for a newer build now (Settings → App → Check). */
  async checkForUpdate(): Promise<'none' | 'update-ready' | 'offline'> {
    const reg = this.reg;
    if (!reg) return 'none';
    try {
      await reg.update();
    } catch {
      return 'offline';
    }
    const installing = reg.installing;
    if (installing) {
      // Wait for the new build to finish downloading (or fail).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        installing.addEventListener('statechange', () => {
          if (installing.state !== 'installing') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    return reg.waiting ? 'update-ready' : 'none';
  }

  /** Switches to the waiting build and reloads once it controls the page. */
  applyUpdate(): void {
    const container = this.host.container;
    const waiting = this.reg?.waiting;
    if (!container || !waiting) {
      this.host.location.reload();
      return;
    }
    // Only this flag reloads on controllerchange: the first install's clients.claim() must not.
    this.reloading = true;
    container.addEventListener(
      'controllerchange',
      () => {
        if (!this.reloading) return;
        this.reloading = false;
        this.host.location.reload();
      },
      { once: true },
    );
    const msg: SwMessage = { type: 'SKIP_WAITING' };
    waiting.postMessage(msg);
  }

  /** Settings → App → Reset: removes the worker and its caches, then reloads (which downloads a fresh copy). */
  async resetOfflineCache(): Promise<void> {
    await this.removeOfflineCopy();
    this.host.location.reload();
  }

  /** The hub calls this when a game ends: a deferred update bar may show now. */
  onGameEnded(): void {
    if (this.status.updateDeferred) this.set({ updateDeferred: false });
  }

  /** Unregisters this site's registrations and deletes only cobalt-hub-* caches. */
  private async removeOfflineCopy(): Promise<void> {
    const h = this.host;
    const scope = this.scopeUrl();
    try {
      const regs = (await h.container?.getRegistrations?.()) ?? [];
      await Promise.all(regs.filter((r) => r.scope.startsWith(scope)).map((r) => r.unregister()));
    } catch {
      /* no service workers here */
    }
    try {
      const keys = (await h.caches?.keys()) ?? [];
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => h.caches!.delete(k)));
    } catch {
      /* no Cache Storage */
    }
    this.reg = null;
  }

  private set(patch: Partial<PwaStatus>): void {
    Object.assign(this.status, patch);
    for (const fn of this.listeners) fn(this.status);
  }
}

/** The app-wide controller; touches no browser API until used. */
export const pwa = new PwaController();
