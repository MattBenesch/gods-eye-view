import test from 'node:test';
import assert from 'node:assert/strict';
import { messageSignsProxy } from '../../server/providers/messageSigns.js';

const IRIS = 'https://data.dot.state.mn.us/iris';
const NOW = Date.parse('2026-10-27T22:22:30Z');
const MODIFIED = 'Tue, 27 Oct 2026 22:22:18 GMT'; // 12 s before NOW

const FIXTURES = {
  [`${IRIS}/dms_pub`]: [
    {
      name: 'V100N01',
      location: 'T.H.100 NB @ 50th St',
      lat: 44.9,
      lon: -93.3,
    },
  ],
  [`${IRIS}/dms_message`]: [
    { name: 'V100N01', msg_current: 'msg_AE72DF0B', failed: false },
  ],
  [`${IRIS}/sign_message`]: [
    { name: 'msg_AE72DF0B', multi: 'FREEWAY TIME TO[nl]I-394 10 MIN' },
  ],
};

/** A header-only GIF: enough for the proxy, which never decodes it. */
function gifBytes(width = 412, height = 100) {
  const bytes = new Uint8Array(32);
  bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  bytes.set([width & 255, width >> 8, height & 255, height >> 8], 6);
  return bytes;
}

function feedResponse(url, { modified = MODIFIED } = {}) {
  return new Response(JSON.stringify(FIXTURES[url]), {
    headers: {
      'Content-Type': 'application/json',
      ...(modified ? { 'Last-Modified': modified } : {}),
    },
  });
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = messageSignsProxy({ now: () => NOW, ...options });
  assert.equal(plugin.name, 'message-signs');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/message-signs');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.raw = body;
        this.body =
          this.headers['Content-Type'] === 'application/json'
            ? JSON.parse(body)
            : body;
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

/** fetchImpl serving the three feeds plus listed GIFs, counting calls. */
function upstream({ feeds = {}, gifs = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    if (url in gifs) return gifs[url]();
    if (url in feeds) return feeds[url](url, options);
    return feedResponse(url);
  };
  return { calls, fetchImpl };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: joins the three fixed feeds and dates them`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl, monotonicNow: () => 0 }, hook);
    const res = await request();
    assert.equal(res.status, 200);
    assert.deepEqual(calls.sort(), [
      `${IRIS}/dms_message`,
      `${IRIS}/dms_pub`,
      `${IRIS}/sign_message`,
    ]);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body, {
      provider: 'mndot',
      signs: [
        {
          id: 'V100N01',
          provider: 'mndot',
          lat: 44.9,
          lon: -93.3,
          location: 'T.H.100 NB @ 50th St',
          message: 'msg_AE72DF0B',
          multi: 'FREEWAY TIME TO[nl]I-394 10 MIN',
        },
      ],
      joinMisses: 0,
      ageMs: 12_000,
      stale: false,
    });
  });
}

test('the list is cached and concurrent reads share one upstream load', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, monotonicNow: () => clock });
  await Promise.all([request(), request(), request()]);
  assert.equal(calls.length, 3);
  clock = 29_000;
  const cached = await request();
  assert.equal(calls.length, 3);
  assert.equal(cached.body.ageMs, 41_000);
  clock = 31_000;
  await request();
  assert.equal(calls.length, 6);
});

test('data age uses the older fast feed, clamped to now', async () => {
  const { fetchImpl } = upstream({
    feeds: {
      [`${IRIS}/dms_message`]: (url) =>
        feedResponse(url, { modified: 'Tue, 27 Oct 2026 22:20:30 GMT' }),
      [`${IRIS}/sign_message`]: (url) =>
        feedResponse(url, { modified: 'Tue, 27 Oct 2026 23:00:00 GMT' }),
    },
  });
  const res = await install({ fetchImpl, monotonicNow: () => 0 })();
  // dms_message froze two minutes ago while sign_message is "in the future".
  assert.equal(res.body.ageMs, 120_000);
  assert.equal(res.body.stale, false);

  const frozen = upstream({
    feeds: {
      [`${IRIS}/dms_message`]: (url) =>
        feedResponse(url, { modified: 'Tue, 27 Oct 2026 22:19:00 GMT' }),
    },
  });
  const stale = await install({
    fetchImpl: frozen.fetchImpl,
    monotonicNow: () => 0,
  })();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
});

test('an undated load fails; one dated fast feed is enough', async () => {
  const none = upstream({
    feeds: {
      [`${IRIS}/dms_message`]: (url) => feedResponse(url, { modified: null }),
      [`${IRIS}/sign_message`]: (url) =>
        feedResponse(url, { modified: 'not a date' }),
    },
  });
  const failed = await install({
    fetchImpl: none.fetchImpl,
    monotonicNow: () => 0,
  })();
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: 'message_signs_unavailable' });

  const one = upstream({
    feeds: {
      [`${IRIS}/dms_message`]: (url) => feedResponse(url, { modified: null }),
    },
  });
  const res = await install({
    fetchImpl: one.fetchImpl,
    monotonicNow: () => 0,
  })();
  assert.equal(res.status, 200);
  assert.equal(res.body.ageMs, 12_000);
});

test('one failed feed aborts the others and returns a sanitised 502', async () => {
  const aborted = [];
  const { fetchImpl } = upstream({
    feeds: {
      [`${IRIS}/dms_pub`]: async () =>
        new Response('<html>secret upstream page</html>', { status: 500 }),
      [`${IRIS}/dms_message`]: (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted.push(url);
            reject(signal.reason);
          });
        }),
    },
  });
  const res = await install({ fetchImpl, monotonicNow: () => 0 })();
  assert.equal(res.status, 502);
  assert.equal(res.headers['Retry-After'], '60');
  assert.deepEqual(res.body, { error: 'message_signs_unavailable' });
  assert.deepEqual(aborted, [`${IRIS}/dms_message`]);
});

test('a failure serves the last good list as stale until it is too old', async () => {
  let clock = 0;
  let fail = false;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (fail) return new Response('down', { status: 503 });
    return feedResponse(url);
  };
  const request = install({ fetchImpl, monotonicNow: () => clock });
  await request();
  fail = true;

  clock = 200_000; // 212 s of data age: past the stale threshold.
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.ageMs, 212_000);
  const afterFailure = calls.length;

  clock = 210_000; // Inside the 15 s failure cooldown: no upstream call.
  assert.equal((await request()).status, 200);
  assert.equal(calls.length, afterFailure);

  clock = 600_000; // 612 s: older than ten minutes.
  const expired = await request();
  assert.equal(expired.status, 502);
});

test('redirects, oversized and non-JSON bodies fail without leaking text', async () => {
  const cases = {
    redirect: async () => {
      throw new TypeError('fetch failed: redirect mode is set to error');
    },
    oversized: async () =>
      new Response('x', { headers: { 'Content-Length': String(600 * 1024) } }),
    notJson: async () => new Response('<html>upstream says hi</html>'),
  };
  for (const make of Object.values(cases)) {
    const { fetchImpl } = upstream({
      feeds: { [`${IRIS}/sign_message`]: make },
    });
    const res = await install({ fetchImpl, monotonicNow: () => 0 })();
    assert.equal(res.status, 502);
    assert.doesNotMatch(res.raw, /upstream says hi|redirect|fetch failed/);
  }
});

test('a listed message GIF is relayed and cached by name', async () => {
  let gifCalls = 0;
  const { fetchImpl } = upstream({
    gifs: {
      [`${IRIS}/img/msg_AE72DF0B.gif`]: () => {
        gifCalls += 1;
        return new Response(gifBytes(), {
          headers: { 'Content-Type': 'image/gif' },
        });
      },
    },
  });
  const request = install({ fetchImpl, monotonicNow: () => 0 });
  await request();
  const first = await request('/img/msg_AE72DF0B.gif');
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/gif');
  assert.equal(first.headers['Cache-Control'], 'private, max-age=300');
  assert.deepEqual(new Uint8Array(first.raw), gifBytes());
  await request('/img/msg_AE72DF0B.gif');
  assert.equal(gifCalls, 1);
});

test('the GIF route refuses unlisted, malformed and non-GIF images', async () => {
  const responses = {
    [`${IRIS}/img/msg_AE72DF0B.gif`]: () =>
      new Response('<html>nope</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  };
  const { calls, fetchImpl } = upstream({
    gifs: responses,
    feeds: {
      [`${IRIS}/sign_message`]: () =>
        new Response(
          JSON.stringify([
            { name: 'msg_AE72DF0B', multi: 'A' },
            { name: 'msg_0000BEEF', multi: 'B' },
          ]),
          { headers: { 'Last-Modified': MODIFIED } },
        ),
    },
  });
  const request = install({ fetchImpl, monotonicNow: () => 0 });
  await request();
  const before = calls.length;
  assert.equal((await request('/img/msg_0000BEEF.gif')).status, 404); // unlisted
  assert.equal((await request('/img/../../etc.gif')).status, 404);
  assert.equal((await request('/img/msg_ae72df0b.gif')).status, 404);
  assert.equal((await request('/img/msg_AE72DF0B.png')).status, 404);
  assert.equal(calls.length, before);
  const html = await request('/img/msg_AE72DF0B.gif');
  assert.equal(html.status, 502);
  assert.doesNotMatch(html.raw, /nope/);

  responses[`${IRIS}/img/msg_AE72DF0B.gif`] = () =>
    new Response(gifBytes(700, 100), {
      headers: { 'Content-Type': 'image/gif' },
    });
  assert.equal((await request('/img/msg_AE72DF0B.gif')).status, 502);
  responses[`${IRIS}/img/msg_AE72DF0B.gif`] = () =>
    new Response(new Uint8Array(70 * 1024), {
      headers: { 'Content-Type': 'image/gif' },
    });
  assert.equal((await request('/img/msg_AE72DF0B.gif')).status, 502);
});

test('a GIF MnDOT has deleted is a 404 that is not refetched for a minute', async () => {
  let clock = 0;
  let gifCalls = 0;
  const { fetchImpl } = upstream({
    gifs: {
      [`${IRIS}/img/msg_AE72DF0B.gif`]: () => {
        gifCalls += 1;
        return new Response('gone', { status: 404 });
      },
    },
  });
  const request = install({ fetchImpl, monotonicNow: () => clock });
  await request();
  assert.equal((await request('/img/msg_AE72DF0B.gif')).status, 404);
  clock = 20_000;
  assert.equal((await request('/img/msg_AE72DF0B.gif')).status, 404);
  assert.equal(gifCalls, 1);
  clock = 61_000;
  await request('/img/msg_AE72DF0B.gif');
  assert.equal(gifCalls, 2);
});

test('other methods, unknown paths and bursts are refused locally', async () => {
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, monotonicNow: () => 0 });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/unknown')).status, 404);
  assert.equal(calls.length, 0);
  let limited;
  for (let i = 0; i < 31; i++) limited = await request('/', 'GET', 'burst');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
});

test('constructing the plugin makes no upstream request (AE5)', () => {
  let calls = 0;
  const plugin = messageSignsProxy({
    fetchImpl: async () => {
      calls += 1;
      return new Response('[]');
    },
  });
  plugin.configureServer({ middlewares: { use() {} } });
  plugin.configurePreviewServer({ middlewares: { use() {} } });
  assert.equal(calls, 0);
});
