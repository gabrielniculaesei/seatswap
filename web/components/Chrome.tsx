import Link from 'next/link';

/**
 * The pieces every page is built from: the header and footer bars, and the card
 * anatomy used for everything that sits on the page background (a header strip,
 * a body, and optionally a footer strip).
 *
 * Pages render their own header rather than the layout, because what it links
 * to changes from page to page and the agreement page narrows to 680px.
 */

type Width = 'wide' | 'narrow';

const CONTAINER: Record<Width, string> = {
  wide: 'mx-auto w-full max-w-[960px] px-6',
  narrow: 'mx-auto w-full max-w-[680px] px-6',
};

export function Wordmark({ size = 'header' }: { size?: 'header' | 'footer' }) {
  return (
    <span
      className={
        'font-semibold leading-none tracking-[-0.03em] text-ink '
        + (size === 'header' ? 'text-[18px]' : 'text-[15px]')
      }
    >
      seatswap<span className="text-accent">.</span>
    </span>
  );
}

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-[13.5px] text-body hover:text-ink">
      {children}
    </Link>
  );
}

export function PageShell({
  nav,
  width = 'wide',
  homeLink = true,
  tagline = true,
  children,
}: {
  /** The right-hand side of the header bar. */
  nav?: React.ReactNode;
  width?: Width;
  /** The agreement page is held up at a gate; its wordmark goes nowhere. */
  homeLink?: boolean;
  tagline?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="border-b border-line bg-white">
        <div className={`${CONTAINER[width]} flex h-14 items-center justify-between gap-4`}>
          {homeLink ? (
            <Link href="/" aria-label="seatswap home">
              <Wordmark />
            </Link>
          ) : (
            <Wordmark />
          )}
          {nav ? <nav aria-label="Site" className="flex items-center gap-5">{nav}</nav> : null}
        </div>
      </header>

      <main className={`${CONTAINER[width]} flex-1`}>{children}</main>

      <footer className="mt-11 border-t border-line bg-white">
        <div
          className={`${CONTAINER[width]} flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3.5 pb-[30px] pt-[22px]`}
        >
          <div className="flex flex-col gap-[5px]">
            <Wordmark size="footer" />
            {tagline ? (
              <p className="max-w-[52ch] text-[13px] text-body">
                Nothing to pay, and nothing to install. Everything about a flight is
                deleted 24 hours after it departs.
              </p>
            ) : null}
          </div>
          <nav aria-label="Legal" className="flex gap-[18px] text-[13px]">
            <Link href="/privacy" className="link">Privacy</Link>
            <Link href="/terms" className="link">Terms</Link>
          </nav>
        </div>
      </footer>
    </>
  );
}

export function Card({
  raised = false,
  className = '',
  children,
}: {
  /** A firmer outline and a small shadow, for the one card a page is about. */
  raised?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        'overflow-hidden rounded-card border bg-white '
        + (raised ? 'border-line-strong shadow-raised ' : 'border-line ')
        + className
      }
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  meta,
  id,
  children,
}: {
  title: React.ReactNode;
  /** A mono uppercase note on the right. */
  meta?: React.ReactNode;
  id?: string;
  /** A control on the right, in place of `meta`. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line px-4 py-[13px]">
      <h2 id={id} className="text-[14.5px] font-semibold">{title}</h2>
      {meta ? <span className="meta-mono">{meta}</span> : null}
      {children}
    </div>
  );
}

export function CardFooter({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`border-t border-line bg-well px-4 py-[11px] text-[12.5px] text-body ${className}`}>
      {children}
    </div>
  );
}

/** A `<dl>` inside a card: mono label over a line of text, rows divided softly. */
export function FactList({ facts }: { facts: { term: string; detail: React.ReactNode }[] }) {
  return (
    <dl className="divide-y divide-soft">
      {facts.map((fact) => (
        <div key={fact.term} className="flex flex-col gap-[3px] px-4 py-[13px]">
          <dt className="meta-mono tracking-[0.09em]">{fact.term}</dt>
          <dd className="text-sm text-ink">{fact.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A section on the page background: rule, eyebrow, heading, optional meta. */
export function SectionHeading({
  eyebrow,
  title,
  meta,
  id,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  id?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2.5 border-t border-line pt-3.5">
      <div className="flex flex-col gap-1">
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={id} className="text-[19px] font-semibold tracking-[-0.02em]">{title}</h2>
      </div>
      {meta ? <p className="font-mono text-[11px] tracking-[0.04em] text-body">{meta}</p> : null}
    </div>
  );
}
