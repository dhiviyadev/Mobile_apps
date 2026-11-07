/**
 * Worlds hosted from a player's device (Package W). The host creates a voxel
 * room with { host: true }; the room waits, locked and hidden, until the host
 * has sent its world file in HostUpload chunks. WorldUpload puts the chunks
 * back together and checks them; VoxelRoom then loads the world like a revived
 * save and sends saves back to the host instead of writing the server's store.
 */
import { decodeUploadChunk, decodeWorld, HOST_CHUNK_BYTES, HOSTED_WORLD_MAX_BYTES, type SavedWorld } from '@hub/shared';

/** What a refused upload tells the host (shown in its menu as is). */
export const UPLOAD_ERRORS = {
  tooBig: 'This world is too big to play online.',
  broken: 'This world file could not be read.',
  wrongMode: 'This world is in a different mode than the room.',
  outOfOrder: 'The world upload got mixed up. Try again.',
} as const;

export type UploadResult = { done: false } | { done: true; world: SavedWorld } | { done: false; error: string };

/** Collects HostUpload chunks (in order; WebSocket messages arrive in order) into one world file. */
export class WorldUpload {
  private buffer: Uint8Array | null = null;
  private received = 0;

  constructor(
    private readonly id: string,
    private readonly maxBytes = HOSTED_WORLD_MAX_BYTES,
  ) {}

  /** Bytes received so far. */
  get progress(): number {
    return this.received;
  }

  accept(chunk: Uint8Array): UploadResult {
    const c = decodeUploadChunk(chunk);
    if (!c || c.payload.byteLength > HOST_CHUNK_BYTES) return { done: false, error: UPLOAD_ERRORS.outOfOrder };
    if (!this.buffer) {
      if (c.total < 1 || c.total > this.maxBytes) return { done: false, error: UPLOAD_ERRORS.tooBig };
      this.buffer = new Uint8Array(c.total);
    }
    if (c.total !== this.buffer.byteLength || c.offset !== this.received || c.offset + c.payload.byteLength > c.total) {
      return { done: false, error: UPLOAD_ERRORS.outOfOrder };
    }
    this.buffer.set(c.payload, c.offset);
    this.received += c.payload.byteLength;
    if (this.received < this.buffer.byteLength) return { done: false };
    const bytes = this.buffer;
    this.buffer = null;
    try {
      return { done: true, world: decodeWorld(this.id, bytes) };
    } catch {
      return { done: false, error: UPLOAD_ERRORS.broken };
    }
  }
}

/** A hosted room's bookkeeping (VoxelRoom.hosted). */
export interface HostedInfo {
  /** Shown in the room list. */
  worldName: string;
  /** The host's nickname and session (set when the host's seat is taken). */
  hostName: string;
  hostSession: string | null;
  /** Join options of the host, kept until the world is loaded (survival reads playerKey). */
  hostOptions: unknown;
  /** Privacy the host asked for; the room stays hidden until the world is loaded. */
  wantPrivate: boolean;
  upload: WorldUpload;
  /** True once the world is loaded and the room is open to others. */
  ready: boolean;
  /** A save is owed to the host (it was away when one was due). */
  savePending: boolean;
  /** Set once the host left for good: the room is closing. */
  closing: boolean;
}
