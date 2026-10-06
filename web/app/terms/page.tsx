import type { Metadata } from 'next';
import Link from 'next/link';

import { Email, LegalPage, LegalSection } from '../../components/Legal.tsx';
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
 * say what we are *not*: an airline, a guarantee, a party to your swap.
 * They get the only card on the page.
 */

const UPDATED = '2026-09-15';

// Per request, for the same reason as the privacy policy.
export const dynamic = 'force-dynamic';

const NOT = [
  {
    lead: 'Not your airline',
    text: 'We are not connected to any airline and cannot change your booking or your seat in the airline’s systems.',
  },
  {
    lead: 'Not a guarantee',
    text: 'A swap is an agreement between passengers to change seats once on board. It is not binding, and anyone can change their mind. If a swap does not happen, you keep the seat the airline gave you.',
  },
  {
    lead: 'Not the last word',
    text: 'Cabin crew decide who sits where. Exit rows in particular have rules about who may sit in them. We never offer a swap that would put a child you told us about in one, but other rules apply too, and if the crew say no, the swap is off.',
  },
];

const ASKS = [
  'Be at least 16, and only sign up for flights you are actually on.',
  'Tell us truthfully how many of your group are under 16. It is what keeps children out of exit-row swaps.',
  'Give the seats you were really assigned. Claiming a seat that is not yours blocks the person who has it from taking part.',
  'Use one Telegram account, and do not automate sign-ups.',
  'Pick a name to show that is not your full name and would not offend the people you swap with.',
  'Be decent on board. If someone changes their mind, they keep their seat, and that is fine.',
];

const TOC = [
  { id: 't01', label: 'What this is' },
  { id: 't02', label: 'What we are not' },
  { id: 't03', label: 'What we ask of you' },
  { id: 't04', label: 'Boarding pass badge' },
  { id: 't05', label: 'No warranty' },
  { id: 't06', label: 'Changes and contact' },
];

export default function TermsPage() {
  const who = operator();

  return (
    <LegalPage
      title="Terms"
      lede="Short, because the product is: free, one Telegram login, nothing to buy. The parts that carry weight are the ones about what we are not."
      updated={UPDATED}
      toc={TOC}
      other={{ href: '/privacy', label: 'Privacy' }}
    >
      <LegalSection id="t01" n={1} title="What this is">
        <p>
          seatswap is a free service run by {who.name}. Passengers on the same flight
          tell us the seat they have and the seat they would like, and we look for
          swaps where everyone involved ends up better off. By signing up you agree to
          these terms and to our <Link href="/privacy" className="link">privacy policy</Link>.
        </p>
      </LegalSection>

      <LegalSection id="t02" n={2} title="What we are not">
        <ul className="divide-y divide-soft overflow-hidden rounded-card border border-line-strong bg-white">
          {NOT.map((item) => (
            <li key={item.lead} className="flex flex-col gap-1 px-[18px] py-[15px]">
              <p className="font-semibold text-ink">{item.lead}</p>
              <p className="text-sm">{item.text}</p>
            </li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection id="t03" n={3} title="What we ask of you">
        <ol className="flex flex-col gap-2.5">
          {ASKS.map((text, index) => (
            <li key={text} className="flex gap-[11px] leading-[1.55]">
              <span className="flex-none pt-[3px] font-mono text-[11px] text-body" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
        <p>
          We may remove a sign-up, or stop an account from using the service, if these
          rules are broken.
        </p>
      </LegalSection>

      <LegalSection id="t04" n={4} title="Boarding pass badge">
        <p>
          A badge means a seat was read from a boarding pass and checked against the
          flight, the aircraft and the seats other people have claimed. Boarding passes
          are not digitally signed, so a badge is a strong hint, not proof of anything.
        </p>
      </LegalSection>

      <LegalSection id="t05" n={5} title="No warranty">
        <p>
          The service is free and provided as it is. We do our best to keep it
          running and correct, but flight data can be wrong, messages can be late and
          the service can be unavailable. As far as the law allows, we are not liable
          for a swap that does not happen, or for what happens on board. Nothing here
          limits rights you have under consumer law that cannot be limited.
        </p>
      </LegalSection>

      <LegalSection id="t06" n={6} title="Changes and contact">
        <p>
          We may update these terms; the current version is always on this page, with
          its date at the top. Questions go to <Email address={who.email} />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
