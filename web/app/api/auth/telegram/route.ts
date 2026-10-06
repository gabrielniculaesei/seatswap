import { NextResponse } from 'next/server';

import { COOKIE_NAME, cookieOptions, sign } from '../../../../lib/session.ts';
import {
  TelegramAuthError,
  type TelegramLoginPayload,
  verifyLogin,
} from '../../../../lib/telegram.ts';

/**
 * Telegram Login Widget callback.
 *
 * The widget redirects here with the signed payload in the query string. We check
 * the HMAC with the bot token, mint a session cookie, and bounce back to wherever
 * the user was. Nothing from the payload is stored: the id goes in the cookie and
 * the name is only a suggestion for the form.
 */

export const dynamic = 'force-dynamic';

/**
 * Only same-site paths. Without this check the `next` parameter would be an open
 * redirect that borrows our domain to send people somewhere else.
 */
function safeReturnPath(value: string | null): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeReturnPath(url.searchParams.get('next'));

  const payload: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== 'next') payload[key] = value;
  }

  try {
    const identity = verifyLogin(payload as unknown as TelegramLoginPayload);
    const response = NextResponse.redirect(new URL(next, url.origin));
    response.cookies.set(
      COOKIE_NAME,
      sign({ uid: identity.telegramUserId, name: identity.suggestedName }),
      cookieOptions(),
    );
    return response;
  } catch (error) {
    if (error instanceof TelegramAuthError) {
      const failed = new URL(next, url.origin);
      failed.searchParams.set('login', 'failed');
      return NextResponse.redirect(failed);
    }
    throw error;
  }
}

/** Sign out. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, '', { ...cookieOptions(), maxAge: 0 });
  return response;
}
