/**
 * Responding to a proposal, and settling one when everybody agrees (CLAUDE.md §7.8).
 *
 * A proposal is atomic: it happens when every party in the cycle accepts, and not
 * before. One decline ends it for everyone, which sounds harsh but is the only
 * coherent rule — a cycle with a hole in it would leave somebody in a seat that
 * no longer exists in their own proposal.
 *
 * Nothing here is enforceable and that is fine. If a swap falls apart nobody is
 * worse off than they started, because the airline's own allocation is untouched
 * until people physically sit down (CLAUDE.md §2.3, §2.5).
 */

import type postgres from 'postgres';

import sql from './db.ts';

export type Response = 'accept' | 'reject';

export interface ProposalView {
  id: number;
  flight_id: number;
  status: string;
  total_gain: number;
  expires_at: Date;
  agreement_token: string | null;
  carrier: string;
  flight_number: string;
  departure_date: string;
}

export interface Move {
  party_id: number;
  display_name: string;
  from_seat: string;
  to_seat: string;
}

export interface RespondResult {
  ok: boolean;
  /** Text to send straight back to the person who pressed the button. */
  message: string;
  settled: boolean;
  agreementToken?: string;
  /** Everyone in the cycle, for notifying them. */
  parties?: { party_id: number; telegram_user_id: number; display_name: string }[];
}

export async function loadProposal(proposalId: number): Promise<ProposalView | null> {
  const rows = await sql<ProposalView[]>`
    SELECT pr.id, pr.flight_id, pr.status, pr.total_gain, pr.expires_at, pr.agreement_token,
           f.carrier, f.flight_number, f.departure_date
      FROM proposals pr
      JOIN flights f ON f.id = pr.flight_id
     WHERE pr.id = ${proposalId}
  `;
  return rows[0] ?? null;
}

export async function loadProposalByToken(token: string): Promise<ProposalView | null> {
  // Length-checked before it reaches the database so a probe cannot make us scan.
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const rows = await sql<ProposalView[]>`
    SELECT pr.id, pr.flight_id, pr.status, pr.total_gain, pr.expires_at, pr.agreement_token,
           f.carrier, f.flight_number, f.departure_date
      FROM proposals pr
      JOIN flights f ON f.id = pr.flight_id
     WHERE pr.agreement_token = ${token}
  `;
  return rows[0] ?? null;
}

export async function movesFor(proposalId: number): Promise<Move[]> {
  return sql<Move[]>`
    SELECT p.id AS party_id, p.display_name, pa.from_seat, pa.to_seat
      FROM proposal_assignments pa
      JOIN members m ON m.id = pa.member_id
      JOIN parties p ON p.id = m.party_id
     WHERE pa.proposal_id = ${proposalId}
     ORDER BY p.id, pa.from_seat
  `;
}

/**
 * Record one party's answer.
 *
 * The caller is identified by their Telegram id, and we look up whether that id
 * is actually in this proposal — a button press carries whatever callback data
 * the sender likes, so the id in the payload is never trusted.
 */
export async function respond(
  proposalId: number,
  telegramUserId: number,
  answer: Response,
): Promise<RespondResult> {
  return sql.begin(async (tx) => {
    const proposals = await tx<ProposalView[]>`
      SELECT pr.id, pr.flight_id, pr.status, pr.total_gain, pr.expires_at, pr.agreement_token,
             f.carrier, f.flight_number, f.departure_date
        FROM proposals pr
        JOIN flights f ON f.id = pr.flight_id
       WHERE pr.id = ${proposalId}
       FOR UPDATE OF pr
    `;
    const proposal = proposals[0];
    if (!proposal) return { ok: false, message: 'That swap no longer exists.', settled: false };

    const membership = await tx<{ party_id: number; response: string | null }[]>`
      SELECT pp.party_id, pp.response
        FROM proposal_parties pp
        JOIN parties p ON p.id = pp.party_id
       WHERE pp.proposal_id = ${proposalId} AND p.telegram_user_id = ${telegramUserId}
    `;
    if (membership.length === 0) {
      return { ok: false, message: 'That swap is not yours to answer.', settled: false };
    }

    if (proposal.status !== 'pending') {
      return {
        ok: false,
        settled: false,
        message:
          proposal.status === 'accepted'
            ? 'This swap is already agreed.'
            : 'This swap is no longer on the table. I will keep looking.',
      };
    }
    if (proposal.expires_at.getTime() < Date.now()) {
      return {
        ok: false,
        settled: false,
        message: 'That swap expired before everyone answered. I will keep looking.',
      };
    }

    const partyId = membership[0].party_id;
    await tx`
      UPDATE proposal_parties
         SET response = ${answer}, responded_at = now()
       WHERE proposal_id = ${proposalId} AND party_id = ${partyId}
    `;

    const everyone = await tx<
      { party_id: number; telegram_user_id: number; display_name: string; response: string | null }[]
    >`
      SELECT pp.party_id, pp.response, p.telegram_user_id, p.display_name
        FROM proposal_parties pp
        JOIN parties p ON p.id = pp.party_id
       WHERE pp.proposal_id = ${proposalId}
       ORDER BY pp.party_id
    `;

    if (answer === 'reject') {
      await tx`UPDATE proposals SET status = 'rejected' WHERE id = ${proposalId}`;
      await releaseParties(tx, proposalId);
      await queueMatchRun(tx, proposal.flight_id);
      return {
        ok: true,
        settled: false,
        message: 'No problem — you keep the seat you have. I will keep looking.',
        parties: everyone.map(({ party_id, telegram_user_id, display_name }) => ({
          party_id, telegram_user_id, display_name,
        })),
      };
    }

    const outstanding = everyone.filter((p) => p.response !== 'accept').length;
    if (outstanding > 0) {
      return {
        ok: true,
        settled: false,
        message:
          `Accepted. Waiting for ${outstanding} other ${outstanding === 1 ? 'person' : 'people'} `
          + 'to confirm — I will let you know.',
        parties: everyone.map(({ party_id, telegram_user_id, display_name }) => ({
          party_id, telegram_user_id, display_name,
        })),
      };
    }

    // Everybody said yes.
    await tx`UPDATE proposals SET status = 'accepted' WHERE id = ${proposalId}`;
    await tx`
      UPDATE parties SET state = 'settled'
       WHERE id IN (SELECT party_id FROM proposal_parties WHERE proposal_id = ${proposalId})
    `;
    // Any other live proposal touching these parties is now moot: their seats are
    // spoken for.
    await tx`
      UPDATE proposals SET status = 'superseded'
       WHERE status = 'pending'
         AND id <> ${proposalId}
         AND id IN (
               SELECT proposal_id FROM proposal_parties
                WHERE party_id IN (
                      SELECT party_id FROM proposal_parties WHERE proposal_id = ${proposalId}
                )
             )
    `;

    return {
      ok: true,
      settled: true,
      agreementToken: proposal.agreement_token ?? undefined,
      message: 'Everyone accepted.',
      parties: everyone.map(({ party_id, telegram_user_id, display_name }) => ({
        party_id, telegram_user_id, display_name,
      })),
    };
  }) as Promise<RespondResult>;
}

/**
 * A party pulling out of a swap they had already accepted (CLAUDE.md §19.2).
 *
 * The cycle cannot go ahead without them, so it ends for everyone and a fresh
 * match run looks for something else. Nobody is left worse off than they started:
 * without an agreement, everyone simply keeps the seat the airline gave them.
 */
export async function withdraw(
  proposalId: number,
  telegramUserId: number,
): Promise<RespondResult> {
  return respond(proposalId, telegramUserId, 'reject');
}

async function releaseParties(
  tx: postgres.TransactionSql,
  proposalId: number,
): Promise<void> {
  await tx`
    UPDATE parties
       SET state = 'seated'
     WHERE state = 'matched'
       AND id IN (SELECT party_id FROM proposal_parties WHERE proposal_id = ${proposalId})
       AND NOT EXISTS (
             SELECT 1
               FROM proposal_parties pp
               JOIN proposals pr ON pr.id = pp.proposal_id
              WHERE pp.party_id = parties.id AND pr.status = 'pending'
           )
  `;
}

async function queueMatchRun(
  tx: postgres.TransactionSql,
  flightId: number,
): Promise<void> {
  await tx`
    INSERT INTO jobs (type, payload, run_after)
    VALUES ('match_run', ${tx.json({ flight_id: flightId, trigger: 'scheduled' })}, now())
    ON CONFLICT DO NOTHING
  `;
}
