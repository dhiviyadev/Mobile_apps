/** Build-time variables and browser APIs that lib.dom doesn't describe yet. */

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  /** Absolute public URL of the site root (canonical/OG tags, "Copy link"). */
  readonly VITE_SITE_URL?: string;
  /** 'off' builds the kill-switch service worker and skips registration. */
  readonly VITE_SW?: string;
  /** Commit shown in Settings → App. */
  readonly VITE_BUILD_SHA?: string;
}

/** Chromium's install prompt (Android, desktop): fired when the site is installable. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
  appinstalled: Event;
}

interface LaunchParams {
  readonly targetURL?: string;
}

interface Window {
  /** Launch Handler API (Chromium): delivers app launches to the running window. */
  launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void };
}

interface Navigator {
  /** iOS Safari: true when opened from the Home Screen. */
  readonly standalone?: boolean;
}
