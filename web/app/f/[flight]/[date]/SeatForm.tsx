'use client';

import { useState } from 'react';

/**
 * Phase two from the web (CLAUDE.md §7.6).
 *
 * The bot is the main path — it reaches you at check-in without you having to
 * remember anything. This is for the person who is already looking at the page,
 * and it is where a parsed boarding pass will post in M5.
 */

interface Props {
  size: number;
  currentSeats: string[];
  checkinOpen: boolean;
  checkinOpensAt: string | null;
}

export default function SeatForm({ size, currentSeats, checkinOpen, checkinOpensAt }: Props) {
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

    const response = await fetch('/api/seats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seats: value }),
    });
    const body = await response.json().catch(() => ({ message: 'Something went wrong' }));

    setStatus(response.ok ? 'saved' : 'error');
    setMessage(body.message ?? body.error ?? 'Something went wrong');
  }

  return (
    <section className="rounded-lg border border-line p-5">
      <h2 className="text-base font-medium">Your seats</h2>
      <p className="mt-2 text-sm text-muted">
        Check-in is open. Send the {size === 1 ? 'seat' : `${size} seats`} the airline
        gave you and we will start looking for a swap.
      </p>

      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={size === 1 ? '14A' : '14A, 22F'}
          className="w-full rounded border border-line px-3 py-2 outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={status === 'saving'}
          className="w-full rounded bg-accent px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : currentSeats.length > 0 ? 'Update seats' : 'Send seats'}
        </button>
        {message ? (
          <p className={status === 'error' ? 'text-sm text-red-600' : 'text-sm text-accent'}>
            {message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
