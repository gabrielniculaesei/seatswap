import type { MetadataRoute } from 'next';

import { siteUrl } from '../lib/seo.ts';

/**
 * robots.txt.
 *
 * Flight pages are the point of indexing this site at all, so they are allowed.
 * Two areas are not:
 *
 *  - `/a/` holds agreement screens. The token is 128 random bits so nothing is
 *    guessable, but a crawler that followed one into an index would put a page
 *    naming two travellers and their seats into public search results. Those
 *    pages also carry `noindex` in their own metadata; this is the belt to that
 *    pair of braces.
 *  - `/api/` is not for readers.
 */
// Per request, not at build: left static, Next prerenders this with whatever
// PUBLIC_BASE_URL the build happened to see, and a deploy that sets it only at
// runtime would point every crawler's sitemap at localhost.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/', '/a/'] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
