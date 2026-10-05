import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#11181c',
        // Secondary text inside white cards only: 4.83:1 on white, but 4.07:1 on
        // the page background, which fails AA. On `page`, use `body`.
        muted: '#6b7280',
        // Body copy, and any secondary text that sits on the page background
        // (6.92:1 on it).
        body: '#4b5563',
        // The page behind the white cards.
        page: '#f7f8f8',
        // Card footer strips and the cabin diagram's well.
        well: '#fbfcfc',
        // Decorative dividers and card outlines only. At 1.24:1 on white it is too
        // faint to be the only thing that shows where a control is.
        line: {
          DEFAULT: '#e5e7eb',
          // The outline of a raised card, one step firmer than a plain one.
          strong: '#d9dcde',
        },
        // Dividers inside a card, softer than `line`: `divide-soft`, `border-soft`.
        soft: '#eef0f1',
        // The border of anything you type into or press: 3.38:1 on white, over
        // the 3:1 WCAG asks of a control's boundary (1.4.11).
        field: '#868c96',
        // Dashed outline of a placeholder slot or drop well.
        slot: '#b9bfc5',
        // The track behind a segmented control, and a neutral badge.
        track: '#f1f3f3',
        'seat-empty': '#e9ebec',
        danger: '#b3261e',
        accent: {
          DEFAULT: '#0f766e',
          // Hover for filled buttons. Fading the accent instead (the old
          // `hover:opacity-90`) took white text on it to 4.48:1, just under AA.
          dark: '#115e59',
        },
      },
      fontFamily: {
        // Anything a person wrote is Archivo; anything that is data (flight
        // numbers, seats, dates, counts, the small uppercase labels) is Plex Mono.
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        card: '10px',
      },
      boxShadow: {
        raised: '0 1px 2px rgba(17,24,28,.05)',
        hero: '0 1px 2px rgba(17,24,28,.05), 0 8px 24px -16px rgba(17,24,28,.22)',
        seg: '0 1px 2px rgba(17,24,28,.13)',
        // Focus halo on text inputs, on top of the border turning accent.
        field: '0 0 0 3px rgba(15,118,110,.12)',
      },
    },
  },
  plugins: [],
} satisfies Config;
