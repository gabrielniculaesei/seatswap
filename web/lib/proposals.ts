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
  /** 0 declared, 1 read off a boarding pass (CLAUDE.md §10). */
  verification_tier: number;
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
    SELECT p.id AS party_id, p.display_name, p.verification_tier,
           pa.from_seat, pa.to_seat
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

export interface LeaveResult {
  /** False when there was nothing to leave: no such party on this flight. */
  left: boolean;
  /** Everyone whose swap fell through because of it, to be told so. */
  affected: { telegram_user_id: number; agreed: boolean }[];
}

/**
 * Leave a flight: delete the party and everything hanging off it, now rather
 * than at purge time (CLAUDE.md §13; GDPR Art. 17).
 *
 * Not a bare DELETE, because a party can be inside a live swap. Deleting it would
 * cascade its proposal_parties rows away and leave the others holding a cycle
 * with a hole in it. So every pending or agreed proposal it is in ends first, for
 * everyone, exactly as §19.2 decided for withdrawing after acceptance: status
 * `rejected`, the other parties back to `seated`, and a fresh match run to look
 * for something else. Nobody ends up worse off than they started — without an
 * agreement, everybody keeps the seat the airline gave them.
 *
 * This is also the only path that can end an *agreed* swap: respond() refuses
 * anything no longer pending, which is right for a button in a chat but would
 * leave a departed party's agreement page telling strangers to expect them.
 */
export async function leaveFlight(
  flightId: number,
  telegramUserId: number,
): Promise<LeaveResult> {
  return sql.begin(async (tx) => {
    const parties = await tx<{ id: number }[]>`
      SELECT id FROM parties
       WHERE flight_id = ${flightId} AND telegram_user_id = ${telegramUserId}
       FOR UPDATE
    `;
    const party = parties[0];
    if (!party) return { left: false, affected: [] };

    const live = await tx<{ id: number; status: string }[]>`
      SELECT pr.id, pr.status
        FROM proposals pr
        JOIN proposal_parties pp ON pp.proposal_id = pr.id
       WHERE pp.party_id = ${party.id}
         AND pr.status IN ('pending', 'accepted')
       ORDER BY pr.id
         FOR UPDATE OF pr
    `;

    const affected = new Map<number, { telegram_user_id: number; agreed: boolean }>();
    for (const proposal of live) {
      await tx`UPDATE proposals SET status = 'rejected' WHERE id = ${proposal.id}`;

      const others = await tx<{ id: number; telegram_user_id: number }[]>`
        SELECT p.id, p.telegram_user_id
          FROM proposal_parties pp
          JOIN parties p ON p.id = pp.party_id
         WHERE pp.proposal_id = ${proposal.id} AND p.id <> ${party.id}
      `;
      for (const other of others) {
        const agreed = proposal.status === 'accepted' || (affected.get(other.id)?.agreed ?? false);
        affected.set(other.id, { telegram_user_id: other.telegram_user_id, agreed });
      }
    }

    if (affected.size > 0) {
      // Back into the pool, unless something else still holds them. `settled` as
      // well as `matched`: an agreed swap that has just ended leaves nobody settled.
      await tx`
        UPDATE parties SET state = 'seated'
         WHERE id IN ${tx([...affected.keys()])}
           AND state IN ('matched', 'settled')
           AND NOT EXISTS (
                 SELECT 1
                   FROM proposal_parties pp
                   JOIN proposals pr ON pr.id = pp.proposal_id
                  WHERE pp.party_id = parties.id
                    AND pr.status IN ('pending', 'accepted')
               )
      `;
      await queueMatchRun(tx, flightId);
    }

    // Cascades to members, proposal_parties and proposal_assignments. The ended
    // proposals themselves stay, rejected and without this party in them, until
    // purge_flight; they hold no personal data of the party that left.
    await tx`DELETE FROM parties WHERE id = ${party.id}`;

    return { left: true, affected: [...affected.values()] };
  }) as Promise<LeaveResult>;
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
