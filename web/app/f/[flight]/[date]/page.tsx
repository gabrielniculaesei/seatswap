import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { COOKIE_NAME, verify } from '../../../../lib/session.ts';
import {
  type Flight,
  type FlightSummary,
  aircraftLabel,
  findFlight,
  flightSummary,
  parseDepartureDate,
  parseFlightSlug,
  partyFor,
  seatsFor,
} from '../../../../lib/flights.ts';
import ShareButton from '../../../../components/ShareButton.tsx';
import { absoluteUrl, flightJsonLd, flightMeta, flightPath } from '../../../../lib/seo.ts';
import BoardingPassForm from './BoardingPassForm.tsx';
import RegistrationForm from './RegistrationForm.tsx';
import SeatForm from './SeatForm.tsx';

/**
 * The flight page. Server-rendered on purpose (CLAUDE.md §5): it is the only
 * acquisition channel with the right granularity, because somebody searching for
 * their own flight number is exactly the person this is for. That means real
 * metadata and real content in the HTML, not a client-side fetch.
 *
 * It reads and never writes. Any carrier, number and date in range renders, so
 * this page is reachable at tens of millions of addresses; creating a row for
 * each one visited would hand a crawler an unbounded way to spend our
 * AeroDataBox quota (CLAUDE.md §11). The row appears when somebody signs up.
 * Until then the page is a real page about a real flight that simply has nobody
 * on it yet, which is exactly what it says.
 */

interface RouteParams {
  params: Promise<{ flight: string; date: string }>;
}

interface PageProps extends RouteParams {
  /**
   * `login=failed` is set by /api/auth/telegram when a sign-in does not verify;
   * `left=1` by RegistrationForm after leaving the flight.
   */
  searchParams: Promise<{ login?: string; left?: string }>;
}

function parseRoute(flight: string, date: string) {
  const slug = parseFlightSlug(decodeURIComponent(flight));
  const departure = parseDepartureDate(decodeURIComponent(date));
  if (!slug || !departure) return null;
  return { ...slug, departure };
}

const EMPTY_SUMMARY: FlightSummary = {
  parties: 0,
  travellers: 0,
  wantAdjacency: 0,
  wantWindow: 0,
  wantAisle: 0,
  seatsSubmitted: 0,
  verified: 0,
};

/** What we know about a flight, whether or not it has a row yet. */
function viewOf(route: { carrier: string; flightNumber: string; departure: string }, row: Flight | null) {
  return {
    carrier: row?.carrier ?? route.carrier,
    flightNumber: row?.flight_number ?? route.flightNumber,
    departureDate: row?.departure_date ?? route.departure,
    origin: row?.origin ?? null,
    destination: row?.destination ?? null,
    aircraftType: row?.aircraft_type ?? null,
    seatMapKey: row?.seat_map_key ?? null,
    scheduledDepartureUtc: row?.scheduled_departure_utc ?? null,
    checkinOpensUtc: row?.checkin_opens_utc ?? null,
    // No row means nobody has signed up, so nothing has been looked up either.
    apiStatus: row?.api_status ?? 'unknown',
    lookedUp: row?.api_verified_at != null,
  };
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { flight, date } = await params;
  const route = parseRoute(flight, date);
  if (!route) return { title: 'Flight not found', robots: { index: false, follow: false } };

  const row = await findFlight(route.carrier, route.flightNumber, route.departure);
  const summary = row ? await flightSummary(row.id) : EMPTY_SUMMARY;
  const view = viewOf(route, row);

  const meta = flightMeta({
    carrier: view.carrier,
    flightNumber: view.flightNumber,
    departureDate: view.departureDate,
    origin: view.origin,
    destination: view.destination,
    parties: summary.parties,
  });

  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical: meta.canonical },
    // A flight nobody has joined is a thin page among millions of near-identical
    // ones. `follow` stays on, so a shared link to an empty flight still passes
    // the crawler through rather than being a dead end.
    robots: { index: meta.index, follow: true },
    // These replace the layout's objects wholesale rather than merging with them,
    // so anything the layout set that still applies has to be said again. The
    // image is added by ./opengraph-image.tsx either way.
    openGraph: {
      title: meta.title,
      description: meta.description,
      type: 'website',
      siteName: 'seatswap',
      url: meta.canonical,
    },
    twitter: { card: 'summary_large_image', title: meta.title, description: meta.description },
  };
}

export default async function FlightPage({ params, searchParams }: PageProps) {
  const { flight, date } = await params;
  const { login, left } = await searchParams;
  const route = parseRoute(flight, date);
  if (!route) notFound();

  const row = await findFlight(route.carrier, route.flightNumber, route.departure);
  const summary = row ? await flightSummary(row.id) : EMPTY_SUMMARY;
  const view = viewOf(route, row);
  const aircraft = aircraftLabel({
    aircraft_type: view.aircraftType,
    seat_map_key: view.seatMapKey,
  });

  const session = verify((await cookies()).get(COOKIE_NAME)?.value);
  const existing = session && row ? await partyFor(row.id, session.uid) : null;
  const currentSeats = existing ? await seatsFor(existing.id) : [];
  const checkinOpen =
    view.checkinOpensUtc !== null && view.checkinOpensUtc.getTime() <= Date.now();

  const designator = `${view.carrier}${view.flightNumber}`;
  const routeText =
    view.origin && view.destination ? `${view.origin} → ${view.destination}` : null;
  const pageUrl = absoluteUrl(flightPath(view.carrier, view.flightNumber, view.departureDate));

  const jsonLd = flightJsonLd({
    carrier: view.carrier,
    flightNumber: view.flightNumber,
    departureDate: view.departureDate,
    origin: view.origin,
    destination: view.destination,
    aircraftType: view.aircraftType,
    scheduledDepartureUtc: view.scheduledDepartureUtc,
    apiStatus: view.apiStatus,
    url: pageUrl,
  });

  const registration = (
    <RegistrationForm
      carrier={view.carrier}
      flightNumber={view.flightNumber}
      departureDate={view.departureDate}
      designator={designator}
      botUsername={process.env.TELEGRAM_BOT_USERNAME ?? ''}
      returnTo={`/f/${view.carrier}-${view.flightNumber}/${view.departureDate}`}
      session={session}
      existing={existing}
      loginFailed={login === 'failed' && !session}
    />
  );

  return (
    <div className="space-y-8">
      {jsonLd ? (
        <script
          type="application/ld+json"
          // Built from our own columns, never from anything a visitor typed.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      ) : null}

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {designator} · {view.departureDate}
        </h1>
        <p className="text-muted">
          {routeText ? <>{routeText} · </> : null}
          {aircraft.label}
          {aircraft.estimated ? (
            <span title="We could not identify the aircraft, so seat positions are a best guess.">
              {' '}(estimated layout)
            </span>
          ) : null}
        </p>
        {row && view.apiStatus === 'unknown' && !view.lookedUp ? (
          <p className="text-sm text-muted">
            We are still checking this flight with our data provider. You can sign up
            now either way.
          </p>
        ) : null}
        {row && view.apiStatus === 'unknown' && view.lookedUp ? (
          // Checked and got nothing: the API was down, out of quota, or switched
          // off (AERODATABOX_MODE=off). "Still checking" would be a lie by now.
          <p className="text-sm text-muted">
            We could not look this flight up, so its check-in time and seat layout
            are our best estimate. You can still sign up, and swaps still work.
          </p>
        ) : null}
        {view.apiStatus === 'not_found' ? (
          <p className="text-sm text-muted">
            We could not find this flight in our data provider. That is often just a
            gap in their coverage — you can still sign up, and swaps will still work.
          </p>
        ) : null}
      </header>

      {left === '1' && !existing ? (
        <p role="status" className="rounded-lg border border-accent/30 bg-accent/5 p-4 text-sm text-accent">
          You have left this flight. Everything we held about you on it has been
          deleted.
        </p>
      ) : null}

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
              <li>
                {summary.seatsSubmitted} have sent their seat numbers
                {summary.verified > 0 ? `, ${summary.verified} off a boarding pass` : null}
              </li>
            ) : null}
          </ul>
        )}
        <div className="mt-4">
          {/* The primary action only when there is nothing else to do: signed up,
              check-in not open yet. Otherwise signing up or sending seats is. */}
          <ShareButton
            url={pageUrl}
            title={`${designator} on ${view.departureDate} — seat swaps`}
            primary={existing !== null && !checkinOpen}
          />
        </div>
      </section>

      {/* Before check-in, or before signing up, the questions come first. Once
          check-in is open and you are in, the seats are the point, so they move
          above preferences you have already answered. */}
      {existing && checkinOpen ? null : registration}

      {existing ? (
        <SeatForm
          size={existing.size}
          currentSeats={currentSeats}
          checkinOpen={checkinOpen}
          checkinOpensAt={
            view.checkinOpensUtc
              // To the minute when it comes from the real departure time; the day
              // only when it was estimated from the date, because a minute we
              // made up is precision we do not have.
              ? view.scheduledDepartureUtc
                ? view.checkinOpensUtc.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
                : view.checkinOpensUtc.toISOString().slice(0, 10)
              : null
          }
          checkinEstimated={view.scheduledDepartureUtc === null}
          verificationTier={existing.verification_tier}
        />
      ) : null}

      {/* Only once there is a seat to read: before check-in the pass does not
          exist yet, and offering it would be the same mistake as asking for the
          seat in phase one (CLAUDE.md §7). */}
      {existing && checkinOpen ? (
        <BoardingPassForm
          size={existing.size}
          designator={designator}
          verificationTier={existing.verification_tier}
        />
      ) : null}

      {existing && checkinOpen ? registration : null}

      <section className="space-y-2 text-sm text-muted">
        <h2 className="text-base font-medium text-ink">What happens next</h2>
        {checkinOpen ? (
          <p>
            Check-in is open, so seats are being assigned now. Once enough people on
            this flight have sent theirs, we look for a set of swaps that leaves
            everyone involved better off.
          </p>
        ) : (
          <p>
            Your seat does not exist yet — the airline assigns it at check-in,
            {' '}24 to 48 hours before departure. That is why we ask for it later: when
            check-in opens, our bot sends one message asking for your seat number.
          </p>
        )}
        <p>
          You will only ever be shown a swap that improves your own situation. If it
          does not improve, you never hear about it.
        </p>
      </section>
    </div>
  );
}
