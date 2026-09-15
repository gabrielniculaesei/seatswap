import type { Metadata } from 'next';
import Link from 'next/link';

import { siteUrl } from '../lib/seo.ts';
import './globals.css';

const DESCRIPTION =
  'Passengers on the same flight declare the seat they have and the seat they want. '
  + 'A solver finds swaps and chains of swaps where everyone ends up better off. '
  + 'No money, no negotiating.';

export const metadata: Metadata = {
  // Without this, every canonical and og:url below is a relative path, which
  // search engines and link unfurlers both ignore. It is the one piece of
  // metadata that has to know the deployed origin.
  metadataBase: new URL(siteUrl()),
  title: {
    default: 'seatswap — swap into a better seat, for free',
    template: '%s — seatswap',
  },
  description: DESCRIPTION,
  applicationName: 'seatswap',
  openGraph: {
    type: 'website',
    siteName: 'seatswap',
    title: 'seatswap — swap into a better seat, for free',
    description: DESCRIPTION,
  },
  // The image itself comes from app/opengraph-image.tsx (and the per-flight one),
  // which Next attaches to og:image; X falls back to og:image when there is no
  // twitter:image, so the large card has something to show.
  twitter: {
    card: 'summary_large_image',
    title: 'seatswap — swap into a better seat, for free',
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-ink antialiased">
        <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-5">
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line py-5">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              seatswap
            </Link>
            <span className="text-sm text-muted">free seat swaps, same flight</span>
          </header>

          <main className="flex-1 py-8">{children}</main>

          <footer className="space-y-3 border-t border-line py-6 text-sm text-muted">
            <p>
              No payments, no ratings, no phone numbers. Everything about a flight is
              deleted 24 hours after it departs.
            </p>
            <nav aria-label="Legal" className="flex gap-4">
              <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
                Privacy
              </Link>
              <Link href="/terms" className="underline underline-offset-2 hover:text-ink">
                Terms
              </Link>
            </nav>
          </footer>
        </div>
      </body>
    </html>
  );
}
