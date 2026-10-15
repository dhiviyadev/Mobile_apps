/**
 * Rate limits on reopening saved worlds by code: keyed on client addresses
 * the client cannot forge. Its own file, so the limiter starts out empty.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@colyseus/core';
import { TokenBucket } from '@hub/shared';
import { config } from '../src/config';
import { AddressBuckets, addressKey, clientAddress } from '../src/http/clientAddress';
import { startTestServer, type TestServer } from './helpers';

/** A matchmaking auth context as Colyseus builds it for an HTTP request from peer. */
function context(peer: string, headers: Record<string, string> = {}): Pick<AuthContext, 'headers' | 'req'> {
  const req = { headers, socket: { remoteAddress: peer } } as unknown as NonNullable<AuthContext['req']>;
  return { headers, req };
}

describe('client addresses', () => {
  const direct = { fly: false, proxyHops: 0 };

  it('uses the TCP peer and ignores headers a client can forge', () => {
    const forged = { 'fly-client-ip': '192.0.2.1', 'x-real-ip': '192.0.2.2', 'x-forwarded-for': '192.0.2.3, 192.0.2.4' };
    expect(clientAddress(context('198.51.100.7', forged), direct)).toBe('198.51.100.7');
    expect(clientAddress(context('::ffff:198.51.100.7', forged), direct)).toBe('198.51.100.7');
    // Without the HTTP request (server code calling the matchmaker) there is no address.
    expect(clientAddress({ headers: forged }, direct)).toBe('unknown');
    expect(clientAddress(undefined, direct)).toBe('unknown');
  });

  it('trusts Fly-Client-IP only on Fly', () => {
    const headers = { 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '192.0.2.3' };
    expect(clientAddress(context('fdaa::3', headers), { fly: true, proxyHops: 0 })).toBe('203.0.113.9');
    expect(clientAddress(context('10.0.0.1', headers), direct)).toBe('10.0.0.1');
    // On Fly without the header (not through Fly's proxy): the peer.
    expect(clientAddress(context('10.0.0.1'), { fly: true, proxyHops: 0 })).toBe('10.0.0.1');
  });

  it('behind N trusted proxies, takes the X-Forwarded-For entry N places from the right', () => {
    const headers = { 'x-forwarded-for': '192.0.2.66, 203.0.113.5, 10.1.0.2', 'x-real-ip': '192.0.2.67' };
    expect(clientAddress(context('10.0.0.1', headers), { fly: false, proxyHops: 1 })).toBe('10.1.0.2');
    expect(clientAddress(context('10.0.0.1', headers), { fly: false, proxyHops: 2 })).toBe('203.0.113.5');
    // Fewer entries than proxies: the request did not come through them, use the peer.
    expect(clientAddress(context('10.0.0.1', headers), { fly: false, proxyHops: 4 })).toBe('10.0.0.1');
    expect(clientAddress(context('10.0.0.1'), { fly: false, proxyHops: 1 })).toBe('10.0.0.1');
  });

  it('keys IPv6 by /64 and normalises what proxies write', () => {
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('[2001:db8:1:2::9]:443')).toBe('2001:db8:1:2::/64');
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(addressKey('::ffff:cb00:7105')).toBe('203.0.113.5');
    expect(addressKey('64:ff9b::203.0.113.5')).toBe('64:ff9b:0:0::/64');
    expect(addressKey(' 203.0.113.5:8080 ')).toBe('203.0.113.5');
    for (const junk of ['', 'unknown', 'not an ip', '203.0.113.256', '192.0.2.1, 192.0.2.2', '1'.repeat(500)]) {
      expect(addressKey(junk)).toBe('unknown');
    }
  });

  it('forgets the least recently used addresses when full, never all of them', () => {
    const buckets = new AddressBuckets(3, () => new TokenBucket(1, 0));
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.take('b')).toBe(true);
    expect(buckets.take('c')).toBe(true);
    expect(buckets.take('a')).toBe(false); // used again: now the most recent
    expect(buckets.take('d')).toBe(true); // full: forgets b, the least recently used
    expect(buckets.size).toBe(3);
    expect(buckets.take('b')).toBe(true); // a fresh bucket; forgets c
    expect(buckets.take('a')).toBe(false); // still limited
    expect(buckets.take('d')).toBe(false);
  });
});

describe('reopen rate limit', () => {
  let ts: TestServer;
  const saved = { onFly: config.onFly, trustProxyHops: config.trustProxyHops };

  beforeAll(async () => {
    ts = await startTestServer();
  });
  afterAll(async () => {
    Object.assign(config, saved);
    await ts.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One attempt to reopen a world that does not exist; returns the error text. */
  const attempt = async (headers: Record<string, string> = {}): Promise<string> => {
    const res = await fetch(`http://127.0.0.1:${ts.port}/matchmake/create/voxel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ nickname: 'Guesser', reviveCode: 'ZZZZZZ' }),
    });
    return ((await res.json()) as { error?: string }).error ?? '';
  };

  it('limits one peer however it rotates forwarding headers', async () => {
    Object.assign(config, { onFly: false, trustProxyHops: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // the matchmaker logs every refused create
    const errors: string[] = [];
    for (let i = 0; i < 21; i++) {
      errors.push(
        await attempt({
          'Fly-Client-IP': `192.0.2.${i}`,
          'X-Real-IP': `198.51.100.${i}`,
          'X-Forwarded-For': `203.0.113.${i}, 2001:db8:${i}::1`,
        }),
      );
    }
    expect(errors.slice(0, 20).every((e) => e.includes('NO_SAVED_WORLD'))).toBe(true);
    expect(errors[20]).toMatch(/TOO_MANY_REVIVES/);
  });

  it('behind a trusted proxy, limits by the address the proxy appended', async () => {
    Object.assign(config, { onFly: false, trustProxyHops: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Every request reaches the server from the "proxy" 127.0.0.1, which appends the client's address.
    const errors: string[] = [];
    for (let i = 0; i < 21; i++) errors.push(await attempt({ 'X-Forwarded-For': `192.0.2.${i}, 203.0.113.5`, 'X-Real-IP': `192.0.2.${i}` }));
    expect(errors.slice(0, 20).every((e) => e.includes('NO_SAVED_WORLD'))).toBe(true);
    expect(errors[20]).toMatch(/TOO_MANY_REVIVES/);
    // Another client still gets through, even one that names the limited address on the left.
    expect(await attempt({ 'X-Forwarded-For': '203.0.113.5, 203.0.113.9' })).toMatch(/NO_SAVED_WORLD/);
    // An IPv6 client is limited by its /64, so rotating within it does not help.
    const v6: string[] = [];
    for (let i = 0; i < 21; i++) v6.push(await attempt({ 'X-Forwarded-For': `2001:db8:5:6::${(i + 1).toString(16)}` }));
    expect(v6.slice(0, 20).every((e) => e.includes('NO_SAVED_WORLD'))).toBe(true);
    expect(v6[20]).toMatch(/TOO_MANY_REVIVES/);
    expect(await attempt({ 'X-Forwarded-For': '2001:db8:5:7::1' })).toMatch(/NO_SAVED_WORLD/);
  });
});
