/**
 * The social preview card, as JSX for `next/og`'s ImageResponse.
 *
 * This is what a flight link turns into when it is pasted into a WhatsApp group,
 * which is the sharing channel the whole product is built around (CLAUDE.md §5).
 * It is drawn by Satori, not a browser: inline styles only, and every element
 * with more than one child needs `display: flex`.
 */

export const OG_SIZE = { width: 1200, height: 630 };

const INK = '#11181c';
const MUTED = '#6b7280';
const ACCENT = '#0f766e';

export function OgCard({ eyebrow, headline, detail }: {
  eyebrow: string;
  headline: string;
  detail: string;
}) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#ffffff',
        borderTop: `24px solid ${ACCENT}`,
        padding: '64px 80px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 36, color: ACCENT, fontWeight: 600 }}>{eyebrow}</div>
        <div style={{ fontSize: 110, color: INK, fontWeight: 700, lineHeight: 1.1, marginTop: 16 }}>
          {headline}
        </div>
        <div style={{ fontSize: 44, color: MUTED, marginTop: 24 }}>{detail}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 40, color: INK, fontWeight: 600 }}>
        <SeatMark size={56} />
        <span style={{ marginLeft: 20 }}>seatswap</span>
      </div>
    </div>
  );
}

/** The same mark as app/icon.svg. */
export function SeatMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill={ACCENT} />
      <rect x="9" y="6" width="5" height="16" rx="2" fill="#ffffff" />
      <rect x="9" y="18" width="14" height="5" rx="2" fill="#ffffff" />
      <rect x="17" y="22" width="3" height="5" fill="#ffffff" />
    </svg>
  );
}
