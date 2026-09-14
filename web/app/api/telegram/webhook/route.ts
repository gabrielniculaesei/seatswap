import { NextResponse } from 'next/server';

import { movesFor, respond } from '../../../../lib/proposals.ts';
import { submitSeats } from '../../../../lib/seats.ts';
import { answerCallbackQuery, sendMessage } from '../../../../lib/telegram.ts';

/**
 * Telegram webhook (CLAUDE.md §7.6, §7.7, §12).
 *
 * Two kinds of update matter:
 *   - a text message, which is somebody sending their seats at check-in;
 *   - a callback query, which is somebody pressing Accept or Decline.
 *
 * Webhook, not polling: a long-poll loop would be a second always-on process to
 * run and supervise, and the whole architecture is two processes.
 */

export const dynamic = 'force-dynamic';

/**
 * Telegram sends this header with every request, set when the webhook is
 * registered. Without it the endpoint is a public, unauthenticated way to act as
 * any user: `chat.id` is whatever the caller writes.
 */
function authorised(request: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  return request.headers.get('x-telegram-bot-api-secret-token') === expected;
}

interface Update {
  message?: {
    text?: string;
    chat?: { id: number };
    from?: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { chat?: { id: number }; message_id?: number };
  };
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'not authorised' }, { status: 401 });
  }

  let update: Update;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (error) {
    // Telegram retries anything that is not a 2xx, and a retry of a seat
    // submission or a button press would double-apply. Swallow, log, move on.
    console.error('webhook handler failed', error);
  }

  // Always 200: the update has been received, whatever we made of it.
  return NextResponse.json({ ok: true });
}

const HELP =
  'Send me your seat numbers when check-in opens — just the seats, like '
  + '14A or 14A, 22F.\n\n'
  + 'If I find a swap where everyone comes out better off, you will get it here '
  + 'with two buttons.';

async function handleMessage(message: NonNullable<Update['message']>) {
  const userId = message.from?.id;
  const chatId = message.chat?.id;
  const text = (message.text ?? '').trim();
  if (!userId || !chatId || !text) return;

  if (text.startsWith('/start') || text.startsWith('/help')) {
    await sendMessage(chatId, HELP);
    return;
  }

  const result = await submitSeats(userId, text);
  await sendMessage(chatId, result.message);
}

const CALLBACK = /^proposal:(\d+):(accept|reject)$/;

async function handleCallback(query: NonNullable<Update['callback_query']>) {
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const match = CALLBACK.exec(query.data ?? '');

  if (!userId || !match) {
    await answerCallbackQuery(query.id, 'Sorry, I did not understand that.');
    return;
  }

  const proposalId = Number.parseInt(match[1], 10);
  const answer = match[2] as 'accept' | 'reject';

  // The party is resolved from the Telegram id, never from the callback data:
  // a button press carries whatever the sender likes.
  const result = await respond(proposalId, userId, answer);
  await answerCallbackQuery(query.id, result.ok ? undefined : result.message);

  if (chatId) await sendMessage(chatId, result.message);

  if (result.settled && result.parties) {
    await announceAgreement(proposalId, result.agreementToken, result.parties);
  } else if (!result.settled && answer === 'reject' && result.ok && result.parties) {
    await tellTheOthers(result.parties, userId);
  }
}

async function announceAgreement(
  proposalId: number,
  token: string | undefined,
  parties: { telegram_user_id: number; display_name: string }[],
) {
  const moves = await movesFor(proposalId);
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const summary = moves
    .map((m) => `  ${m.display_name}: ${m.from_seat} → <b>${m.to_seat}</b>`)
    .join('\n');

  for (const party of parties) {
    await sendMessage(
      party.telegram_user_id,
      'Everyone accepted. Here is the swap:\n\n'
        + `${summary}\n\n`
        + (token ? `Show this page to each other on board:\n${base}/a/${token}\n\n` : '')
        + 'Nothing else to do — just take your new seat.',
    );
  }
}

async function tellTheOthers(
  parties: { telegram_user_id: number; display_name: string }[],
  decliner: number,
) {
  for (const party of parties) {
    if (party.telegram_user_id === decliner) continue;
    await sendMessage(
      party.telegram_user_id,
      'That swap is off — someone declined, so you keep the seat you have. '
        + 'I am already looking for another one.',
    );
  }
}
