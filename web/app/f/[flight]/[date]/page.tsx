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
import { Card, CardFooter, CardHeader, FactList, NavLink, PageShell, SectionHeading } from '../../../../components/Chrome.tsx';
import ShareButton from '../../../../components/ShareButton.tsx';
import { formatDay, formatUtcDay, formatUtcMinute } from '../../../../lib/format.ts';
import { loadSeatMap } from '../../../../lib/seatmap.ts';
import { absoluteUrl, flightJsonLd, flightMeta, flightPath } from '../../../../lib/seo.ts';
import BoardingPassForm from './BoardingPassForm.tsx';
import RegistrationForm from './RegistrationForm.tsx';
import SeatForm from './SeatForm.tsx';

/**
 * The flight page. Server-rendered on purpose: it is the only
 * acquisition channel with the right granularity, because somebody searching for
 * their own flight number is exactly the person this is for. That means real
 * metadata and real content in the HTML, not a client-side fetch.
 *
 * It reads and never writes. Any carrier, number and date in range renders, so
 * this page is reachable at tens of millions of addresses; creating a row for
 * each one visited would hand a crawler an unbounded way to spend our
 * AeroDataBox quota. The row appears when somebody signs up.
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

/**
 * Roughly where swaps start working: about 10 % of one cabin, per the
 * simulator's results in docs/liquidity.md.
 */
const LIQUIDITY_TRAVELLERS = 20;

const ACROSS = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

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
  const seatMap = loadSeatMap(view.seatMapKey);

  const session = verify((await cookies()).get(COOKIE_NAME)?.value);
  const existing = session && row ? await partyFor(row.id, session.uid) : null;
  const currentSeats = existing ? await seatsFor(existing.id) : [];
  const checkinOpen =
    view.checkinOpensUtc !== null && view.checkinOpensUtc.getTime() <= Date.now();
  // We never learned the departure time, so every time below it is our estimate.
  const estimated = view.scheduledDepartureUtc === null;

  const designator = `${view.carrier} ${view.flightNumber}`;
  const hasRoute = view.origin !== null && view.destination !== null;
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

  const phase = checkinOpen
    ? { label: 'Check-in open', className: 'border-accent bg-accent text-white' }
    : existing
      ? { label: 'Signed up', className: 'border-accent/30 bg-accent/[.08] text-accent' }
      : summary.parties === 0
        ? { label: 'Nobody signed up', className: 'border-line-strong bg-track text-body' }
        : { label: 'Open to join', className: 'border-line-strong bg-track text-body' };

  // Only facts the row actually has: a line that says "unknown" tells nobody
  // anything, the same reasoning as flightJsonLd.
  const facts: { term: string; detail: React.ReactNode }[] = [];
  if (hasRoute) facts.push({ term: 'Route', detail: `${view.origin} to ${view.destination}` });
  if (!aircraft.estimated) {
    facts.push({
      term: 'Aircraft',
      detail: `${aircraft.label} · ${seatMap.rows} rows, ${ACROSS[seatMap.columns.length] ?? seatMap.columns.length} across`,
    });
  }
  if (view.checkinOpensUtc) {
    // To the minute when it comes from the real departure time; the day only
    // when it was estimated from the date, because a minute we made up is
    // precision we do not have.
    const when = estimated
      ? `${formatUtcDay(view.checkinOpensUtc)}, estimated`
      : formatUtcMinute(view.checkinOpensUtc);
    facts.push({ term: 'Check-in opens', detail: checkinOpen ? `Open now, since ${when}` : when });
  }
  facts.push({
    term: 'Deleted',
    detail: view.scheduledDepartureUtc
      ? `${formatUtcDay(new Date(view.scheduledDepartureUtc.getTime() + 24 * 3600_000))}, 24 hours after departure`
      : '24 hours after departure',
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
    <PageShell
      nav={
        <>
          <NavLink href="/">Another flight</NavLink>
          <NavLink href="/privacy">Privacy</NavLink>
        </>
      }
    >
      {jsonLd ? (
        <script
          type="application/ld+json"
          // Built from our own columns, never from anything a visitor typed.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      ) : null}

      <section className="flex flex-col gap-3 pb-6 pt-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-[5px]">
            <p className="eyebrow">Flight page · shareable link</p>
            <h1 className="font-mono text-[clamp(26px,5.4vw,34px)] font-semibold leading-[1.1] tracking-[0.02em]">
              {designator}
            </h1>
            <p className="font-mono text-[12.5px] uppercase tracking-[0.05em] text-body">
              {formatDay(view.departureDate)}
              {hasRoute ? <> · {view.origin} → {view.destination}</> : null}
              {' · '}
              {aircraft.label}
              {aircraft.estimated ? (
                <span title="We could not identify the aircraft, so seat positions are a best guess.">
                  {' '}(estimated layout)
                </span>
              ) : null}
            </p>
          </div>
          <p className={`meta-mono rounded-md border px-2.5 py-[5px] text-[10.5px] ${phase.className}`}>
            {phase.label}
          </p>
        </div>

        {row && view.apiStatus === 'unknown' && !view.lookedUp ? (
          <p className="max-w-[70ch] text-[13px] text-body">
            We are still checking this flight with our data provider. You can sign up
            now either way.
          </p>
        ) : null}
        {row && view.apiStatus === 'unknown' && view.lookedUp ? (
          // Checked and got nothing: the API was down, out of quota, or switched
          // off (AERODATABOX_MODE=off). "Still checking" would be a lie by now.
          <p className="max-w-[70ch] text-[13px] text-body">
            We could not look this flight up, so its check-in time and seat layout
            are our best estimate. You can still sign up, and swaps still work.
          </p>
        ) : null}
        {view.apiStatus === 'not_found' ? (
          <p className="max-w-[70ch] text-[13px] text-body">
            We could not find this flight in our data provider. That is often just a
            gap in their coverage, and you can still sign up. Swaps will still work.
          </p>
        ) : null}
      </section>

      {left === '1' && !existing ? (
        <p role="status" className="mb-4 rounded-card border border-accent/30 bg-accent/[.06] px-4 py-3 text-sm text-accent">
          You have left this flight. Everything we held about you on it has been
          deleted.
        </p>
      ) : null}

      <section className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-4">
        {/* Aggregate only: no names, no seats. This is what a stranger may see. */}
        <Card>
          <CardHeader title="Who is here so far" meta="Totals only" />
          {summary.parties === 0 ? (
            <p className="p-4 text-sm text-body">
              Nobody yet. Be first, then send this page to anyone else on your flight.
              Swaps need a handful of people on the same aircraft before they start
              working.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-[repeat(auto-fit,minmax(88px,1fr))] [&>div+div]:border-l [&>div+div]:border-soft">
                <Stat value={summary.parties} label={summary.parties === 1 ? 'group' : 'groups'} />
                <Stat value={summary.travellers} label={summary.travellers === 1 ? 'traveller' : 'travellers'} />
                {/* Never a "0": an empty stat reads as a flight going nowhere. */}
                {summary.seatsSubmitted > 0 ? <Stat value={summary.seatsSubmitted} label="sent seats" /> : null}
              </dl>
              <div className="flex flex-col gap-2 border-t border-soft px-4 py-3.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-seat-empty" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.min(100, (summary.travellers / LIQUIDITY_TRAVELLERS) * 100)}%` }}
                  />
                </div>
                <p className="text-[13px] text-body">
                  {summary.travellers < LIQUIDITY_TRAVELLERS
                    ? `${summary.travellers} of about ${LIQUIDITY_TRAVELLERS} travellers, which is roughly where swaps start working on a cabin this size.`
                    : `${summary.travellers} travellers, past the ${LIQUIDITY_TRAVELLERS} or so where swaps start working on a cabin this size.`}
                </p>
                {summary.wantAdjacency + summary.wantWindow + summary.wantAisle > 0 ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {summary.wantAdjacency > 0 ? <Chip>{summary.wantAdjacency} together</Chip> : null}
                    {summary.wantWindow > 0 ? <Chip>{summary.wantWindow} window</Chip> : null}
                    {summary.wantAisle > 0 ? <Chip>{summary.wantAisle} aisle</Chip> : null}
                  </ul>
                ) : null}
              </div>
            </>
          )}
          <CardFooter className="flex flex-col gap-2 py-[13px]">
            {/* The primary action only when there is nothing else to do: signed up,
                check-in not open yet. Otherwise signing up or sending seats is. */}
            <ShareButton
              url={pageUrl}
              title={`${designator} on ${formatDay(view.departureDate)}: seat swaps`}
              primary={existing !== null && !checkinOpen}
            />
            <p>No names and no seats, ever, to anyone looking at this page.</p>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader title="This flight" />
          <FactList facts={facts} />
        </Card>
      </section>

      {/* Before check-in, or before signing up, the questions come first. Once
          check-in is open and you are in, the seats are the point, so they move
          above preferences you have already answered. Before check-in there is no
          seat to send or pass to scan, so neither form shows. */}
      {existing && checkinOpen ? (
        <section className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(290px,1fr))] items-start gap-4">
          <SeatForm
            size={existing.size}
            currentSeats={currentSeats}
            checkinEstimated={estimated}
            verificationTier={existing.verification_tier}
          />
          <BoardingPassForm size={existing.size} designator={designator} />
        </section>
      ) : null}

      <div className="mt-4">{registration}</div>

      <section className="mt-9 flex flex-col gap-3">
        <SectionHeading eyebrow="Next" title="What happens next" />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(270px,1fr))] gap-3 text-sm text-body">
          {checkinOpen ? (
            <p>
              Check-in is open, so seats are being assigned now. Once enough people on
              this flight have sent theirs, we look for a set of swaps that leaves
              everyone involved better off.
            </p>
          ) : (
            <p>
              Your seat does not exist yet. The airline assigns it at check-in, 24 to
              48 hours before departure, and that is when our bot sends one message
              asking for your seat number.
            </p>
          )}
          <p>
            You only ever get shown a swap that improves your own situation. If it
            does not improve, you never hear about it.
          </p>
        </div>
      </section>
    </PageShell>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col-reverse gap-0.5 px-4 py-3.5">
      <dt className="meta-mono tracking-[0.08em]">{label}</dt>
      <dd className="font-mono text-[26px] font-semibold leading-[1.1]">{value}</dd>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <li className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-body">{children}</li>
  );
}
