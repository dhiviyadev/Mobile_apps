/**
 * Floating damage numbers (design-voxel-survival §17.7): a pool of 16 DOM
 * labels projected from the hit point each frame; they rise and fade over
 * 0.8 s. Crits are gold, blocked hits read "Blocked". Off with the
 * damageNumbers setting.
 */
import * as THREE from 'three';
import { settings } from '../../../core/settings';
import { h } from '../../../core/ui/dom';

interface Num {
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  t: number;
}

const LIFE = 0.8;

export class DamageNumbers {
  private readonly pool: Num[] = [];
  private next = 0;
  private readonly v = new THREE.Vector3();

  constructor(private readonly parent: HTMLElement) {
    for (let i = 0; i < 16; i++) {
      const el = h('div', { class: 'dmg-num' });
      parent.appendChild(el);
      this.pool.push({ el, x: 0, y: 0, z: 0, t: LIFE });
    }
  }

  spawn(x: number, y: number, z: number, amount: number, kind: 'hit' | 'crit' | 'blocked'): void {
    if (!settings.get().damageNumbers) return;
    const n = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    n.x = x + (Math.random() - 0.5) * 0.4;
    n.y = y + 0.3;
    n.z = z + (Math.random() - 0.5) * 0.4;
    n.t = 0;
    const v = Math.round(amount * 2) / 2;
    n.el.textContent = kind === 'blocked' && v <= 0 ? 'Blocked' : `${Number.isInteger(v) ? v : v.toFixed(1)}${kind === 'crit' ? '!' : ''}`;
    n.el.className = `dmg-num show ${kind}`;
  }

  update(dt: number, camera: THREE.Camera): void {
    const w = this.parent.clientWidth;
    const hgt = this.parent.clientHeight;
    for (const n of this.pool) {
      if (n.t >= LIFE) continue;
      n.t += dt;
      if (n.t >= LIFE) {
        n.el.className = 'dmg-num';
        continue;
      }
      const k = n.t / LIFE;
      this.v.set(n.x, n.y + 0.9 * (1 - (1 - k) * (1 - k)), n.z);
      const dist = this.v.distanceTo(camera.position);
      this.v.project(camera);
      if (this.v.z > 1 || dist > 32) {
        n.el.style.opacity = '0';
        continue;
      }
      n.el.style.opacity = String(1 - k * k);
      n.el.style.transform = `translate(${(this.v.x * 0.5 + 0.5) * w}px, ${(-this.v.y * 0.5 + 0.5) * hgt}px) translate(-50%, -50%) scale(${1 + (1 - k) * 0.25})`;
    }
  }

  dispose(): void {
    for (const n of this.pool) n.el.remove();
  }
}
