import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { layerFeedState } from '../../data/feedState.js';
import { createMessageSignsLayer } from './index.js';
import { FACE_BUDGET } from './faces.js';

const FLOOR_M = 250;
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((done) => setImmediate(done));
};

function gifBytes(width = 412, height = 100) {
  const bytes = new Uint8Array(32);
  bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  bytes.set([width & 255, width >> 8, height & 255, height >> 8], 6);
  return bytes;
}

function sign(id, message, { lat = 44.95, lon = -93.2, multi } = {}) {
  return {
    id,
    provider: 'mndot',
    lat,
    lon,
    location: `${id} location`,
    message,
    multi: multi ?? `MESSAGE ${message}[nl]SECOND LINE`,
  };
}

function harness({
  snapshot,
  frames = {},
  missing = new Set(),
  reducedMotion = false,
} = {}) {
  const clock = { now: 1_000_000 };
  const pending = new Map();
  let nextTimer = 1;
  const timers = {
    setTimeout(fn, ms) {
      const id = nextTimer++;
      pending.set(id, { fn, at: clock.now + ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const advance = async (ms) => {
    clock.now += ms;
    for (const [id, timer] of [...pending]) {
      if (timer.at > clock.now) continue;
      pending.delete(id);
      await timer.fn();
    }
    await settle();
  };

  const entries = new Map();
  const visible = new Map();
  const overlayHost = {
    setEntries(sourceId, list) {
      entries.set(sourceId, list);
    },
    setVisible(sourceId, value) {
      visible.set(sourceId, value);
    },
    clearSource(sourceId) {
      entries.set(sourceId, []);
    },
    hitTest: () => null,
  };

  const primitives = [];
  const moveEnd = new Set();
  const listeners = new Map();
  const statusNodes = [];
  let renders = 0;
  let picked;
  let click;
  const viewer = {
    isDestroyed: () => false,
    scene: {
      primitives: {
        add(value) {
          primitives.push(value);
          return value;
        },
        remove(value) {
          primitives.splice(primitives.indexOf(value), 1);
        },
      },
      pick: () => picked,
      preRender: { addEventListener: () => () => {} },
    },
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(-93.2, 44.95, 1500),
      positionWC: Cesium.Cartesian3.fromDegrees(-93.2, 44.95, 1500),
      moveEnd: {
        addEventListener(fn) {
          moveEnd.add(fn);
          return () => moveEnd.delete(fn);
        },
      },
    },
  };
  const documentRef = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    createElement() {
      const node = {
        attributes: {},
        textContent: '',
        setAttribute(key, value) {
          this.attributes[key] = value;
        },
        remove() {
          statusNodes.splice(statusNodes.indexOf(node), 1);
        },
      };
      return node;
    },
    body: { appendChild: (node) => statusNodes.push(node) },
  };

  let current = snapshot ?? { signs: [], ageMs: 5000, stale: false };
  const requests = { list: 0, faces: [] };
  const source = {
    async getSnapshot() {
      requests.list += 1;
      if (current instanceof Error) throw current;
      return typeof current === 'function' ? current() : current;
    },
    async getFaceImage(message) {
      requests.faces.push(message);
      if (missing.has(message)) throw new Error('MnDOT HTTP 404');
      return gifBytes();
    },
  };

  class FakeDecoder {
    static async isTypeSupported() {
      return true;
    }
    constructor({ data }) {
      this.frameCount = frames[data.message] ?? 1;
      this.message = data.message;
      this.tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: this.frameCount },
      };
    }
    async decode({ frameIndex }) {
      return {
        image: { message: this.message, frameIndex, duration: 1_000_000 },
      };
    }
    close() {}
  }
  // getFaceImage returns fresh bytes; tag them so the decoder knows which.
  const tagged = source.getFaceImage;
  source.getFaceImage = async (message, options) => {
    const bytes = await tagged(message, options);
    bytes.message = message;
    return bytes;
  };

  const drawn = [];
  const createCanvas = (width, height) => {
    const canvas = {
      width,
      height,
      getContext: () => ({
        imageSmoothingEnabled: true,
        clearRect() {},
        fillRect() {},
        drawImage(image) {
          drawn.push({ canvas, image });
        },
        strokeRect() {},
      }),
      toDataURL: () => 'data:image/png;base64,',
    };
    return canvas;
  };

  const layer = createMessageSignsLayer({
    source,
    overlayHost,
    picking: {
      resolvePickId: (value) => value?.id ?? null,
      registerPickOwner() {},
      unregisterPickOwner() {},
    },
    pointer: { isPointerFree: () => true },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(fn) {
        click = fn;
      },
      destroy() {
        click = null;
      },
    }),
    surface: {
      groundFloor: {
        cachedGroundFloor: () => FLOOR_M,
        resolveGroundFloorCellsBounded: async () => {},
        resolveGroundFloorCells: async () => {},
      },
    },
    requestRender: () => {
      renders += 1;
    },
    createCanvas,
    imageEnv: { ImageDecoder: FakeDecoder },
    now: () => clock.now,
    timers,
    documentRef,
    prefersReducedMotion: () => reducedMotion,
  });
  layer.init(viewer);
  layer.enable(viewer);
  return {
    layer,
    viewer,
    clock,
    advance,
    pendingTimers: pending,
    entries,
    faces: () => entries.get('message-signs') ?? [],
    cards: () => entries.get('message-signs-card') ?? [],
    markers: () => primitives[0] ?? null,
    primitives,
    requests,
    drawn,
    listeners,
    statusNodes,
    moveEnd,
    renders: () => renders,
    setSnapshot(value) {
      current = value;
    },
    setVisibility(state) {
      documentRef.visibilityState = state;
      listeners.get('visibilitychange')?.();
    },
    click: (position, pick = undefined) => {
      picked = pick;
      click({ position });
    },
    get hostHit() {
      return overlayHost.hitTest;
    },
    set hostHit(fn) {
      overlayHost.hitTest = fn;
    },
  };
}

test('lit signs publish markers and GIF faces with stable labels (AE1)', async () => {
  const h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_00000001'), sign('V2', 'msg_00000002')],
      ageMs: 5000,
      stale: false,
    },
  });
  assert.equal(await h.layer.update(h.viewer), true);
  await settle();

  assert.equal(h.markers().length, 2);
  const height = Cesium.Cartographic.fromCartesian(
    h.markers().get(0).position,
  ).height;
  assert.ok(Math.abs(height - (FLOOR_M + 6)) < 0.01);

  const faces = h.faces();
  assert.equal(faces.length, 2);
  for (const face of faces) {
    assert.equal(face.variant, 'thumbnail');
    assert.equal(face.requireImage, true);
    assert.equal(face.thumbnailWidth, 206);
    assert.equal(face.thumbnailHeight, 50);
    assert.equal(face.thumbnailTitleHeight, 0);
    assert.equal(face.image.stamp, 1);
    assert.equal(face.accessibilityLabel, `Message sign, ${face.id} location`);
  }
  const stats = h.layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.countLabel, '2 signs lit');
  assert.equal(stats.status, 'ok');
  assert.equal(stats.error, null);
  h.layer.destroy();
});

test('every lit sign gets a marker; only the nearest get faces', async () => {
  const signs = Array.from({ length: 60 }, (_, i) =>
    sign(
      `V${String(i).padStart(2, '0')}`,
      `msg_${String(i).padStart(8, '0')}`,
      {
        lat: 44.95,
        lon: -93.2 + i * 0.01,
      },
    ),
  );
  const h = harness({ snapshot: { signs, ageMs: 0, stale: false } });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.markers().length, 60);
  assert.equal(h.faces().length, FACE_BUDGET);
  assert.ok(h.faces().some((face) => face.id === 'V00'));

  // Fly east: moveEnd re-selects faces without refetching the list.
  h.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -92.61,
    44.95,
    1500,
  );
  for (const fn of h.moveEnd) fn();
  await settle();
  assert.equal(h.requests.list, 1);
  assert.ok(h.faces().some((face) => face.id === 'V59'));
  assert.ok(!h.faces().some((face) => face.id === 'V00'));

  // Statewide: markers stay, faces go.
  h.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -93.2,
    44.95,
    400_000,
  );
  for (const fn of h.moveEnd) fn();
  await settle();
  assert.equal(h.faces().length, 0);
  assert.equal(h.markers().length, 60);
  h.layer.destroy();
});

test('a changed message redraws only its face; a blank sign leaves (AE3)', async () => {
  const h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_00000001'), sign('V2', 'msg_00000002')],
      ageMs: 0,
      stale: false,
    },
  });
  await h.layer.update(h.viewer);
  await settle();
  const before = new Map(h.faces().map((face) => [face.id, face.image]));

  h.setSnapshot({
    signs: [sign('V1', 'msg_000000AA'), sign('V2', 'msg_00000002')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  const after = new Map(h.faces().map((face) => [face.id, face.image]));
  assert.equal(after.get('V1'), before.get('V1')); // same slot, redrawn
  assert.equal(after.get('V1').stamp, 2);
  assert.equal(after.get('V2').stamp, 1);

  h.setSnapshot({
    signs: [sign('V2', 'msg_00000002')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.deepEqual(
    h.faces().map((face) => face.id),
    ['V2'],
  );
  assert.equal(h.markers().length, 1);
  h.layer.destroy();
});

test('clicking a face opens its card below; again, Escape or a drop closes it (AE4)', async () => {
  const h = harness({
    snapshot: {
      signs: [
        sign('V1', 'msg_00000001', { multi: 'CRASH AHEAD[nl]USE CAUTION' }),
      ],
      ageMs: 45_000,
      stale: false,
    },
  });
  await h.layer.update(h.viewer);
  await settle();

  h.faces()[0].activate();
  const [card] = h.cards();
  assert.equal(card.placement, 'below');
  assert.equal(card.title, 'SIGN · V1 location');
  assert.deepEqual(card.details, [
    'CRASH AHEAD',
    'USE CAUTION',
    'MnDOT data 45 seconds ago',
  ]);
  assert.match(h.statusNodes[0].textContent, /CRASH AHEAD, USE CAUTION/);
  assert.equal(h.faces()[0].protected, true);

  h.faces()[0].activate();
  assert.equal(h.cards().length, 0);

  h.faces()[0].activate();
  h.listeners.get('keydown')({ key: 'Escape' });
  assert.equal(h.cards().length, 0);

  // A click on the face (hit test) opens it; a new message refreshes it.
  h.hostHit = (x, y, { sourceId }) =>
    sourceId === 'message-signs' ? { entryId: 'V1' } : null;
  h.click({ x: 10, y: 10 });
  assert.equal(h.cards().length, 1);
  h.setSnapshot({
    signs: [sign('V1', 'msg_00000002', { multi: 'ALL LANES OPEN' })],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  assert.equal(h.cards()[0].details[0], 'ALL LANES OPEN');
  assert.match(h.statusNodes[0].textContent, /ALL LANES OPEN/);

  h.setSnapshot({ signs: [], ageMs: 0, stale: false });
  await h.layer.update(h.viewer);
  assert.equal(h.cards().length, 0);
  h.layer.destroy();
});

test("a marker click selects; another layer's object keeps the click", async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false },
  });
  await h.layer.update(h.viewer);
  await settle();
  h.click({ x: 1, y: 1 }, { id: 'message-sign:V1' });
  assert.equal(h.cards().length, 1);
  h.click({ x: 1, y: 1 }, { id: 'cctv:C001' });
  assert.equal(h.cards().length, 1);
  h.click({ x: 1, y: 1 }); // empty globe
  assert.equal(h.cards().length, 0);
  h.layer.destroy();
});

test('an empty list is a quiet success, not an error (AE2)', async () => {
  const h = harness();
  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.countLabel, '0 signs lit');
  assert.equal(stats.error, null);
  assert.equal(layerFeedState(stats), 'nominal');
  h.layer.destroy();
});

test('a sign whose GIF is gone keeps its marker and card, without a face', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false },
    missing: new Set(['msg_00000001']),
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.faces().length, 0);
  assert.equal(h.markers().length, 1);
  h.click({ x: 1, y: 1 }, { id: 'message-sign:V1' });
  assert.equal(h.cards().length, 1);
  h.layer.destroy();
});

test('late, superseded and post-destroy results change nothing', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve;
    const h = harness();
    h.setSnapshot(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    resolve({ signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false });
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.faces().length, 0);
    assert.equal(h.primitives.length, 0);
  }

  const h = harness();
  const resolvers = [];
  h.setSnapshot(() => new Promise((done) => resolvers.push(done)));
  const first = h.layer.update(h.viewer);
  const second = h.layer.update(h.viewer);
  resolvers[1]({ signs: [sign('V2', 'msg_00000002')], ageMs: 0, stale: false });
  resolvers[0]({ signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false });
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(
    h.layer.getAnalystRecords().map(({ id }) => id),
    ['V2'],
  );
  h.layer.destroy();
});

test('animated faces flip on their own delay, one render per flip (R3)', async () => {
  const h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_000000F2'), sign('V2', 'msg_00000001')],
      ageMs: 0,
      stale: false,
    },
    frames: { msg_000000F2: 2 },
  });
  await h.layer.update(h.viewer);
  await settle();
  const slot = h.faces().find((face) => face.id === 'V1').image;
  assert.equal(slot.stamp, 1);
  assert.equal(h.pendingTimers.size, 1);

  const rendersBefore = h.renders();
  await h.advance(1000);
  assert.equal(slot.stamp, 2);
  assert.equal(h.drawn.at(-1).image.frameIndex, 1);
  assert.equal(h.renders(), rendersBefore + 1);
  await h.advance(1000);
  assert.equal(h.drawn.at(-1).image.frameIndex, 0);

  // A hidden tab stops the clock; showing it again restarts it.
  h.setVisibility('hidden');
  assert.equal(h.pendingTimers.size, 0);
  h.setVisibility('visible');
  assert.equal(h.pendingTimers.size, 1);

  // With no animated face left, the clock stops.
  h.setSnapshot({
    signs: [sign('V2', 'msg_00000001')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.pendingTimers.size, 0);
  h.layer.destroy();
});

test('reduced motion holds an animated face on its first frame', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_000000F2')], ageMs: 0, stale: false },
    frames: { msg_000000F2: 2 },
    reducedMotion: true,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.faces()[0].image.stamp, 1);
  assert.equal(h.pendingTimers.size, 0);
  h.layer.destroy();
});

test('a failed first load stays enabled and reads unavailable (AE6)', async () => {
  const h = harness();
  h.setSnapshot(new Error('MnDOT HTTP 502'));
  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.countLabel, null);
  assert.equal(stats.error, 'MnDOT HTTP 502');
  assert.equal(layerFeedState(stats), 'unavailable');
  assert.equal(h.faces().length, 0);
  h.layer.destroy();
});

test('stale data dims faces; an error clears them; success recovers', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false },
  });
  await h.layer.update(h.viewer);
  await settle();
  h.faces()[0].activate();

  h.setSnapshot({
    signs: [sign('V1', 'msg_00000001')],
    ageMs: 180_000,
    stale: true,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.faces()[0].image.stamp, 2); // redrawn dimmed
  assert.equal(h.cards()[0].details.at(-1), 'STALE · MnDOT data 3 minutes ago');
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');

  h.setSnapshot(new Error('MnDOT HTTP 502'));
  await h.layer.update(h.viewer);
  assert.equal(h.faces().length, 0);
  assert.equal(h.markers(), null);
  assert.equal(h.cards().length, 0);
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');

  h.setSnapshot({
    signs: [sign('V1', 'msg_00000001')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  const stats = h.layer.getStats();
  assert.equal(stats.error, null);
  assert.equal(stats.status, 'ok');
  assert.equal(h.faces().length, 1);
  h.layer.destroy();
});

test('disable releases markers, faces, the card, timers and the status node', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_000000F2')], ageMs: 0, stale: false },
    frames: { msg_000000F2: 2 },
  });
  await h.layer.update(h.viewer);
  await settle();
  h.faces()[0].activate();
  assert.equal(h.statusNodes.length, 1);
  h.layer.disable();
  assert.equal(h.primitives.length, 0);
  assert.equal(h.faces().length, 0);
  assert.equal(h.cards().length, 0);
  assert.equal(h.pendingTimers.size, 0);
  assert.equal(h.statusNodes.length, 0);
  assert.equal(h.moveEnd.size, 0);
  assert.equal(h.listeners.size, 0);
  h.layer.destroy();
});
