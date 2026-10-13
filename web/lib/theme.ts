/**
 * The light or dark choice made with the header's toggle.
 *
 * Kept out of components/ThemeToggle.tsx because that is a client module, and
 * a constant imported from one into the server layout arrives as a client
 * reference, not as the string.
 */

/** The localStorage key. The choice never reaches the server. */
export const THEME_KEY = 'theme';

/**
 * Runs in <head>, before the page paints, so a visitor who chose dark never
 * sees a white flash. Keep it tiny and dependency-free.
 */
export const THEME_SCRIPT =
  `try{var t=localStorage.getItem('${THEME_KEY}');`
  + `if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
