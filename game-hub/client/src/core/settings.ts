/**
 * Persistent player settings (localStorage). Every module reads from the same
 * reactive store so changes in the settings menu apply immediately in-game.
 */

export type QualityPreset = 'low' | 'medium' | 'high';
export type QualitySetting = QualityPreset | 'auto';

/** Saved position/size of one on-screen touch button. Coordinates are 0..1 of the viewport. */
export interface TouchButtonLayout {
  x: number;
  y: number;
  scale: number;
}

export interface Settings {
  nickname: string;
  color: number;
  // Graphics
  quality: QualitySetting;
  /** Result of the first-run benchmark, used when quality is "auto". */
  detectedQuality: QualityPreset | null;
  /** Voxel render distance in chunks. */
  renderDistance: number;
  dynamicResolution: boolean;
  showStats: boolean;
  // Controls
  lookSensitivity: number;
  mouseSensitivity: number;
  invertY: boolean;
  leftHanded: boolean;
  /** Voxelvale: hop up single blocks automatically while walking. */
  autoJump: boolean;
  aimAssist: boolean;
  touchButtonScale: number;
  touchOpacity: number;
  /** Per-button overrides keyed by "<layoutId>:<buttonId>". */
  touchLayout: Record<string, TouchButtonLayout>;
  // Audio
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
}

export const AVATAR_COLORS = [0x4fa3ff, 0x5fd17a, 0xffd166, 0xff7a45, 0xff4f7b, 0xb07cff, 0x2fb3a6, 0xf4f1ea];

const STORAGE_KEY = 'cobalt-hub.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  nickname: '',
  color: AVATAR_COLORS[0],
  quality: 'auto',
  detectedQuality: null,
  renderDistance: 4,
  dynamicResolution: true,
  showStats: false,
  lookSensitivity: 1,
  mouseSensitivity: 1,
  invertY: false,
  leftHanded: false,
  autoJump: true,
  aimAssist: true,
  touchButtonScale: 1,
  touchOpacity: 0.85,
  touchLayout: {},
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.8,
};

type Listener = (s: Settings, changed: (keyof Settings)[]) => void;

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Only keep known keys with the right primitive type.
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = parsed[key];
      if (v !== undefined && v !== null && typeof v === typeof DEFAULT_SETTINGS[key]) {
        (out as unknown as Record<string, unknown>)[key] = v;
      } else if (key === 'detectedQuality' && typeof v === 'string') {
        out.detectedQuality = v as QualityPreset;
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class SettingsStore {
  private state: Settings = load();
  private listeners = new Set<Listener>();

  get(): Readonly<Settings> {
    return this.state;
  }

  update(patch: Partial<Settings>): void {
    const changed = (Object.keys(patch) as (keyof Settings)[]).filter((k) => patch[k] !== this.state[k]);
    if (changed.length === 0) return;
    this.state = { ...this.state, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* private mode / quota: settings just won't persist */
    }
    for (const l of this.listeners) l(this.state, changed);
  }

  /** Subscribes to changes; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(keys: (keyof Settings)[]): void {
    const patch: Partial<Settings> = {};
    for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    this.update(patch);
  }

  /** The concrete preset to use right now. */
  effectiveQuality(): QualityPreset {
    const s = this.state;
    if (s.quality !== 'auto') return s.quality;
    return s.detectedQuality ?? 'medium';
  }
}

export const settings = new SettingsStore();
