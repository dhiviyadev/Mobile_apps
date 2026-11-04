import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  BurstKind,
  decodeEntitySnapshot,
  decodeEvents,
  decodeMobInteract,
  decodeMobInteractResult,
  decodeMobsSection,
  encodeEntitySnapshot,
  encodeEvents,
  encodeMobInteract,
  encodeMobInteractResult,
  encodeMobsSection,
  EntityEventType,
  eventsFor,
  MobFlag,
  MobKind,
  MobVariant,
  mobsFromJson,
  mobsToJson,
  ProjectileKind,
  Team,
  TelegraphShape,
  type EntitySnapshot,
  type SavedMob,
} from '../src/index';
import { FLOOR, setupWorld } from './mobWorld';

function sample(): EntitySnapshot {
  return {
    tick: 65534,
    mobs: [{ id: 7, kind: MobKind.Mudlurch, flags: 5, x: 12.34, y: 20.5, z: -301.77, yaw: 2.5, headYaw: 2.9, headPitch: -0.4, health: 0.5, action: 2, variant: MobVariant.Frost, actionSeq: 9, progress: 0.5 }],
    projectiles: [{ id: 9, kind: ProjectileKind.MobArrow, flags: 4, x: 1, y: 2, z: 3, vx: 21.5, vy: -3.25, vz: 0 }],
    hazards: [{ id: 11, kind: 1, radius: 2.5, x: 4, y: 10, z: 5, secondsLeft: 3.2, param: 0 }],
    bosses: [{ mobId: 7, kind: MobKind.AshenKnight, phase: 2, flags: 16 | 64, health: 201, maxHealth: 340, structureId: 0x0102, minions: 2 }],
  };
}

describe('entity net', () => {
  it('snapshot round trip with record sizes 16/16/12/12', () => {
    const s = sample();
    const bytes = encodeEntitySnapshot(s);
    expect(bytes.byteLength).toBe(3 + 1 + 16 + 1 + 16 + 1 + 12 + 1 + 1 + 12);
    const d = decodeEntitySnapshot(bytes);
    expect(d.tick).toBe(65534);
    const m = d.mobs[0];
    expect(Math.abs(m.x - 12.34)).toBeLessThanOrEqual(1 / 64);
    expect(Math.abs(m.z + 301.77)).toBeLessThanOrEqual(1 / 64);
    expect(Math.abs(m.yaw - 2.5)).toBeLessThan((1.5 * Math.PI) / 180);
    expect(Math.abs(m.headYaw - 2.9)).toBeLessThan((3 * Math.PI) / 180);
    expect(m.variant).toBe(MobVariant.Frost);
    expect(m.actionSeq).toBe(9);
    expect(d.projectiles[0].vx).toBeCloseTo(21.5, 2);
    expect(d.projectiles[0].flags).toBe(4);
    expect(d.hazards[0].radius).toBe(2.5);
    expect(d.bosses[0]).toMatchObject({ phase: 2, flags: 16 | 64, health: 201, maxHealth: 340, minions: 2 });
  });

  it('events round trip (byYou per recipient) and are routed by distance', () => {
    const ev = [
      { type: EntityEventType.MobHurt, id: 3, amount: 2.5, crit: true, killed: false, attacker: { type: 'player' as const, id: 'ana' }, x: 0, y: 0, z: 0 },
      { type: EntityEventType.Telegraph, bossId: 3, shape: TelegraphShape.Arc, seconds: 0.7, x: 1, y: 10, z: 2, radius: 6, width: 0, yaw: 1, halfAngle: 1.22, },
      { type: EntityEventType.Burst, kind: BurstKind.Slam, x: 100, y: 10, z: 0, radius: 4.5 },
      { type: EntityEventType.MobInfo, id: 3, name: 'Fluffy', owner: 'Ana', x: 0, y: 0, z: 0 },
    ] as const;
    const [bytes] = encodeEvents(5, ev, 'ana');
    const d = decodeEvents(bytes);
    expect(d.events.length).toBe(4);
    expect(d.events[0]).toMatchObject({ amount: 2.5, crit: true, byYou: true });
    expect(d.events[1]).toMatchObject({ shape: TelegraphShape.Arc, radius: 6 });
    expect(d.events[3]).toMatchObject({ name: 'Fluffy', owner: 'Ana' });
    expect(decodeEvents(encodeEvents(5, ev, 'bo')[0]).events[0]).toMatchObject({ byYou: false });
    expect(eventsFor(ev, { id: 'x', x: 0, y: 0, z: 0 }).length).toBe(3);
  });

  it('interest: mobs within 64, bosses within 96, nearest first', () => {
    const s = setupWorld({ caps: { maxNatural: 0 } });
    for (let i = 0; i < 70; i++) s.world.spawnMob(MobKind.Woolback, i, FLOOR, 0);
    s.world.spawnMob(MobKind.Woolback, 80, FLOOR, 0);
    const snap = buildSnapshot(s.world, { id: 'a', x: 0, y: FLOOR, z: 0 });
    expect(snap.mobs.length).toBe(64);
    expect(snap.mobs.every((m) => m.x <= 64)).toBe(true);
    expect(snap.mobs[0].x).toBe(0);
  });

  it('mi / mr codecs', () => {
    expect(decodeMobInteract(encodeMobInteract(513, 'block:HayBale'))).toEqual({ mobId: 513, key: 'block:HayBale' });
    expect(decodeMobInteractResult(encodeMobInteractResult(9, 'tamed'))).toEqual({ mobId: 9, result: 'tamed' });
  });
});

const tame = (o: Partial<SavedMob> = {}): SavedMob => ({ kind: MobKind.Woolback, variant: MobVariant.Frost, flags: MobFlag.Tamed | MobFlag.Named, x: 10.5, y: 22, z: -40.25, yaw: 1, health: 7, growLeft: 0, owner: 'Ana', name: 'Fluffy', ...o });

describe('mob persistence', () => {
  it('MOBS section round trip; hostile kinds skipped; bad payloads rejected', () => {
    const list = [tame(), tame({ kind: MobKind.Hopling, flags: MobFlag.Tamed | MobFlag.Baby, growLeft: 300, name: '' })];
    const back = decodeMobsSection(encodeMobsSection(list))!;
    expect(back.length).toBe(2);
    expect(back[0]).toMatchObject({ kind: MobKind.Woolback, variant: MobVariant.Frost, x: 10.5, z: -40.25, owner: 'Ana', name: 'Fluffy', health: 7 });
    expect(back[1].growLeft).toBe(300);
    expect(back[1].flags & MobFlag.Baby).toBeTruthy();
    const withHostile = encodeMobsSection([tame()]);
    withHostile[3] = MobKind.Mudlurch;
    expect(decodeMobsSection(withHostile)).toEqual([]);
    const v2 = encodeMobsSection(list);
    v2[0] = 2;
    expect(decodeMobsSection(v2)).toBeNull();
    expect(decodeMobsSection(encodeMobsSection(list).slice(0, 20))).toBeNull();
    const many = Uint8Array.from([1, 65, 0]);
    expect(decodeMobsSection(many)).toBeNull();
  });

  it('JSON round trip tolerates junk', () => {
    const json = mobsToJson([tame()]);
    expect(mobsFromJson(JSON.parse(JSON.stringify(json)))[0]).toMatchObject({ name: 'Fluffy', owner: 'Ana' });
    expect(mobsFromJson({ v: 1, list: [null, { k: 999 }, { k: MobKind.Mudlurch, x: 0, y: 20, z: 0 }, json.list[0]] }).length).toBe(1);
    expect(mobsFromJson('junk')).toEqual([]);
    void Team;
  });
});

describe('entity net in endless worlds', () => {
  it('keeps the bytes for positions within 1024 blocks and unwraps far ones near the viewer', () => {
    const s = sample();
    // Same bytes as before for the usual range: the wrap only differs past +-1024.
    expect([...encodeEntitySnapshot(s)].slice(8, 14)).toEqual([0x8b, 0x01, 0x90, 0x02, 0x47, 0xda]); // 12.34, 20.5, -301.77 in 1/32 blocks
    const far = sample();
    far.mobs[0] = { ...far.mobs[0], x: 30000.5, z: -29999.25 };
    far.projectiles[0] = { ...far.projectiles[0], x: 30003, z: -30001 };
    far.hazards[0] = { ...far.hazards[0], x: 29990, z: -30010 };
    const d = decodeEntitySnapshot(encodeEntitySnapshot(far), { x: 29980.2, z: -30020.7 });
    expect(d.mobs[0].x).toBeCloseTo(30000.5, 6);
    expect(d.mobs[0].z).toBeCloseTo(-29999.25, 6);
    expect(d.mobs[0].y).toBeCloseTo(20.5, 6);
    expect(d.projectiles[0].x).toBeCloseTo(30003, 6);
    expect(d.hazards[0].z).toBeCloseTo(-30010, 6);
    // Without a viewer position, positions near the origin decode as before.
    expect(decodeEntitySnapshot(encodeEntitySnapshot(sample())).mobs[0].z).toBeCloseTo(-301.77, 1);

    const [bytes] = encodeEvents(5, [{ type: EntityEventType.Burst, kind: BurstKind.Slam, x: -25000.5, y: 10, z: 12000, radius: 4.5 }], null);
    const e = decodeEvents(bytes, { x: -25010, z: 11990 }).events[0];
    expect(e.x).toBeCloseTo(-25000.5, 6);
    expect(e.z).toBeCloseTo(12000, 6);
  });

  it('saves tamed creatures anywhere in the endless world', () => {
    const list: SavedMob[] = mobsFromJson({ v: 1, list: [{ k: MobKind.Woolback, x: 25000.5, y: 30, z: -18000.5 }] });
    expect(list.length).toBe(1);
    expect(decodeMobsSection(encodeMobsSection(list))![0]).toMatchObject({ x: 25000.5, z: -18000.5 });
  });
});
