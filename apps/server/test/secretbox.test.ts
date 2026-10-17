// secretbox roundtrip. config validates process.env at import, so set the needed vars before importing it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgres://test';
process.env.CREDENTIALS_KEY = crypto.randomBytes(32).toString('base64');

const { encryptSecret, decryptSecret, secretEquals, credentialsEnabled } = await import('../src/lib/secretbox.ts');

test('encrypt/decrypt roundtrip', () => {
  assert.equal(credentialsEnabled(), true);
  const secret = 'hunter2 · 🔐 café';
  const blob = encryptSecret(secret);
  assert.match(blob, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.notEqual(blob, secret);
  assert.equal(decryptSecret(blob), secret);
});

test('two encryptions of the same secret differ (random IV) but both decrypt', () => {
  const a = encryptSecret('same');
  const b = encryptSecret('same');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), 'same');
  assert.equal(decryptSecret(b), 'same');
});

test('secretEquals: constant-time compare, wrong password fails, tampered blob fails', () => {
  const blob = encryptSecret('correct horse');
  assert.equal(secretEquals(blob, 'correct horse'), true);
  assert.equal(secretEquals(blob, 'correct hors'), false);
  assert.equal(secretEquals(blob, 'wrong'), false);
  assert.equal(secretEquals('v1:bad:blob:here', 'correct horse'), false);
});
