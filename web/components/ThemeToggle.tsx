'use client';

import { useEffect, useState } from 'react';

import { THEME_KEY } from '../lib/theme.ts';

/**
 * Light or dark, overriding the system setting.
 *
 * With no choice made the site follows the system, and choosing the same thing
 * the system already shows forgets the choice again, so nobody gets stuck on a
 * theme after changing their phone's setting. The choice lives in this
 * browser's localStorage and never reaches the server; THEME_SCRIPT (lib/theme.ts)
 * applies it before the first paint.
 */

function systemIsDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function isDark(): boolean {
  const chosen = document.documentElement.dataset.theme;
  return chosen ? chosen === 'dark' : systemIsDark();
}

export default function ThemeToggle() {
  // Unknown until mounted: the server cannot see the visitor's setting. The
  // icons switch through CSS, so only aria-pressed waits for this.
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(isDark());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => setDark(isDark());
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);

  function toggle() {
    const next = isDark() ? 'light' : 'dark';
    const root = document.documentElement;
    const followsSystem = (next === 'dark') === systemIsDark();
    try {
      if (followsSystem) localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode or blocked storage: the switch still works for this page.
    }
    if (followsSystem) delete root.dataset.theme;
    else root.dataset.theme = next;
    setDark(next === 'dark');
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Dark mode"
      aria-pressed={dark ?? undefined}
      title="Dark mode"
      className="-m-1.5 rounded-md p-1.5 text-body transition-colors hover:text-ink"
    >
      {/* Moon in light mode, sun in dark: each shows what a press switches to. */}
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className="dark:hidden">
        <path
          d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className="hidden dark:block">
        <circle cx="10" cy="10" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
