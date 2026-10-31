/** Brain per creature archetype (MobDef.brain). */
import type { Mob } from '../types';
import type { Brain } from './common';
import { fishBrain, friendlyBrain } from './friendly';
import { bursterBrain, climberBrain, flyerBrain, meleeBrain, rangedBrain } from './hostile';

const bossBrain: Brain = {
  think() {},
  act(_w, m, dt) {
    if (m.boss) m.boss.update(dt);
    else {
      m.intent.vx = m.intent.vz = 0;
    }
  },
};

const BRAINS: Record<string, Brain> = {
  friendly: friendlyBrain,
  fish: fishBrain,
  melee: meleeBrain,
  ranged: rangedBrain,
  climber: climberBrain,
  burster: bursterBrain,
  flyer: flyerBrain,
  boss: bossBrain,
};

export function brainFor(m: Mob): Brain {
  return BRAINS[m.def.brain];
}
