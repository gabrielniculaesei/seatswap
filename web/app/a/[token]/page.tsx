import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { loadProposalByToken, movesFor } from '../../../lib/proposals.ts';

/**
 * The agreement screen (CLAUDE.md §7.8).
 *
 * This is the product's actual output: a page two or three strangers show each
 * other at the gate, having settled the whole thing before boarding. No account
 * needed to view it — the point is that you can hold up a phone.
 *
 * The token is 128 random bits and is not derived from anything (CLAUDE.md §13.6).
 * The page stops existing when purge_flight runs 24 hours after departure, which
 * is the expiry: there is no separate timer to get wrong.
 */

interface RouteParams {
  params: Promise<{ token: string }>;
}

/** Never let an agreement into a search index. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AgreementPage({ params }: RouteParams) {
  const { token } = await params;
  const proposal = await loadProposalByToken(token);
  if (!proposal || proposal.status !== 'accepted') notFound();

  const moves = await movesFor(proposal.id);
  const byParty = new Map<number, { name: string; moves: typeof moves }>();
  for (const move of moves) {
    const entry = byParty.get(move.party_id) ?? { name: move.display_name, moves: [] };
    entry.moves.push(move);
    byParty.set(move.party_id, entry);
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wide text-accent">Agreed swap</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {proposal.carrier}
          {proposal.flight_number} · {proposal.departure_date}
        </h1>
        <p className="text-muted">
          Everyone below accepted this swap in advance. Show each other this page
          when you board.
        </p>
      </header>

      <section className="divide-y divide-line rounded-lg border border-line">
        {[...byParty.values()].map((party) => (
          <div key={party.name} className="p-5">
            <p className="font-medium">{party.name}</p>
            <ul className="mt-2 space-y-1">
              {party.moves.map((move) => (
                <li key={`${move.from_seat}-${move.to_seat}`} className="text-sm">
                  <span className="text-muted line-through">{move.from_seat}</span>
                  <span className="mx-2 text-muted">→</span>
                  <span className="text-lg font-semibold">{move.to_seat}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="space-y-2 rounded-lg border border-line bg-gray-50 p-5 text-sm text-muted">
        <h2 className="text-base font-medium text-ink">If someone asks</h2>
        <p>
          Nobody is doing anybody a favour here. Every person on this page asked for
          something the others did not want, so all of them end up better off than
          the seats they were given.
        </p>
        <p>
          There is nothing to do on the airline&rsquo;s website, and nothing to pay.
          Just sit in your new seat.
        </p>
      </section>

      <p className="text-sm text-muted">
        This page is deleted 24 hours after the flight departs, along with everything
        else we hold about it.
      </p>
    </div>
  );
}
