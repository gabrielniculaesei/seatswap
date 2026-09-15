'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

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
  /**
   * The flight is identified by carrier, number and date rather than by a row id,
   * because signing up is what creates the row. The page itself never writes, and
   * sign-up goes through flightForUser so the per-account daily cap on new
   * flights applies (CLAUDE.md §5, §11).
   */
  carrier: string;
  flightNumber: string;
  departureDate: string;
  designator: string;
  botUsername: string;
  returnTo: string;
  session: Session | null;
  existing: PartyRow | null;
  /** The Telegram callback bounced back with `?login=failed`. */
  loginFailed: boolean;
}

function answersFromExisting(existing: PartyRow | null) {
  if (!existing) {
    return { size: 1, children: 0, adjacency: 'essential' as AdjacencyAnswer, seatType: 'either' as SeatTypeAnswer, extras: [] as ExtraAnswer[] };
  }
  const extras: ExtraAnswer[] = [];
  if (existing.w_avoid_middle > 0) extras.push('avoid_middle');
  if (existing.w_front > 0) extras.push('front');
  if (existing.w_avoid_lavatory > 0) extras.push('avoid_lavatory');

  return {
    size: existing.size,
    children: existing.children,
    adjacency: (existing.w_adjacency >= 200 ? 'essential' : existing.w_adjacency > 0 ? 'prefer' : 'no') as AdjacencyAnswer,
    seatType: (existing.w_window > 0 ? 'window' : existing.w_aisle > 0 ? 'aisle' : 'either') as SeatTypeAnswer,
    extras,
  };
}

export default function RegistrationForm(props: Props) {
  const router = useRouter();
  const nameId = useId();
  const initial = answersFromExisting(props.existing);

  const [size, setSize] = useState(initial.size);
  const [under16, setUnder16] = useState(initial.children);
  const [adjacency, setAdjacency] = useState<AdjacencyAnswer>(initial.adjacency);
  const [seatType, setSeatType] = useState<SeatTypeAnswer>(initial.seatType);
  const [extras, setExtras] = useState<ExtraAnswer[]>(initial.extras);
  const [displayName, setDisplayName] = useState(
    props.existing?.display_name ?? props.session?.name ?? '',
  );
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  if (!props.session) {
    return (
      <TelegramLogin
        botUsername={props.botUsername}
        returnTo={props.returnTo}
        failed={props.loginFailed}
      />
    );
  }

  const toggleExtra = (extra: ExtraAnswer) =>
    setExtras((current) =>
      current.includes(extra) ? current.filter((e) => e !== extra) : [...current, extra],
    );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus('saving');
    setMessage('');

    let response: Response;
    try {
      response = await fetch('/api/parties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrier: props.carrier,
          flightNumber: props.flightNumber,
          departureDate: props.departureDate,
          displayName: displayName.trim(),
          size,
          // Clamped here as well as on the buttons: going from 3 people to 2
          // must not leave a stale "2 children" behind.
          children: Math.min(under16, size - 1),
          adjacency: size >= 2 ? adjacency : undefined,
          seatType,
          extras,
        }),
      });
    } catch {
      // Without this a dropped connection leaves the button stuck on "Saving…".
      setStatus('error');
      setMessage('We could not reach the server. Check your connection and try again.');
      return;
    }

    if (response.ok) {
      setStatus('saved');
      setMessage(
        props.existing
          ? 'Updated. We will message you when check-in opens.'
          : 'You are in. We will message you on Telegram when check-in opens.',
      );
      // The rest of the page is server-rendered from the party row that was just
      // written: the counts, the seat section, this form's own heading.
      router.refresh();
    } else {
      const body = await response.json().catch(() => ({ error: 'Something went wrong' }));
      setStatus('error');
      setMessage(body.error ?? 'Something went wrong');
    }
  }

  async function leave() {
    const confirmed = window.confirm(
      `Leave ${props.designator}? This deletes your sign-up and your seats straight `
      + 'away. If you are part of a swap, it ends for everyone in it.',
    );
    if (!confirmed) return;

    setStatus('saving');
    setMessage('');
    let response: Response;
    try {
      response = await fetch('/api/parties', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrier: props.carrier,
          flightNumber: props.flightNumber,
          departureDate: props.departureDate,
        }),
      });
    } catch {
      setStatus('error');
      setMessage('We could not reach the server. Check your connection and try again.');
      return;
    }

    if (response.ok) {
      // Before check-in this component stays mounted and simply turns back into
      // the sign-up form, so its state survives the navigation: without the reset
      // its button would come back stuck on "Saving…". The answers are kept on
      // purpose, so rejoining is one press.
      setStatus('idle');
      // A navigation rather than a refresh: the page confirms the deletion from
      // `?left=1`, which also covers the check-in case, where this component is
      // remounted elsewhere and any message it held would be lost.
      router.replace(`${props.returnTo}?left=1`);
    } else {
      const body = await response.json().catch(() => ({ error: 'Something went wrong' }));
      setStatus('error');
      setMessage(body.error ?? 'Something went wrong');
    }
  }

  const form = (
    <form onSubmit={submit} className="mt-4 space-y-6">
      <Field
        label="What should we call you?"
        htmlFor={nameId}
        hint="Shown to the people you swap with. A nickname or a first name is plenty — please do not use your full name."
      >
        <input
          id={nameId}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={40}
          required
          // A name of only spaces passes `required` and is then refused by the
          // server; refuse it here instead, with the browser's own message.
          pattern=".*\S.*"
          title="Please choose a name to show"
          autoComplete="nickname"
          className="w-full rounded border border-field px-3 py-2 focus:border-accent"
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
        <Field
          label="How many of them are under 16?"
          hint="Children cannot sit in an exit row, so we never offer your group a swap that would put one there."
        >
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: size }, (_, n) => n).map((n) => (
              <Choice key={n} selected={Math.min(under16, size - 1) === n} onClick={() => setUnder16(n)}>
                {n === 0 ? 'None' : n}
              </Choice>
            ))}
          </div>
        </Field>
      ) : null}

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
        className={
          'w-full rounded px-4 py-2 font-medium disabled:opacity-50 '
          // Signing up is this section's one job, so it is the filled button. Once
          // you are in, updating is housekeeping and must not outshout the seat
          // form below it, which is where the real action is by then.
          + (props.existing
            ? 'border border-field hover:border-accent'
            : 'bg-accent text-white hover:bg-accent-dark')
        }
      >
        {status === 'saving' ? 'Saving…' : props.existing ? 'Update preferences' : 'Sign up'}
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
  );

  // Already signed up: the questions are answered, so they fold away and leave
  // the page's attention on what happens next.
  if (props.existing) {
    return (
      <details className="group rounded-lg border border-line p-5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-base font-medium [&::-webkit-details-marker]:hidden">
          <span>Your preferences</span>
          <span className="text-sm font-normal text-accent underline underline-offset-2 group-open:hidden">
            Change
          </span>
        </summary>
        {form}
        <div className="mt-6 border-t border-line pt-4">
          <button
            type="button"
            onClick={leave}
            disabled={status === 'saving'}
            className="text-sm font-medium text-red-600 underline underline-offset-2 disabled:opacity-50"
          >
            Leave this flight
          </button>
          <p className="mt-1 text-xs text-muted">
            Deletes your sign-up and seats now, instead of 24 hours after departure.
          </p>
        </div>
      </details>
    );
  }

  return (
    <section className="rounded-lg border border-line p-5">
      <h2 className="text-base font-medium">Sign up for this flight</h2>
      {form}
    </section>
  );
}

/**
 * One question. A single control gets a real <label>; a row of choice buttons
 * gets a group named by the question, so a screen reader announces "How many of
 * you are travelling? group" before the buttons rather than a bare "3".
 */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const labelId = useId();
  const hintId = useId();

  return (
    <div
      className="space-y-2"
      role={htmlFor ? undefined : 'group'}
      aria-labelledby={htmlFor ? undefined : labelId}
      aria-describedby={!htmlFor && hint ? hintId : undefined}
    >
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
        ) : (
          <p id={labelId} className="text-sm font-medium">{label}</p>
        )}
        {hint ? <p id={hintId} className="text-sm text-muted">{hint}</p> : null}
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
          : 'border-field hover:border-ink')
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
function TelegramLogin({
  botUsername,
  returnTo,
  failed,
}: {
  botUsername: string;
  returnTo: string;
  failed: boolean;
}) {
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
      {failed ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          Telegram did not confirm that sign-in, or it took too long. Please try
          again.
        </p>
      ) : null}
      <div ref={container} className="mt-4 min-h-[40px]" />
      {!botUsername ? (
        <p className="mt-2 text-sm text-red-600">
          TELEGRAM_BOT_USERNAME is not configured, so the login button cannot render.
        </p>
      ) : null}
      <p className="mt-3 text-xs text-muted">
        By signing up you agree to our{' '}
        <Link href="/terms" className="underline underline-offset-2">terms</Link> and{' '}
        <Link href="/privacy" className="underline underline-offset-2">privacy policy</Link>.
      </p>
    </section>
  );
}
