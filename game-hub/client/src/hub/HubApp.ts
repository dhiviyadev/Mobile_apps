/**
 * The hub shell: landing page with the two game cards, nickname + colour
 * picker, join-by-code, and the per-game sheet. Hands off to the launcher.
 */
import {
  GAME_TITLES,
  type GameId,
  HUB_NAME,
  isValidRoomCode,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  normalizeRoomCode,
  type RoomListResponse,
  sanitizeNickname,
} from '@hub/shared';
import { audio } from '../core/audio/audio';
import { AVATAR_COLORS, settings } from '../core/settings';
import { h, hexColor, svg } from '../core/ui/dom';
import { toast } from '../core/ui/overlays';
import { openSettings } from '../core/ui/settingsMenu';
import { pendingResume } from '../net/session';
import { arenaArt, ICONS, voxelArt } from './art';
import { GameSheet, type SheetAction } from './GameSheet';
import { launchGame, type LaunchHooks, profileOptions } from './launcher';
import { RoomPoller } from './roomPoller';

const TAGLINES: Record<GameId, string> = {
  voxel: 'Build, explore and race in a shared block world',
  arena: 'Fast round-based duels and team fights',
};

export class HubApp {
  private readonly root: HTMLElement;
  private readonly poller = new RoomPoller();
  private sheet: GameSheet | null = null;
  private nickInput!: HTMLInputElement;
  private onlineBadges = new Map<GameId, HTMLElement>();
  private serverPill!: HTMLElement;

  constructor(mount: HTMLElement) {
    this.root = h('div', { class: 'hub' });
    mount.appendChild(this.root);
    this.render();
    this.poller.subscribe((data, error) => this.updateCounts(data, error));
    this.poller.start();
    void this.tryResume();
  }

  private render(): void {
    const s = settings.get();
    this.nickInput = h('input', {
      class: 'nick-input',
      type: 'text',
      inputmode: 'text',
      autocomplete: 'nickname',
      autocapitalize: 'off',
      spellcheck: 'false',
      maxlength: String(NICKNAME_MAX_LENGTH),
      placeholder: 'Pick a nickname',
      'aria-label': 'Nickname',
      'data-testid': 'nickname',
      value: s.nickname,
    });
    this.nickInput.addEventListener('input', () => {
      settings.update({ nickname: sanitizeNickname(this.nickInput.value) });
    });
    this.nickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nickInput.blur();
    });

    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Avatar colour' });
    const renderSwatches = () => {
      swatches.replaceChildren(
        ...AVATAR_COLORS.map((c) =>
          h('button', {
            class: `swatch ${settings.get().color === c ? 'active' : ''}`,
            style: `--sw:${hexColor(c)}`,
            role: 'radio',
            'aria-checked': String(settings.get().color === c),
            'aria-label': `Colour ${hexColor(c)}`,
            onclick: () => {
              settings.update({ color: c });
              audio.unlock();
              audio.play('click');
              renderSwatches();
            },
          }),
        ),
      );
    };
    renderSwatches();

    const codeInput = h('input', {
      class: 'code-input',
      type: 'text',
      inputmode: 'text',
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '6',
      placeholder: 'ABC123',
      'aria-label': 'Room code',
      'data-testid': 'room-code',
    });
    codeInput.addEventListener('input', () => {
      codeInput.value = normalizeRoomCode(codeInput.value);
    });
    const joinCode = () => {
      const code = normalizeRoomCode(codeInput.value);
      if (!isValidRoomCode(code)) {
        toast('Room codes are 6 letters/numbers, e.g. K7PX2M', 'error');
        codeInput.focus();
        return;
      }
      if (!this.requireNickname()) return;
      void this.start({ online: true, join: { kind: 'code', code, options: profileOptions() }, mode: '' });
    };
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinCode();
    });

    this.serverPill = h('span', { class: 'server-pill' }, 'Connecting…');

    this.root.replaceChildren(
      h('header', { class: 'hub-header' },
        h('div', { class: 'brand' }, svg('<svg viewBox="0 0 128 128"><polygon points="64,26 98,46 64,66 30,46" fill="#5fd17a"/><polygon points="30,46 64,66 64,106 30,86" fill="#2fb3a6"/><polygon points="98,46 64,66 64,106 98,86" fill="#ff7a45"/></svg>', 'brand-mark'),
          h('span', { class: 'brand-name' }, HUB_NAME)),
        h('div', { class: 'header-right' },
          this.serverPill,
          h('button', { class: 'icon-btn', 'aria-label': 'Settings', 'data-testid': 'open-settings', onclick: () => openSettings() }, svg(ICONS.gear)),
        ),
      ),
      h('section', { class: 'profile' },
        h('div', { class: 'avatar-preview', style: `--sw:${hexColor(settings.get().color)}` }),
        h('div', { class: 'profile-fields' },
          h('label', { class: 'field-label' }, 'Your nickname'),
          this.nickInput,
          swatches,
        ),
      ),
      h('section', { class: 'cards' }, this.card('voxel', voxelArt()), this.card('arena', arenaArt())),
      h('section', { class: 'join-code' },
        h('label', { class: 'field-label' }, 'Have a room code?'),
        h('div', { class: 'join-code-row' },
          codeInput,
          h('button', { class: 'btn btn-primary', 'data-testid': 'join-code', onclick: joinCode }, 'Join'),
        ),
      ),
      h('footer', { class: 'hub-footer' }, 'All games, art, music and sound are original & generated in your browser.'),
    );
    settings.subscribe((st, changed) => {
      if (changed.includes('color')) {
        this.root.querySelector<HTMLElement>('.avatar-preview')?.style.setProperty('--sw', hexColor(st.color));
      }
    });
  }

  private card(game: GameId, art: string): HTMLElement {
    const badge = h('span', { class: 'online-badge' }, '…');
    this.onlineBadges.set(game, badge);
    return h('button', {
      class: `game-card card-${game}`,
      'data-testid': `card-${game}`,
      onclick: () => this.openSheet(game),
    },
      h('div', { class: 'card-art' }, svg(art)),
      h('div', { class: 'card-body' },
        h('h2', null, GAME_TITLES[game]),
        h('p', null, TAGLINES[game]),
        h('div', { class: 'card-meta' }, badge, h('span', { class: 'card-cta' }, 'Play ›')),
      ),
    );
  }

  private openSheet(game: GameId): void {
    audio.unlock();
    audio.play('click');
    this.sheet?.close();
    this.sheet = new GameSheet(game, this.poller, (a) => this.onSheetAction(game, a), () => (this.sheet = null));
    this.poller.refresh();
  }

  private onSheetAction(game: GameId, action: SheetAction): void {
    if (action.kind !== 'offline' && !this.requireNickname()) {
      this.sheet?.close();
      return;
    }
    audio.play('click');
    this.sheet?.close();
    switch (action.kind) {
      case 'quick':
        void this.start({ online: true, game, mode: action.mode, join: { kind: 'quick', game, options: profileOptions(action.mode) } });
        break;
      case 'create':
        void this.start({ online: true, game, mode: action.mode, join: { kind: 'create', game, options: profileOptions(action.mode) } });
        break;
      case 'join':
        void this.start({ online: true, game, mode: '', join: { kind: 'code', code: action.code, options: profileOptions() } });
        break;
      case 'offline':
        void this.start({ online: false, game, mode: action.mode });
        break;
    }
  }

  private requireNickname(): boolean {
    const nick = sanitizeNickname(this.nickInput.value);
    if (nick.length >= NICKNAME_MIN_LENGTH) {
      settings.update({ nickname: nick });
      return true;
    }
    toast(`Pick a nickname first (${NICKNAME_MIN_LENGTH}-${NICKNAME_MAX_LENGTH} characters).`, 'error');
    this.nickInput.classList.remove('shake');
    void this.nickInput.offsetWidth;
    this.nickInput.classList.add('shake');
    this.nickInput.focus();
    return false;
  }

  private hooks: LaunchHooks = {
    onGameStart: () => {
      this.poller.stop();
      this.root.classList.add('hidden');
    },
    onGameEnd: (message) => {
      this.root.classList.remove('hidden');
      this.poller.start();
      if (message) toast(message, 'info', 4000);
    },
  };

  private start(req: Parameters<typeof launchGame>[0]): Promise<void> {
    return launchGame(req, this.hooks);
  }

  /** Rejoin automatically if the page was reloaded mid-game. */
  private async tryResume(): Promise<void> {
    const info = pendingResume();
    if (!info) return;
    toast('Rejoining your last room…');
    await this.start({ online: true, join: { kind: 'resume', token: info.token }, mode: '' });
  }

  private updateCounts(data: RoomListResponse | null, error: boolean): void {
    if (error) {
      this.serverPill.textContent = 'Server offline';
      this.serverPill.className = 'server-pill offline';
    } else if (data) {
      const total = data.online.voxel + data.online.arena;
      this.serverPill.textContent = `${total} online`;
      this.serverPill.className = 'server-pill online';
    }
    for (const [game, badge] of this.onlineBadges) {
      if (error) badge.textContent = 'Offline play only';
      else if (data) {
        const n = data.online[game] ?? 0;
        const rooms = data.rooms.filter((r) => r.game === game).length;
        badge.textContent = `${n} playing · ${rooms} open room${rooms === 1 ? '' : 's'}`;
      }
    }
  }
}
