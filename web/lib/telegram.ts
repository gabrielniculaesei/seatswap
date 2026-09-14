/**
 * Telegram, from the web side (CLAUDE.md §12).
 *
 * Two jobs: verifying the Login Widget signature, and sending the occasional
 * immediate confirmation. Match-run notifications come from the worker instead,
 * because that is where the result is produced.
 *
 * Why Telegram is the only way in: it is the one mainstream identity that does
 * not hand us a phone number. Joining a WhatsApp group would expose a stranger's
 * number to other strangers who also know when they are away from home, which is
 * an unacceptable trade for a product whose whole purpose is avoiding an awkward
 * moment (CLAUDE.md §13.3).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Exactly the fields the Login Widget sends. */
export interface TelegramLoginPayload {
  id: string;
  auth_date: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  hash: string;
}

export interface TelegramIdentity {
  telegramUserId: number;
  /** Suggested display name. Never a full name — see displayNameFrom(). */
  suggestedName: string;
}

/** A login older than this is refused, so a leaked URL cannot be replayed later. */
export const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

export class TelegramAuthError extends Error {}

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramAuthError('TELEGRAM_BOT_TOKEN is not set');
  return token;
}

/**
 * The data-check string from Telegram's documentation: every field except `hash`,
 * sorted by key, as `key=value`, joined by newlines.
 */
export function dataCheckString(payload: Record<string, string>): string {
  return Object.keys(payload)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${payload[key]}`)
    .join('\n');
}

/**
 * Verify a Login Widget payload and return who it is.
 *
 * The secret is SHA256 of the bot token — not the token itself — and the
 * comparison is timing-safe. Anyone who can forge this can impersonate any user
 * on any flight, so this function is the whole authentication system.
 */
export function verifyLogin(
  payload: TelegramLoginPayload,
  now: Date = new Date(),
): TelegramIdentity {
  if (!payload?.hash) throw new TelegramAuthError('missing hash');
  if (!payload.id) throw new TelegramAuthError('missing id');

  const secret = createHash('sha256').update(botToken()).digest();
  const expected = createHmac('sha256', secret)
    .update(dataCheckString(payload as unknown as Record<string, string>))
    .digest('hex');

  const given = payload.hash.toLowerCase();
  if (given.length !== expected.length) throw new TelegramAuthError('bad signature');
  if (!timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'))) {
    throw new TelegramAuthError('bad signature');
  }

  const authDate = Number.parseInt(payload.auth_date ?? '', 10);
  if (!Number.isFinite(authDate)) throw new TelegramAuthError('bad auth_date');
  const age = Math.floor(now.getTime() / 1000) - authDate;
  if (age > MAX_AUTH_AGE_SECONDS) throw new TelegramAuthError('login has expired');
  // A little clock skew is normal; a login from the future is not.
  if (age < -300) throw new TelegramAuthError('auth_date is in the future');

  const telegramUserId = Number.parseInt(payload.id, 10);
  if (!Number.isFinite(telegramUserId)) throw new TelegramAuthError('bad id');

  return {
    telegramUserId,
    suggestedName: displayNameFrom(payload.first_name, payload.last_name, payload.username),
  };
}

/**
 * Build a display name that is deliberately *not* a full name (CLAUDE.md §13.2).
 *
 * First name plus the initial of the surname, capped at 40 characters. The
 * surname itself is never stored anywhere, and neither is the raw payload: this
 * function's output is the only thing that reaches the database.
 */
export function displayNameFrom(
  firstName?: string,
  lastName?: string,
  username?: string,
): string {
  const first = (firstName ?? '').trim();
  const last = (lastName ?? '').trim();

  if (first && last) return `${first} ${last[0].toUpperCase()}.`.slice(0, 40);
  if (first) return first.slice(0, 40);
  if (username) return username.trim().slice(0, 40);
  return 'Traveller';
}

/** Send a message from the web tier. Used for immediate confirmations only. */
export async function sendMessage(chatId: number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return response.ok;
  } catch {
    // A confirmation that did not arrive must never fail the request that
    // triggered it: the registration itself is already committed.
    return false;
  }
}

/**
 * Acknowledge a button press.
 *
 * Telegram shows a spinner on an inline button until this is called, so it has to
 * happen even when the answer is "no": an unacknowledged press looks broken and
 * invites the user to press again.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text ? { text, show_alert: false } : {}),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
