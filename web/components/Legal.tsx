import { NavLink, PageShell } from './Chrome.tsx';
import { formatDay } from '../lib/format.ts';

/**
 * The shell shared by the privacy policy and the terms: a title block, the
 * numbered sections, and a table of contents beside them that wraps underneath
 * on a phone.
 */

export interface TocEntry {
  id: string;
  label: string;
}

export function LegalPage({
  title,
  lede,
  updated,
  toc,
  other,
  children,
}: {
  title: string;
  lede: string;
  /** ISO date of the last change. */
  updated: string;
  toc: TocEntry[];
  /** The other legal page, linked from the header. */
  other: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <PageShell
      nav={
        <>
          <NavLink href="/">Home</NavLink>
          <NavLink href={other.href}>{other.label}</NavLink>
        </>
      }
    >
      <section className="flex flex-col gap-2.5 pb-6 pt-10">
        <p className="eyebrow">Legal · last updated {formatDay(updated)}</p>
        <h1 className="text-[clamp(30px,5.6vw,42px)] font-semibold leading-[1.04] tracking-[-0.035em]">{title}</h1>
        <p className="max-w-[58ch] text-base text-body">{lede}</p>
      </section>

      <div className="flex flex-wrap items-start gap-6">
        <article className="flex min-w-0 flex-[1_1_430px] flex-col gap-6 text-[14.5px] leading-[1.6] text-body">
          {children}
        </article>

        <nav
          aria-label="On this page"
          className="min-w-[190px] flex-[0_1_210px] overflow-hidden rounded-card border border-line bg-white"
        >
          <div className="border-b border-line bg-well px-3.5 py-[11px]">
            <span className="label-mono font-normal">On this page</span>
          </div>
          <ol className="flex flex-col gap-px p-1.5">
            {toc.map((entry, index) => (
              <li key={entry.id}>
                <a
                  href={`#${entry.id}`}
                  className="flex gap-[9px] rounded-md px-[9px] py-[7px] text-[13px] text-body hover:bg-[#f4f5f5] hover:text-ink"
                >
                  <span className="font-mono text-[11px] text-muted">{number(index)}</span>
                  <span>{entry.label}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </PageShell>
  );
}

/** A numbered section. `n` counts from 1 and must match its place in the toc. */
export function LegalSection({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-2.5">
      <div className="flex items-baseline gap-[11px] border-t border-line pt-[13px]">
        <span className="font-mono text-[11px] font-semibold text-accent">{number(n - 1)}</span>
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** Bold lead-in inside legal prose. */
export function Lead({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

export function Email({ address }: { address: string }) {
  // Unset in the environment, operator() gives a visible placeholder instead.
  if (!address.includes('@')) return <strong className="text-ink">{address}</strong>;
  return <a href={`mailto:${address}`} className="link">{address}</a>;
}

function number(index: number): string {
  return String(index + 1).padStart(2, '0');
}
