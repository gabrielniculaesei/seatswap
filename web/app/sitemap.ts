import type { MetadataRoute } from 'next';

import { sitemapFlights } from '../lib/flights.ts';
import { absoluteUrl, flightPath } from '../lib/seo.ts';

/**
 * The sitemap (CLAUDE.md §5).
 *
 * Only flights somebody has actually signed up for — exactly the pages that are
 * allowed to be indexed. Listing every address the router will answer on would
 * mean offering a crawler millions of empty pages while their own metadata says
 * `noindex`, and contradictory signals are worse than none.
 */

// Built per request rather than at build time: its contents change whenever
// somebody signs up, and it must not require a database to compile.
export const dynamic = 'force-dynamic';

const STATIC_PAGES: MetadataRoute.Sitemap = [
  { url: absoluteUrl('/'), changeFrequency: 'weekly', priority: 1 },
  { url: absoluteUrl('/privacy'), changeFrequency: 'yearly', priority: 0.2 },
  { url: absoluteUrl('/terms'), changeFrequency: 'yearly', priority: 0.2 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let flights;
  try {
    flights = await sitemapFlights();
  } catch (error) {
    // A sitemap that 500s teaches a crawler the site is broken. Degrade to the
    // pages we can name without asking anything (CLAUDE.md §11).
    console.error('sitemap: could not list flights', error);
    return STATIC_PAGES;
  }

  return [
    ...STATIC_PAGES,
    ...flights.map((flight) => ({
      url: absoluteUrl(
        flightPath(flight.carrier, flight.flight_number, flight.departure_date),
      ),
      lastModified: flight.last_modified,
      // A flight page changes as people join it and stops changing once it
      // departs, which is days away at most.
      changeFrequency: 'daily' as const,
      priority: 0.8,
    })),
  ];
}
