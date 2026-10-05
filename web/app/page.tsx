import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Card, CardFooter, CardHeader, FactList, NavLink, PageShell, SectionHeading } from '../components/Chrome.tsx';
import SwapChainDemo from '../components/SwapChainDemo.tsx';
import {
  departureDateBounds,
  formatFlightSlug,
  normaliseFlightInput,
  parseDepartureDate,
  parseFlightSlug,
} from '../lib/flight-id.ts';
import { loadSeatMap } from '../lib/seatmap.ts';
import { EXAMPLE_AIRCRAFT, EXAMPLE_ROWS } from '../lib/swap-example.ts';

export const metadata: Metadata = {
  title: { absolute: 'seatswap: swap into a better seat, for free' },
  // The home page is the site root; say so, so `/?error=1&flight=…` reruns of the
  // search form cannot each become their own indexed near-duplicate.
  alternates: { canonical: '/' },
};

/**
 * The home page exists to get someone to a flight page. Everything that matters
 * happens there, and the flight page is the thing that gets shared and indexed
 * (CLAUDE.md §5). Search comes first; the argument for it comes after.
 */
async function search(formData: FormData) {
  'use server';

  const raw = String(formData.get('flight') ?? '');
  const date = String(formData.get('date') ?? '').trim();

  const slug = parseFlightSlug(normaliseFlightInput(raw));
  const departure = parseDepartureDate(date);

  if (!slug || !departure) {
    // Say which one was wrong. The flight number is the likelier culprit, so it
    // wins when both are.
    const error = slug ? 'date' : 'flight';
    redirect(`/?error=${error}&flight=${encodeURIComponent(raw)}&date=${encodeURIComponent(date)}`);
  }
  redirect(`/f/${formatFlightSlug(slug.carrier, slug.flightNumber)}/${departure}`);
}

const ERRORS: Record<string, { field: 'flight' | 'date'; text: string }> = {
  flight: {
    field: 'flight',
    text: 'That does not look like a flight number. It is the two-character airline code and then the number, like W6 3234 or FR 1234.',
  },
  date: {
    field: 'date',
    text: 'Pick a departure date between today and a year from now.',
  },
};

const STEPS = [
  ['01 · Sign up', 'Whenever you book. One tap with Telegram, and that is the whole sign-in.'],
  ['02 · Three questions', 'How many of you are travelling, and what you would like.'],
  ['03 · Send your seat', 'When check-in opens our bot asks. That takes ten seconds.'],
  ['04 · Accept or decline', 'A message with two buttons. Accept, and you both get a page to show at the gate.'],
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; flight?: string; date?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.flight) : null;
  const bounds = departureDateBounds();
  const aircraft = loadSeatMap(EXAMPLE_AIRCRAFT);

  return (
    <PageShell
      nav={
        <>
          <NavLink href="#how">How it works</NavLink>
          <NavLink href="/privacy">Privacy</NavLink>
          {/* Dropped on a phone, where it would push the links off the bar. */}
          <span className="meta-mono hidden rounded-md border border-line px-2 py-1 text-[10.5px] sm:inline">
            Same flight only
          </span>
        </>
      }
    >
      <section className="flex flex-col gap-4 pb-8 pt-12">
        <p className="eyebrow">Free seat swaps · one aircraft at a time</p>
        <h1 className="max-w-[17ch] text-[clamp(33px,5.6vw,46px)] font-semibold leading-[1.02] tracking-[-0.035em]">
          Swap into a better seat. For free.
        </h1>
        <p className="max-w-[60ch] text-[17px] leading-normal text-body">
          Say which seat you have and which one you would rather have. We look at
          everyone else on your flight and find swaps, and chains of swaps, where
          every single person ends up better off.
        </p>
      </section>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-start gap-4">
        <form action={search} className="overflow-hidden rounded-card border border-line bg-white">
          <CardHeader title="Find your flight" meta="Step 01" />
          <div className="flex flex-col gap-3.5 p-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="flight" className="label-mono">Flight number</label>
              <input
                id="flight"
                name="flight"
                required
                maxLength={12}
                placeholder="W6 3234"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                defaultValue={params.flight ?? ''}
                aria-invalid={error?.field === 'flight' || undefined}
                aria-describedby={error?.field === 'flight' ? 'search-error' : undefined}
                className="input-mono"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="date" className="label-mono">Departure date</label>
              <input
                id="date"
                name="date"
                type="date"
                required
                min={bounds.min}
                max={bounds.max}
                defaultValue={params.date ?? ''}
                aria-invalid={error?.field === 'date' || undefined}
                aria-describedby={error?.field === 'date' ? 'search-error' : undefined}
                className="input-mono py-[10px] tracking-normal"
              />
              {error ? (
                <p id="search-error" role="alert" className="text-[13px] text-danger">
                  {error.text}
                </p>
              ) : null}
            </div>

            <button type="submit" className="btn-primary w-full">Find my flight</button>
          </div>
          <CardFooter>
            Every flight gets its own page, and it is just a link. Paste it into
            whatever group chat you are already in.
          </CardFooter>
        </form>

        <Card>
          <CardHeader title="What you are signing up to" />
          <FactList
            facts={[
              { term: 'Cost', detail: 'Nothing, and there is nothing to install.' },
              { term: 'Negotiating', detail: 'None. You only ever see a trade you already said you would want.' },
              { term: 'Kept until', detail: '24 hours after your flight departs, then deleted.' },
              { term: 'Works when', detail: 'About twenty people on your aircraft have joined.' },
            ]}
          />
        </Card>
      </section>

      <section className="mt-10 flex flex-col gap-3.5">
        <SectionHeading
          eyebrow="Worked example"
          title="One chain, four parties, everyone better off"
          meta={`${aircraft.label} · rows ${EXAMPLE_ROWS[0]}–${EXAMPLE_ROWS.at(-1)} of ${aircraft.rows}`}
        />
        <SwapChainDemo />
      </section>

      <section id="how" className="mt-10 flex scroll-mt-4 flex-col gap-3.5">
        <SectionHeading eyebrow="Process" title="How it works" />
        <ol className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
          {STEPS.map(([label, text]) => (
            <li key={label} className="flex flex-col gap-2 rounded-card border border-line bg-white px-[15px] py-3.5">
              <span className="font-mono text-[10.5px] font-semibold tracking-[0.07em] text-accent">{label}</span>
              <span className="text-[13.5px] leading-normal text-body">{text}</span>
            </li>
          ))}
        </ol>
      </section>
    </PageShell>
  );
}
