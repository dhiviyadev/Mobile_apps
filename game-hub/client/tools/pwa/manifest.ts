/**
 * The web app manifest, generated per build so its id, icons and screenshot
 * sizes always match what was emitted. Every URL except related_applications
 * is relative to the manifest, so one build works under any base path.
 */
import { SITE_TEXT, type SiteConfig } from './site';

export interface ManifestScreenshot {
  src: string;
  width: number;
  height: number;
  label: string;
}

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: 'any' | 'maskable';
}

export const MANIFEST_ICONS: readonly ManifestIcon[] = [
  { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  // The SVG's logo reaches past the maskable safe zone, so it is "any" only.
  { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
];

export const SHORTCUTS = [
  { name: 'Play Voxelvale', short_name: 'Voxelvale', url: './?open=voxel', icon: 'icons/shortcut-voxel-96.png' },
  { name: 'Play Arcfire Arena', short_name: 'Arena', url: './?open=arena', icon: 'icons/shortcut-arena-96.png' },
] as const;

export function buildManifest(site: SiteConfig, screenshots: readonly ManifestScreenshot[]): Record<string, unknown> {
  return {
    // Equals the implicit id of the old static manifest (start_url "./"), so existing installs keep their identity.
    id: site.base,
    name: SITE_TEXT.name,
    short_name: SITE_TEXT.shortName,
    description: SITE_TEXT.manifestDescription,
    lang: 'en',
    dir: 'ltr',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone'],
    orientation: 'landscape',
    background_color: SITE_TEXT.backgroundColor,
    theme_color: SITE_TEXT.themeColor,
    categories: ['games', 'entertainment'],
    prefer_related_applications: false,
    ...(site.siteUrl ? { related_applications: [{ platform: 'webapp', url: `${site.siteUrl}manifest.webmanifest` }] } : {}),
    // A second launch focuses the running app instead of navigating away from a game.
    launch_handler: { client_mode: ['focus-existing', 'auto'] },
    icons: MANIFEST_ICONS,
    shortcuts: SHORTCUTS.map((s) => ({
      name: s.name,
      short_name: s.short_name,
      url: s.url,
      icons: [{ src: s.icon, sizes: '96x96', type: 'image/png' }],
    })),
    screenshots: screenshots.map((s) => ({
      src: s.src,
      sizes: `${s.width}x${s.height}`,
      type: 'image/png',
      form_factor: s.width >= s.height ? 'wide' : 'narrow',
      label: s.label,
    })),
  };
}
