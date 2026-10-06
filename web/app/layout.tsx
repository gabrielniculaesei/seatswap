import type { Metadata } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';

import { siteUrl } from '../lib/seo.ts';
import './globals.css';

// Downloaded at build time and served from our own origin, so a visitor's
// browser never talks to Google.
const sans = Archivo({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

const TITLE = 'seatswap: swap into a better seat, for free';
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
    default: TITLE,
    template: '%s · seatswap',
  },
  description: DESCRIPTION,
  applicationName: 'seatswap',
  openGraph: {
    type: 'website',
    siteName: 'seatswap',
    title: TITLE,
    description: DESCRIPTION,
  },
  // The image itself comes from app/opengraph-image.tsx (and the per-flight one),
  // which Next attaches to og:image; X falls back to og:image when there is no
  // twitter:image, so the large card has something to show.
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
  // Google Search Console ownership check. Read at build time, so setting it
  // needs a redeploy; unset, no tag is emitted.
  verification: process.env.GOOGLE_SITE_VERIFICATION
    ? { google: process.env.GOOGLE_SITE_VERIFICATION }
    : undefined,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col bg-page font-sans text-[15px] leading-[1.55] text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
