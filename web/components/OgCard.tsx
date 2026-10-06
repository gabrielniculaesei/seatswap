/**
 * The social preview card, as JSX for `next/og`'s ImageResponse.
 *
 * This is what a flight link turns into when it is pasted into a WhatsApp group,
 * which is the sharing channel the whole product is built around.
 * It is drawn by Satori, not a browser: inline styles only, and every element
 * with more than one child needs `display: flex`.
 */

export const OG_SIZE = { width: 1200, height: 630 };

const INK = '#11181c';
// Secondary text: #4b5563, the same as the site's `body` token.
const MUTED = '#4b5563';
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
      {/* The wordmark, with its accent full stop, as in the site header. */}
      <div style={{ display: 'flex', fontSize: 44, color: INK, fontWeight: 600, letterSpacing: '-0.03em' }}>
        <span>seatswap</span>
        <span style={{ color: ACCENT }}>.</span>
      </div>
    </div>
  );
}

/** The same mark as app/icon.svg: the wordmark's full stop, on the accent. */
export function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill={ACCENT} />
      <circle cx="16" cy="16" r="6" fill="#ffffff" />
    </svg>
  );
}
