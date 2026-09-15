'use client';

import { useState } from 'react';

/**
 * "Send this page to others on your flight", as a button.
 *
 * Liquidity lives inside one flight (CLAUDE.md §2.2): the single most useful
 * thing a signed-up traveller can do before check-in is bring in more people from
 * the same aircraft, and the page already told them to without giving them a way
 * to. The phone's own share sheet where there is one (it reaches WhatsApp, which
 * is where these links go), a copied link where there is not.
 */

export default function ShareButton({
  url,
  title,
  primary = false,
}: {
  url: string;
  title: string;
  primary?: boolean;
}) {
  const [note, setNote] = useState('');

  async function share() {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        // Closing the share sheet is a choice, not a failure.
        if ((error as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setNote('Link copied. Paste it wherever your fellow passengers are.');
    } catch {
      setNote(url);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={share}
        className={
          'w-full rounded px-4 py-2 font-medium '
          + (primary
            ? 'bg-accent text-white hover:bg-accent-dark'
            : 'border border-field hover:border-accent')
        }
      >
        Share this flight
      </button>
      {note ? (
        <p role="status" className="break-words text-sm text-muted">{note}</p>
      ) : null}
    </div>
  );
}
