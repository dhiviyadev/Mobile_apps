/**
 * Icons and names for hotbar, picker and inventory (WP-B). Block items use the
 * world area's drawBlockIcon; items >= 256 draw their 16x16 sprite (painted
 * by world/itemSprites.ts, independent of the atlas layout), scaled with
 * nearest-neighbour filtering.
 */
import { FIRST_ITEM, itemName as sharedItemName } from '@hub/shared';
import { drawBlockIcon } from '../world/atlas';
import { itemSprite } from '../world/itemSprites';

const cache = new Map<string, HTMLCanvasElement>();
let spriteCanvas: HTMLCanvasElement | null = null;

/** A 16x16 canvas holding one item sprite (reused scratch). */
function spriteImage(item: number): HTMLCanvasElement | null {
  const px = itemSprite(item);
  if (!px) return null;
  spriteCanvas ??= Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
  const ctx = spriteCanvas.getContext('2d')!;
  const img = ctx.createImageData(16, 16);
  img.data.set(px);
  ctx.putImageData(img, 0, 0);
  return spriteCanvas;
}

export function drawItemIcon(atlas: HTMLCanvasElement, item: number, size: number): HTMLCanvasElement {
  const key = `${item}:${size}`;
  let c = cache.get(key);
  if (!c) {
    if (item < FIRST_ITEM) c = drawBlockIcon(atlas, item, size);
    else {
      c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      const img = spriteImage(item);
      if (img) ctx.drawImage(img, 0, 0, 16, 16, size * 0.06, size * 0.06, size * 0.88, size * 0.88);
    }
    cache.set(key, c);
  }
  return c;
}

export function createItemIcons(atlas: HTMLCanvasElement) {
  const iconFor = (item: number, size: number): HTMLCanvasElement => {
    const c = drawItemIcon(atlas, item, size);
    // Every slot needs its own element.
    const copy = document.createElement('canvas');
    copy.width = copy.height = size;
    copy.getContext('2d')!.drawImage(c, 0, 0);
    return copy;
  };
  return { iconFor, itemName: sharedItemName };
}
