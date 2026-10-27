import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMndotSources,
  mndotCameraToSource,
  mndotStillUrl,
  MNDOT_CAMERA_LIST_URL,
  MNDOT_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/mndot.js';
import {
  resetTaiwanSourcesCache,
  TAIWAN_FREEWAY_CCTV_URL,
} from '../../server/providers/cctv/taiwan.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { fallbackHeadingFromId } from '../../server/providers/cctv/normalize.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

// Settings that would steer the loader or the catalog away from the mocks.
const ISOLATED_ENV = [
  'CCTV_SOURCES_FILE',
  'CCTV_SOURCES_JSON',
  'CCTV_PREFER_AUSTIN',
  'CCTV_FORCE_AUSTIN',
  'CCTV_MAX_SOURCES',
  'CCTV_MNDOT_ENABLED',
  'CCTV_MNDOT_URL',
  'CCTV_MNDOT_MAX_SOURCES',
  'CCTV_TAIWAN_ENABLED',
  'CCTV_TAIWAN_URL',
];

let savedEnv = {};
beforeEach(() => {
  resetTaiwanSourcesCache();
  savedEnv = Object.fromEntries(
    ISOLATED_ENV.map((key) => [key, process.env[key]]),
  );
  for (const key of ISOLATED_ENV) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const MINNEAPOLIS = { lat: 44.98, lon: -93.27 };
const ST_PAUL = { lat: 44.95, lon: -93.1 };
const DULUTH = { lat: 46.79, lon: -92.1 };

function camera(overrides = {}) {
  return {
    name: 'C001',
    cam_num: 1,
    publish: true,
    streamable: true,
    hashtags: '#LiveStream #Recorded',
    roadway: 'T.H.36',
    road_dir: 'WB',
    cross_street: 'Cleveland Ave',
    location: 'T.H.36 WB @ Cleveland Ave',
    lat: 45.0103771789102,
    lon: -93.1860000160346,
    views: [],
    ...overrides,
  };
}

const stillOf = (name) =>
  `https://video.dot.state.mn.us/video/image/metro/${name}?size=l`;

test('maps a published camera to a registered still and a low-confidence heading', () => {
  const source = mndotCameraToSource(camera());
  assert.equal(source.id, 'mndot-c001');
  assert.equal(source.name, 'T.H.36 WB @ Cleveland Ave');
  assert.equal(source.city, 'Minnesota');
  assert.equal(source.cityId, 'minnesota');
  assert.equal(source.provider, 'MnDOT');
  assert.equal(source.feedType, 'image');
  assert.equal(source.url, stillOf('C001'));
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.headingDeg, 270);
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.code, 'C001');
});

test('every MnDOT naming pattern keeps its exact name in the still URL', () => {
  for (const name of [
    'C001',
    'C30000',
    'D6-C002',
    'D6-C001a',
    'C35-084',
    'C1504',
  ]) {
    assert.equal(mndotCameraToSource(camera({ name }))?.url, stillOf(name));
  }
});

test('only literal true publish and streamable flags admit a camera', () => {
  for (const flags of [
    { publish: false },
    { streamable: false },
    { publish: undefined },
    { streamable: null },
    { publish: 'true' },
    { streamable: 1 },
  ]) {
    assert.equal(
      mndotCameraToSource(camera(flags)),
      null,
      JSON.stringify(flags),
    );
  }
});

test('missing, malformed or out-of-state coordinates are rejected', () => {
  for (const position of [
    { lat: undefined },
    { lon: null },
    { lat: '45.01' },
    { lat: Number.NaN },
    { lat: 0, lon: 0 },
    { lat: -93.186, lon: 45.01 },
    { lat: 41.88, lon: -87.63 },
  ]) {
    assert.equal(
      mndotCameraToSource(camera(position)),
      null,
      JSON.stringify(position),
    );
  }
});

test('unsafe or malformed camera names never produce a URL', () => {
  for (const name of [
    '../C001',
    'C001/../../x',
    'C001?x=1',
    'C001#a',
    'C 001',
    '',
    'C'.repeat(41),
    123,
    undefined,
  ]) {
    assert.equal(mndotStillUrl(name), null, String(name));
    assert.equal(mndotCameraToSource(camera({ name })), null, String(name));
  }
});

test('only a travel token sets the bearing; anything else uses the id prior', () => {
  assert.equal(mndotCameraToSource(camera({ road_dir: 'NB' })).headingDeg, 0);
  assert.equal(mndotCameraToSource(camera({ road_dir: 'EB' })).headingDeg, 90);
  for (const road_dir of ['N-S', 'E-W', '', undefined]) {
    const source = mndotCameraToSource(camera({ road_dir }));
    assert.equal(source.headingDeg, fallbackHeadingFromId('mndot-c001'));
    assert.equal(source.headingConfidence, 'low');
  }
});

test('names fall back to the camera name and are cleaned and bounded', () => {
  assert.equal(mndotCameraToSource(camera({ location: '' })).name, 'C001');
  assert.equal(
    mndotCameraToSource(camera({ location: '  I-94\u0000EB\n@  Snelling ' }))
      .name,
    'I-94 EB @ Snelling',
  );
  assert.equal(
    mndotCameraToSource(camera({ location: 'x'.repeat(500) })).name.length,
    160,
  );
});

function mockList(t, body, { status = 200, headers = {} } = {}) {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push(String(url));
    assert.equal(options.redirect, 'manual');
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      },
    );
  });
  return requested;
}

test('loader deduplicates cameras whose names differ only in case', async (t) => {
  mockList(t, [camera(), camera({ name: 'c001' }), camera({ name: 'C002' })]);
  assert.deepEqual((await loadMndotSources()).map((c) => c.id).sort(), [
    'mndot-c001',
    'mndot-c002',
  ]);
});

test('the cap keeps the Twin Cities first, nearest first', async (t) => {
  mockList(t, [
    camera({ name: 'C900', ...DULUTH }),
    camera({ name: 'C002', ...ST_PAUL }),
    camera({ name: 'C001', ...MINNEAPOLIS }),
  ]);
  process.env.CCTV_MNDOT_MAX_SOURCES = '2';
  const sources = await loadMndotSources();
  assert.deepEqual(
    sources.map((c) => c.id),
    ['mndot-c001', 'mndot-c002'],
  );
  assert.equal(sources.available, 3);
});

test('CCTV_MNDOT_MAX_SOURCES is clamped to 1-2000', async (t) => {
  mockList(t, [
    camera({ name: 'C001', ...MINNEAPOLIS }),
    camera({ name: 'C002', ...ST_PAUL }),
    camera({ name: 'C003', ...DULUTH }),
  ]);
  for (const [value, expected] of [
    ['0', 1],
    ['2', 2],
    ['99999', 3],
    ['abc', 3],
  ]) {
    process.env.CCTV_MNDOT_MAX_SOURCES = value;
    assert.equal((await loadMndotSources()).length, expected, value);
  }
});

test('a redirected, failed or malformed list contributes an empty pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const cases = [
    () =>
      new Response('[]', {
        status: 302,
        headers: { location: 'https://evil.test/' },
      }),
    () => new Response('', { status: 503 }),
    () => new Response('<html>challenge</html>'),
    () => Response.json({ cameras: [camera()] }),
    () => Response.json([{ ...camera(), publish: false }]),
    () => new Response(`[${' '.repeat(MNDOT_MAX_CATALOG_BYTES)}]`),
  ];
  for (const [index, respond] of cases.entries()) {
    t.mock.method(globalThis, 'fetch', async () => respond());
    assert.deepEqual(await loadMndotSources(), [], `case ${index}`);
  }
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await loadMndotSources(), []);
});

function taiwanXml() {
  return `<?xml version='1.0' encoding='utf-8'?>
<CCTVList><CCTVs>${[1, 2, 3, 4, 5, 6]
    .map(
      (n) => `<CCTV>
    <CCTVID>CCTV-N1-S-${n}</CCTVID>
    <VideoStreamURL>https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=${n}</VideoStreamURL>
    <PositionLon>121.5${n}</PositionLon>
    <PositionLat>25.0${n}</PositionLat>
    <RoadName>國道1號</RoadName>
  </CCTV>`,
    )
    .join('')}</CCTVs></CCTVList>`;
}

/** Stubs the MnDOT list and Taiwan table; every other pack gets an empty answer. */
function mockCatalog(t, { mndot = [camera()], mndotStatus = 200 } = {}) {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const href = String(url);
    requested.push(href);
    if (href === (process.env.CCTV_MNDOT_URL || MNDOT_CAMERA_LIST_URL)) {
      assert.equal(options.redirect, 'manual');
      return Response.json(mndot, { status: mndotStatus });
    }
    if (href === TAIWAN_FREEWAY_CCTV_URL) return new Response(taiwanXml());
    return Response.json([]);
  });
  return requested;
}

const runCatalog = () => createCctvCatalog({ sourceRoot: '/nonexistent' })();

test('the MnDOT pack is in the catalog by default', async (t) => {
  mockCatalog(t);
  const sources = await runCatalog();
  assert.equal(sources.find((c) => c.id === 'mndot-c001')?.cityId, 'minnesota');
});

test('CCTV_MNDOT_ENABLED=0 makes no MnDOT request', async (t) => {
  const requested = mockCatalog(t);
  process.env.CCTV_MNDOT_ENABLED = '0';
  const sources = await runCatalog();
  assert.ok(requested.length > 0, 'the other packs still refreshed');
  assert.equal(
    requested.some((href) => href.includes('dot.state.mn.us')),
    false,
  );
  assert.ok(!sources.some((c) => c.cityId === 'minnesota'));
});

test('CCTV_MNDOT_URL redirects the loader to the override', async (t) => {
  process.env.CCTV_MNDOT_URL = 'https://mirror.test/camera_pub';
  const requested = mockCatalog(t);
  const sources = await runCatalog();
  assert.ok(requested.includes('https://mirror.test/camera_pub'));
  assert.ok(!requested.includes(MNDOT_CAMERA_LIST_URL));
  assert.ok(sources.some((c) => c.id === 'mndot-c001'));
});

test('a failed MnDOT list leaves the other packs in the catalog', async (t) => {
  mockCatalog(t, { mndotStatus: 503 });
  const sources = await runCatalog();
  assert.ok(sources.some((c) => c.cityId === 'taiwan'));
  assert.ok(!sources.some((c) => c.cityId === 'minnesota'));
});

test('under a lowered catalog cap MnDOT shares round-robin, metro first', async (t) => {
  mockCatalog(t, {
    mndot: [
      camera({ name: 'C900', ...DULUTH }),
      camera({ name: 'C003', lat: 45.5, lon: -94.15 }),
      camera({ name: 'C002', ...ST_PAUL }),
      camera({ name: 'C004', lat: 44.02, lon: -92.46 }),
      camera({ name: 'C001', ...MINNEAPOLIS }),
      camera({ name: 'C005', lat: 44.86, lon: -93.43 }),
    ],
  });
  process.env.CCTV_MAX_SOURCES = '8';
  const sources = await runCatalog();
  const minnesota = sources.filter((c) => c.cityId === 'minnesota');
  assert.equal(minnesota.length, 4);
  assert.equal(sources.filter((c) => c.cityId === 'taiwan').length, 4);
  assert.deepEqual(
    minnesota.map((c) => c.id),
    ['mndot-c001', 'mndot-c002', 'mndot-c005', 'mndot-c003'],
  );
});

test('raising the MnDOT cap cannot outgrow its share of the shared budget', async (t) => {
  // 1,300 cameras stepping north from downtown Minneapolis, listed farthest first.
  const cameras = Array.from({ length: 1300 }, (_, i) =>
    camera({ name: `C${10000 + i}`, lat: 44.98 + i * 0.003, lon: -93.27 }),
  ).reverse();
  mockList(t, cameras);
  process.env.CCTV_MNDOT_MAX_SOURCES = '2000';
  const mndot = await loadMndotSources();
  assert.equal(mndot.length, 1300);
  // Nineteen other default-sized packs offering 5,700 cameras between them.
  const others = Array.from({ length: 19 }, (_, p) => ({
    name: `pack${p}`,
    sources: Array.from({ length: 300 }, (_, i) => ({ id: `p${p}-${i}` })),
  }));
  const { sources, packs } = allocateSourceCap(
    [...others, { name: 'mndot', sources: mndot }],
    4000,
  );
  const share = packs.find((pack) => pack.name === 'mndot');
  assert.equal(share.kept, 200);
  assert.equal(share.offered, 1300);
  assert.deepEqual(
    sources.filter((c) => c.id.startsWith('mndot-')).map((c) => c.id),
    mndot.slice(0, 200).map((c) => c.id),
    'the cameras kept are the ones nearest the downtowns',
  );
});
