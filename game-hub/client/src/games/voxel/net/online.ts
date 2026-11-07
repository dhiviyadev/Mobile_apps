/**
 * Online Voxelvale: build the game from the room's seed and attach the network
 * layer. Hosting a library world first uploads it (the room waits for it), then
 * keeps every save the server sends back in the library. Guests of a hosted
 * world leave with a clear message when its host goes.
 */
import {
  decodeWorld,
  encodeWorld,
  type HostReadyMsg,
  isGenVersion,
  type SavedWorld,
  uploadChunks,
  type VoxelMode,
  VoxelMsg,
  type WorldMeta,
} from '@hub/shared';
import { dialog, toast } from '../../../core/ui/overlays';
import { setPauseNote } from '../../common/PauseMenu';
import type { GameInstance, GameLaunchContext } from '../../types';
import { voxelLaunchData } from '../launchData';
import { withMeta, worldMeta } from '../library/codec';
import { getLibrary, type WorldLibrary } from '../library/WorldLibrary';
import { LEGACY_NOTE } from '../world/WorldFeatures';
import { VoxelGame } from '../VoxelGame';
import { VoxelNet } from './VoxelNet';

async function waitFor(check: () => boolean, timeoutMs: number, what = 'the room state'): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** How long Save & quit waits for the server's last save. */
const FINAL_SAVE_MS = 5000;

/** A library world being hosted from this device. */
class HostLink {
  private meta: WorldMeta;
  private since = performance.now();
  private waiters: (() => void)[] = [];
  private lastWrite: Promise<unknown> = Promise.resolve();
  game: VoxelGame | null = null;
  isPublic: boolean;
  code = '';

  constructor(
    private readonly ctx: GameLaunchContext,
    private readonly lib: WorldLibrary,
    private readonly worldId: string,
    private readonly world: SavedWorld,
    isPublic: boolean,
  ) {
    this.meta = worldMeta(world);
    this.isPublic = isPublic;
  }

  get name(): string {
    return this.meta.name;
  }

  /** Uploads the world and waits until the room has loaded it. Throws a player-facing error. */
  async upload(): Promise<{ code: string; seed: number }> {
    const session = this.ctx.session!;
    let reply: HostReadyMsg | null = null;
    const off = session.onMessage(VoxelMsg.HostReady, (m: HostReadyMsg) => (reply = m));
    try {
      const file = encodeWorld(this.world);
      const chunks = uploadChunks(file);
      for (let i = 0; i < chunks.length; i++) {
        session.sendBytes(VoxelMsg.HostUpload, chunks[i]);
        this.ctx.loading.set(0.3 + (0.04 * (i + 1)) / chunks.length, `Sending your world (${Math.round(((i + 1) / chunks.length) * 100)}%)`);
        // Let the socket drain between chunks (the server also rate limits them).
        if (i % 16 === 15) await new Promise((r) => setTimeout(r, 30));
      }
      this.ctx.loading.set(0.34, 'Opening your world online');
      await waitFor(() => reply !== null || session.status === 'closed', 60_000, 'the server to open your world');
    } finally {
      off();
    }
    const r = reply as HostReadyMsg | null;
    if (!r) throw new Error('The connection closed while sending your world.');
    if (!r.ok) throw new Error(r.error);
    this.code = r.code;
    this.meta = { ...this.meta, hostCode: r.code, hostPublic: this.isPublic, lastPlayed: Date.now() };
    await this.lib.updateMeta(this.worldId, (m) => ({ ...m, hostCode: r.code, hostPublic: this.isPublic, lastPlayed: Date.now() }));
    session.onMessage(VoxelMsg.HostSave, (bytes: Uint8Array) => this.onSave(bytes));
    return { code: r.code, seed: r.seed };
  }

  /** The server's copy of the world: keep it (with our META and where we stand). */
  private onSave(bytes: Uint8Array): void {
    let world: SavedWorld;
    try {
      world = decodeWorld(this.worldId, bytes);
    } catch (err) {
      console.error('[host] bad save from the server', err);
      return;
    }
    const now = performance.now();
    const b = this.game?.player.body;
    this.meta = {
      ...this.meta,
      lastPlayed: Date.now(),
      playtimeMs: this.meta.playtimeMs + Math.max(0, now - this.since),
      hostCode: this.code,
      hostPublic: this.isPublic,
      ownerKey: this.lib.myKey,
      ...(b && this.game ? { player: { x: b.x, y: b.y, z: b.z, yaw: this.game.player.yaw, pitch: this.game.player.pitch } } : {}),
    };
    this.since = now;
    this.lastWrite = this.lib.save(this.worldId, withMeta(world, this.meta)).catch((err) => {
      console.error('[host] could not keep the save', err);
      toast('Could not save the world on this device: storage may be full.', 'error', 5000);
    });
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Asks for a save now and waits for it to be written (at most FINAL_SAVE_MS). */
  async finalSave(): Promise<void> {
    const session = this.ctx.session;
    if (!session || session.status !== 'connected') return;
    const got = new Promise<void>((resolve) => this.waiters.push(resolve));
    session.send(VoxelMsg.HostSaveRequest, {});
    await Promise.race([got.then(() => this.lastWrite), new Promise((r) => setTimeout(r, FINAL_SAVE_MS))]);
  }

  async choosePrivacy(): Promise<void> {
    const pick = await dialog(
      'Who can join?',
      this.isPublic
        ? `This world is Public: it is listed and anyone can join. Code ${this.code}.`
        : `This world is Private: only people with the code ${this.code} can join.`,
      [
        { label: 'Private', value: 'private', primary: !this.isPublic },
        { label: 'Public', value: 'public', primary: this.isPublic },
      ],
      { testId: 'host-privacy' },
    );
    if (!pick) return;
    this.isPublic = pick === 'public';
    this.ctx.session?.send(VoxelMsg.HostPrivacy, { public: this.isPublic });
    void this.lib.updateMeta(this.worldId, (m) => ({ ...m, hostPublic: this.isPublic }));
  }

  note(): string {
    return `Hosting "${this.meta.name}" from this device (${this.isPublic ? 'Public' : 'Private'}, code ${this.code}). Saves come back here.`;
  }
}

export async function launchOnline(ctx: GameLaunchContext, fallbackMode: VoxelMode): Promise<GameInstance> {
  const session = ctx.session!;
  const data = voxelLaunchData(ctx);
  let host: HostLink | null = null;
  let expectSeed: number | null = null;
  if (data.host && data.worldId) {
    const lib = await getLibrary();
    const got = await lib.load(data.worldId);
    if (!got) throw new Error('That world could not be found. It may have been deleted.');
    host = new HostLink(ctx, lib, data.worldId, got.world, data.host.public);
    expectSeed = (await host.upload()).seed;
  }
  ctx.loading.set(0.34, 'Syncing world');
  await waitFor(() => !!session.state?.seed && (expectSeed === null || session.state.seed === expectSeed) && session.state.players?.get(session.sessionId) !== undefined, 10000);
  const state = session.state;
  const mode = (state.mode as VoxelMode) || fallbackMode;
  const me = state.players.get(session.sessionId);
  const link = host;

  const game = new VoxelGame({
    container: ctx.container,
    seed: state.seed,
    mode,
    chat: true,
    loading: ctx.loading,
    onExit: (m) => ctx.exit(m),
    // Use the server's idea of where we are (matters after a reconnect / page reload).
    initialPlayer: me ? { x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: me.pitch } : null,
    initialTime: state.timeOfDay,
    // A server without the field (or an old world) means generator 1.
    genVersion: isGenVersion(state.genVersion) ? state.genVersion : 1,
    online: true,
    pauseExtras: link ? [{ label: 'Who can join…', onClick: () => void link.choosePrivacy() }] : undefined,
    beforeExit: link ? () => link.finalSave() : undefined,
  });
  if (link) link.game = game;
  const net = new VoxelNet(session, game, ctx.container);
  game.setNet(net);
  // A hosted world closes when its host leaves: say why.
  const offClosed = session.onMessage(VoxelMsg.HostClosed, (m: { text?: string }) => {
    if (!link) ctx.exit(typeof m?.text === 'string' ? m.text : 'The host left.');
  });
  // Tell players whether and where this world is kept (read when the menu opens).
  const legacy = game.generator.genVersion === 1 && mode !== 'parkour';
  setPauseNote(ctx.container, () =>
    [link?.note() ?? net.saveNote() ?? (state.worldKind === 'hosted' ? 'This world is hosted from a player’s device; it closes when they leave.' : null), legacy ? LEGACY_NOTE : null].filter(Boolean).join(' ') || null,
  );
  await game.start();
  if (link) toast(`Your world is online. Code: ${link.code}`, 'success', 5000);
  return {
    dispose: () => {
      offClosed();
      setPauseNote(ctx.container, null);
      game.dispose();
    },
  };
}
