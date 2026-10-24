/**
 * Site-wide text and build settings for the web app manifest, SEO tags and
 * the service worker. Node-only (imported by vite.config.ts): don't import
 * @hub/shared here; a unit test keeps the names in sync with it instead.
 */

export interface SiteConfig {
  /** Vite base path, always starting and ending with '/', e.g. '/Mobile_apps/'. */
  base: string;
  /** Absolute public URL of the site root ending with '/', or null (local builds). */
  siteUrl: string | null;
  serviceWorker: 'on' | 'off';
  googleSiteVerification: string | null;
  /** Build date, 'YYYY-MM-DD' in UTC (sitemap lastmod). */
  buildDate: string;
}

export const SITE_TEXT = {
  name: 'Cobalt Game Hub',
  shortName: 'Cobalt Hub',
  title: 'Cobalt Game Hub – free 3D voxel sandbox and arena shooter',
  description:
    'Play two original 3D games free: build and survive in Voxelvale or fight fast rounds in Arcfire Arena. Made for tablets, works offline, installs as an app.',
  manifestDescription: 'Two original 3D games for tablets and computers: Voxelvale and Arcfire Arena. Plays offline.',
  ogTitle: 'Cobalt Game Hub – free 3D games you can install',
  ogDescription:
    'Build and explore in Voxelvale or fight fast rounds in Arcfire Arena. Free, original, made for tablets, and playable offline.',
  ogImageAlt: 'Cobalt Game Hub logo, a green, teal and orange cube, next to the names Voxelvale and Arcfire Arena',
  games: {
    voxel: {
      name: 'Voxelvale',
      genre: ['Sandbox', 'Survival', 'Platformer'],
      description:
        'A block-building sandbox with survival, creatures, biomes and parkour courses in procedurally generated worlds, solo or with up to 16 players.',
    },
    arena: {
      name: 'Arcfire Arena',
      genre: ['Shooter', 'Arena'],
      description: 'A fast round-based arena shooter: 1v1 duels, 2v2 team fights and free-for-all, online or against bots.',
    },
  },
  themeColor: '#10162a',
  backgroundColor: '#10162a',
} as const;

/** Variables read by the build (VITE_* from the environment or .env files, plus SOURCE_DATE_EPOCH). */
export type SiteEnv = Partial<Record<'VITE_SITE_URL' | 'VITE_SW' | 'VITE_GOOGLE_SITE_VERIFICATION' | 'SOURCE_DATE_EPOCH', string>>;

export function normalizeBase(base: string): string {
  let b = base.trim() || '/';
  if (!b.startsWith('/')) b = '/' + b;
  if (!b.endsWith('/')) b += '/';
  return b;
}

export function resolveSiteConfig(env: SiteEnv, base: string, now: number): SiteConfig {
  const rawUrl = env.VITE_SITE_URL?.trim();
  let siteUrl: string | null = null;
  if (rawUrl) {
    const u = new URL(rawUrl); // throws on a malformed URL: better to fail the build than ship bad tags
    siteUrl = u.href.endsWith('/') ? u.href : u.href + '/';
  }
  const epoch = Number(env.SOURCE_DATE_EPOCH);
  const date = new Date(Number.isFinite(epoch) && env.SOURCE_DATE_EPOCH ? epoch * 1000 : now);
  return {
    base: normalizeBase(base),
    siteUrl,
    serviceWorker: env.VITE_SW?.trim().toLowerCase() === 'off' ? 'off' : 'on',
    googleSiteVerification: env.VITE_GOOGLE_SITE_VERIFICATION?.trim() || null,
    buildDate: date.toISOString().slice(0, 10),
  };
}

/** A warning when the public URL doesn't end with the base path (canonical URLs would point elsewhere). */
export function siteUrlWarning(site: SiteConfig): string | null {
  if (!site.siteUrl) return null;
  const path = new URL(site.siteUrl).pathname;
  return path.endsWith(site.base) ? null : `[pwa] VITE_SITE_URL ${site.siteUrl} does not end with the base path ${site.base}`;
}
