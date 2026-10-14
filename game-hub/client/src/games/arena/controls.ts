/** Default touch layout for Arcfire Arena (landscape, right-handed). */
import { GAME_ICONS } from '../../core/ui/icons';
import type { TouchLayout } from '../../core/input/TouchControls';

export interface ArenaTouchHandlers {
  onMenu: () => void;
  onScoreboard: () => void;
  onSwap: () => void;
  onChat: (() => void) | null;
}

export function arenaTouchLayout(h: ArenaTouchHandlers): TouchLayout {
  const buttons: TouchLayout['buttons'] = [
    // Fire doubles as a look pad: hold to shoot and drag to aim with one thumb.
    { id: 'fire', action: 'primary', icon: GAME_ICONS.fire, x: 0.86, y: 0.56, size: 104, mode: 'hold', lookThrough: true, variant: 'accent' },
    { id: 'aim', action: 'secondary', icon: GAME_ICONS.aim, label: 'Aim', x: 0.95, y: 0.36, size: 66, mode: 'toggle' },
    { id: 'jump', action: 'jump', icon: GAME_ICONS.jump, x: 0.94, y: 0.8, size: 78, mode: 'hold', variant: 'primary' },
    { id: 'crouch', action: 'crouch', icon: GAME_ICONS.crouch, x: 0.83, y: 0.9, size: 62, mode: 'toggle' },
    { id: 'reload', action: 'reload', icon: GAME_ICONS.reload, x: 0.72, y: 0.86, size: 62, mode: 'tap' },
    { id: 'swap', icon: GAME_ICONS.swap, label: 'Swap', x: 0.7, y: 0.66, size: 62, mode: 'tap', onPress: h.onSwap },
    { id: 'melee', action: 'melee', icon: GAME_ICONS.melee, x: 0.76, y: 0.38, size: 56, mode: 'tap' },
    { id: 'scores', icon: GAME_ICONS.scoreboard, x: 0.885, y: 0.08, size: 50, mode: 'tap', onPress: h.onScoreboard, variant: 'small' },
    { id: 'menu', icon: GAME_ICONS.menu, x: 0.965, y: 0.08, size: 50, mode: 'tap', onPress: h.onMenu, variant: 'small' },
  ];
  if (h.onChat) buttons.push({ id: 'chat', icon: GAME_ICONS.chat, x: 0.805, y: 0.08, size: 50, mode: 'tap', onPress: h.onChat, variant: 'small' });
  return { id: 'arena', buttons, stickZone: 0.4 };
}
