'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import type { AdjacencyAnswer, ExtraAnswer, SeatTypeAnswer } from '../../../../config/preferences.ts';
import type { PartyRow } from '../../../../lib/flights.ts';
import type { Session } from '../../../../lib/session.ts';
import { Card, CardFooter, CardHeader } from '../../../../components/Chrome.tsx';

/**
 * Phase one of the questionnaire.
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
   * flights applies.
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

  const answered = Math.min(under16, size - 1);
  const summary =
    `${size} ${size === 1 ? 'traveller' : 'travellers'} · `
    + (seatType === 'either' ? 'any seat' : seatType);

  const form = (
    <form onSubmit={submit}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(238px,1fr))] gap-[18px] p-4">
        <Field
          label="What we should call you"
          htmlFor={nameId}
          hint="Shown to the people you swap with. A nickname or a first name is plenty, please not your full name."
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
            className="input-text"
          />
        </Field>

        <Field label="How many of you are travelling">
          {/* Six to a row always, so a narrow column never strands the 6. */}
          <div className="grid grid-cols-6 gap-[7px]">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <Choice key={n} selected={size === n} onClick={() => setSize(n)} className="px-0 py-[9px] text-center font-mono">
                {n}
              </Choice>
            ))}
          </div>
        </Field>

        {size >= 2 ? (
          <Field
            label="How many are under 16"
            hint="Children cannot sit in an exit row, so we never offer your group a swap that would put one there."
          >
            <div className="flex flex-wrap gap-[7px]">
              {Array.from({ length: size }, (_, n) => n).map((n) => (
                <Choice key={n} selected={answered === n} onClick={() => setUnder16(n)} className="min-w-[52px] px-[11px] py-[9px] text-center text-[13px]">
                  {n === 0 ? 'None' : n}
                </Choice>
              ))}
            </div>
          </Field>
        ) : null}

        {size >= 2 ? (
          <Field label="How much sitting together matters">
            <div className="flex flex-col gap-[7px]">
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

        <Field label="Which seat you would rather have">
          <div className="flex flex-wrap gap-[7px]">
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

        <Field label="Anything else · optional">
          <div className="flex flex-col gap-[7px]">
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
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-line bg-well px-4 py-[13px]">
        <button
          type="submit"
          disabled={status === 'saving'}
          // Signing up is this card's one job, so it is the filled button. Once
          // you are in, updating is housekeeping and must not outshout the seat
          // form above it, which is where the real action is by then.
          className={props.existing ? 'btn-secondary' : 'btn-primary w-full'}
        >
          {status === 'saving' ? 'Saving…' : props.existing ? 'Update preferences' : 'Sign up'}
        </button>
        {props.existing ? (
          <button
            type="button"
            onClick={leave}
            disabled={status === 'saving'}
            title="Deletes your sign-up and seats now, instead of 24 hours after departure."
            className="text-[13px] font-semibold text-danger underline underline-offset-2 disabled:opacity-50"
          >
            Leave this flight
          </button>
        ) : null}
        {message ? (
          <p
            role={status === 'error' ? 'alert' : 'status'}
            className={`w-full text-[13px] ${status === 'error' ? 'text-danger' : 'text-accent'}`}
          >
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );

  // Already signed up: the questions are answered, so they fold away and leave
  // the page's attention on what happens next.
  if (props.existing) {
    return (
      <details className="group overflow-hidden rounded-card border border-line bg-white">
        <summary
          className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-[13px]
                     group-open:border-b group-open:border-line [&::-webkit-details-marker]:hidden"
        >
          <h2 className="text-[14.5px] font-semibold">Your preferences</h2>
          <span className="flex items-center gap-3">
            <span className="meta-mono">{summary}</span>
            <span className="link text-[13px] group-open:hidden">Change</span>
          </span>
        </summary>
        {form}
      </details>
    );
  }

  return (
    <Card>
      <CardHeader title="Sign up for this flight" meta="Step 02" />
      {form}
    </Card>
  );
}

/**
 * One question. A single control gets a real <label>; a row of choice buttons
 * gets a group named by the question, so a screen reader announces "How many of
 * you are travelling, group" before the buttons rather than a bare "3".
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
      className="flex flex-col gap-2"
      role={htmlFor ? undefined : 'group'}
      aria-labelledby={htmlFor ? undefined : labelId}
      aria-describedby={!htmlFor && hint ? hintId : undefined}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className="label-mono">{label}</label>
      ) : (
        <p id={labelId} className="label-mono">{label}</p>
      )}
      {children}
      {hint ? <p id={hintId} className="text-[12.5px] text-muted">{hint}</p> : null}
    </div>
  );
}

function Choice({
  selected,
  onClick,
  className = 'px-3 py-2.5 text-left',
  children,
}: {
  selected: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={
        'rounded-[7px] border text-[13.5px] transition-colors '
        + (selected
          ? 'border-accent bg-accent/[.08] font-semibold text-accent '
          : 'border-field bg-white text-ink hover:border-ink ')
        + className
      }
    >
      {children}
    </button>
  );
}

/**
 * The Telegram Login Widget. One tap, and no phone number ever reaches us.
 * The button and its mark are Telegram's: the script draws
 * them, and nothing here restyles them.
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
    <Card>
      <CardHeader title="Sign up for this flight" meta="Step 01" />
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-body">
          One tap with Telegram and you are in. That is the whole sign-in, and your
          number stays where it already is.
        </p>
        {failed ? (
          <p role="alert" className="text-[13px] text-danger">
            Telegram did not confirm that sign-in, or it took too long. Please try
            again.
          </p>
        ) : null}
        <div ref={container} className="min-h-[40px]" />
        {!botUsername ? (
          <p className="text-[13px] text-danger">
            TELEGRAM_BOT_USERNAME is not configured, so the login button cannot render.
          </p>
        ) : null}
      </div>
      <CardFooter>
        Then three questions about who is travelling and what you would like. By
        signing up you agree to our <Link href="/terms" className="link">terms</Link>{' '}
        and <Link href="/privacy" className="link">privacy policy</Link>.
      </CardFooter>
    </Card>
  );
}
