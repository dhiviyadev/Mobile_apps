/**
 * Takes the player from a hub button press to a running game and back:
 * fullscreen + audio unlock (needs the user gesture), loading screen,
 * parallel "download game bundle" + "join room", then hand-off to the game.
 */
import { GAME_TITLES, type GameId, type JoinOptions } from '@hub/shared';
import { enterFullscreen, exitFullscreen, isTouchDevice, ScreenWakeLock } from '../core/device';
import { settings } from '../core/settings';
import { h } from '../core/ui/dom';
import { LoadingScreen, ReconnectBanner, toast } from '../core/ui/overlays';
import { audio } from '../core/audio/audio';
import { type JoinRequest, NetSession } from '../net/session';
import { isAbortError, serverSeenRecently, waitForServer } from '../net/api';
import { hasGameServer } from '../net/serverUrl';
import { gameLoaders } from '../games/registry';
import { runBenchmark } from '../core/render/benchmark';
import type { GameInstance } from '../games/types';
import { isChunkLoadError } from '../platform/chunkErrors';
import { gameSupport, type UnsupportedReason } from '../platform/detect';
import { showChunkLoadError, showUnsupported } from './PlatformNotices';

export type LaunchRequest =
  | { online: true; join: JoinRequest; game?: GameId; mode: string }
  | { online: false; game: GameId; mode: string };

const ACCENTS: Record<GameId, string> = { voxel: 'var(--voxel)', arena: 'var(--arena)' };

export interface LaunchHooks {
  onGameStart(): void;
  onGameEnd(message?: string): void;
}

let running = false;
let fullscreenFailed = false;
const wakeLock = new ScreenWakeLock();

/** True while a game (or its loading screen) is up. */
export const isGameRunning = (): boolean => running;

/** Whether the last launch on a touch device couldn't go full screen (suggests installing). */
export const lastLaunchFullscreenFailed = (): boolean => fullscreenFailed;

/** This browser lacks something the game needs (see platform/detect.ts gameSupport). */
class UnsupportedError extends Error {
  constructor(readonly reason: UnsupportedReason) {
    super(`unsupported: ${reason}`);
  }
}

/** Builds the join options from the saved profile. */
export function profileOptions(mode?: string): JoinOptions {
  const s = settings.get();
  return { nickname: s.nickname, color: s.color, mode };
}

export async function launchGame(req: LaunchRequest, hooks: LaunchHooks): Promise<void> {
  if (running) return;
  // Say so clearly when this browser can't run the game (no WebGL 2, or no module workers for Voxelvale).
  const support = gameSupport(req.game);
  if (!support.ok) {
    void showUnsupported(support.reason);
    return;
  }
  running = true;
  // Both of these must start inside the click handler's user gesture.
  audio.unlock();
  fullscreenFailed = false;
  if (isTouchDevice()) void enterFullscreen().then((ok) => (fullscreenFailed = !ok));

  const knownGame = req.game;
  const loading = new LoadingScreen(knownGame ? GAME_TITLES[knownGame] : 'Joining room', knownGame ? ACCENTS[knownGame] : undefined);
  loading.set(0.02, req.online ? 'Connecting…' : 'Loading…');

  let session: NetSession | null = null;
  let instance: GameInstance | null = null;
  let container: HTMLElement | null = null;
  const banner = new ReconnectBanner();

  const finish = (message?: string) => {
    instance?.dispose();
    instance = null;
    container?.remove();
    container = null;
    banner.hide();
    document.body.classList.remove('in-game');
    void wakeLock.disable();
    void exitFullscreen();
    audio.stopMusic();
    running = false;
    hooks.onGameEnd(message);
  };

  try {
    // First run on this device with "Auto" quality: measure the GPU once.
    if (settings.get().quality === 'auto' && !settings.get().detectedQuality) {
      loading.set(0.04, 'Tuning graphics for this device');
      await new Promise((r) => requestAnimationFrame(r));
      const result = runBenchmark();
      settings.update({ detectedQuality: result.preset });
      console.info(`[quality] ${result.gpu}: ${result.msPerFrame.toFixed(2)} ms → ${result.preset}`);
    }
    // A free server sleeps when nobody plays: wake it before joining, or the join fails.
    if (req.online && hasGameServer() && !serverSeenRecently()) {
      const cancel = new AbortController();
      const hideCancel = loading.showCancel(() => cancel.abort());
      try {
        await waitForServer({
          signal: cancel.signal,
          onWait: (s) => loading.set(0.02, `Waking the game server… ${s} s`),
        });
      } finally {
        hideCancel();
      }
      loading.set(0.03, 'Connecting…');
    }
    // Join and download in parallel; the room tells us which game a code belongs to.
    const sessionPromise = req.online ? NetSession.connect(req.join) : Promise.resolve(null);
    let game = knownGame;
    if (!game) {
      session = await sessionPromise;
      game = session!.game;
      const known = gameSupport(game); // a room code turned out to be Voxelvale
      if (!known.ok) throw new UnsupportedError(known.reason);
    }
    const modulePromise = gameLoaders[game]();
    modulePromise.then(() => loading.set(0.25, 'Game loaded'));
    session = await sessionPromise;
    if (session) loading.set(0.3, 'Joined room ' + session.roomId);
    const mod = await modulePromise;

    const mode = session ? String(session.state?.mode || req.mode) : req.mode;
    container = h('div', { class: 'game-root', dataset: { game } });
    document.body.appendChild(container);
    document.body.classList.add('in-game');
    hooks.onGameStart();

    if (session) {
      session.onStatus((status, detail) => {
        if (status === 'reconnecting') banner.show(Number(detail) || 1);
        else if (status === 'connected') {
          banner.hide();
          toast('Reconnected', 'success', 1800);
        } else if (status === 'closed') {
          banner.hide();
          if (detail !== 'left') {
            const msg =
              detail === 'kicked' ? 'You were removed from the room.' :
              detail === 'room-closed' ? 'The room was closed.' : 'Lost connection to the server.';
            finish(msg);
          }
        }
      });
    }

    instance = await mod.launch({
      game,
      container,
      session,
      mode,
      loading,
      exit: (message) => {
        const s = session;
        session = null;
        void s?.leave();
        finish(message);
      },
    });
    loading.done();
    void wakeLock.enable();
  } catch (err) {
    console.error(err);
    loading.done();
    void session?.leave();
    finish();
    if (err instanceof UnsupportedError) void showUnsupported(err.reason);
    else if (isChunkLoadError(err)) void showChunkLoadError();
    else if (!isAbortError(err)) toast(err instanceof Error ? err.message : 'Something went wrong.', 'error', 4500);
  }
}
