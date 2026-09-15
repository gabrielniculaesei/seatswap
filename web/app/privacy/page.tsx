import type { Metadata } from 'next';
import Link from 'next/link';

import { operator } from '../../lib/operator.ts';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'What seatswap stores about you, why, who sees it, and when it is deleted — '
    + 'which is 24 hours after your flight leaves.',
  alternates: { canonical: '/privacy' },
};

/**
 * The privacy policy (CLAUDE.md §13).
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

export default function PrivacyPage() {
  const who = operator();

  return (
    <article className="space-y-8 text-sm leading-relaxed">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Privacy policy</h1>
        <p className="text-muted">Last updated {UPDATED}</p>
      </header>

      <Section title="The short version">
        <ul className="list-disc space-y-1 pl-5">
          <li>We never have your phone number, your email address or your full name.</li>
          <li>
            Everything about you on a flight is deleted automatically 24 hours after
            that flight departs — or straight away, if you leave the flight.
          </li>
          <li>Your boarding pass barcode is read in your browser and never sent to us.</li>
          <li>No advertising, no analytics, no trackers, and nothing is ever sold.</li>
        </ul>
      </Section>

      <Section title="Who is responsible">
        <p>
          This site is run by {who.name}, who is the data controller for the
          information described here. You can reach them at{' '}
          <Email address={who.email} />.
        </p>
      </Section>

      <Section title="What we store, and why">
        <ul className="divide-y divide-line border-y border-line">
          <Row
            what="Your Telegram user ID (a number, not your phone number)"
            why="To know which sign-ups are yours and to send you messages through our bot"
            until="24 hours after the flight departs"
          />
          <Row
            what="The name you choose to show"
            why="Shown to the people you swap with. We suggest your first name and the initial of your surname; you can change it."
            until="24 hours after the flight departs"
          />
          <Row
            what="How many of you are travelling, how many are under 16, and your seat preferences"
            why="To find swaps that leave everyone better off — and never to offer a child a seat in an exit row, where children may not sit"
            until="24 hours after the flight departs"
          />
          <Row
            what="Your seat numbers, and the check-in number if you scan a boarding pass"
            why="Swaps are made of seats. The check-in number stops two people claiming the same pass."
            until="24 hours after the flight departs"
          />
          <Row
            what="Swaps we proposed to you, and whether you accepted"
            why="So a swap only goes ahead when everyone in it has said yes"
            until="24 hours after the flight departs"
          />
          <Row
            what="A note that your account added a new flight, with the time"
            why="Each account can add a limited number of new flights a day, to stop automated abuse"
            until="A day after it is written, two at most"
          />
        </ul>
        <p>
          If we could not look up a flight&rsquo;s departure time, we assume the latest
          it could be on that date and delete 24 hours after that — never more than
          two and a half days after the departure date.
        </p>
        <p>
          After a flight departs we keep one anonymous line about it — how many groups
          took part, how many swapped and how much they gained on average — with no
          names, IDs or seats in it. Details of the flight itself (number, date, route,
          aircraft) are not about you and are kept.
        </p>
      </Section>

      <Section title="What we never collect">
        <p>
          Your phone number, your email address, your surname, your booking reference,
          any payment details, your location, or your browsing behaviour.
        </p>
        <p>
          <strong className="font-medium text-ink">Boarding passes.</strong> If you
          scan one, the barcode is decoded on your own device. Only the flight number,
          route, day, cabin class, seat and check-in number are sent to us, never your
          name or booking reference. We use them to check the pass matches the flight,
          and store only the seat and the check-in number.
        </p>
      </Section>

      <Section title="Cookies">
        <p>
          We set one cookie, <code>seatswap_session</code>, and only after you sign in
          with Telegram. It holds your Telegram user ID and suggested name, is signed
          so nobody can forge it, and lasts 90 days. It is strictly necessary to keep
          you signed in, which is why there is no cookie banner: we have no other
          cookies to ask about.
        </p>
        <p>
          The Telegram sign-in button is loaded from telegram.org, so Telegram sees
          that you visited a flight page, and may set its own cookies, under{' '}
          <ExternalLink href="https://telegram.org/privacy">
            Telegram&rsquo;s privacy policy
          </ExternalLink>
          .
        </p>
      </Section>

      <Section title="Who else sees it">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="font-medium text-ink">People you swap with</strong> see
            your chosen name, the seats involved and whether your seat was checked
            against a boarding pass. The agreement page can be opened by anyone who has
            its link, until it is deleted with the rest of the flight.
          </li>
          <li>
            <strong className="font-medium text-ink">Anyone looking at a flight
            page</strong> sees totals only — how many groups have signed up and what
            they are looking for. Never names or seats.
          </li>
          <li>
            <strong className="font-medium text-ink">Telegram</strong> handles
            sign-in and delivers our bot&rsquo;s messages.
          </li>
          <li>
            <strong className="font-medium text-ink">Our hosting providers</strong>{' '}
            (Vercel for the website, Neon for the database, and the server that runs
            our matching) store and process the data on our behalf and nothing else.
            Like any web server, they log IP addresses and requests for a short time
            for security.
          </li>
          <li>
            <strong className="font-medium text-ink">AeroDataBox</strong>, our flight
            data provider, receives a flight number and date — nothing about you.
          </li>
        </ul>
        <p>
          Some of these providers are based outside the EU. Where your data leaves the
          EU, it is protected by the European Commission&rsquo;s Standard Contractual
          Clauses or the EU–US Data Privacy Framework.
        </p>
      </Section>

      <Section title="Our legal basis">
        <p>
          We process this information because you asked us to find you a seat swap,
          which we cannot do without it (GDPR Art. 6(1)(b)). The daily cap on new
          flights and our security logs rely on our legitimate interest in keeping the
          service working and free from abuse (Art. 6(1)(f)).
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          You can ask to see, correct, export or delete what we hold about you, or
          object to how we use it. You can change your name and preferences yourself
          at any time on your flight page, and you can leave a flight there too:
          that deletes your sign-up, your seats and your part in any swap straight
          away, without waiting for the flight to depart. For anything else, write
          to{' '}
          <Email address={who.email} /> and we will answer within a month. You can
          also complain to the data protection authority where you live.
        </p>
      </Section>

      <Section title="Age">
        <p>
          You need to be at least 16 to sign up. Children can travel in your group —
          you sign up for them, and we store nothing about them beyond how many of your
          group are under 16, their seat and, if you scan their boarding pass, its
          check-in number.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes, the new version will be here with a new date at the
          top. See also our <Link href="/terms" className="text-accent underline underline-offset-2">terms</Link>.
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

function Row({ what, why, until }: { what: string; why: string; until: string }) {
  // A list rather than a table: three columns of prose do not fit a phone, and
  // a table that scrolls sideways is the worst way to read a privacy policy.
  return (
    <li className="space-y-1 py-3">
      <p className="font-medium text-ink">{what}</p>
      <p className="text-muted">{why}</p>
      <p className="text-muted">
        <span className="font-medium text-ink">Kept until:</span> {until}
      </p>
    </li>
  );
}

function Email({ address }: { address: string }) {
  if (!address.includes('@')) return <strong>{address}</strong>;
  return (
    <a href={`mailto:${address}`} className="text-accent underline underline-offset-2">
      {address}
    </a>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-accent underline underline-offset-2" rel="noopener noreferrer">
      {children}
    </a>
  );
}
