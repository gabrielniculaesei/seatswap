/** Session cookie signing. A forgeable cookie is a login bypass. */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { MAX_AGE_SECONDS, cookieOptions, sign, verify } from './session.ts';

const NOW = new Date('2026-09-14T12:00:00Z');
let previousSecret: string | undefined;

before(() => {
  previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'a-test-secret-long-enough-to-pass';
});

after(() => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});

describe('sign and verify', () => {
  test('round-trips a session', () => {
    const token = sign({ uid: 42, name: 'Anna B.' });
    const session = verify(token, NOW);
    assert.equal(session?.uid, 42);
    assert.equal(session?.name, 'Anna B.');
  });

  test('rejects a tampered payload', () => {
    const token = sign({ uid: 42, name: 'Anna B.' });
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ uid: 1, name: 'x', iat: 0 })).toString('base64url')}.${sig}`;
    assert.equal(verify(forged, NOW), null);
  });

  test('rejects a token signed with a different secret', () => {
    const token = sign({ uid: 42, name: 'Anna B.' });
    process.env.SESSION_SECRET = 'a-completely-different-secret-value';
    try {
      assert.equal(verify(token, NOW), null);
    } finally {
      process.env.SESSION_SECRET = 'a-test-secret-long-enough-to-pass';
    }
  });

  test('rejects an unsigned token', () => {
    const body = Buffer.from(JSON.stringify({ uid: 1, name: 'x', iat: 0 })).toString('base64url');
    assert.equal(verify(body, NOW), null);
  });

  test('rejects junk', () => {
    for (const junk of ['', '.', 'a.b', 'not-a-token', undefined, null]) {
      assert.equal(verify(junk as never, NOW), null);
    }
  });

  test('rejects an expired session', () => {
    const old = Math.floor(NOW.getTime() / 1000) - MAX_AGE_SECONDS - 1;
    const token = sign({ uid: 42, name: 'Anna B.', iat: old });
    assert.equal(verify(token, NOW), null);
  });

  test('accepts a session just inside its lifetime', () => {
    const recent = Math.floor(NOW.getTime() / 1000) - MAX_AGE_SECONDS + 60;
    const token = sign({ uid: 42, name: 'Anna B.', iat: recent });
    assert.equal(verify(token, NOW)?.uid, 42);
  });
});

describe('cookieOptions', () => {
  test('is httpOnly and same-site', () => {
    const options = cookieOptions();
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, 'lax');
    assert.equal(options.path, '/');
  });
});
