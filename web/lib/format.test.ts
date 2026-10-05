import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDay, formatUtcDay, formatUtcMinute } from './format.ts';

test('a calendar date prints without touching a time zone', () => {
  assert.equal(formatDay('2026-10-12'), '12 Oct 2026');
  assert.equal(formatDay('2027-01-01'), '1 Jan 2027');
  assert.equal(formatDay('2026-12-31'), '31 Dec 2026');
});

test('a moment prints in UTC, whatever the server thinks the time zone is', () => {
  // 23:30 UTC is already the next day east of Greenwich; it must still say the 11th.
  const late = new Date('2026-10-11T23:30:00Z');
  assert.equal(formatUtcDay(late), '11 Oct 2026');
  assert.equal(formatUtcMinute(late), '11 Oct 2026, 23:30 UTC');
  assert.equal(formatUtcMinute(new Date('2026-10-11T08:40:59Z')), '11 Oct 2026, 08:40 UTC');
});
