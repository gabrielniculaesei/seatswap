'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { Card, CardFooter, CardHeader } from '../../../../components/Chrome.tsx';
import VerificationBadge from '../../../../components/VerificationBadge.tsx';

/**
 * Phase two from the web (CLAUDE.md §7.6).
 *
 * The bot is the main path: it reaches you at check-in without you having to
 * remember anything. This is for the person who is already looking at the page,
 * so the page only shows it once check-in is open and there is a seat to send.
 *
 * Typing a seat is tier 0 and always will be: it is the default, it is what most
 * people will do, and nothing about taking part requires more (CLAUDE.md §10).
 * BoardingPassForm sits beside it for anyone who would rather scan.
 */

interface Props {
  size: number;
  currentSeats: string[];
  /** We never learned the departure time, so "open" is our earliest guess. */
  checkinEstimated: boolean;
  verificationTier: number;
}

export default function SeatForm({ size, currentSeats, checkinEstimated, verificationTier }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [value, setValue] = useState(currentSeats.join(', '));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

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
    <Card>
      <CardHeader title="Your seats">
        <VerificationBadge tier={verificationTier} />
      </CardHeader>
      <form onSubmit={submit} className="flex flex-col gap-[13px] p-4">
        <p className="text-sm text-body">
          {checkinEstimated
            // True for the whole window, unlike "around now", which the bot can say
            // because it says it once, at the estimated moment.
            ? 'Check-in is open or opens soon, but we could not look up the exact time. '
              + 'Once the airline has given you '
              + `${size === 1 ? 'a seat' : 'your seats'}, send `
              + `${size === 1 ? 'it' : 'them'} here and we will start looking for a swap.`
            : `Check-in is open. Send the ${size === 1 ? 'seat' : `${size} seats`} the airline `
              + 'gave you and we will start looking for a swap.'}
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="label-mono">
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
            className="input-mono"
          />
        </div>
        <button type="submit" disabled={status === 'saving'} className="btn-primary w-full">
          {status === 'saving' ? 'Saving…' : currentSeats.length > 0 ? 'Update seats' : 'Send seats'}
        </button>
        {message ? (
          <p
            role={status === 'error' ? 'alert' : 'status'}
            className={`text-[13px] ${status === 'error' ? 'text-danger' : 'text-accent'}`}
          >
            {message}
          </p>
        ) : null}
      </form>
      {verificationTier > 0 ? (
        <CardFooter>
          These came off your boarding pass. Typing different ones is fine, they just
          would not be checked any more, so the badge comes off.
        </CardFooter>
      ) : null}
    </Card>
  );
}
