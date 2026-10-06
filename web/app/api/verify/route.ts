import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { COOKIE_NAME, verify } from '../../../lib/session.ts';
import { sanitisePasses, submitBoardingPasses } from '../../../lib/verification.ts';

/**
 * Seats read off a boarding pass (tier 1).
 *
 * The body is the small set of fields the browser pulled out of the barcode — no
 * passenger name, no PNR, and never the raw payload, which does not leave the
 * page. That is also why this is a separate route from
 * /api/seats rather than a flag on it: the two carry different things, and a
 * route that accepted either would sooner or later be sent the whole barcode.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = verify((await cookies()).get(COOKIE_NAME)?.value);
  if (!session) {
    return NextResponse.json({ error: 'Please sign in with Telegram first' }, { status: 401 });
  }

  let body: { passes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400 });
  }

  const passes = sanitisePasses(body.passes);
  if (!passes) {
    return NextResponse.json(
      { error: 'We could not read that boarding pass. You can send your seat numbers instead.' },
      { status: 400 },
    );
  }

  const result = await submitBoardingPasses(session.uid, passes);
  return NextResponse.json(
    { ok: result.ok, message: result.message, seats: result.seats, tier: result.tier },
    { status: result.ok ? 200 : 400 },
  );
}
