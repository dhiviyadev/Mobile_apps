/**
 * Search and social tags: <head> tags, JSON-LD, robots.txt and sitemap.xml.
 * Absolute URLs (canonical, og:url, og:image, sitemap) need VITE_SITE_URL and
 * are left out of builds without it.
 */
import type { HtmlTagDescriptor } from 'vite';
import { OG_HEIGHT, OG_WIDTH } from './brandArt';
import { SITE_TEXT, type SiteConfig } from './site';

const meta = (attrs: Record<string, string>): HtmlTagDescriptor => ({ tag: 'meta', attrs, injectTo: 'head' });
const link = (attrs: Record<string, string>): HtmlTagDescriptor => ({ tag: 'link', attrs, injectTo: 'head' });

export function headTags(site: SiteConfig): HtmlTagDescriptor[] {
  const { base: B, siteUrl: S } = site;
  const t = SITE_TEXT;
  const tags: HtmlTagDescriptor[] = [
    { tag: 'title', children: t.title, injectTo: 'head' },
    meta({ name: 'description', content: t.description }),
    meta({ name: 'robots', content: 'index, follow, max-image-preview:large' }),
    meta({ name: 'application-name', content: t.shortName }),
  ];
  if (S) tags.push(link({ rel: 'canonical', href: S }));
  tags.push(
    link({ rel: 'manifest', href: `${B}manifest.webmanifest` }),
    link({ rel: 'icon', href: `${B}icon.svg`, type: 'image/svg+xml' }),
    link({ rel: 'icon', href: `${B}icons/favicon-48.png`, type: 'image/png', sizes: '48x48' }),
    link({ rel: 'apple-touch-icon', href: `${B}icons/apple-touch-icon-180.png` }),
    meta({ property: 'og:type', content: 'website' }),
    meta({ property: 'og:site_name', content: t.name }),
    meta({ property: 'og:title', content: t.ogTitle }),
    meta({ property: 'og:description', content: t.ogDescription }),
  );
  if (S) {
    tags.push(
      meta({ property: 'og:url', content: S }),
      meta({ property: 'og:image', content: `${S}og-image.png` }),
      meta({ property: 'og:image:type', content: 'image/png' }),
      meta({ property: 'og:image:width', content: String(OG_WIDTH) }),
      meta({ property: 'og:image:height', content: String(OG_HEIGHT) }),
      meta({ property: 'og:image:alt', content: t.ogImageAlt }),
    );
  }
  tags.push(
    meta({ property: 'og:locale', content: 'en_US' }),
    meta({ name: 'twitter:card', content: 'summary_large_image' }),
    meta({ name: 'twitter:title', content: t.ogTitle }),
    meta({ name: 'twitter:description', content: t.ogDescription }),
  );
  if (S) tags.push(meta({ name: 'twitter:image', content: `${S}og-image.png` }), meta({ name: 'twitter:image:alt', content: t.ogImageAlt }));
  if (site.googleSiteVerification) tags.push(meta({ name: 'google-site-verification', content: site.googleSiteVerification }));
  tags.push({
    tag: 'script',
    attrs: { type: 'application/ld+json' },
    // "<" is escaped so no string inside the JSON can close the script element.
    children: JSON.stringify(jsonLd(site)).replace(/</g, '\\u003c'),
    injectTo: 'head',
  });
  return tags;
}

/**
 * schema.org description of the site. Never add aggregateRating or review:
 * there are no genuine ratings, and made-up ones break Google's policies.
 */
export function jsonLd(site: SiteConfig): Record<string, unknown> {
  const S = site.siteUrl;
  const t = SITE_TEXT;
  const abs = <T>(value: T) => (S ? value : undefined);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': abs(`${S}#website`),
        url: abs(S),
        name: t.name,
        alternateName: [t.shortName],
        inLanguage: 'en',
      },
      {
        '@type': ['VideoGame', 'WebApplication'],
        '@id': abs(`${S}#app`),
        name: t.name,
        url: abs(S),
        description: t.description,
        image: abs(`${S}og-image.png`),
        screenshot: abs([`${S}screenshots/voxel-sandbox.png`, `${S}screenshots/arena-live.png`]),
        applicationCategory: 'GameApplication',
        operatingSystem: 'Any (web browser): Android, iPadOS, iOS, Windows, macOS, ChromeOS, Linux',
        browserRequirements: 'Requires JavaScript and WebGL 2',
        gamePlatform: ['Web browser', 'Android', 'iPadOS', 'iOS', 'Windows', 'macOS', 'ChromeOS'],
        playMode: ['SinglePlayer', 'MultiPlayer', 'CoOp'],
        numberOfPlayers: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 16 },
        genre: ['Sandbox', 'Shooter'],
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
        inLanguage: 'en',
        hasPart: [
          {
            '@type': 'VideoGame',
            name: t.games.voxel.name,
            description: t.games.voxel.description,
            genre: t.games.voxel.genre,
            playMode: ['SinglePlayer', 'MultiPlayer', 'CoOp'],
            url: abs(`${S}?open=voxel`),
          },
          {
            '@type': 'VideoGame',
            name: t.games.arena.name,
            description: t.games.arena.description,
            genre: t.games.arena.genre,
            playMode: ['SinglePlayer', 'MultiPlayer'],
            url: abs(`${S}?open=arena`),
          },
        ],
      },
    ],
  };
}

/**
 * Crawlers read robots.txt only at a host's root, so on a GitHub Pages project
 * site this file only matters with a custom domain; it is emitted anyway.
 */
export function robotsTxt(site: SiteConfig): string {
  const lines = ['# Cobalt Game Hub', 'User-agent: *', 'Allow: /'];
  if (site.siteUrl) lines.push('', `Sitemap: ${site.siteUrl}sitemap.xml`);
  return lines.join('\n') + '\n';
}

/** The hub is one page; ?open= links are the same page (canonical points at the root). */
export function sitemapXml(site: SiteConfig): string | null {
  if (!site.siteUrl) return null;
  const esc = site.siteUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `  <url><loc>${esc}</loc><lastmod>${site.buildDate}</lastmod></url>\n` +
    '</urlset>\n'
  );
}
