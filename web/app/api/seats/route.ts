import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { COOKIE_NAME, verify } from '../../../lib/session.ts';
import { submitSeats } from '../../../lib/seats.ts';

/**
 * Submitting seats from the web instead of the bot.
 *
 * The bot is the main path — it is the one that reaches you at check-in without
 * you having to remember anything (CLAUDE.md §7.5). This exists because somebody
 * who is already on the flight page should not have to go and find a chat window.
 *
 * Seats arriving here are tier 0, taken on trust, and that is the normal case.
 * Seats read off a boarding pass go to /api/verify instead, which carries parsed
 * fields rather than free text and can therefore cross-check them (CLAUDE.md §10).
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = verify((await cookies()).get(COOKIE_NAME)?.value);
  if (!session) {
    return NextResponse.json({ error: 'Please sign in with Telegram first' }, { status: 401 });
  }

  let body: { seats?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400 });
  }

  const text = Array.isArray(body.seats) ? body.seats.join(', ') : String(body.seats ?? '');
  if (!text.trim()) {
    return NextResponse.json({ error: 'Send at least one seat' }, { status: 400 });
  }

  const result = await submitSeats(session.uid, text);
  return NextResponse.json(
    { ok: result.ok, message: result.message, seats: result.seats },
    { status: result.ok ? 200 : 400 },
  );
}
