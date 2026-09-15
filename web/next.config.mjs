/**
 * Response headers. Nothing else lives here on purpose.
 *
 * HTTPS: Vercel already redirects plain HTTP to HTTPS on every domain it serves.
 * HSTS is what makes the browser stop trying HTTP at all after the first visit,
 * so a session cookie can never be offered over an unencrypted hop. It is sent in
 * production only; browsers ignore it over plain HTTP anyway, so this is about
 * not confusing anyone reading headers locally. No `preload`: that is a
 * commitment made per domain and hard to walk back, so it waits for the domain.
 */

const isProduction = process.env.NODE_ENV === 'production';

const everywhere = [
  ...(isProduction
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nobody has a reason to frame this site, and the sign-up form is worth
  // protecting from clickjacking. This is not a full CSP: the Telegram widget
  // and Next's inline scripts would need one written and tested with care.
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  // The boarding pass form reads files, not the camera (CLAUDE.md §10).
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: everywhere },
      // The agreement token is the only thing guarding that page (CLAUDE.md
      // §13.6). It should not leave in a Referer header, not even to our own
      // pages, where it would end up in access logs.
      { source: '/a/:token', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ];
  },
};

export default config;
