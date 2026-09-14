import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { COOKIE_NAME, verify } from '../../../../lib/session.ts';
import {
  aircraftLabel,
  findOrCreateFlight,
  flightSummary,
  parseDepartureDate,
  parseFlightSlug,
  partyFor,
  seatsFor,
} from '../../../../lib/flights.ts';
import RegistrationForm from './RegistrationForm.tsx';
import SeatForm from './SeatForm.tsx';

/**
 * The flight page. Server-rendered on purpose (CLAUDE.md §5): it is the only
 * acquisition channel with the right granularity, because somebody searching for
 * their own flight number is exactly the person this is for. That means real
 * metadata and real content in the HTML, not a client-side fetch.
 */

interface RouteParams {
  params: Promise<{ flight: string; date: string }>;
}

function parseRoute(flight: string, date: string) {
  const slug = parseFlightSlug(decodeURIComponent(flight));
  const departure = parseDepartureDate(decodeURIComponent(date));
  if (!slug || !departure) return null;
  return { ...slug, departure };
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { flight, date } = await params;
  const route = parseRoute(flight, date);
  if (!route) return { title: 'Flight not found' };

  const designator = `${route.carrier}${route.flightNumber}`;
  const title = `${designator} on ${route.departure} — seat swaps`;
  const description =
    `Swap into a better seat on ${designator} departing ${route.departure}. `
    + 'Say which seat you have and which one you want; if there is a trade where '
    + 'everyone gains, we find it. Free, no negotiating.';

  return {
    title,
    description,
    alternates: { canonical: `/f/${designator.slice(0, 2)}-${route.flightNumber}/${route.departure}` },
    openGraph: { title, description, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function FlightPage({ params }: RouteParams) {
  const { flight, date } = await params;
  const route = parseRoute(flight, date);
  if (!route) notFound();

  const { flight: row } = await findOrCreateFlight(
    route.carrier,
    route.flightNumber,
    route.departure,
  );
  const summary = await flightSummary(row.id);
  const aircraft = aircraftLabel(row);

  const session = verify((await cookies()).get(COOKIE_NAME)?.value);
  const existing = session ? await partyFor(row.id, session.uid) : null;
  const currentSeats = existing ? await seatsFor(existing.id) : [];
  const checkinOpen =
    row.checkin_opens_utc !== null && row.checkin_opens_utc.getTime() <= Date.now();

  const designator = `${row.carrier}${row.flight_number}`;
  const route_text =
    row.origin && row.destination ? `${row.origin} → ${row.destination}` : null;

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {designator} · {row.departure_date}
        </h1>
        <p className="text-muted">
          {route_text ? <>{route_text} · </> : null}
          {aircraft.label}
          {aircraft.estimated ? (
            <span title="We could not identify the aircraft, so seat positions are a best guess.">
              {' '}(estimated layout)
            </span>
          ) : null}
        </p>
        {row.api_status === 'unknown' ? (
          <p className="text-sm text-muted">
            We are still checking this flight with our data provider. You can sign up
            now either way.
          </p>
        ) : null}
        {row.api_status === 'not_found' ? (
          <p className="text-sm text-muted">
            We could not find this flight in our data provider. That is often just a
            gap in their coverage — you can still sign up, and swaps will still work.
          </p>
        ) : null}
      </header>

      {/* Aggregate only: no names, no seats. This is what a stranger may see. */}
      <section className="rounded-lg border border-line p-5">
        <h2 className="text-base font-medium">Who is here so far</h2>
        {summary.parties === 0 ? (
          <p className="mt-2 text-muted">
            Nobody yet. Be first — then send this page to anyone else on your flight.
            Swaps need a handful of people on the <em>same</em> aircraft to work.
          </p>
        ) : (
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>
              <strong className="text-ink">{summary.parties}</strong>{' '}
              {summary.parties === 1 ? 'group' : 'groups'} signed up,{' '}
              <strong className="text-ink">{summary.travellers}</strong>{' '}
              {summary.travellers === 1 ? 'traveller' : 'travellers'} in total
            </li>
            {summary.wantAdjacency > 0 ? (
              <li>{summary.wantAdjacency} want to sit together</li>
            ) : null}
            {summary.wantWindow > 0 ? <li>{summary.wantWindow} want a window</li> : null}
            {summary.wantAisle > 0 ? <li>{summary.wantAisle} want an aisle</li> : null}
            {summary.seatsSubmitted > 0 ? (
              <li>{summary.seatsSubmitted} have sent their seat numbers</li>
            ) : null}
          </ul>
        )}
      </section>

      <RegistrationForm
        flightId={row.id}
        designator={designator}
        departureDate={row.departure_date}
        botUsername={process.env.TELEGRAM_BOT_USERNAME ?? ''}
        returnTo={`/f/${row.carrier}-${row.flight_number}/${row.departure_date}`}
        session={session}
        existing={existing}
      />

      {existing ? (
        <SeatForm
          size={existing.size}
          currentSeats={currentSeats}
          checkinOpen={checkinOpen}
          checkinOpensAt={
            row.checkin_opens_utc
              ? row.checkin_opens_utc.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
              : null
          }
        />
      ) : null}

      <section className="space-y-2 text-sm text-muted">
        <h2 className="text-base font-medium text-ink">What happens next</h2>
        <p>
          Your seat does not exist yet — the airline assigns it at check-in,
          {' '}24 to 48 hours before departure. That is why we ask for it later: when
          check-in opens, our bot sends one message asking for your seat number.
        </p>
        <p>
          You will only ever be shown a swap that improves your own situation. If it
          does not improve, you never hear about it.
        </p>
      </section>
    </div>
  );
}
