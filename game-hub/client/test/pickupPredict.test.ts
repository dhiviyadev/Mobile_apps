/**
 * Pickup and pad presentation logic (no WebGL needed): when pickups show, the cosmetic predicted
 * hide, respawn progress, and where launcher landing marks go.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createArenaWorld, createPlayerSim, flatArenaMap, launcherPad, type MapBox, type MapPickup, trampolinePad, WeaponId } from '@hub/shared';
import { PadRenderer, padLanding } from '../src/games/arena/render/PadRenderer';
import { PickupRenderer, PREDICT_HIDE_TICKS } from '../src/games/arena/render/PickupRenderer';

const PICKUPS: MapPickup[] = [
  { kind: 'health', x: 0, y: 0, z: 0 },
  { kind: 'ammo', x: 5, y: 0, z: 0 },
];

function renderer(pickups = PICKUPS): PickupRenderer {
  const r = new PickupRenderer(new THREE.Scene());
  r.load(flatArenaMap({ pickups }));
  return r;
}

describe('PickupRenderer', () => {
  it('shows a pickup while its authoritative tick has passed, and pops it back in', () => {
    const r = renderer();
    expect(r.update(0.016, [0, 0], 100)).toEqual([]);
    expect([r.isVisible(0), r.isVisible(1)]).toEqual([true, true]);
    // Taken: back at tick 700.
    r.update(0.016, [700, 0], 101);
    expect(r.isVisible(0)).toBe(false);
    r.update(0.016, [700, 0], 400);
    expect(r.progress(0)).toBeGreaterThan(0.45);
    expect(r.progress(0)).toBeLessThan(0.55);
    expect(r.update(0.016, [700, 0], 699.5)).toEqual([]);
    expect(r.update(0.016, [700, 0], 700)).toEqual([0]);
    expect(r.isVisible(0)).toBe(true);
    expect(r.progress(0)).toBe(1);
  });

  it('predicts a useful touch once, hides it briefly, and lets the server decide', () => {
    const r = renderer();
    r.update(0, [0, 0], 50);
    const p = createPlayerSim();
    // Full health and full reserves: nothing is useful.
    expect(r.predictTouch(p, 1000)).toBe(-1);
    p.hp = 40;
    expect(r.predictTouch(p, 1000)).toBe(0);
    r.markTaken(0, 50 + PREDICT_HIDE_TICKS);
    r.update(0.016, [0, 0], 51);
    expect(r.isVisible(0)).toBe(false);
    expect(r.predictedRecently(0, 1500, 1200)).toBe(true);
    // The server never confirmed it: back after the provisional hide, and no second prediction right away.
    r.update(0.016, [0, 0], 50 + PREDICT_HIDE_TICKS);
    expect(r.isVisible(0)).toBe(true);
    expect(r.predictTouch(p, 1400)).toBe(-1);
    expect(r.predictTouch(p, 2600)).toBe(0);
  });

  it('follows the touch radius and the ammo rule of the sim', () => {
    const r = renderer();
    r.update(0, [0, 0], 1);
    const p = createPlayerSim(WeaponId.Sniper);
    Object.assign(p, { x: 5.85, z: 0 });
    expect(r.predictTouch(p, 0)).toBe(-1); // full reserves
    p.weapons[0].reserve = 0;
    expect(r.predictTouch(p, 0)).toBe(1);
    Object.assign(p, { x: 5.95 });
    expect(r.predictTouch(p, 5000)).toBe(-1); // beyond 0.9 m
  });

  it('keeps an event hide until the authority catches up, and forgets overrides on a new round', () => {
    const r = renderer();
    r.update(0, [0, 0], 10);
    r.confirmTaken(1, 10);
    r.update(0.016, [0, 0], 20);
    expect(r.isVisible(1)).toBe(false);
    r.clearOverrides();
    r.update(0.016, [0, 0], 21);
    expect(r.isVisible(1)).toBe(true);
  });

  it('adds nothing on maps without pickups and at most three draw calls otherwise', () => {
    const empty = renderer([]);
    expect(empty.drawCalls).toBe(0);
    expect(empty.group.children).toHaveLength(0);
    expect(renderer().drawCalls).toBe(3);
    expect(renderer([PICKUPS[0], PICKUPS[0]]).drawCalls).toBe(2);
    let tris = 0;
    renderer([PICKUPS[0], PICKUPS[1]]).group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh) tris += (m.geometry.attributes.position.count / 3) * m.count;
    });
    expect(tris).toBeLessThan(400);
  });
});

describe('PadRenderer', () => {
  const target = { x: 0, y: 3, z: -20 };
  const launcher = launcherPad(0, 0, 2, 2, 0.3, target, 6);
  const tramp = trampolinePad(6, 0, 2, 2, 0.3, 5);
  const boxes: MapBox[] = [
    { minX: -1, maxX: 1, minY: 0, maxY: 0.3, minZ: -1, maxZ: 1, kind: 'pad' },
    { minX: 5, maxX: 7, minY: 0, maxY: 0.3, minZ: -1, maxZ: 1, kind: 'pad' },
    { minX: -4, maxX: 4, minY: 0, maxY: 3, minZ: -26, maxZ: -16, kind: 'platform' },
  ];
  const map = flatArenaMap({ pads: [launcher, tramp], boxes });
  const world = createArenaWorld(map);

  it('marks where a launcher really lands', () => {
    const at = padLanding(launcher, world)!;
    expect(at.y).toBe(3);
    expect(Math.hypot(at.x - target.x, at.z - target.z)).toBeLessThan(0.5);
  });

  it('draws caps plus landing marks, pops a pad on launch and settles again', () => {
    const r = new PadRenderer(new THREE.Scene());
    r.load(map, world);
    expect(r.drawCalls).toBe(2);
    r.pulse(1);
    expect(r.pulseOf(1)).toBe(1);
    r.update(0.1);
    expect(r.pulseOf(1)).toBeCloseTo(Math.exp(-0.6), 5);
    for (let i = 0; i < 60; i++) r.update(0.05);
    expect(r.pulseOf(1)).toBe(0);
    r.load(flatArenaMap(), createArenaWorld(flatArenaMap()));
    expect(r.drawCalls).toBe(0);
    expect(r.group.children).toHaveLength(0);
    r.dispose();
  });
});
