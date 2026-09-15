import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { operator } from './operator.ts';

describe('operator', () => {
  test('reads the name and address from the environment', () => {
    const who = operator({ OPERATOR_NAME: ' Ada L. ', CONTACT_EMAIL: 'privacy@example.org ' });
    assert.deepEqual(who, { name: 'Ada L.', email: 'privacy@example.org', configured: true });
  });

  test('says so, visibly, when either is missing', () => {
    // A privacy policy that names nobody must not read as finished.
    const who = operator({ OPERATOR_NAME: 'Ada L.' });
    assert.equal(who.configured, false);
    assert.match(who.email, /CONTACT_EMAIL not set/);

    assert.match(operator({}).name, /OPERATOR_NAME not set/);
  });
});
