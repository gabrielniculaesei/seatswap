/**
 * The verification badge.
 *
 * Three rungs, none of them required to take part. The wording is deliberately
 * modest, because the standard does not let us claim more: BCBP carries no usable
 * signature, so reading a boarding pass tells us what it says, not that it is
 * genuine. "Checked against the flight" is true; "verified traveller" would not be,
 * and a badge that overstates itself is worse than no badge — people would read
 * a swap partner's badge as a promise about a stranger.
 *
 * What it actually represents is that the seat survived cross-checking: the flight
 * exists on that date, the seat exists on that aircraft, and nobody else on the
 * flight has claimed that seat or that check-in number.
 */

export interface VerificationBadgeProps {
  tier: number;
  /** `full` explains itself; `compact` is for lists where space is tight. */
  variant?: 'full' | 'compact';
}

const TIERS: Record<number, { label: string; short: string; title: string }> = {
  1: {
    label: 'Boarding pass checked',
    short: 'Pass checked',
    title:
      'Read from a boarding pass barcode and cross-checked against the flight, the '
      + 'aircraft and the seats already claimed. Boarding passes are not digitally '
      + 'signed, so this is a strong hint, not proof.',
  },
  2: {
    label: 'Booking verified',
    short: 'Booking verified',
    title: 'Confirmed against a signed booking email from the airline.',
  },
};

export default function VerificationBadge({ tier, variant = 'full' }: VerificationBadgeProps) {
  const rung = TIERS[tier];
  // Tier 0 is the default and the majority, and it is fine. Marking it would turn
  // "normal" into "suspect", which is the opposite of what the tiers are for.
  if (!rung) return null;

  return (
    <span
      title={rung.title}
      className={
        'inline-flex items-center gap-[5px] rounded-md border border-accent/30 '
        + 'bg-accent/[.06] font-medium text-accent '
        + (variant === 'compact' ? 'px-[7px] py-0.5 text-[10.5px]' : 'px-2 py-[3px] text-[11px]')
      }
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-2.5 w-2.5 fill-current">
        <path d="M8 1 2.5 3.3v4.2c0 3.2 2.3 6.2 5.5 7.2 3.2-1 5.5-4 5.5-7.2V3.3L8 1Zm2.6 5.2-3 3.6a.7.7 0 0 1-1 .1L4.9 8.5a.7.7 0 1 1 .9-1l1.2 1 2.5-3a.7.7 0 1 1 1.1.8Z" />
      </svg>
      {variant === 'compact' ? rung.short : rung.label}
    </span>
  );
}
