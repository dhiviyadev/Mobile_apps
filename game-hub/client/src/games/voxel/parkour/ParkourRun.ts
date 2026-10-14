/**
 * Parkour mode rules on the client: start timer when leaving the start pad,
 * record checkpoints, respawn after falling, finish on the gold pad.
 * In multiplayer the server receives the same events and validates timing.
 */
import { Block, type BlockQuery, type ParkourCourse } from '@hub/shared';

export type ParkourEvent =
  | { kind: 'start' }
  | { kind: 'checkpoint'; index: number }
  | { kind: 'respawn'; index: number }
  | { kind: 'finish'; timeMs: number; best: boolean };

const BEST_KEY = 'cobalt-hub.parkour.best.';

export class ParkourRun {
  checkpoint = 0;
  running = false;
  finished = false;
  private startedAt = 0;
  private finishedMs = 0;
  best: number | null;

  constructor(
    readonly course: ParkourCourse,
    private readonly courseId: string,
  ) {
    const saved = Number(localStorage.getItem(BEST_KEY + courseId));
    this.best = Number.isFinite(saved) && saved > 0 ? saved : null;
  }

  get elapsedMs(): number {
    if (this.finished) return this.finishedMs;
    return this.running ? performance.now() - this.startedAt : 0;
  }

  get totalCheckpoints(): number {
    return this.course.checkpoints.length - 1;
  }

  /** Where to put the player after a fall or a restart (feet position). */
  respawnPoint(): { x: number; y: number; z: number } {
    const c = this.course.checkpoints[this.checkpoint];
    return { x: c.x + 0.5, y: c.y + 1, z: c.z + 0.5 };
  }

  restart(): void {
    this.checkpoint = 0;
    this.running = false;
    this.finished = false;
    this.finishedMs = 0;
  }

  /** Checks the player's feet position; returns at most one event per call. */
  update(x: number, y: number, z: number, onGround: boolean, get: BlockQuery): ParkourEvent | null {
    if (y < this.course.killY) return { kind: 'respawn', index: this.checkpoint };
    const start = this.course.checkpoints[0];
    if (!this.running && !this.finished && Math.hypot(x - (start.x + 0.5), z - (start.z + 0.5)) > 2.6) {
      this.running = true;
      this.startedAt = performance.now();
      return { kind: 'start' };
    }
    if (!onGround || this.finished) return null;
    const bx = Math.floor(x);
    const by = Math.floor(y - 0.05);
    const bz = Math.floor(z);
    const under = get(bx, by, bz);
    if (under === Block.Checkpoint) {
      const idx = this.course.checkpoints.findIndex((c) => c.x === bx && c.y === by && c.z === bz);
      if (idx > this.checkpoint) {
        this.checkpoint = idx;
        return { kind: 'checkpoint', index: idx };
      }
    } else if (under === Block.Finish && this.running) {
      this.finished = true;
      this.running = false;
      this.finishedMs = performance.now() - this.startedAt;
      const isBest = this.best === null || this.finishedMs < this.best;
      if (isBest) {
        this.best = this.finishedMs;
        try {
          localStorage.setItem(BEST_KEY + this.courseId, String(Math.round(this.finishedMs)));
        } catch {
          /* ignore */
        }
      }
      return { kind: 'finish', timeMs: this.finishedMs, best: isBest };
    }
    return null;
  }
}
