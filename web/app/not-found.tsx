import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Not found',
  robots: { index: false, follow: true },
};

/**
 * Reached by a mistyped flight URL more than anything else, so it says what a
 * good one looks like instead of apologising.
 */
export default function NotFound() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Nothing here</h1>
      <p className="text-muted">
        That is not a flight we can read. A flight page looks like{' '}
        <code className="rounded bg-gray-100 px-1">/f/W6-3234/2026-10-12</code> — the
        carrier and number, then the departure date, which has to be in the next year.
      </p>
      <p>
        <Link href="/" className="text-accent underline underline-offset-2">
          Search for your flight
        </Link>
      </p>
    </div>
  );
}
