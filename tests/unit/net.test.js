'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateAddress, assertPublicUrl, safeFetch, parseHttpUrl } = require('../../src/utils/net');
const { UnsupportedSourceError, ProviderError } = require('../../src/utils/errors');

test('isPrivateAddress blocks internal ranges (SSRF protection)', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  assert.equal(isPrivateAddress('not-an-ip'), true);
});

test('parseHttpUrl only accepts http(s)', () => {
  assert.ok(parseHttpUrl('https://example.com/a.mp3'));
  assert.ok(parseHttpUrl('<https://example.com/a.mp3>'));
  assert.equal(parseHttpUrl('file:///etc/passwd'), null);
  assert.equal(parseHttpUrl('ftp://x'), null);
  assert.equal(parseHttpUrl('just words'), null);
});

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];

test('assertPublicUrl rejects private hosts, credentials and bad schemes', async () => {
  await assert.rejects(assertPublicUrl('http://localhost/a.mp3'), UnsupportedSourceError);
  await assert.rejects(assertPublicUrl('http://127.0.0.1/a.mp3'), UnsupportedSourceError);
  await assert.rejects(assertPublicUrl('http://[::1]/a.mp3'), UnsupportedSourceError);
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'), UnsupportedSourceError);
  await assert.rejects(assertPublicUrl('http://user:pw@example.com/a.mp3', { lookup: publicLookup }), /usernames or passwords/);
  await assert.rejects(assertPublicUrl('http://internal.example/a.mp3', { lookup: privateLookup }), UnsupportedSourceError);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), UnsupportedSourceError);
  const ok = await assertPublicUrl('https://example.com/a.mp3', { lookup: publicLookup });
  assert.equal(ok.hostname, 'example.com');
  // explicit opt-in for local testing
  assert.ok(await assertPublicUrl('http://127.0.0.1/a.mp3', { allowPrivate: true }));
});

function fakeResponse(status, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), body: null };
}

test('safeFetch follows redirects but re-validates every hop', async () => {
  const lookup = async (host) => (host === 'evil.example' ? [{ address: '192.168.0.10' }] : [{ address: '93.184.216.34' }]);
  const fetchImpl = async (url) => {
    if (String(url).includes('start')) return fakeResponse(302, { location: 'http://evil.example/secret' });
    return fakeResponse(200);
  };
  await assert.rejects(safeFetch('https://good.example/start', { fetchImpl, lookup }), UnsupportedSourceError);

  const okFetch = async (url) => (String(url).includes('start') ? fakeResponse(301, { location: '/final.mp3' }) : fakeResponse(200));
  const res = await safeFetch('https://good.example/start', { fetchImpl: okFetch, lookup });
  assert.equal(res.finalUrl, 'https://good.example/final.mp3');
});

test('safeFetch limits redirects and wraps network errors', async () => {
  const lookup = publicLookup;
  const loop = async () => fakeResponse(302, { location: 'https://good.example/again' });
  await assert.rejects(safeFetch('https://good.example/', { fetchImpl: loop, lookup, maxRedirects: 3 }), /too many/);
  const broken = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(safeFetch('https://good.example/', { fetchImpl: broken, lookup }), ProviderError);
});
