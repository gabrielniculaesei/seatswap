import { redirect } from 'next/navigation';

import {
  formatFlightSlug,
  normaliseFlightInput,
  parseDepartureDate,
  parseFlightSlug,
} from '../lib/flight-id.ts';

export const metadata = {
  title: 'seatswap — swap into a better seat, for free',
};

/**
 * The home page exists to get someone to a flight page. Everything that matters
 * happens there, and the flight page is the thing that gets shared and indexed
 * (CLAUDE.md §5).
 */
async function search(formData: FormData) {
  'use server';

  const raw = String(formData.get('flight') ?? '');
  const date = String(formData.get('date') ?? '').trim();

  const slug = parseFlightSlug(normaliseFlightInput(raw));
  const departure = parseDepartureDate(date);

  if (!slug || !departure) {
    redirect(`/?error=1&flight=${encodeURIComponent(raw)}&date=${encodeURIComponent(date)}`);
  }
  redirect(`/f/${formatFlightSlug(slug.carrier, slug.flightNumber)}/${departure}`);
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; flight?: string; date?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          Swap into a better seat. For free.
        </h1>
        <p className="text-muted">
          Tell us which seat you have and which one you would rather have. We look at
          everyone else on your flight and find swaps — and chains of swaps — where
          every single person ends up better off.
        </p>
        <p className="text-muted">
          Nobody asks anyone for a favour. The system only ever proposes a trade you
          have already said you would want.
        </p>
      </section>

      <section>
        <form action={search} className="space-y-4 rounded-lg border border-line p-5">
          <div className="space-y-1">
            <label htmlFor="flight" className="block text-sm font-medium">
              Flight number
            </label>
            <input
              id="flight"
              name="flight"
              required
              placeholder="W6 3234"
              defaultValue={params.flight ?? ''}
              className="w-full rounded border border-line px-3 py-2 outline-none focus:border-accent"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="date" className="block text-sm font-medium">
              Departure date
            </label>
            <input
              id="date"
              name="date"
              type="date"
              required
              defaultValue={params.date ?? ''}
              className="w-full rounded border border-line px-3 py-2 outline-none focus:border-accent"
            />
          </div>

          {params.error ? (
            <p className="text-sm text-red-600">
              That does not look like a flight number and a date in the next year.
              Try something like <code>W6 3234</code> and a date.
            </p>
          ) : null}

          <button
            type="submit"
            className="w-full rounded bg-accent px-4 py-2 font-medium text-white hover:opacity-90"
          >
            Find my flight
          </button>
        </form>
      </section>

      <section className="space-y-3 text-sm text-muted">
        <h2 className="text-base font-medium text-ink">How it works</h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Sign up for your flight whenever you book. One click with Telegram — no
            password, no email, no phone number.
          </li>
          <li>
            Say how many of you are travelling and what you would like. That is three
            questions.
          </li>
          <li>
            When check-in opens, our bot asks for your seat. That takes ten seconds.
          </li>
          <li>
            If there is a swap where everyone gains, you get it as a message with two
            buttons. Accept, and you both get a page to show each other at the gate.
          </li>
        </ol>
      </section>
    </div>
  );
}
