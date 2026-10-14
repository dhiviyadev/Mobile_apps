/** Default touch layout for Voxelvale (landscape, right-handed). */
import { GAME_ICONS } from '../../core/ui/icons';
import type { TouchLayout } from '../../core/input/TouchControls';

export function voxelTouchLayout(onMenu: () => void, onChat: (() => void) | null): TouchLayout {
  const buttons: TouchLayout['buttons'] = [
    { id: 'jump', action: 'jump', icon: GAME_ICONS.jump, x: 0.9, y: 0.76, size: 92, mode: 'hold', variant: 'primary' },
    { id: 'crouch', action: 'crouch', icon: GAME_ICONS.crouch, x: 0.78, y: 0.88, size: 64, mode: 'toggle' },
    { id: 'break', action: 'primary', icon: GAME_ICONS.pickaxe, label: 'Break', x: 0.9, y: 0.48, size: 84, mode: 'hold', lookThrough: true, variant: 'accent' },
    { id: 'place', action: 'secondary', icon: GAME_ICONS.place, label: 'Place', x: 0.77, y: 0.62, size: 78, mode: 'hold', lookThrough: true },
    { id: 'menu', icon: GAME_ICONS.menu, x: 0.965, y: 0.08, size: 52, mode: 'tap', onPress: onMenu, variant: 'small' },
  ];
  if (onChat) buttons.push({ id: 'chat', icon: GAME_ICONS.chat, x: 0.885, y: 0.08, size: 52, mode: 'tap', onPress: onChat, variant: 'small' });
  return { id: 'voxel', buttons, stickZone: 0.42 };
}
