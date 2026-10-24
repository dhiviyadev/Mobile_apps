import { describe, expect, it } from 'vitest';
import { precacheCacheName, routeRequest, type SwRoute } from '../src/platform/sw/routing';

const PAGES = 'https://dhiviyadev.github.io/Mobile_apps/';
const ctx = {
  scope: PAGES,
  precache: new Set([`${PAGES}index.html`, `${PAGES}assets/three-abc.js`, `${PAGES}icons/icon-192.png`]),
};
const nav = (url: string) => ({ url, method: 'GET', mode: 'navigate' });
const get = (url: string) => ({ url, method: 'GET', mode: 'cors' });

describe('service worker routing', () => {
  const cases: [string, { url: string; method: string; mode: string }, SwRoute][] = [
    ['the hub page', nav(PAGES), 'navigation'],
    ['the hub with ?server=', nav(`${PAGES}?server=wss://x`), 'navigation'],
    ['an app shortcut', nav(`${PAGES}?open=voxel`), 'navigation'],
    ['index.html', nav(`${PAGES}index.html`), 'navigation'],
    ['the kill switch', nav(`${PAGES}?sw=off`), 'passthrough'],
    ['robots.txt opened as a page', nav(`${PAGES}robots.txt`), 'passthrough'],
    ['a precached chunk', get(`${PAGES}assets/three-abc.js`), 'precache'],
    ['a precached chunk with a query', get(`${PAGES}assets/three-abc.js?v=1`), 'precache'],
    ['another deploy’s chunk', get(`${PAGES}assets/new-xyz.js`), 'asset'],
    ['a POST', { url: `${PAGES}assets/three-abc.js`, method: 'POST', mode: 'cors' }, 'passthrough'],
    ['the room list on the game server', get('https://cobalt-hub-server.onrender.com/api/rooms'), 'passthrough'],
    ['matchmaking', { url: 'https://cobalt-hub-server.onrender.com/matchmake/joinOrCreate/arena', method: 'POST', mode: 'cors' }, 'passthrough'],
    ['another project on github.io', nav('https://dhiviyadev.github.io/other-project/'), 'passthrough'],
    ['a same-origin server path', get(`${PAGES}api/rooms`), 'passthrough'],
    ['sw.js itself', get(`${PAGES}sw.js`), 'passthrough'],
    ['the social image', get(`${PAGES}og-image.png`), 'passthrough'],
    ['a WebSocket URL', get('wss://dhiviyadev.github.io/Mobile_apps/'), 'passthrough'],
    ['not a URL', get('not a url'), 'passthrough'],
  ];
  it.each(cases)('%s', (_name, req, expected) => {
    expect(routeRequest(req, ctx)).toBe(expected);
  });

  it('works for a site at the root of its host', () => {
    const root = { scope: 'http://127.0.0.1:4173/', precache: new Set<string>() };
    expect(routeRequest(nav('http://127.0.0.1:4173/'), root)).toBe('navigation');
    expect(routeRequest(get('http://127.0.0.1:4173/matchmake/x'), root)).toBe('passthrough');
    expect(routeRequest(get('http://127.0.0.1:2567/health'), root)).toBe('passthrough');
  });

  it('names precaches by build', () => {
    expect(precacheCacheName('abc')).toBe('cobalt-hub-precache-abc');
  });
});
