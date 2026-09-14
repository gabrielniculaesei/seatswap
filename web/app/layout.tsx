import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'seatswap — swap into a better seat, for free',
    template: '%s — seatswap',
  },
  description:
    'Passengers on the same flight declare the seat they have and the seat they want. '
    + 'A solver finds swaps and chains of swaps where everyone ends up better off. No money, no negotiating.',
  openGraph: {
    type: 'website',
    siteName: 'seatswap',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-ink antialiased">
        <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-5">
          <header className="flex items-baseline justify-between border-b border-line py-5">
            <a href="/" className="text-lg font-semibold tracking-tight">
              seatswap
            </a>
            <span className="text-sm text-muted">free seat swaps, same flight</span>
          </header>

          <main className="flex-1 py-8">{children}</main>

          <footer className="border-t border-line py-6 text-sm text-muted">
            <p>
              No payments, no ratings, no phone numbers. Everything about a flight is
              deleted 24 hours after it departs.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
