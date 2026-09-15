import type { Metadata } from 'next';
import Link from 'next/link';

import { operator } from '../../lib/operator.ts';

export const metadata: Metadata = {
  title: 'Terms',
  description:
    'The rules for using seatswap: it is free, swaps are agreements between '
    + 'passengers, and the airline crew always have the final word.',
  alternates: { canonical: '/terms' },
};

/**
 * Terms of use. Short, because the product is: free, no accounts beyond a
 * Telegram login, nothing to buy. The parts that carry weight are the ones that
 * say what we are *not* — an airline, a guarantee, a party to your swap
 * (CLAUDE.md §2.3, §2.4).
 */

const UPDATED = '2026-09-15';

// Per request, for the same reason as the privacy policy.
export const dynamic = 'force-dynamic';

export default function TermsPage() {
  const who = operator();

  return (
    <article className="space-y-8 text-sm leading-relaxed">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Terms</h1>
        <p className="text-muted">Last updated {UPDATED}</p>
      </header>

      <Section title="What this is">
        <p>
          seatswap is a free service run by {who.name}. Passengers on the same flight
          tell us the seat they have and the seat they would like, and we look for
          swaps where everyone involved ends up better off. By signing up you agree to
          these terms and to our{' '}
          <Link href="/privacy" className="text-accent underline underline-offset-2">
            privacy policy
          </Link>
          .
        </p>
      </Section>

      <Section title="What we are not">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="font-medium text-ink">Not your airline.</strong> We are
            not connected to any airline and cannot change your booking or your seat in
            the airline&rsquo;s systems.
          </li>
          <li>
            <strong className="font-medium text-ink">Not a guarantee.</strong> A swap
            is an agreement between passengers to change seats once on board. It is not
            binding, and anyone can change their mind. If a swap does not happen, you
            keep the seat the airline gave you.
          </li>
          <li>
            <strong className="font-medium text-ink">Not the last word.</strong> Cabin
            crew decide who sits where. Exit rows in particular have rules about who
            may sit in them. We never offer a swap that would put a child you told us
            about in one, but other rules apply too, and if the crew say no, the swap
            is off.
          </li>
        </ul>
      </Section>

      <Section title="What we ask of you">
        <ul className="list-disc space-y-2 pl-5">
          <li>Be at least 16, and only sign up for flights you are actually on.</li>
          <li>
            Tell us truthfully how many of your group are under 16. It is what keeps
            children out of exit-row swaps.
          </li>
          <li>
            Give the seats you were really assigned. Claiming a seat that is not yours
            blocks the person who has it from taking part.
          </li>
          <li>Use one Telegram account, and do not automate sign-ups.</li>
          <li>
            Pick a name to show that is not your full name and would not offend the
            people you swap with.
          </li>
          <li>
            Be decent on board. If someone changes their mind, they keep their seat,
            and that is fine.
          </li>
        </ul>
        <p>
          We may remove a sign-up, or stop an account from using the service, if these
          rules are broken.
        </p>
      </Section>

      <Section title="Boarding pass badge">
        <p>
          A badge means a seat was read from a boarding pass and checked against the
          flight, the aircraft and the seats other people have claimed. Boarding passes
          are not digitally signed, so a badge is a strong hint, not proof of anything.
        </p>
      </Section>

      <Section title="No warranty">
        <p>
          The service is free and provided as it is. We do our best to keep it
          running and correct, but flight data can be wrong, messages can be late and
          the service can be unavailable. As far as the law allows, we are not liable
          for a swap that does not happen, or for what happens on board. Nothing here
          limits rights you have under consumer law that cannot be limited.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>
          We may update these terms; the current version is always on this page, with
          its date at the top. Questions go to{' '}
          {who.email.includes('@') ? (
            <a href={`mailto:${who.email}`} className="text-accent underline underline-offset-2">
              {who.email}
            </a>
          ) : (
            <strong>{who.email}</strong>
          )}
          .
        </p>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}
