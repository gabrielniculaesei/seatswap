import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#11181c',
        muted: '#6b7280',
        // Decorative dividers and card outlines only. At 1.24:1 on white it is too
        // faint to be the only thing that shows where a control is.
        line: '#e5e7eb',
        // The border of anything you type into or press: 3.38:1 on white, over
        // the 3:1 WCAG asks of a control's boundary (1.4.11).
        field: '#868c96',
        accent: {
          DEFAULT: '#0f766e',
          // Hover for filled buttons. Fading the accent instead (the old
          // `hover:opacity-90`) took white text on it to 4.48:1, just under AA.
          dark: '#115e59',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
