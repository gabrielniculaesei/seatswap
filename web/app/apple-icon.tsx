import { ImageResponse } from 'next/og';

import { Mark } from '../components/OgCard.tsx';

/**
 * Home-screen icon for iOS, which will not use an SVG favicon. iOS rounds the
 * corners itself and paints anything transparent black, so the mark sits on a
 * full-bleed square of the same colour.
 */

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: '#0f766e' }}>
        <Mark size={180} />
      </div>
    ),
    size,
  );
}
