import type { Metadata } from 'next';
import Link from 'next/link';

import { Email, Lead, LegalPage, LegalSection } from '../../components/Legal.tsx';
import { operator } from '../../lib/operator.ts';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'What seatswap stores about you, why, who sees it, and when it is deleted: '
    + '24 hours after your flight leaves.',
  alternates: { canonical: '/privacy' },
};

/**
 * The privacy policy.
 *
 * Every claim here is a claim about the code, so it has to move when the code
 * does. The ones most likely to drift: what purge_flight deletes
 * (solver/repository.py), how long flight_creations rows live
 * (lib/flight-quota.ts), what the session cookie holds (lib/session.ts) and which
 * boarding pass fields reach the server (lib/verification.ts).
 */

const UPDATED = '2026-09-15';

// Rendered per request so the operator's name and address, and the canonical
// URL, come from the running environment rather than the build's (see robots.ts).
export const dynamic = 'force-dynamic';

const DAY = '24h after departure';

const STORED = [
  {
    what: 'Your Telegram user ID, a number and not your phone number',
    why: 'To know which sign-ups are yours and to send you messages through our bot.',
    until: DAY,
  },
  {
    what: 'The name you choose to show',
    why: 'Shown to the people you swap with. We suggest your first name and the initial of your surname, and you can change it.',
    until: DAY,
  },
  {
    what: 'How many of you are travelling, how many are under 16, and your seat preferences',
    why: 'To find swaps that leave everyone better off, and never to offer a child a seat in an exit row, where children may not sit.',
    until: DAY,
  },
  {
    what: 'Your seat numbers, and the check-in number if you scan a boarding pass',
    why: 'Swaps are made of seats. The check-in number stops two people claiming the same pass.',
    until: DAY,
  },
  {
    what: 'Swaps we proposed to you, and whether you accepted',
    why: 'So a swap only goes ahead when everyone in it has said yes.',
    until: DAY,
  },
  {
    what: 'A note that your account added a new flight, with the time',
    why: 'Each account can add a limited number of new flights a day, to stop automated abuse.',
    until: 'A day after it is written, two at most',
  },
];

const SHORT_VERSION = [
  'We never have your phone number, your email address or your full name.',
  'Everything about you on a flight is deleted automatically 24 hours after that flight departs, or straight away if you leave the flight.',
  'Your boarding pass barcode is read in your browser and never sent to us.',
  'No advertising, no analytics, no trackers, and nothing is ever sold.',
];

const TOC = [
  { id: 's01', label: 'Who is responsible' },
  { id: 's02', label: 'What we store' },
  { id: 's03', label: 'Never collected' },
  { id: 's04', label: 'Cookies' },
  { id: 's05', label: 'Who else sees it' },
  { id: 's06', label: 'Legal basis' },
  { id: 's07', label: 'Your rights' },
  { id: 's08', label: 'Age' },
  { id: 's09', label: 'Changes' },
];

// One track definition for the header strip and every row, so they line up.
const TRACKS = 'grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-3.5 gap-y-1.5';

export default function PrivacyPage() {
  const who = operator();

  return (
    <LegalPage
      title="Privacy policy"
      lede="Every claim here is a claim about the code, so it moves when the code does."
      updated={UPDATED}
      toc={TOC}
      other={{ href: '/terms', label: 'Terms' }}
    >
      <section className="overflow-hidden rounded-card border border-line-strong bg-white">
        <div className="border-b border-line px-[18px] py-[13px]">
          <h2 className="text-[14.5px] font-semibold text-ink">The short version</h2>
        </div>
        <ul className="divide-y divide-soft">
          {SHORT_VERSION.map((line) => (
            <li key={line} className="flex gap-[11px] px-[18px] py-3 text-sm leading-[1.55]">
              <span className="mt-[9px] h-[5px] w-[5px] flex-none rounded-full bg-accent" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>

      <LegalSection id="s01" n={1} title="Who is responsible">
        <p>
          This site is run by {who.name}, who is the data controller for the
          information described here. You can reach them at{' '}
          <Email address={who.email} />.
        </p>
      </LegalSection>

      <LegalSection id="s02" n={2} title="What we store, and why">
        {/* A grid that wraps rather than a table: three columns of prose do not
            fit a phone, and a table that scrolls sideways is the worst way to
            read a privacy policy. */}
        <div role="table" aria-label="What we store" className="overflow-hidden rounded-card border border-line bg-white">
          <div role="row" className={`${TRACKS} border-b border-line bg-well px-4 py-[9px]`}>
            <span role="columnheader" className="label-mono font-normal">What</span>
            <span role="columnheader" className="label-mono font-normal">Why</span>
            <span role="columnheader" className="label-mono font-normal">Kept until</span>
          </div>
          {STORED.map((row) => (
            <div key={row.what} role="row" className={`${TRACKS} border-b border-soft px-4 py-[13px] last:border-b-0`}>
              <span role="cell" className="min-w-0 text-[13.5px] font-semibold text-ink">{row.what}</span>
              <span role="cell" className="min-w-0 text-[13.5px]">{row.why}</span>
              <span role="cell" className="min-w-0 font-mono text-[11.5px]">{row.until}</span>
            </div>
          ))}
        </div>
        <p>
          If we could not look up a flight&rsquo;s departure time, we assume the latest
          it could be on that date and delete 24 hours after that, so never more than
          two and a half days after the departure date.
        </p>
        <p>
          After a flight departs we keep one anonymous line about it, covering how
          many groups took part, how many swapped and how much they gained on
          average, with no names, IDs or seats in it. Details of the flight itself
          (number, date, route, aircraft) are not about you and are kept.
        </p>
      </LegalSection>

      <LegalSection id="s03" n={3} title="What we never collect">
        <p>
          Your phone number, your email address, your surname, your booking reference,
          any payment details, your location, or your browsing behaviour.
        </p>
        <p>
          <Lead>Boarding passes.</Lead> If you scan one, the barcode is decoded on your
          own device. Only the flight number, route, day, cabin class, seat and
          check-in number are sent to us, never your name or booking reference. We use
          them to check the pass matches the flight, and store only the seat and the
          check-in number.
        </p>
      </LegalSection>

      <LegalSection id="s04" n={4} title="Cookies">
        <p>
          We set one cookie,{' '}
          <code className="rounded bg-soft px-[5px] py-px font-mono text-[13px] text-ink">seatswap_session</code>,
          and only after you sign in with Telegram. It holds your Telegram user ID and
          suggested name, is signed so nobody can forge it, and lasts 90 days. It is
          strictly necessary to keep you signed in, which is why there is no cookie
          banner: we have no other cookies to ask about.
        </p>
        <p>
          The Telegram sign-in button is loaded from telegram.org, so Telegram sees
          that you visited a flight page, and may set its own cookies, under{' '}
          <a href="https://telegram.org/privacy" className="link" rel="noopener noreferrer">
            Telegram&rsquo;s privacy policy
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="s05" n={5} title="Who else sees it">
        <ul className="flex flex-col gap-2.5">
          <li>
            <Lead>People you swap with</Lead> see your chosen name, the seats involved
            and whether your seat was checked against a boarding pass. The agreement
            page can be opened by anyone who has its link, until it is deleted with the
            rest of the flight.
          </li>
          <li>
            <Lead>Anyone looking at a flight page</Lead> sees totals only, meaning how
            many groups have signed up and what they are looking for. Never names or
            seats.
          </li>
          <li>
            <Lead>Telegram</Lead> handles sign-in and delivers our bot&rsquo;s messages.
          </li>
          <li>
            <Lead>Our hosting providers</Lead> (Vercel for the website, Neon for the
            database, and the server that runs our matching) store and process the data
            on our behalf and nothing else. Like any web server, they log IP addresses
            and requests for a short time for security.
          </li>
          <li>
            <Lead>AeroDataBox</Lead>, our flight data provider, receives a flight
            number and date, and nothing about you.
          </li>
        </ul>
        <p>
          Some of these providers are based outside the EU. Where your data leaves the
          EU, it is protected by the European Commission&rsquo;s Standard Contractual
          Clauses or the EU–US Data Privacy Framework.
        </p>
      </LegalSection>

      <LegalSection id="s06" n={6} title="Our legal basis">
        <p>
          We process this information because you asked us to find you a seat swap,
          which we cannot do without it (GDPR Art. 6(1)(b)). The daily cap on new
          flights and our security logs rely on our legitimate interest in keeping the
          service working and free from abuse (Art. 6(1)(f)).
        </p>
      </LegalSection>

      <LegalSection id="s07" n={7} title="Your rights">
        <p>
          You can ask to see, correct, export or delete what we hold about you, or
          object to how we use it. You can change your name and preferences yourself
          at any time on your flight page, and you can leave a flight there too: that
          deletes your sign-up, your seats and your part in any swap straight away,
          without waiting for the flight to depart. For anything else, write to{' '}
          <Email address={who.email} /> and we will answer within a month. You can
          also complain to the data protection authority where you live.
        </p>
      </LegalSection>

      <LegalSection id="s08" n={8} title="Age">
        <p>
          You need to be at least 16 to sign up. Children can travel in your group:
          you sign up for them, and we store nothing about them beyond how many of
          your group are under 16, their seat and, if you scan their boarding pass,
          its check-in number.
        </p>
      </LegalSection>

      <LegalSection id="s09" n={9} title="Changes">
        <p>
          If this policy changes, the new version will be here with a new date at the
          top. See also our <Link href="/terms" className="link">terms</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
