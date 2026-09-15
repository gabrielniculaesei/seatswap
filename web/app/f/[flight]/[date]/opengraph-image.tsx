import { ImageResponse } from 'next/og';

import { OG_SIZE, OgCard } from '../../../../components/OgCard.tsx';
import { parseDepartureDate, parseFlightSlug } from '../../../../lib/flight-id.ts';

/**
 * The preview card for one flight — what a shared link looks like in a chat.
 *
 * Drawn from the URL alone, with no database read. The flight page answers at
 * tens of millions of addresses and link unfurlers fetch this for every one that
 * is shared, so it should cost nothing and be cacheable forever; and like the
 * page itself it must never write (CLAUDE.md §5, lib/page-invariants.test.ts).
 * The route, which only the database knows, is in the page's title and
 * description instead.
 */

export const alt = 'Seat swaps on this flight';
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image({
  params,
}: {
  params: Promise<{ flight: string; date: string }>;
}) {
  const { flight, date } = await params;
  const slug = parseFlightSlug(decodeURIComponent(flight));
  const departure = parseDepartureDate(decodeURIComponent(date));

  return new ImageResponse(
    slug && departure ? (
      <OgCard
        eyebrow={`Departing ${departure}`}
        headline={`${slug.carrier} ${slug.flightNumber}`}
        detail="On this flight? Swap into a better seat, for free."
      />
    ) : (
      <OgCard
        eyebrow="Free seat swaps, same flight"
        headline="Swap into a better seat."
        detail="Everyone gains. Nobody asks for a favour."
      />
    ),
    size,
  );
}
