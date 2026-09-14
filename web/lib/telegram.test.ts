/**
 * Telegram Login Widget verification.
 *
 * Anyone who can forge this can impersonate any user on any flight, so the
 * forgery attempts matter more than the happy path.
 */

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import {
  MAX_AUTH_AGE_SECONDS,
  TelegramAuthError,
  type TelegramLoginPayload,
  dataCheckString,
  displayNameFrom,
  verifyLogin,
} from './telegram.ts';

const BOT_TOKEN = '123456:test-token-not-a-real-one';
const NOW = new Date('2026-09-14T12:00:00Z');
const AUTH_DATE = String(Math.floor(NOW.getTime() / 1000) - 60);

let previousToken: string | undefined;

before(() => {
  previousToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
});

after(() => {
  if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = previousToken;
});

/** Build a payload signed the way Telegram signs one. */
function signed(fields: Record<string, string>): TelegramLoginPayload {
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString(fields)).digest('hex');
  return { ...fields, hash } as unknown as TelegramLoginPayload;
}

const validPayload = () =>
  signed({
    id: '987654321',
    first_name: 'Anna',
    last_name: 'Bianchi',
    username: 'annab',
    auth_date: AUTH_DATE,
  });

describe('dataCheckString', () => {
  test('sorts keys and excludes the hash', () => {
    const built = dataCheckString({ b: '2', a: '1', hash: 'ignored', c: '3' });
    assert.equal(built, 'a=1\nb=2\nc=3');
  });

  test('keeps values containing = and newlines intact', () => {
    assert.equal(dataCheckString({ a: 'x=y' }), 'a=x=y');
  });
});

describe('verifyLogin', () => {
  test('accepts a correctly signed payload', () => {
    const identity = verifyLogin(validPayload(), NOW);
    assert.equal(identity.telegramUserId, 987654321);
    assert.equal(identity.suggestedName, 'Anna B.');
  });

  test('rejects a tampered user id', () => {
    const payload = { ...validPayload(), id: '111' };
    assert.throws(() => verifyLogin(payload, NOW), TelegramAuthError);
  });

  test('rejects a tampered name', () => {
    const payload = { ...validPayload(), first_name: 'Mallory' };
    assert.throws(() => verifyLogin(payload, NOW), TelegramAuthError);
  });

  test('rejects an added field', () => {
    const payload = { ...validPayload(), is_admin: 'true' } as TelegramLoginPayload;
    assert.throws(() => verifyLogin(payload, NOW), TelegramAuthError);
  });

  test('rejects a missing hash', () => {
    const { hash, ...rest } = validPayload() as unknown as Record<string, string>;
    assert.throws(() => verifyLogin(rest as unknown as TelegramLoginPayload, NOW), TelegramAuthError);
  });

  test('rejects a hash of the right shape but wrong value', () => {
    const payload = { ...validPayload(), hash: 'a'.repeat(64) };
    assert.throws(() => verifyLogin(payload, NOW), TelegramAuthError);
  });

  test('rejects a payload signed with a different bot token', () => {
    const secret = createHash('sha256').update('999:someone-elses-bot').digest();
    const fields = { id: '1', auth_date: AUTH_DATE };
    const hash = createHmac('sha256', secret).update(dataCheckString(fields)).digest('hex');
    assert.throws(
      () => verifyLogin({ ...fields, hash } as unknown as TelegramLoginPayload, NOW),
      TelegramAuthError,
    );
  });

  test('rejects a login older than the replay window', () => {
    const stale = String(Math.floor(NOW.getTime() / 1000) - MAX_AUTH_AGE_SECONDS - 10);
    const payload = signed({ id: '1', auth_date: stale });
    assert.throws(() => verifyLogin(payload, NOW), /expired/);
  });

  test('accepts a login just inside the replay window', () => {
    const recent = String(Math.floor(NOW.getTime() / 1000) - MAX_AUTH_AGE_SECONDS + 60);
    const payload = signed({ id: '1', auth_date: recent });
    assert.equal(verifyLogin(payload, NOW).telegramUserId, 1);
  });

  test('rejects a login from the future', () => {
    const future = String(Math.floor(NOW.getTime() / 1000) + 3600);
    const payload = signed({ id: '1', auth_date: future });
    assert.throws(() => verifyLogin(payload, NOW), /future/);
  });

  test('tolerates small clock skew', () => {
    const slightlyAhead = String(Math.floor(NOW.getTime() / 1000) + 30);
    const payload = signed({ id: '1', auth_date: slightlyAhead });
    assert.equal(verifyLogin(payload, NOW).telegramUserId, 1);
  });
});

describe('displayNameFrom', () => {
  test('never produces a full name', () => {
    assert.equal(displayNameFrom('Anna', 'Bianchi'), 'Anna B.');
    assert.equal(displayNameFrom('Anna', 'bianchi'), 'Anna B.');
  });

  test('falls back through first name, username, then a generic label', () => {
    assert.equal(displayNameFrom('Anna'), 'Anna');
    assert.equal(displayNameFrom(undefined, undefined, 'annab'), 'annab');
    assert.equal(displayNameFrom(), 'Traveller');
  });

  test('caps at the 40 characters the column allows', () => {
    const long = displayNameFrom('A'.repeat(60), 'Bianchi');
    assert.ok(long.length <= 40);
  });

  test('trims whitespace', () => {
    assert.equal(displayNameFrom('  Anna  ', '  Bianchi '), 'Anna B.');
  });
});
