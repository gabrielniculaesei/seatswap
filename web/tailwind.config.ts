import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#11181c',
        muted: '#6b7280',
        line: '#e5e7eb',
        accent: '#0f766e',
      },
    },
  },
  plugins: [],
} satisfies Config;
