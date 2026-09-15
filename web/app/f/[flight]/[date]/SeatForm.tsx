'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import VerificationBadge from '../../../../components/VerificationBadge.tsx';

/**
 * Phase two from the web (CLAUDE.md §7.6).
 *
 * The bot is the main path — it reaches you at check-in without you having to
 * remember anything. This is for the person who is already looking at the page.
 *
 * Typing a seat is tier 0 and always will be: it is the default, it is what most
 * people will do, and nothing about taking part requires more (CLAUDE.md §10).
 * BoardingPassForm sits underneath for anyone who would rather scan.
 */

interface Props {
  size: number;
  currentSeats: string[];
  checkinOpen: boolean;
  checkinOpensAt: string | null;
  /** We never learned the departure time, so "open" is our earliest guess. */
  checkinEstimated: boolean;
  verificationTier: number;
}

export default function SeatForm({
  size,
  currentSeats,
  checkinOpen,
  checkinOpensAt,
  checkinEstimated,
  verificationTier,
}: Props) {
  const router = useRouter();
  const inputId = useId();
  const [value, setValue] = useState(currentSeats.join(', '));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  if (!checkinOpen) {
    return (
      <section className="rounded-lg border border-line p-5">
        <h2 className="text-base font-medium">Your seats</h2>
        <p className="mt-2 text-sm text-muted">
          The airline has not assigned them yet. Check-in opens
          {checkinOpensAt ? ` on ${checkinOpensAt}` : ' 24 to 48 hours before departure'},
          and our bot will message you then. Nothing to do until it does.
        </p>
      </section>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus('saving');

    let response: Response;
    try {
      response = await fetch('/api/seats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seats: value }),
      });
    } catch {
      setStatus('error');
      setMessage('We could not reach the server. Check your connection and try again.');
      return;
    }
    const body = await response.json().catch(() => ({ message: 'Something went wrong' }));

    setStatus(response.ok ? 'saved' : 'error');
    setMessage(body.message ?? body.error ?? 'Something went wrong');
    // Typed seats replace boarding pass ones, so the badge may have just come off.
    if (response.ok) router.refresh();
  }

  return (
    <section className="rounded-lg border border-line p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-medium">Your seats</h2>
        <VerificationBadge tier={verificationTier} />
      </div>
      <p className="mt-2 text-sm text-muted">
        {checkinEstimated
          // True for the whole window, unlike "around now", which the bot can say
          // because it says it once, at the estimated moment.
          ? 'Check-in is open or opens soon — we could not look up the exact time. '
            + 'Once the airline has given you '
            + `${size === 1 ? 'a seat' : 'your seats'}, send `
            + `${size === 1 ? 'it' : 'them'} here and we will start looking for a swap.`
          : `Check-in is open. Send the ${size === 1 ? 'seat' : `${size} seats`} the airline `
            + 'gave you and we will start looking for a swap.'}
      </p>
      {verificationTier > 0 ? (
        <p className="mt-2 text-sm text-muted">
          These came off your boarding pass. Typing different ones is fine, but they
          would no longer be checked, so the badge would come off.
        </p>
      ) : null}

      <form onSubmit={submit} className="mt-4 space-y-3">
        <label htmlFor={inputId} className="block text-sm font-medium">
          {size === 1 ? 'Seat number' : 'Seat numbers, separated by commas'}
        </label>
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          placeholder={size === 1 ? '14A' : '14A, 22F'}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="w-full rounded border border-field px-3 py-2 focus:border-accent"
        />
        <button
          type="submit"
          disabled={status === 'saving'}
          className="w-full rounded bg-accent px-4 py-2 font-medium text-white hover:bg-accent-dark disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : currentSeats.length > 0 ? 'Update seats' : 'Send seats'}
        </button>
        {message ? (
          <p
            role={status === 'error' ? 'alert' : 'status'}
            className={status === 'error' ? 'text-sm text-red-600' : 'text-sm text-accent'}
          >
            {message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
