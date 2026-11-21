'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { UnsupportedSourceError, ProviderError } = require('./errors');

const USER_AGENT = 'KINGSROCK-DiscordMusicBot/1.0';
const MAX_REDIRECTS = 5;

/**
 * IPv4 ranges that must never be fetched on behalf of a Discord user:
 * loopback, private LANs, link-local (incl. cloud metadata 169.254.169.254),
 * carrier-grade NAT, multicast, reserved, etc.
 */
const BLOCKED_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(ip, [base, bits]) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** Expands an IPv6 address to 8 hextets (numbers). */
function expandIPv6(ip) {
  let addr = ip.split('%')[0].toLowerCase();
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const v4Match = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const n = ipv4ToInt(v4Match[1]);
    addr = addr.replace(v4Match[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = addr.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(fill, 0)).fill('0'), ...tailParts];
  return parts.map((p) => parseInt(p || '0', 16));
}

/** True when the IP address is not a public unicast internet address. */
function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED_V4.some((range) => inV4Range(ip, range));
  if (family === 6) {
    const h = expandIPv6(ip);
    if (h.every((x) => x === 0)) return true; // ::
    if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible / NAT64 well-known prefix
    if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
      const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
      return isPrivateAddress(v4);
    }
    if (h[0] === 0x64 && h[1] === 0xff9b) {
      const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
      return isPrivateAddress(v4);
    }
    if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
    return false;
  }
  return true; // not an IP at all: refuse
}

/** Parses a user supplied string as an http(s) URL, or returns null. */
function parseHttpUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/^<(.+)>$/, '$1'); // Discord <url> embed suppression
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Throws unless the URL is an http(s) URL that resolves only to public IPs.
 * @returns {Promise<URL>}
 */
async function assertPublicUrl(input, { allowPrivate = false, lookup = dns.lookup } = {}) {
  const url = input instanceof URL ? input : parseHttpUrl(String(input));
  if (!url) throw new UnsupportedSourceError('Only `http://` and `https://` links are supported.');
  if (url.username || url.password) {
    throw new UnsupportedSourceError('Links containing usernames or passwords are not allowed.');
  }
  if (allowPrivate) return url;

  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (/^localhost$/i.test(host) || /\.localhost$/i.test(host) || /\.(local|internal|lan|home\.arpa)$/i.test(host)) {
    throw new UnsupportedSourceError('Links to local or private network addresses are not allowed.');
  }

  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch (err) {
      throw new UnsupportedSourceError(`Could not find the server \`${host}\`. Check the link.`, { cause: err });
    }
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsupportedSourceError('Links to local or private network addresses are not allowed.');
  }
  return url;
}

/**
 * fetch() wrapper that:
 *  - validates every hop (including redirects) with assertPublicUrl,
 *  - applies a timeout,
 *  - sends a KINGSROCK User-Agent.
 * The response gets a `finalUrl` property with the URL after redirects.
 */
async function safeFetch(input, {
  method = 'GET',
  headers = {},
  timeoutMs = 10000,
  allowPrivate = false,
  maxRedirects = MAX_REDIRECTS,
  fetchImpl = globalThis.fetch,
  lookup,
} = {}) {
  let url = await assertPublicUrl(input, { allowPrivate, lookup });
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new ProviderError('The server took too long to respond.', { cause: err });
      }
      const wrapped = new ProviderError('Could not connect to that server.', { cause: err });
      wrapped.networkError = true;
      throw wrapped;
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await discardBody(response);
      const next = new URL(response.headers.get('location'), url);
      url = await assertPublicUrl(next, { allowPrivate, lookup });
      continue;
    }

    Object.defineProperty(response, 'finalUrl', { value: url.toString() });
    return response;
  }
  throw new ProviderError('That link redirects too many times.');
}

/** Fetches JSON from a (trusted) provider API with timeout + status checks. */
async function fetchJson(input, { timeoutMs = 10000, headers = {}, fetchImpl = globalThis.fetch, provider = 'provider' } = {}) {
  let response;
  try {
    response = await fetchImpl(input, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ProviderError(
      timedOut ? `${provider} did not respond in time. Try again shortly.` : `Could not reach ${provider}. Try again shortly.`,
      { cause: err },
    );
  }
  if (response.status === 404) {
    await discardBody(response);
    const err = new ProviderError(`${provider} could not find that item.`);
    err.status = 404;
    throw err;
  }
  if (response.status === 429) {
    await discardBody(response);
    throw new ProviderError(`${provider} is rate limiting requests. Try again in a minute.`);
  }
  if (!response.ok) {
    await discardBody(response);
    const err = new ProviderError(`${provider} returned an error (HTTP ${response.status}).`);
    err.status = response.status;
    throw err;
  }
  try {
    return await response.json();
  } catch (err) {
    throw new ProviderError(`${provider} returned an invalid response.`, { cause: err });
  }
}

/** Reads at most `maxBytes` of a response body, then cancels the rest. */
async function readBodyPrefix(response, maxBytes = 4096) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

async function discardBody(response) {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    /* ignore */
  }
}

module.exports = {
  USER_AGENT,
  isPrivateAddress,
  parseHttpUrl,
  assertPublicUrl,
  safeFetch,
  fetchJson,
  readBodyPrefix,
  discardBody,
};
