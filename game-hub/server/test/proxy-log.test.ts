/** The log line for checking TRUST_PROXY_HOPS. Its own file, so nothing has been logged yet. */
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { reportForwardedFor } from '../src/http/routes';

const request = (xff?: string) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as IncomingMessage;

describe('proxy check log', () => {
  it('logs each new X-Forwarded-For length once, a few at most, without addresses', () => {
    const lines: string[] = [];
    const report = (line: string) => void lines.push(line);
    reportForwardedFor(request(), report);
    reportForwardedFor(request('198.51.100.7, 104.23.0.9, 10.0.0.4'), report);
    reportForwardedFor(request('203.0.113.8,104.23.0.9, 10.0.0.4'), report);
    reportForwardedFor(request('1.1.1.1, 198.51.100.7, 104.23.0.9, 10.0.0.4'), report);
    for (const n of [1, 2, 5, 6]) reportForwardedFor(request(Array.from({ length: n }, (_, i) => `10.0.0.${i}`).join(', ')), report);
    expect(lines.map((l) => /with (\d+) entr/.exec(l)?.[1])).toEqual(['3', '4', '1', '2']);
    expect(lines[0]).toBe(`X-Forwarded-For with 3 entries seen (TRUST_PROXY_HOPS=${config.trustProxyHops})`);
    expect(lines.join('\n')).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
