// Proxy helpers (pure: no DB/config import needed). Masking never leaks credentials; validation matches the account
// field's rules; the reachability check fails closed on a bad address or a dead port.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProxy, maskAddress, ProxyAddress } from '../src/lib/proxy-check.ts';

test('maskAddress strips any credentials, keeping scheme://host:port', () => {
  assert.equal(maskAddress('http://user:pass@proxy.example.com:8080'), 'http://proxy.example.com:8080');
  assert.equal(maskAddress('https://proxy.example.com:3128'), 'https://proxy.example.com:3128');
  assert.equal(maskAddress('socks5://10.0.0.5:1080'), 'socks5://10.0.0.5:1080');
});

test('ProxyAddress accepts http(s)/socks5 host:port', () => {
  for (const ok of ['http://proxy.example.com:8080', 'https://1.2.3.4:3128', 'socks5://10.0.0.5:1080', 'http://user:pass@h:8080']) {
    assert.equal(ProxyAddress.safeParse(ok).success, true, ok);
  }
});

test('ProxyAddress rejects garbage and SOCKS with credentials', () => {
  for (const bad of ['', 'proxy.example.com:8080', 'ftp://h:21', 'socks5://user:pass@h:1080', `http://h:1/${'x'.repeat(400)}`]) {
    assert.equal(ProxyAddress.safeParse(bad).success, false, bad);
  }
});

test('checkProxy fails on an address that is not a URL', async () => {
  const r = await checkProxy('not a url');
  assert.equal(r.ok, false);
  assert.match(r.detail, /valid proxy address/);
});

test('checkProxy fails closed when nothing answers the port', async () => {
  // Port 1 on localhost: a connect is refused fast and deterministically.
  const r = await checkProxy('http://127.0.0.1:1');
  assert.equal(r.ok, false);
  assert.ok(typeof r.ms === 'number');
});
