/** Minimal PNG decoder for tests: checks chunk CRCs, inflates IDAT and undoes the row filters. */
import { inflateSync } from 'node:zlib';
import { crc32 } from '../../tools/pwa/raster';

export interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  /** RGBA, 4 bytes per pixel. */
  pixels: Uint8Array;
  pixel(x: number, y: number): [number, number, number, number];
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  const idat: Uint8Array[] = [];
  for (let o = 8; o < bytes.length; ) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const data = bytes.subarray(o + 8, o + 8 + len);
    const crc = view.getUint32(o + 8 + len);
    if (crc32(bytes.subarray(o + 4, o + 8 + len)) !== crc) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') {
      width = view.getUint32(o + 8);
      height = view.getUint32(o + 12);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (colorType !== 6 || bitDepth !== 8) throw new Error(`unsupported PNG: colour type ${colorType}, depth ${bitDepth}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? pixels[y * stride + i - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 4 ? pixels[(y - 1) * stride + i - 4] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad filter ${filter}`);
      pixels[y * stride + i] = (src[i] + pred) & 0xff;
    }
  }
  return {
    width,
    height,
    colorType,
    bitDepth,
    pixels,
    pixel: (x, y) => {
      const i = (y * width + x) * 4;
      return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
    },
  };
}
