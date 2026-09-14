'use client';

import { useEffect, useRef, useState } from 'react';

import type { AdjacencyAnswer, ExtraAnswer, SeatTypeAnswer } from '../../../../config/preferences.ts';
import type { PartyRow } from '../../../../lib/flights.ts';
import type { Session } from '../../../../lib/session.ts';

/**
 * Phase one of the questionnaire (CLAUDE.md §7, §8).
 *
 * Three blunt questions, never a slider and never free text. Sliders invite people
 * to express a precision they do not have, and free text cannot be optimised over.
 * Each answer maps to a fixed integer weight in config/preferences.ts.
 *
 * No seat is asked for here. Weeks before departure there is no seat to give.
 */

interface Props {
  flightId: number;
  designator: string;
  departureDate: string;
  botUsername: string;
  returnTo: string;
  session: Session | null;
  existing: PartyRow | null;
}

function answersFromExisting(existing: PartyRow | null) {
  if (!existing) {
    return { size: 1, adjacency: 'essential' as AdjacencyAnswer, seatType: 'either' as SeatTypeAnswer, extras: [] as ExtraAnswer[] };
  }
  const extras: ExtraAnswer[] = [];
  if (existing.w_avoid_middle > 0) extras.push('avoid_middle');
  if (existing.w_front > 0) extras.push('front');
  if (existing.w_avoid_lavatory > 0) extras.push('avoid_lavatory');

  return {
    size: existing.size,
    adjacency: (existing.w_adjacency >= 200 ? 'essential' : existing.w_adjacency > 0 ? 'prefer' : 'no') as AdjacencyAnswer,
    seatType: (existing.w_window > 0 ? 'window' : existing.w_aisle > 0 ? 'aisle' : 'either') as SeatTypeAnswer,
    extras,
  };
}

export default function RegistrationForm(props: Props) {
  const initial = answersFromExisting(props.existing);

  const [size, setSize] = useState(initial.size);
  const [adjacency, setAdjacency] = useState<AdjacencyAnswer>(initial.adjacency);
  const [seatType, setSeatType] = useState<SeatTypeAnswer>(initial.seatType);
  const [extras, setExtras] = useState<ExtraAnswer[]>(initial.extras);
  const [displayName, setDisplayName] = useState(
    props.existing?.display_name ?? props.session?.name ?? '',
  );
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  if (!props.session) {
    return <TelegramLogin botUsername={props.botUsername} returnTo={props.returnTo} />;
  }

  const toggleExtra = (extra: ExtraAnswer) =>
    setExtras((current) =>
      current.includes(extra) ? current.filter((e) => e !== extra) : [...current, extra],
    );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus('saving');
    setMessage('');

    const response = await fetch('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flightId: props.flightId,
        displayName,
        size,
        adjacency: size >= 2 ? adjacency : undefined,
        seatType,
        extras,
      }),
    });

    if (response.ok) {
      setStatus('saved');
      setMessage(
        props.existing
          ? 'Updated. We will message you when check-in opens.'
          : 'You are in. We will message you on Telegram when check-in opens.',
      );
    } else {
      const body = await response.json().catch(() => ({ error: 'Something went wrong' }));
      setStatus('error');
      setMessage(body.error ?? 'Something went wrong');
    }
  }

  return (
    <section className="rounded-lg border border-line p-5">
      <h2 className="text-base font-medium">
        {props.existing ? 'Your preferences' : 'Sign up for this flight'}
      </h2>

      <form onSubmit={submit} className="mt-4 space-y-6">
        <Field label="What should we call you?" hint="Shown to the people you swap with. A nickname or a first name is plenty — please do not use your full name.">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            required
            className="w-full rounded border border-line px-3 py-2 outline-none focus:border-accent"
          />
        </Field>

        <Field label="How many of you are travelling?">
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <Choice key={n} selected={size === n} onClick={() => setSize(n)}>
                {n}
              </Choice>
            ))}
          </div>
        </Field>

        {size >= 2 ? (
          <Field label="How much does sitting together matter?">
            <div className="flex flex-col gap-2">
              <Choice selected={adjacency === 'no'} onClick={() => setAdjacency('no')}>
                Not important
              </Choice>
              <Choice selected={adjacency === 'prefer'} onClick={() => setAdjacency('prefer')}>
                We would prefer it
              </Choice>
              <Choice selected={adjacency === 'essential'} onClick={() => setAdjacency('essential')}>
                It is the reason we are here
              </Choice>
            </div>
          </Field>
        ) : null}

        <Field label="Which seat would you rather have?">
          <div className="flex flex-wrap gap-2">
            <Choice selected={seatType === 'window'} onClick={() => setSeatType('window')}>
              Window
            </Choice>
            <Choice selected={seatType === 'aisle'} onClick={() => setSeatType('aisle')}>
              Aisle
            </Choice>
            <Choice selected={seatType === 'either'} onClick={() => setSeatType('either')}>
              Either is fine
            </Choice>
          </div>
        </Field>

        <Field label="Anything else?" hint="Optional.">
          <div className="flex flex-col gap-2">
            <Choice selected={extras.includes('avoid_middle')} onClick={() => toggleExtra('avoid_middle')}>
              Not the middle seat
            </Choice>
            <Choice selected={extras.includes('front')} onClick={() => toggleExtra('front')}>
              Nearer the front
            </Choice>
            <Choice selected={extras.includes('avoid_lavatory')} onClick={() => toggleExtra('avoid_lavatory')}>
              Away from the toilets
            </Choice>
          </div>
        </Field>

        <button
          type="submit"
          disabled={status === 'saving'}
          className="w-full rounded bg-accent px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : props.existing ? 'Update' : 'Sign up'}
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={
        'rounded border px-3 py-2 text-left text-sm '
        + (selected
          ? 'border-accent bg-accent/10 font-medium text-accent'
          : 'border-line hover:border-muted')
      }
    >
      {children}
    </button>
  );
}

/**
 * The Telegram Login Widget. One click, no password, no email — and crucially no
 * phone number ever reaches us (CLAUDE.md §13.3).
 */
function TelegramLogin({ botUsername, returnTo }: { botUsername: string; returnTo: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current || !botUsername) return;
    container.current.innerHTML = '';

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute('data-request-access', 'write');
    script.setAttribute(
      'data-auth-url',
      `${window.location.origin}/api/auth/telegram?next=${encodeURIComponent(returnTo)}`,
    );
    container.current.appendChild(script);
  }, [botUsername, returnTo]);

  return (
    <section className="rounded-lg border border-line p-5">
      <h2 className="text-base font-medium">Sign up for this flight</h2>
      <p className="mt-2 text-sm text-muted">
        One click with Telegram. No password, no email, and no phone number — we never
        see it, which is the whole reason we use Telegram and not WhatsApp or SMS.
      </p>
      <div ref={container} className="mt-4" />
      {!botUsername ? (
        <p className="mt-2 text-sm text-red-600">
          TELEGRAM_BOT_USERNAME is not configured, so the login button cannot render.
        </p>
      ) : null}
    </section>
  );
}
