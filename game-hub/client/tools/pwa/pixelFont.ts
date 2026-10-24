/**
 * Original 5×7 block letters for the social preview image. Each lit font
 * pixel is drawn as a slightly rounded square, which gives a voxel look.
 * Only the characters the artwork uses are defined.
 */
import { type Raster, type Rgb, roundRect } from './raster';

/** Rows top to bottom, '1' = lit. */
export const FONT_5X7: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** Glyph advance in font pixels (5 columns + 1 spacing). */
const ADVANCE = 6;

export function textWidth(text: string, px: number): number {
  return text.length === 0 ? 0 : (text.length * ADVANCE - 1) * px;
}

/** Draws `text` with its top-left corner at (x, y); `px` is the size of one font pixel. */
export function drawText(raster: Raster, text: string, x: number, y: number, px: number, color: Rgb): void {
  const side = px * 0.88;
  const inset = (px - side) / 2;
  [...text].forEach((ch, i) => {
    const glyph = FONT_5X7[ch];
    if (!glyph) throw new Error(`pixelFont: no glyph for ${JSON.stringify(ch)}`);
    glyph.forEach((row, r) => {
      for (let c = 0; c < 5; c++) {
        if (row[c] !== '1') continue;
        const gx = x + (i * ADVANCE + c) * px + inset;
        const gy = y + r * px + inset;
        raster.fill({ inside: roundRect(gx, gy, side, side, px * 0.12), color, bbox: [gx, gy, gx + side, gy + side] });
      }
    });
  });
}
