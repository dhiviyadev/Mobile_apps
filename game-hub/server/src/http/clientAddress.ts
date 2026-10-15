/**
 * Which client a matchmaking request came from, for per-address rate limits.
 *
 * Only addresses the client cannot choose are used:
 *  - on Fly.io, the Fly-Client-IP header (Fly's proxy sets it, replacing any
 *    value the client sent);
 *  - behind TRUST_PROXY_HOPS reverse proxies, the X-Forwarded-For entry that
 *    many places from the right (the one the outermost proxy appended);
 *  - otherwise the TCP peer address of the request.
 * X-Real-IP and the leftmost X-Forwarded-For entries are never used: a client
 * can put anything there.
 *
 * Addresses are keyed by what one subscriber controls: IPv6 by its /64
 * prefix (a single host is usually handed a whole /64), IPv4-mapped IPv6 as
 * plain IPv4.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import type { AuthContext } from '@colyseus/core';
import type { TokenBucket } from '@hub/shared';
import { config } from '../config';

export interface AddressTrust {
  /** Trust Fly-Client-IP (only when running on Fly.io). */
  fly: boolean;
  /** Reverse proxies in front of the server that each append to X-Forwarded-For. */
  proxyHops: number;
}

const configuredTrust = (): AddressTrust => ({ fly: config.onFly, proxyHops: config.trustProxyHops });

function header(headers: IncomingHttpHeaders | undefined, name: string): string {
  const value = headers?.[name];
  return (Array.isArray(value) ? value.join(',') : value) ?? '';
}

/**
 * Rate-limit key for the client behind a matchmaking request. Colyseus passes
 * the HTTP request as context.req; a context without one (server code calling
 * the matchmaker directly) is keyed "unknown".
 */
export function clientAddress(context: Pick<AuthContext, 'headers' | 'req'> | undefined, trust: AddressTrust = configuredTrust()): string {
  const headers = context?.req?.headers ?? context?.headers;
  if (trust.fly) {
    const fly = header(headers, 'fly-client-ip').trim();
    if (fly) return addressKey(fly);
  }
  if (trust.proxyHops > 0) {
    const forwarded = header(headers, 'x-forwarded-for')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Each trusted proxy appends the address it received the request from.
    const entry = forwarded[forwarded.length - trust.proxyHops];
    if (entry) return addressKey(entry);
  }
  return addressKey(context?.req?.socket?.remoteAddress ?? '');
}

/** Canonical key for an address: IPv4 as is, IPv6 as its /64 prefix, anything unparseable as "unknown". */
export function addressKey(raw: string): string {
  let addr = raw.trim();
  // Proxies may add a port: "[2001:db8::1]:443", "203.0.113.5:443".
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(addr);
  if (bracketed) addr = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(addr)) addr = addr.slice(0, addr.lastIndexOf(':'));
  addr = addr.replace(/%.*$/, ''); // zone index, e.g. fe80::1%eth0
  const family = isIP(addr);
  if (family === 4) return addr;
  if (family !== 6) return 'unknown';
  const g = ipv6Groups(addr);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  }
  const prefix = g.slice(0, 4).map((x) => x.toString(16));
  return `${prefix.join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (expands "::" and a dotted IPv4 tail). */
function ipv6Groups(addr: string): number[] {
  let s = addr;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((x) => parseInt(x, 16));
}

/**
 * A token bucket per address, for at most maxAddresses addresses: when full,
 * the address used least recently is forgotten (it starts with a full bucket
 * if it comes back), so a burst of new addresses never resets the others.
 */
export class AddressBuckets {
  /** Least recently used first (Map keeps insertion order; a use re-inserts). */
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly maxAddresses: number,
    private readonly create: () => TokenBucket,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  /** Takes one token from address's bucket; false when it has none left. */
  take(address: string): boolean {
    let bucket = this.buckets.get(address);
    if (bucket) {
      this.buckets.delete(address);
    } else {
      bucket = this.create();
      while (this.buckets.size >= Math.max(1, this.maxAddresses)) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(address, bucket);
    return bucket.take();
  }
}
