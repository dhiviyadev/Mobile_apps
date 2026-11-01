/**
 * Icons and names for hotbar, picker and inventory (WP-B owns this file after
 * WP0). Block items use the world area's drawBlockIcon; items >= 256 draw their
 * atlas sprite tile (WP0: a placeholder square in the item colour).
 */
import { FIRST_ITEM, itemDef, itemName as sharedItemName } from '@hub/shared';
import { drawBlockIcon } from '../world/atlas';

const cache = new Map<string, HTMLCanvasElement>();

export function createItemIcons(atlas: HTMLCanvasElement) {
  const iconFor = (item: number, size: number): HTMLCanvasElement => {
    const key = `${item}:${size}`;
    let c = cache.get(key);
    if (!c) {
      if (item < FIRST_ITEM) c = drawBlockIcon(atlas, item, size);
      else {
        c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = `#${(itemDef(item)?.color ?? 0x888888).toString(16).padStart(6, '0')}`;
        ctx.fillRect(size * 0.25, size * 0.25, size * 0.5, size * 0.5);
      }
      cache.set(key, c);
    }
    // Every slot needs its own element.
    const copy = document.createElement('canvas');
    copy.width = copy.height = size;
    copy.getContext('2d')!.drawImage(c, 0, 0);
    return copy;
  };
  return { iconFor, itemName: sharedItemName };
}
