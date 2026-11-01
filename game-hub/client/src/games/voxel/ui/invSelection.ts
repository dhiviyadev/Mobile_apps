/**
 * Touch-friendly slot selection for the inventory screen (pure, unit-tested):
 * tap to lift, tap another slot to place, tap the same slot to put it back,
 * long-press to lift half, double-tap to quick-move.
 */
import type { InvOp } from '@hub/shared';

export type SelState = { kind: 'idle' } | { kind: 'lifted'; ref: number; /** 0 = the whole stack */ count: number };

export type SelAction =
  | { type: 'tap'; ref: number; /** items in the tapped slot */ count: number }
  | { type: 'longPress'; ref: number; count: number }
  | { type: 'doubleTap'; ref: number; count: number }
  | { type: 'drop'; one: boolean }
  | { type: 'cancel' };

export const IDLE: SelState = { kind: 'idle' };

export function reduceSelection(s: SelState, a: SelAction): { state: SelState; op: InvOp | null } {
  switch (a.type) {
    case 'cancel':
      return { state: IDLE, op: null };
    case 'doubleTap':
      return a.count > 0 ? { state: IDLE, op: { op: 'quick', from: a.ref } } : { state: IDLE, op: null };
    case 'longPress':
      if (a.count <= 0) return { state: s, op: null };
      return { state: { kind: 'lifted', ref: a.ref, count: a.count > 1 ? Math.ceil(a.count / 2) : 0 }, op: null };
    case 'drop':
      if (s.kind !== 'lifted') return { state: s, op: null };
      return { state: IDLE, op: { op: 'drop', from: s.ref, count: a.one ? 1 : s.count } };
    case 'tap':
      if (s.kind === 'idle') return a.count > 0 ? { state: { kind: 'lifted', ref: a.ref, count: 0 }, op: null } : { state: s, op: null };
      if (a.ref === s.ref) return { state: IDLE, op: null };
      if (s.count > 0 && a.count === 0) return { state: IDLE, op: { op: 'split', from: s.ref, to: a.ref } };
      return { state: IDLE, op: { op: 'move', from: s.ref, to: a.ref, count: s.count } };
  }
}
