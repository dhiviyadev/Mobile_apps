/**
 * Tiny little-endian binary writer/reader for compact network messages.
 * Works on any Uint8Array view (Colyseus hands out subarrays with offsets).
 */

export class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialSize = 64) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  /** Angle in radians packed into 16 bits (precision ~0.0001 rad). */
  angle(v: number): this {
    const wrapped = Math.atan2(Math.sin(v), Math.cos(v));
    return this.i16(Math.round((wrapped / Math.PI) * 32767));
  }

  get length(): number {
    return this.pos;
  }

  /** A copy of the written bytes. */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class BinaryReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.byteLength - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.data.byteLength) throw new RangeError('BinaryReader: out of data');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  angle(): number {
    return (this.i16() / 32767) * Math.PI;
  }
}

/** Normalises whatever a transport hands us (Buffer, Uint8Array, ArrayBuffer) to a Uint8Array view. */
export function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
