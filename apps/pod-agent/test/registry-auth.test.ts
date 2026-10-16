import assert from 'node:assert/strict';
import test from 'node:test';
import { registryAuthHeader, registryHost } from '../src/registry-auth.ts';

const config = (auths: Record<string, unknown>) => JSON.stringify({ auths });
const b64 = (s: string) => Buffer.from(s).toString('base64');
const decode = (h: string | null) => (h ? JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) : null);

test('registry host of an image reference', () => {
  assert.equal(registryHost('h4rb0r.example.com/linkedin-outreach/chrome:abc123'), 'h4rb0r.example.com');
  assert.equal(registryHost('localhost:5000/chrome:1'), 'localhost:5000');
  assert.equal(registryHost('linkedin-console/chrome:latest'), null, 'a local name, not a registry');
  assert.equal(registryHost('alpine:3.22'), null);
});

test('the login from the docker config, as Docker wants it', () => {
  const file = config({ 'h4rb0r.example.com': { auth: b64('robot$deploy:s3cr:et') } });
  assert.deepEqual(decode(registryAuthHeader('h4rb0r.example.com/p/chrome:abc', file)), {
    username: 'robot$deploy',
    password: 's3cr:et',
    serveraddress: 'h4rb0r.example.com',
  });
  // Written by older Docker versions with the scheme.
  const old = config({ 'https://h4rb0r.example.com': { auth: b64('u:p') } });
  assert.equal(decode(registryAuthHeader('h4rb0r.example.com/p/chrome:abc', old)).username, 'u');
});

test('no login: pulled without one', () => {
  assert.equal(registryAuthHeader('other.example.com/p/chrome:1', config({ 'h4rb0r.example.com': { auth: b64('u:p') } })), null);
  assert.equal(registryAuthHeader('linkedin-console/chrome:latest', config({})), null);
  assert.equal(registryAuthHeader('h4rb0r.example.com/p/c:1', config({ 'h4rb0r.example.com': {} })), null, 'credential helper');
  assert.equal(registryAuthHeader('h4rb0r.example.com/p/c:1', 'not json'), null);
});
