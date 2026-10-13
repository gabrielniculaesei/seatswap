import type { Config } from 'tailwindcss';

// The values live in app/globals.css, once for light and once for dark, so a
// class like `bg-surface` or `text-accent/30` follows the visitor's system
// setting without a `dark:` variant on every element. The contrast figures
// below are for light; the dark ones are noted next to their values.
const color = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: color('ink'),
        // Secondary text inside white cards only: 4.83:1 on white, but 4.07:1 on
        // the page background, which fails AA. On `page`, use `body`.
        muted: color('muted'),
        // Body copy, and any secondary text that sits on the page background
        // (6.92:1 on it).
        body: color('body'),
        // The page behind the cards.
        page: color('page'),
        // Cards, the header and footer bars, and anything you type into: white
        // in light mode.
        surface: color('surface'),
        // Text and marks on a filled accent background: white in light mode,
        // near-black in dark, where the accent is a lighter teal.
        'on-accent': color('on-accent'),
        // Row hover and the selected row in a list inside a card.
        hover: color('hover'),
        selected: color('selected'),
        // Card footer strips and the cabin diagram's well.
        well: color('well'),
        // Decorative dividers and card outlines only. At 1.24:1 on white it is too
        // faint to be the only thing that shows where a control is.
        line: {
          DEFAULT: color('line'),
          // The outline of a raised card, one step firmer than a plain one.
          strong: color('line-strong'),
        },
        // Dividers inside a card, softer than `line`: `divide-soft`, `border-soft`.
        soft: color('soft'),
        // The border of anything you type into or press: 3.38:1 on white, over
        // the 3:1 WCAG asks of a control's boundary (1.4.11).
        field: color('field'),
        // Dashed outline of a placeholder slot or drop well.
        slot: color('slot'),
        // The track behind a segmented control, and a neutral badge.
        track: color('track'),
        'seat-empty': color('seat-empty'),
        danger: color('danger'),
        accent: {
          DEFAULT: color('accent'),
          // Hover for filled buttons. Fading the accent instead (the old
          // `hover:opacity-90`) took white text on it to 4.48:1, just under AA.
          dark: color('accent-dark'),
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
        field: '0 0 0 3px rgb(var(--c-accent) / .12)',
      },
    },
  },
  plugins: [],
} satisfies Config;
