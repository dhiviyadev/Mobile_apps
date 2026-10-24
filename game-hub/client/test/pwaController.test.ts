import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaController, type ServiceWorkerHost, SW_FLAG_KEY } from '../src/platform/register';
import { createSafeStorage, MemoryStorage } from '../src/platform/storage';
import type { SwInfo } from '../src/platform/sw/routing';

const ORIGIN = 'https://example.org';
const BASE = '/Mobile_apps/';
const SCOPE = ORIGIN + BASE;

/** Just enough of ServiceWorker: state changes and the GET_INFO / SKIP_WAITING messages. */
class FakeWorker extends EventTarget {
  messages: unknown[] = [];
  constructor(
    public state: ServiceWorkerState,
    private readonly info: SwInfo,
  ) {
    super();
  }
  postMessage(msg: { type: string }, transfer?: MessagePort[]): void {
    this.messages.push(msg);
    if (msg.type === 'GET_INFO') transfer?.[0]?.postMessage(this.info);
  }
  setState(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  unregistered = false;
  constructor(readonly scope = SCOPE) {
    super();
  }
  update = vi.fn(async () => undefined);
  async unregister(): Promise<boolean> {
    this.unregistered = true;
    return true;
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  registrations: FakeRegistration[] = [];
  constructor(readonly reg: FakeRegistration) {
    super();
    this.registrations.push(reg);
  }
  register = vi.fn(async () => this.reg);
  async getRegistrations(): Promise<FakeRegistration[]> {
    return this.registrations;
  }
}

class FakeCaches {
  names = new Set<string>();
  async keys(): Promise<string[]> {
    return [...this.names];
  }
  async has(name: string): Promise<boolean> {
    return this.names.has(name);
  }
  async delete(name: string): Promise<boolean> {
    return this.names.delete(name);
  }
}

const info = (buildId: string): SwInfo => ({ buildId, precache: ['index.html'], kill: false });
/** Lets promises, MessagePort deliveries and listeners run. */
const flush = () => new Promise((r) => setTimeout(r, 20));

function setup(opts: { href?: string; mode?: 'on' | 'off'; container?: FakeContainer | undefined } = {}) {
  const reg = new FakeRegistration();
  const container = 'container' in opts ? opts.container : new FakeContainer(reg);
  const caches = new FakeCaches();
  const location = { href: opts.href ?? SCOPE, reload: vi.fn(), replace: vi.fn() };
  const notify = vi.fn();
  const storage = createSafeStorage(() => new MemoryStorage());
  const host: ServiceWorkerHost = {
    container: container as unknown as ServiceWorkerContainer | undefined,
    caches: caches as unknown as CacheStorage,
    storage,
    location,
    document: undefined,
    baseUrl: BASE,
    mode: opts.mode ?? 'on',
    prod: true,
    secure: true,
    whenLoaded: () => Promise.resolve(),
    notify,
  };
  let gameRunning = false;
  const pwa = new PwaController(host);
  pwa.configure({ isGameRunning: () => gameRunning });
  return { pwa, reg, container: container as FakeContainer, caches, location, notify, storage, setGame: (v: boolean) => (gameRunning = v) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PwaController', () => {
  it('first install: installing, then offline-ready, and claiming the page does not reload it', async () => {
    const { pwa, reg, container, caches, location, notify } = setup();
    const worker = new FakeWorker('installing', info('build1'));
    reg.installing = worker;
    const states: string[] = [];
    pwa.subscribe((s) => states.push(s.state));
    pwa.start();
    await flush();
    expect(pwa.status.state).toBe('installing');

    worker.setState('installed');
    caches.names.add('cobalt-hub-precache-build1');
    reg.installing = null;
    reg.active = worker;
    container.controller = worker; // clients.claim()
    container.dispatchEvent(new Event('controllerchange'));
    worker.setState('activated');
    await flush();

    expect(pwa.status).toMatchObject({ state: 'offline-ready', info: { buildId: 'build1' } });
    expect(states).not.toContain('update-ready');
    expect(location.reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('an update found during a game waits for the game to end', async () => {
    const { pwa, reg, container, caches, setGame } = setup();
    const current = new FakeWorker('activated', info('old'));
    caches.names.add('cobalt-hub-precache-old');
    reg.active = current;
    container.controller = current;
    reg.waiting = new FakeWorker('installed', info('new'));
    setGame(true);
    pwa.start();
    await flush();
    expect(pwa.status).toMatchObject({ state: 'update-ready', updateDeferred: true });
    pwa.onGameEnded();
    expect(pwa.status.updateDeferred).toBe(false);
  });

  it('applyUpdate tells the waiting worker to take over and reloads exactly once', async () => {
    const { pwa, reg, container, location } = setup();
    const current = new FakeWorker('activated', info('old'));
    reg.active = current;
    container.controller = current;
    const next = new FakeWorker('installed', info('new'));
    reg.waiting = next;
    pwa.start();
    await flush();
    pwa.applyUpdate();
    expect(next.messages).toContainEqual({ type: 'SKIP_WAITING' });
    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('a VITE_SW=off build unregisters this site and deletes only its caches', async () => {
    const { pwa, reg, container, caches } = setup({ mode: 'off' });
    const other = new FakeRegistration(`${ORIGIN}/other-project/`);
    container.registrations.push(other);
    caches.names = new Set(['cobalt-hub-precache-x', 'cobalt-hub-runtime-v1', 'other-app-cache']);
    pwa.start();
    await flush();
    expect(pwa.status.state).toBe('disabled');
    expect(reg.unregistered).toBe(true);
    expect(other.unregistered).toBe(false);
    expect([...caches.names]).toEqual(['other-app-cache']);
    expect(container.register).not.toHaveBeenCalled();
  });

  it('?sw=off removes the offline copy and remembers it; ?sw=on forgets it', async () => {
    const off = setup({ href: `${SCOPE}?server=wss://x&sw=off` });
    off.caches.names.add('cobalt-hub-precache-x');
    expect(await off.pwa.handleKillSwitchParam()).toBe(true);
    expect(off.reg.unregistered).toBe(true);
    expect(off.caches.names.size).toBe(0);
    expect(off.storage.get(SW_FLAG_KEY)).toBe('off');
    expect(off.location.replace).toHaveBeenCalledWith(`${SCOPE}?server=wss%3A%2F%2Fx`);
    off.pwa.start();
    expect(off.pwa.status.state).toBe('disabled');

    const on = setup({ href: `${SCOPE}?sw=on` });
    on.storage.set(SW_FLAG_KEY, 'off');
    expect(await on.pwa.handleKillSwitchParam()).toBe(true);
    expect(on.storage.get(SW_FLAG_KEY)).toBeNull();
    expect(on.location.replace).toHaveBeenCalledWith(SCOPE);

    expect(await setup().pwa.handleKillSwitchParam()).toBe(false);
  });

  it('a browser without service workers is reported, without errors', async () => {
    const { pwa } = setup({ container: undefined });
    expect(() => pwa.start()).not.toThrow();
    expect(pwa.status.state).toBe('unsupported');
    await expect(pwa.checkForUpdate()).resolves.toBe('none');
  });
});
