import Link from 'next/link';
import type { Metadata } from 'next';

import { NavLink, PageShell } from '../components/Chrome.tsx';

export const metadata: Metadata = {
  title: 'Not found',
  robots: { index: false, follow: true },
};

/**
 * Reached by a mistyped flight URL more than anything else, so it says what a
 * good one looks like instead of apologising, and that is the whole page.
 */

const PARTS = [
  { term: 'Carrier', detail: 'The two-character airline code, like W6 or FR.', color: '#0f766e' },
  { term: 'Flight number', detail: 'The digits after it, with no space.', color: '#4c4fa6' },
  { term: 'Departure date', detail: 'Year, month, day, and it has to be in the next year.', color: '#8d4a7c' },
];

/** Each part's colour, lifted in dark mode by .party-text (globals.css). */
const partyStyle = (i: number) => ({ '--party': PARTS[i].color }) as React.CSSProperties;

export default function NotFound() {
  return (
    <PageShell
      width="narrow"
      nav={
        <>
          <NavLink href="/privacy">Privacy</NavLink>
          <NavLink href="/terms">Terms</NavLink>
        </>
      }
    >
      <section className="flex flex-col gap-3 pb-6 pt-12">
        <p className="eyebrow">404 · not a flight we can read</p>
        <h1 className="text-[clamp(30px,5.6vw,42px)] font-semibold leading-[1.04] tracking-[-0.035em]">
          Nothing here
        </h1>
        <p className="max-w-[56ch] text-base text-body">
          That address is not a flight we can read. Here is what a working one looks
          like.
        </p>
      </section>

      <section className="overflow-hidden rounded-card border border-line-strong bg-surface">
        <div className="flex items-center justify-between gap-2.5 border-b border-line px-[18px] py-[13px]">
          <h2 className="text-[14.5px] font-semibold">A flight page address</h2>
          <span className="meta-mono">Three parts</span>
        </div>
        <div className="border-b border-line bg-well px-[18px] py-4">
          <p className="break-all font-mono text-[clamp(15px,3.6vw,19px)] tracking-[0.03em]">
            /f/
            <span className="party-text font-semibold" style={partyStyle(0)}>W6</span>-
            <span className="party-text font-semibold" style={partyStyle(1)}>3234</span>/
            <span className="party-text font-semibold" style={partyStyle(2)}>2026-10-12</span>
          </p>
        </div>
        <dl className="divide-y divide-soft">
          {PARTS.map((part) => (
            <div key={part.term} className="flex items-baseline gap-[11px] px-[18px] py-[13px]">
              <span
                className="mt-[5px] h-[9px] w-[9px] flex-none rounded-sm"
                style={{ background: part.color }}
                aria-hidden="true"
              />
              <div>
                <dt className="meta-mono tracking-[0.09em]">{part.term}</dt>
                <dd className="text-sm">{part.detail}</dd>
              </div>
            </div>
          ))}
        </dl>
        <div className="border-t border-line bg-well px-[18px] py-3.5">
          <Link href="/" className="btn-primary inline-block px-[18px] py-[11px] text-[14.5px]">
            Search for your flight
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
