import { ImageResponse } from 'next/og';

import { OG_SIZE, OgCard } from '../components/OgCard.tsx';

export const alt = 'seatswap — swap into a better seat, for free';
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Free seat swaps, same flight"
        headline="Swap into a better seat."
        detail="Everyone gains. Nobody asks for a favour."
      />
    ),
    size,
  );
}
