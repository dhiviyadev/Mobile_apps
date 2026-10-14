/**
 * Base class for every game room in the hub.
 *
 * Handles the lobby plumbing shared by both games:
 *  - unique 6-character room codes (used as the Colyseus roomId, so
 *    `client.joinById(code)` is all a friend needs)
 *  - private rooms (hidden from quick match and listings)
 *  - nickname sanitising and host assignment
 *  - holding a dropped player's seat for auto-reconnect
 *  - a ping/pong channel for the in-game ping display
 */
import { type Client, Room } from '@colyseus/core';
import {
  CHAT_BURST,
  CHAT_REFILL_PER_SECOND,
  type ChatMessage,
  generateRoomCode,
  type GameId,
  type JoinOptions,
  nicknameOrGuest,
  RECONNECT_WINDOW_SECONDS,
  type RoomMeta,
  sanitizeChat,
  TokenBucket,
} from '@hub/shared';
import { logger } from '../log';
import type { HubPlayer, HubState } from './schema/HubState';

const CODE_SET = 'hub:room-codes';

export abstract class HubRoom<S extends HubState<P>, P extends HubPlayer> extends Room<S, RoomMeta> {
  protected abstract readonly gameId: GameId;
  protected readonly log = logger(this.constructor.name);
  protected isPrivate = false;
  protected mode = '';
  /** Set in setup() to enable text chat (rate limited, sanitised) with join/leave notices. */
  protected chatEnabled = false;
  private readonly chatBuckets = new Map<string, TokenBucket>();

  // ---- hooks for subclasses -------------------------------------------------

  /** Validates the requested mode and returns the one actually used. */
  protected abstract resolveMode(requested: unknown): string;
  /** Creates the state object and registers message handlers. */
  protected abstract setup(options: JoinOptions): void | Promise<void>;
  /** Builds the player schema for a newly joined client. */
  protected abstract createPlayer(client: Client, options: JoinOptions, name: string): P;
  /** One-line status shown in public room listings. */
  protected describeStatus(): string {
    return '';
  }
  protected onPlayerJoined(_client: Client, _player: P): void {}
  protected onPlayerDropped(_sessionId: string, _player: P): void {}
  protected onPlayerReconnected(_client: Client, _player: P): void {}
  protected onPlayerRemoved(_sessionId: string, _player: P): void {}

  // ---- lifecycle --------------------------------------------------------------

  override async onCreate(options: JoinOptions = { nickname: '' }): Promise<void> {
    this.roomId = await this.reserveRoomCode();
    this.isPrivate = options.private === true;
    this.mode = this.resolveMode(options.mode);
    if (this.isPrivate) await this.setPrivate(true);

    await this.setup(options);
    this.state.code = this.roomId;
    this.state.mode = this.mode;

    this.onMessage('ping', (client, t: unknown) => {
      if (typeof t === 'number') client.send('pong', t);
    });
    if (this.chatEnabled) this.onMessage('chat', (client, data: { text?: unknown }) => this.handleChat(client, data));
    await this.refreshMetadata();
    this.log.info(`created ${this.gameId} room ${this.roomId} mode=${this.mode} private=${this.isPrivate}`);
  }

  override onJoin(client: Client, options: JoinOptions = { nickname: '' }): void {
    const name = nicknameOrGuest(options.nickname);
    const player = this.createPlayer(client, options, name);
    player.name = name;
    player.connected = true;
    this.state.players.set(client.sessionId, player);
    if (!this.state.hostId) this.state.hostId = client.sessionId;
    this.chatBuckets.set(client.sessionId, new TokenBucket(CHAT_BURST, CHAT_REFILL_PER_SECOND));
    this.onPlayerJoined(client, player);
    if (this.chatEnabled) this.systemChat(`${name} joined`);
    void this.refreshMetadata();
    this.log.info(`${name} (${client.sessionId}) joined ${this.roomId}`);
  }

  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (consented) {
      this.removePlayer(client.sessionId);
      return;
    }
    // Unexpected drop (tablet went to sleep, wifi hiccup...): keep the seat.
    player.connected = false;
    this.onPlayerDropped(client.sessionId, player);
    this.log.info(`${player.name} dropped from ${this.roomId}, holding seat ${RECONNECT_WINDOW_SECONDS}s`);
    try {
      const newClient = await this.allowReconnection(client, RECONNECT_WINDOW_SECONDS);
      player.connected = true;
      this.onPlayerReconnected(newClient, player);
      this.log.info(`${player.name} reconnected to ${this.roomId}`);
    } catch {
      this.removePlayer(client.sessionId);
    }
  }

  override async onDispose(): Promise<void> {
    await this.presence.srem(CODE_SET, this.roomId);
    this.log.info(`disposed room ${this.roomId}`);
  }

  // ---- helpers ------------------------------------------------------------------

  protected removePlayer(sessionId: string): void {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    this.state.players.delete(sessionId);
    this.chatBuckets.delete(sessionId);
    this.onPlayerRemoved(sessionId, player);
    if (this.chatEnabled) this.systemChat(`${player.name} left`);
    if (this.state.hostId === sessionId) {
      // Hand host rights to the longest-connected human.
      let next = '';
      this.state.players.forEach((p, id) => {
        if (!next && !p.bot) next = id;
      });
      this.state.hostId = next;
    }
    void this.refreshMetadata();
    this.log.info(`${player.name} left ${this.roomId}`);
  }

  // ---- chat -----------------------------------------------------------------------------

  private handleChat(client: Client, data: { text?: unknown }): void {
    const player = this.state.players.get(client.sessionId);
    const bucket = this.chatBuckets.get(client.sessionId);
    if (!player || !bucket) return;
    const text = sanitizeChat(data?.text);
    if (!text) return;
    if (!bucket.take()) {
      client.send('chat', { id: '', name: '', color: 0, text: 'Slow down: you are sending messages too fast.', system: true } satisfies ChatMessage);
      return;
    }
    this.broadcast('chat', { id: client.sessionId, name: player.name, color: player.color, text } satisfies ChatMessage);
  }

  protected systemChat(text: string): void {
    this.broadcast('chat', { id: '', name: '', color: 0, text, system: true } satisfies ChatMessage);
  }

  /** Number of human players currently holding a seat (connected or not). */
  protected humanCount(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (!p.bot) n++;
    });
    return n;
  }

  protected async refreshMetadata(): Promise<void> {
    if (this.state === undefined) return;
    await this.setMetadata({
      code: this.roomId,
      mode: this.mode,
      private: this.isPrivate,
      status: this.describeStatus(),
    });
  }

  private async reserveRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = generateRoomCode();
      if (!(await this.presence.sismember(CODE_SET, code))) {
        await this.presence.sadd(CODE_SET, code);
        return code;
      }
    }
    throw new Error('could not allocate a unique room code');
  }
}
