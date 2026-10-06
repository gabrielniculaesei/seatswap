import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Card, CardFooter, CardHeader, PageShell } from '../../../components/Chrome.tsx';
import VerificationBadge from '../../../components/VerificationBadge.tsx';
import { aircraftLabel } from '../../../lib/flights.ts';
import { formatDay } from '../../../lib/format.ts';
import { loadProposalByToken, movesFor } from '../../../lib/proposals.ts';

/**
 * The agreement screen.
 *
 * This is the product's actual output: a page two or three strangers show each
 * other at the gate, having settled the whole thing before boarding. No account
 * needed to view it; the point is that you can hold up a phone. It is narrower
 * than the other pages for the same reason, and the new seat is the biggest thing
 * on it, because that is the one thing anybody needs to read.
 *
 * The token is 128 random bits and is not derived from anything.
 * The page stops existing when purge_flight runs 24 hours after departure, which
 * is the expiry: there is no separate timer to get wrong.
 */

interface RouteParams {
  params: Promise<{ token: string }>;
}

/** Never let an agreement into a search index. */
export const metadata: Metadata = {
  // Generic on purpose: the title travels into browser history and link
  // previews, and names or seats have no business there.
  title: 'Agreed swap',
  robots: { index: false, follow: false },
};

// The header strip and every row share one track definition, or the labels stop
// lining up with their columns once the grid wraps on a phone.
const TRACKS = 'grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-x-3.5 gap-y-2';

export default async function AgreementPage({ params }: RouteParams) {
  const { token } = await params;
  const proposal = await loadProposalByToken(token);
  if (!proposal || proposal.status !== 'accepted') notFound();

  const moves = await movesFor(proposal.id);
  const byParty = new Map<number, { name: string; tier: number; moves: typeof moves }>();
  for (const move of moves) {
    const entry = byParty.get(move.party_id)
      ?? { name: move.display_name, tier: move.verification_tier, moves: [] };
    entry.moves.push(move);
    byParty.set(move.party_id, entry);
  }
  const parties = [...byParty.entries()];

  const aircraft = aircraftLabel(proposal);
  const details = [
    formatDay(proposal.departure_date),
    proposal.origin && proposal.destination ? `${proposal.origin} → ${proposal.destination}` : null,
    aircraft.estimated ? null : aircraft.label,
  ].filter(Boolean);

  return (
    <PageShell
      width="narrow"
      homeLink={false}
      tagline={false}
      nav={<span className="meta-mono text-[10.5px]">No login needed</span>}
    >
      <section className="flex flex-col gap-3 pb-[22px] pt-8">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-[7px] rounded-md bg-accent px-[11px] py-[5px] font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-white">
            <span className="h-[5px] w-[5px] rounded-full bg-white" aria-hidden="true" />
            Agreed
          </span>
          <span className="meta-mono text-[10.5px]">
            {parties.length} parties · {moves.length} seats
          </span>
        </div>
        <h1 className="font-mono text-[clamp(27px,6.4vw,36px)] font-semibold leading-[1.1] tracking-[0.02em]">
          {proposal.carrier} {proposal.flight_number}
        </h1>
        <p className="font-mono text-[13px] uppercase tracking-[0.05em] text-body">{details.join(' · ')}</p>
        <p className="max-w-[52ch] text-body">
          Everyone below accepted this swap before boarding. Show each other the page
          and sit down.
        </p>
      </section>

      <section
        role="table"
        aria-label="Who moves where"
        className="overflow-hidden rounded-card border border-line-strong bg-white shadow-raised"
      >
        <div role="row" className={`${TRACKS} border-b border-line bg-well px-[18px] py-2.5`}>
          <span role="columnheader" className="label-mono font-normal">Who</span>
          <span role="columnheader" className="label-mono font-normal">Was</span>
          <span role="columnheader" className="label-mono font-normal">Now sits in</span>
        </div>
        {parties.map(([id, party]) => (
          <div
            key={id}
            role="row"
            className={`${TRACKS} items-center border-b border-soft px-[18px] py-4 last:border-b-0`}
          >
            <div role="cell" className="flex flex-col items-start gap-[5px]">
              <span className="text-base font-semibold">{party.name}</span>
              <VerificationBadge tier={party.tier} variant="compact" />
            </div>
            <div role="cell" className="flex flex-col gap-0.5 font-mono text-[13px] text-body">
              {party.moves.map((move) => (
                <span key={move.from_seat} className="line-through">{move.from_seat}</span>
              ))}
            </div>
            <div role="cell" className="flex flex-col gap-0.5 font-mono text-[28px] font-semibold leading-[1.15] tracking-[0.02em]">
              {party.moves.map((move) => (
                <span key={move.from_seat}>{move.to_seat}</span>
              ))}
            </div>
          </div>
        ))}
      </section>

      <Card className="mt-4">
        <CardHeader title="If someone asks" />
        <div className="flex flex-col gap-[9px] px-4 py-[15px] text-sm text-body">
          <p>
            Everyone on this page asked for something the others did not want, so
            all of them end up better off than the seats they were given. It was
            settled before anyone boarded.
          </p>
          <p>
            There is nothing to do on the airline&rsquo;s website and nothing to pay.
            Just sit in the new seat.
          </p>
        </div>
        <CardFooter>
          This page is deleted 24 hours after the flight departs, along with
          everything else we hold about it.
        </CardFooter>
      </Card>
    </PageShell>
  );
}
