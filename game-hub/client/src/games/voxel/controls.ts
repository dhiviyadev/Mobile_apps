/** Default touch layout for Voxelvale (landscape, right-handed). Layout id 'voxel' for every mode. */
import { GAME_ICONS } from '../../core/ui/icons';
import type { TouchLayout } from '../../core/input/TouchControls';

export interface VoxelTouchOptions {
  onMenu: () => void;
  /** Online only. */
  onChat: (() => void) | null;
  /** Sandbox: open the block picker. */
  onBlocks: (() => void) | null;
  /** Survival: open the bag. */
  onInventory: (() => void) | null;
  /** Sandbox and survival: open the teleport menu. */
  onTeleport?: (() => void) | null;
  /** Sandbox and survival: the Guard button exists (shown only while a shield is held, see setButton). */
  combat: boolean;
}

export function voxelTouchLayout(o: VoxelTouchOptions): TouchLayout {
  const buttons: TouchLayout['buttons'] = [
    { id: 'jump', action: 'jump', icon: GAME_ICONS.jump, x: 0.9, y: 0.76, size: 92, mode: 'hold', variant: 'primary' },
    { id: 'crouch', action: 'crouch', icon: GAME_ICONS.crouch, x: 0.78, y: 0.88, size: 64, mode: 'toggle' },
    // Relabelled at runtime: Break / Mine / Attack.
    { id: 'break', action: 'primary', icon: GAME_ICONS.pickaxe, label: 'Break', x: 0.9, y: 0.48, size: 84, mode: 'hold', lookThrough: true, variant: 'accent' },
    // Relabelled at runtime: Place / Use / Draw / Load / Fire / Eat / Guard / Open / Feed / Name.
    { id: 'place', action: 'secondary', icon: GAME_ICONS.place, label: 'Place', x: 0.77, y: 0.62, size: 78, mode: 'hold', lookThrough: true },
    { id: 'menu', icon: GAME_ICONS.menu, x: 0.965, y: 0.08, size: 52, mode: 'tap', onPress: o.onMenu, variant: 'small' },
  ];
  if (o.onChat) buttons.push({ id: 'chat', icon: GAME_ICONS.chat, x: 0.885, y: 0.08, size: 52, mode: 'tap', onPress: o.onChat, variant: 'small' });
  if (o.combat) buttons.push({ id: 'guard', action: 'guard', icon: GAME_ICONS.shield, label: 'Guard', x: 0.66, y: 0.74, size: 70, mode: 'hold', lookThrough: true });
  // Same default spot: only one of them exists per mode.
  if (o.onBlocks) buttons.push({ id: 'blocks', icon: GAME_ICONS.blocks, label: 'Blocks', x: 0.965, y: 0.2, size: 52, mode: 'tap', onPress: o.onBlocks, variant: 'small' });
  if (o.onInventory) buttons.push({ id: 'inventory', icon: GAME_ICONS.bag, label: 'Bag', x: 0.965, y: 0.2, size: 52, mode: 'tap', onPress: o.onInventory, variant: 'small' });
  if (o.onTeleport) {
    buttons.push({
      id: 'teleport',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-5.5-5-5.5-9a5.5 5.5 0 0 1 11 0c0 4-5.5 9-5.5 9z"/><circle cx="12" cy="11" r="2"/></svg>',
      label: 'Teleport',
      x: 0.885,
      y: 0.2,
      size: 52,
      mode: 'tap',
      onPress: o.onTeleport,
      variant: 'small',
    });
  }
  return { id: 'voxel', buttons, stickZone: 0.42 };
}
