'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DirectUrlProvider, parsePlaylist, sniff } = require('../../src/music/providers/DirectUrlProvider');
const { AudiusProvider, isPlayable } = require('../../src/music/providers/AudiusProvider');
const { RadioBrowserProvider } = require('../../src/music/providers/RadioBrowserProvider');
const { InternetArchiveProvider, pickAudioFiles, sanitizeQuery } = require('../../src/music/providers/InternetArchiveProvider');
const { JamendoProvider } = require('../../src/music/providers/JamendoProvider');
const { UnsupportedSourceError, TrackUnavailableError, ProviderError } = require('../../src/utils/errors');

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** Builds a fetch() double from a route table: url substring -> response spec. */
function routeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) throw new Error(`unexpected fetch ${u}`);
    const spec = typeof routes[key] === 'function' ? routes[key](u) : routes[key];
    const bodyBuf = spec.body === undefined ? Buffer.alloc(0) : Buffer.from(typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body));
    return {
      status: spec.status || 200,
      ok: (spec.status || 200) < 300,
      headers: new Headers(spec.headers || {}),
      body: new ReadableStream({ start(c) { if (bodyBuf.length) c.enqueue(new Uint8Array(bodyBuf)); c.close(); } }),
      json: async () => JSON.parse(bodyBuf.toString('utf8')),
    };
  };
  impl.calls = calls;
  return impl;
}

const noProbe = async () => null;

// ---------------------------------------------------------------- direct

test('direct: audio file resolves to a track with probed metadata', async () => {
  const fetchImpl = routeFetch({ 'song.mp3': { headers: { 'content-type': 'audio/mpeg', 'content-length': '5000000' } } });
  const probe = async () => ({ ok: true, hasAudio: true, durationMs: 200000, title: 'Tagged Title', artist: 'Tagged Artist' });
  const p = new DirectUrlProvider({ fetchImpl, lookup, probe });
  const [track] = await p.resolve('https://cdn.example/song.mp3');
  assert.equal(track.title, 'Tagged Title');
  assert.equal(track.artist, 'Tagged Artist');
  assert.equal(track.durationMs, 200000);
  assert.equal(track.isLive, false);
  assert.equal(track.streamUrl, 'https://cdn.example/song.mp3');
});

test('direct: icecast stream is live and uses icy-name', async () => {
  const fetchImpl = routeFetch({ stream: { headers: { 'content-type': 'audio/mpeg', 'icy-name': 'KR Radio' } } });
  const p = new DirectUrlProvider({ fetchImpl, lookup, probe: noProbe });
  const [track] = await p.resolve('https://radio.example/stream');
  assert.equal(track.title, 'KR Radio');
  assert.equal(track.isLive, true);
  assert.equal(track.durationMs, null);
});

test('direct: web pages, logins and missing files are rejected clearly', async () => {
  const fetchImpl = routeFetch({
    'page': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html></html>' },
    'private': { status: 403 },
    'gone': { status: 404 },
    'boom': { status: 500 },
  });
  const p = new DirectUrlProvider({ fetchImpl, lookup, probe: noProbe });
  await assert.rejects(p.resolve('https://x.example/page'), (e) => e instanceof UnsupportedSourceError && /web page/.test(e.userMessage));
  await assert.rejects(p.resolve('https://x.example/private'), UnsupportedSourceError);
  await assert.rejects(p.resolve('https://x.example/gone'), TrackUnavailableError);
  await assert.rejects(p.resolve('https://x.example/boom'), ProviderError);
});

test('direct: unsupported binary formats are rejected', async () => {
  const fetchImpl = routeFetch({ 'file.zip': { headers: { 'content-type': 'application/zip' }, body: 'PK\u0003\u0004 not audio' } });
  const p = new DirectUrlProvider({ fetchImpl, lookup, probe: noProbe });
  await assert.rejects(p.resolve('https://x.example/file.zip'), /not point to a supported audio format/);
});

test('direct: files without an audio stream are rejected (probe)', async () => {
  const fetchImpl = routeFetch({ 'clip.mp4': { headers: { 'content-type': 'video/mp4', 'content-length': '10' } } });
  const probe = async () => ({ ok: true, hasAudio: false });
  const p = new DirectUrlProvider({ fetchImpl, lookup, probe });
  await assert.rejects(p.resolve('https://x.example/clip.mp4'), /no audio track/);
});

test('direct: .pls and .m3u playlists resolve to the first working stream', async () => {
  const fetchImpl = routeFetch({
    'station.pls': { headers: { 'content-type': 'audio/x-scpls' }, body: '[playlist]\nNumberOfEntries=2\nFile1=https://dead.example/live\nTitle1=Main\nFile2=https://ok.example/live\nTitle2=Backup\n' },
    'dead.example': { status: 404 },
    'ok.example': { headers: { 'content-type': 'audio/aac' } },
    'list.m3u': { headers: { 'content-type': 'audio/x-mpegurl' }, body: '#EXTM3U\n#EXTINF:-1,Cool FM\nhttps://ok.example/live\n' },
  });
  const p = new DirectUrlProvider({ fetchImpl, lookup, probe: noProbe });
  const [fromPls] = await p.resolve('https://x.example/station.pls');
  assert.equal(fromPls.streamUrl, 'https://ok.example/live');
  assert.equal(fromPls.title, 'Backup');
  assert.equal(fromPls.isLive, true);
  const [fromM3u] = await p.resolve('https://x.example/list.m3u');
  assert.equal(fromM3u.title, 'Cool FM');
});

test('direct: HLS playlists are passed to FFmpeg as-is', async () => {
  const fetchImpl = routeFetch({ 'live.m3u8': { headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.aac\n' } });
  const p = new DirectUrlProvider({ fetchImpl, lookup, probe: noProbe });
  const [track] = await p.resolve('https://hls.example/live.m3u8');
  assert.equal(track.streamUrl, 'https://hls.example/live.m3u8');
  assert.equal(track.isLive, true);
  assert.equal(track.extra.hls, true);
});

test('direct: getStream re-validates the URL at play time', async () => {
  const p = new DirectUrlProvider({ lookup: async () => [{ address: '10.0.0.1' }] });
  await assert.rejects(p.getStream({ streamUrl: 'https://rebound.example/a.mp3', isLive: false }), UnsupportedSourceError);
});

test('parsePlaylist and sniff helpers', () => {
  assert.deepEqual(parsePlaylist('#EXTM3U\nfile:///etc/passwd\nhttps://a.example/x.mp3\n', 'https://base.example/'), [{ url: 'https://a.example/x.mp3', title: null }]);
  assert.deepEqual(parsePlaylist('relative.mp3', 'https://base.example/dir/list.m3u'), [{ url: 'https://base.example/dir/relative.mp3', title: null }]);
  assert.equal(sniff(Buffer.from('ID3\u0004\u0000')), 'audio');
  assert.equal(sniff(Buffer.from('OggS\u0000\u0002')), 'audio');
  assert.equal(sniff(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'audio');
  assert.equal(sniff(Buffer.from('#EXTM3U\n')), 'playlist');
  assert.equal(sniff(Buffer.from('<!DOCTYPE html>')), 'html');
});

// ---------------------------------------------------------------- audius

const audiusTrack = (over = {}) => ({
  id: 'abc', title: 'Neon Rush', duration: 200, user: { name: 'KR Artist' }, permalink: '/kr/neon-rush',
  artwork: { '480x480': 'https://img.example/480.jpg' }, is_streamable: true, ...over,
});

test('audius: search filters gated / non-streamable tracks and maps metadata', async () => {
  const fetchImpl = routeFetch({
    '/tracks/search': { body: { data: [audiusTrack({ id: 'gated', is_stream_gated: true }), audiusTrack({ id: 'no', is_streamable: false }), audiusTrack()] } },
  });
  const p = new AudiusProvider({ fetchImpl, lookup });
  const results = await p.search('neon', { limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].sourceId, 'abc');
  assert.equal(results[0].artist, 'KR Artist');
  assert.equal(results[0].durationMs, 200000);
  assert.equal(results[0].url, 'https://audius.co/kr/neon-rush');
  assert.ok(fetchImpl.calls[0].includes('app_name=KINGSROCK'));
});

test('audius: getStream fetches a fresh signed URL each time; 404 means unavailable', async () => {
  let n = 0;
  const fetchImpl = routeFetch({
    '/tracks/abc/stream': () => ({ status: 302, headers: { location: `https://node.example/stream?sig=${++n}` } }),
    '/tracks/dead/stream': { status: 404 },
  });
  const p = new AudiusProvider({ fetchImpl, lookup });
  assert.equal((await p.getStream({ sourceId: 'abc' })).url, 'https://node.example/stream?sig=1');
  assert.equal((await p.getStream({ sourceId: 'abc' })).url, 'https://node.example/stream?sig=2');
  await assert.rejects(p.getStream({ sourceId: 'dead' }), TrackUnavailableError);
});

test('audius: resolves track links and refuses gated tracks', async () => {
  const fetchImpl = routeFetch({ '/resolve': { body: { data: audiusTrack({ is_stream_gated: true }) } } });
  const p = new AudiusProvider({ fetchImpl, lookup });
  assert.ok(p.canResolve('https://audius.co/kr/neon-rush'));
  assert.equal(p.canResolve('https://example.com/x'), false);
  await assert.rejects(p.resolve('https://audius.co/kr/neon-rush'), TrackUnavailableError);
  assert.equal(isPlayable({ id: 'x', title: 'y', access: { stream: false } }), false);
});

// ---------------------------------------------------------------- radio browser

const station = { stationuuid: 'uuid-1', name: ' Lofi 24/7 ', url_resolved: 'https://radio.example/lofi', country: 'Germany', codec: 'MP3', bitrate: 128, favicon: 'https://radio.example/icon.png', homepage: 'https://radio.example', hls: 0 };

test('radio: search maps stations to live tracks', async () => {
  const fetchImpl = routeFetch({
    '/json/servers': { body: [{ name: 'rb.example' }] },
    '/json/stations/search': (u) => ({ body: u.includes('name=') ? [station] : [] }),
  });
  const p = new RadioBrowserProvider({ fetchImpl, lookup });
  const [t] = await p.search('lofi', { limit: 1 });
  assert.equal(t.title, 'Lofi 24/7');
  assert.equal(t.isLive, true);
  assert.equal(t.artist, 'Germany · MP3 128 kbps');
  assert.ok(fetchImpl.calls.some((c) => c.startsWith('https://rb.example/json/stations/search')));
});

test('radio: getStream uses the click endpoint, falls back to the cached URL', async () => {
  const fetchImpl = routeFetch({
    '/json/servers': { body: [{ name: 'rb.example' }] },
    '/json/url/uuid-1': { body: { ok: true, url: 'https://radio.example/fresh' } },
    '/json/url/uuid-2': { status: 500 },
  });
  const p = new RadioBrowserProvider({ fetchImpl, lookup });
  const t1 = p.toTrack(station, null);
  assert.equal((await p.getStream(t1)).url, 'https://radio.example/fresh');
  const t2 = p.toTrack({ ...station, stationuuid: 'uuid-2' }, null);
  assert.equal((await p.getStream(t2)).url, 'https://radio.example/lofi');
});

// ---------------------------------------------------------------- internet archive

test('archive: pickAudioFiles prefers MP3 derivatives and orders by track', () => {
  const files = [
    { name: '02.flac', format: 'Flac', source: 'original', track: '2' },
    { name: '02.mp3', format: 'VBR MP3', source: 'derivative', original: '02.flac', track: '2' },
    { name: '01.flac', format: 'Flac', source: 'original', track: '1' },
    { name: '01.ogg', format: 'Ogg Vorbis', source: 'derivative', original: '01.flac', track: '1' },
    { name: 'cover.jpg', format: 'JPEG', source: 'original' },
  ];
  assert.deepEqual(pickAudioFiles(files).map((f) => f.name), ['01.ogg', '02.mp3']);
});

test('archive: sanitizeQuery strips Lucene syntax', () => {
  assert.equal(sanitizeQuery('title:(evil) OR *'), 'title evil');
  assert.equal(sanitizeQuery('moonlight sonata'), 'moonlight sonata');
});

test('archive: refuses items without an open license, hydrates licensed ones', async () => {
  const fetchImpl = routeFetch({
    '/metadata/closed': { body: { metadata: { title: 'Closed', licenseurl: '' }, files: [{ name: 'a.mp3', format: 'VBR MP3' }] } },
    '/metadata/open': { body: { metadata: { title: 'Open Album', creator: 'Band', licenseurl: 'http://creativecommons.org/licenses/by/4.0/' }, files: [{ name: 'Track 1.mp3', format: 'VBR MP3', title: 'First', length: '01:30', track: '1' }] } },
  });
  const p = new InternetArchiveProvider({ fetchImpl });
  await assert.rejects(p.resolve('https://archive.org/details/closed'), UnsupportedSourceError);
  const [t] = await p.resolve('https://archive.org/details/open');
  assert.equal(t.title, 'First');
  assert.equal(t.artist, 'Band');
  assert.equal(t.durationMs, 90000);
  assert.equal(t.streamUrl, 'https://archive.org/download/open/Track%201.mp3');
});

// ---------------------------------------------------------------- jamendo

test('jamendo: disabled without client id, maps results, surfaces API errors', async () => {
  assert.equal(new JamendoProvider({}).isAvailable, false);
  const fetchImpl = routeFetch({
    'search=ok': { body: { headers: { status: 'success' }, results: [{ id: 42, name: 'CC Song', duration: 120, artist_name: 'Indie', audio: 'https://storage.example/42.mp3', album_image: 'https://img.example/a.jpg' }] } },
    'search=bad': { body: { headers: { status: 'failed', error_message: 'Invalid Client Id' }, results: [] } },
    'id=42': { body: { headers: { status: 'success' }, results: [{ id: 42, name: 'CC Song', duration: 120, artist_name: 'Indie', audio: 'https://storage.example/42-fresh.mp3' }] } },
  });
  const p = new JamendoProvider({ clientId: 'abc123', fetchImpl, lookup });
  const [t] = await p.search('ok');
  assert.equal(t.title, 'CC Song');
  assert.equal(t.durationMs, 120000);
  await assert.rejects(p.search('bad'), /Invalid Client Id/);
  assert.equal((await p.getStream(t)).url, 'https://storage.example/42-fresh.mp3');
});
