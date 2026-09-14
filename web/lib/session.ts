/**
 * Sessions: a signed, httpOnly cookie. Nothing else (CLAUDE.md §12).
 *
 * There is no users table and no server-side session store, because there is
 * nothing to keep: a session is a Telegram user id and a suggested display name.
 * Everything else about a person lives on a `parties` row attached to one flight,
 * and is deleted 24 hours after that flight leaves.
 *
 * The cookie is signed, not encrypted. Its contents are not secret — the id is
 * yours and the name is the one you picked — but it must not be forgeable.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'seatswap_session';
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export interface Session {
  /** Telegram user id. */
  uid: number;
  /** Suggested display name, for pre-filling the form. Never a full name. */
  name: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error('SESSION_SECRET is not set, or is too short to be worth setting');
  }
  return value;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signature(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

export function sign(session: Omit<Session, 'iat'> & { iat?: number }): string {
  const payload: Session = {
    uid: session.uid,
    name: session.name,
    iat: session.iat ?? Math.floor(Date.now() / 1000),
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${signature(body)}`;
}

/** Returns null for anything unparseable, unsigned, mis-signed or expired. */
export function verify(token: string | undefined | null, now: Date = new Date()): Session | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expected = signature(body);

  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;

  let session: Session;
  try {
    session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof session.uid !== 'number' || !Number.isFinite(session.uid)) return null;
  if (typeof session.iat !== 'number') return null;
  if (Math.floor(now.getTime() / 1000) - session.iat > MAX_AGE_SECONDS) return null;

  return session;
}

/** Cookie attributes. `lax` is enough: there is no cross-site POST to protect. */
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}
