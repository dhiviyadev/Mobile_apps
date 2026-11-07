import { describe, expect, it } from 'vitest';
import {
  Block,
  decodeWaypoints,
  encodeWaypoints,
  parseTeleportOp,
  safeSpotNear,
  TELEPORT,
  TeleportCore,
  type TeleportEvent,
  type TeleportHooks,
} from '../src/index';

/** Flat world: stone below y = 20, air above, plus any blocks placed in `extra`. */
function setup(survival: boolean) {
  let now = 1_000_000;
  const extra = new Map<string, number>();
  const pos = new Map<string, { x: number; y: number; z: number }>();
  const hp = new Map<string, number>();
  const events = new Map<string, TeleportEvent[]>();
  let boss: { x: number; z: number } | null = null;
  const get = (x: number, y: number, z: number) => extra.get(`${x},${y},${z}`) ?? (y < 20 ? Block.Stone : Block.Air);
  const hooks: TeleportHooks = {
    now: () => now,
    survival: () => survival,
    pos: (id) => pos.get(id) ?? null,
    health: (id) => (survival ? (hp.get(id) ?? 20) : null),
    name: (id) => (pos.has(id) ? id.toUpperCase() : null),
    bossNear: (x, _y, z) => !!boss && Math.hypot(boss.x - x, boss.z - z) < TELEPORT.bossRadius,
    getBlock: get,
    move: (id, x, y, z) => pos.set(id, { x, y, z }),
    send: (id, e) => {
      if (!events.has(id)) events.set(id, []);
      events.get(id)!.push(e);
    },
  };
  const core = new TeleportCore(hooks);
  const add = (id: string, x: number, z: number) => {
    pos.set(id, { x, y: 20, z });
    core.addPlayer(id);
  };
  const last = (id: string) => events.get(id)?.at(-1);
  const kinds = (id: string) => (events.get(id) ?? []).map((e) => e.kind);
  return {
    core, pos, hp, extra, events, add, last, kinds,
    advance: (ms: number) => {
      now += ms;
      core.tick();
    },
    setBoss: (b: { x: number; z: number } | null) => (boss = b),
  };
}

describe('teleport: saved places', () => {
  it('saves, renames, recolours and deletes places, up to the limit', () => {
    const t = setup(false);
    t.add('a', 5.5, 5.5);
    t.core.handle('a', { op: 'save', name: '  My\u0007 house  ', color: 2 });
    expect(t.core.places('a')).toEqual([{ name: 'My house', x: 5.5, y: 20, z: 5.5, color: 2 }]);
    t.core.handle('a', { op: 'rename', index: 0, name: 'Home' });
    t.core.handle('a', { op: 'recolor', index: 0, color: 4 });
    expect(t.core.places('a')[0]).toMatchObject({ name: 'Home', color: 4 });
    for (let i = 1; i < TELEPORT.maxPlaces + 3; i++) t.core.handle('a', { op: 'save', name: '', color: 0 });
    expect(t.core.places('a')).toHaveLength(TELEPORT.maxPlaces);
    expect(t.core.places('a')[1].name).toBe('Place 2');
    expect(t.last('a')).toMatchObject({ kind: 'notice', error: true });
    t.core.handle('a', { op: 'delete', index: 0 });
    expect(t.core.places('a')).toHaveLength(TELEPORT.maxPlaces - 1);
  });

  it('sandbox: teleports at once to a safe spot, never inside blocks', () => {
    const t = setup(false);
    t.add('a', 0.5, 0.5);
    t.core.handle('a', { op: 'save', name: 'Home', color: 0 });
    t.pos.set('a', { x: 300.5, y: 20, z: -40.5 });
    // Someone built a wall on the place since.
    t.extra.set('0,20,0', Block.Stone);
    t.extra.set('0,21,0', Block.Stone);
    t.core.handle('a', { op: 'go', index: 0 });
    const p = t.pos.get('a')!;
    expect(Math.hypot(p.x - 0.5, p.z - 0.5)).toBeLessThan(2);
    // On top of the wall: feet and head free, ground solid.
    const at = (dy: number) => t.extra.get(`${Math.floor(p.x)},${p.y + dy},${Math.floor(p.z)}`) ?? (p.y + dy < 20 ? Block.Stone : Block.Air);
    expect([at(0), at(1)]).toEqual([Block.Air, Block.Air]);
    expect(at(-1)).toBe(Block.Stone);
    expect(t.last('a')).toMatchObject({ kind: 'arrived', to: 'Home', cooldownMs: 0 });
    // No cooldown in sandbox.
    t.pos.set('a', { x: 50.5, y: 20, z: 50.5 });
    t.core.handle('a', { op: 'go', index: 0 });
    expect(t.pos.get('a')!.x).toBeLessThan(2);
  });

  it('finds no spot in solid rock', () => {
    const solid = () => Block.Stone;
    expect(safeSpotNear(solid, 0, 10, 0)).toBeNull();
  });
});

describe('teleport: survival rules', () => {
  it('counts down 3 s, then jumps and starts a 30 s cooldown', () => {
    const t = setup(true);
    t.add('a', 0.5, 0.5);
    t.core.handle('a', { op: 'save', name: 'Home', color: 0 });
    t.pos.set('a', { x: 100.5, y: 20, z: 100.5 });
    t.core.handle('a', { op: 'go', index: 0 });
    expect(t.last('a')).toMatchObject({ kind: 'warmup', ms: TELEPORT.warmupMs });
    t.advance(2900);
    expect(t.pos.get('a')!.x).toBe(100.5);
    t.advance(200);
    expect(t.pos.get('a')!.x).toBeCloseTo(0.5);
    expect(t.last('a')).toMatchObject({ kind: 'arrived', cooldownMs: TELEPORT.cooldownMs });
    t.pos.set('a', { x: 100.5, y: 20, z: 100.5 });
    t.core.handle('a', { op: 'go', index: 0 });
    expect(t.last('a')).toMatchObject({ kind: 'notice', error: true, text: expect.stringContaining('recharging') });
    t.advance(TELEPORT.cooldownMs);
    t.core.handle('a', { op: 'go', index: 0 });
    expect(t.last('a')).toMatchObject({ kind: 'warmup' });
  });

  it('cancels the countdown on damage or moving away', () => {
    const t = setup(true);
    t.add('a', 0.5, 0.5);
    t.core.handle('a', { op: 'save', name: 'Home', color: 0 });
    t.pos.set('a', { x: 100.5, y: 20, z: 100.5 });
    t.core.handle('a', { op: 'go', index: 0 });
    t.hp.set('a', 17);
    t.advance(500);
    expect(t.last('a')).toMatchObject({ kind: 'cancelled', reason: expect.stringContaining('hurt') });
    t.advance(TELEPORT.warmupMs);
    expect(t.pos.get('a')!.x).toBe(100.5);

    t.core.handle('a', { op: 'go', index: 0 });
    t.pos.set('a', { x: 104.5, y: 20, z: 100.5 });
    t.advance(500);
    expect(t.last('a')).toMatchObject({ kind: 'cancelled', reason: expect.stringContaining('moved') });
    // A small shuffle does not cancel.
    t.core.handle('a', { op: 'go', index: 0 });
    t.pos.set('a', { x: 105, y: 20, z: 100.5 });
    t.advance(TELEPORT.warmupMs);
    expect(t.last('a')).toMatchObject({ kind: 'arrived' });
  });

  it('refuses during a boss fight', () => {
    const t = setup(true);
    t.add('a', 0.5, 0.5);
    t.core.handle('a', { op: 'save', name: 'Home', color: 0 });
    t.pos.set('a', { x: 500.5, y: 20, z: 500.5 });
    t.setBoss({ x: 510, z: 500 });
    t.core.handle('a', { op: 'go', index: 0 });
    expect(t.last('a')).toMatchObject({ kind: 'notice', text: expect.stringContaining('boss') });
    expect(t.core.warming('a')).toBe(false);
  });
});

describe('teleport: requests', () => {
  it('accepting brings the asker next to the target', () => {
    const t = setup(false);
    t.add('a', 0.5, 0.5);
    t.add('b', 200.5, 50.5);
    t.core.handle('b', { op: 'ask', to: 'a' });
    expect(t.last('a')).toEqual({ kind: 'request', from: 'b', name: 'B', expiresInMs: TELEPORT.requestTtlMs });
    t.core.handle('a', { op: 'answer', from: 'b', accept: true });
    const b = t.pos.get('b')!;
    const d = Math.hypot(b.x - 0.5, b.z - 0.5);
    expect(d).toBeGreaterThanOrEqual(1);
    expect(d).toBeLessThan(4.5);
    expect(b.y).toBe(20);
    expect(t.last('b')).toMatchObject({ kind: 'arrived', to: 'A' });
  });

  it('declines, limits repeats and expires', () => {
    const t = setup(false);
    t.add('a', 0.5, 0.5);
    t.add('b', 200.5, 50.5);
    t.core.handle('b', { op: 'ask', to: 'a' });
    t.core.handle('b', { op: 'ask', to: 'a' });
    expect(t.last('b')).toMatchObject({ kind: 'notice', error: true, text: expect.stringContaining('already asked') });
    t.core.handle('a', { op: 'answer', from: 'b', accept: false });
    expect(t.last('b')).toMatchObject({ text: expect.stringContaining('declined') });
    expect(t.pos.get('b')!.x).toBe(200.5);
    // Answering again does nothing; asking again needs 10 s.
    t.core.handle('a', { op: 'answer', from: 'b', accept: true });
    expect(t.pos.get('b')!.x).toBe(200.5);
    t.core.handle('b', { op: 'ask', to: 'a' });
    expect(t.last('b')).toMatchObject({ error: true, text: expect.stringContaining('Wait') });
    t.advance(TELEPORT.requestGapMs);
    t.core.handle('b', { op: 'ask', to: 'a' });
    expect(t.last('a')).toMatchObject({ kind: 'request' });
    t.advance(TELEPORT.requestTtlMs);
    expect(t.last('a')).toEqual({ kind: 'requestGone', from: 'b' });
    expect(t.last('b')).toMatchObject({ text: expect.stringContaining('expired') });
    t.core.handle('a', { op: 'answer', from: 'b', accept: true });
    expect(t.pos.get('b')!.x).toBe(200.5);
  });

  it('auto-decline turns requests away', () => {
    const t = setup(false);
    t.add('a', 0.5, 0.5);
    t.add('b', 200.5, 50.5);
    t.core.handle('a', { op: 'autoDecline', on: true });
    t.core.handle('b', { op: 'ask', to: 'a' });
    expect(t.last('b')).toMatchObject({ error: true, text: expect.stringContaining('not taking') });
    expect(t.kinds('a')).not.toContain('request');
  });

  it('a requester leaving withdraws the request', () => {
    const t = setup(false);
    t.add('a', 0.5, 0.5);
    t.add('b', 200.5, 50.5);
    t.core.handle('b', { op: 'ask', to: 'a' });
    t.core.removePlayer('b');
    expect(t.last('a')).toEqual({ kind: 'requestGone', from: 'b' });
  });

  it('survival: accepted requests count down too', () => {
    const t = setup(true);
    t.add('a', 0.5, 0.5);
    t.add('b', 200.5, 50.5);
    t.core.handle('b', { op: 'ask', to: 'a' });
    t.core.handle('a', { op: 'answer', from: 'b', accept: true });
    expect(t.last('b')).toMatchObject({ kind: 'warmup' });
    t.pos.set('a', { x: 30.5, y: 20, z: 30.5 }); // the target walks on: the asker lands where they are now
    t.advance(TELEPORT.warmupMs);
    expect(Math.hypot(t.pos.get('b')!.x - 30.5, t.pos.get('b')!.z - 30.5)).toBeLessThan(4.5);
  });
});

describe('teleport: wire and save formats', () => {
  it('parses only well-formed ops', () => {
    expect(parseTeleportOp({ op: 'go', index: 3 })).toEqual({ op: 'go', index: 3 });
    expect(parseTeleportOp({ op: 'go', index: 99 })).toBeNull();
    expect(parseTeleportOp({ op: 'save', name: 'x', color: 9 })).toBeNull();
    expect(parseTeleportOp({ op: 'answer', from: 'abc', accept: 'yes' })).toBeNull();
    expect(parseTeleportOp('nope')).toBeNull();
  });

  it('round-trips the WAYP section and rejects damaged bytes', () => {
    const recs = [
      { key: 'ab'.repeat(16), autoDecline: true, places: [{ name: 'Home', x: 1.5, y: 30, z: -2.25, color: 3 }, { name: 'Mine ⛏', x: 400, y: 12, z: 9, color: 0 }] },
      { key: '01'.repeat(16), autoDecline: false, places: [] },
    ];
    const bytes = encodeWaypoints(recs);
    expect(decodeWaypoints(bytes)).toEqual(recs);
    expect(() => decodeWaypoints(bytes.subarray(0, bytes.length - 2))).toThrow();
    expect(() => decodeWaypoints(new Uint8Array([9, 0, 0]))).toThrow();
  });
});
