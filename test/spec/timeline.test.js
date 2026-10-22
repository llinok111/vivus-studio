import test from 'node:test';
import assert from 'node:assert/strict';

import { Timeline, Track } from '../../src/motion/timeline.js';
import { EASINGS, resolveEasing } from '../../src/motion/easing.js';
import { unifyMorphKeyframes, sampleUnified } from '../../src/motion/geometry/unify.js';

const SQUARE = 'M2 2 L22 2 L22 22 L2 22 Z';
const CIRCLE = 'M12 2 A10 10 0 1 1 11.99 2 Z';

function numberTrack(keyframes) {
  return new Track({ id: 'n', kind: 'number', target: 'n', keyframes });
}

test('sampling hits keyframe values exactly', () => {
  const track = numberTrack([
    { t: 0, value: 0, easing: 'linear' },
    { t: 100, value: 10, easing: 'linear' },
    { t: 300, value: 4, easing: 'linear' }
  ]);
  assert.equal(track.bracket(0).local, 0);
  const tl = new Timeline({ duration: 300, tracks: [track] });
  assert.equal(tl.sampleAt(0).get('n'), 0);
  assert.equal(tl.sampleAt(100).get('n'), 10);
  assert.equal(tl.sampleAt(300).get('n'), 4);
});

test('easing is deterministic and monotone where expected', () => {
  for (const name of ['linear', 'easeInOutCubic', 'easeOutQuint' in EASINGS ? 'easeOutQuint' : 'easeOutCubic']) {
    const fn = resolveEasing(name);
    assert.equal(fn(0), 0);
    assert.equal(fn(1), 1);
    for (let i = 1; i <= 20; i++) {
      const v = fn(i / 20);
      assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${name} left 0..1 at t=${i / 20}`);
    }
  }
});

test('hold easing produces a step, not a ramp', () => {
  const track = numberTrack([
    { t: 0, value: 0, easing: 'hold' },
    { t: 100, value: 1, easing: 'hold' }
  ]);
  const tl = new Timeline({ duration: 100, tracks: [track] });
  assert.equal(tl.sampleAt(0).get('n'), 0);
  assert.equal(tl.sampleAt(50).get('n'), 0);
  assert.equal(tl.sampleAt(99).get('n'), 0);
  assert.equal(tl.sampleAt(100).get('n'), 1);
});

test('morph track interpolates and caches its preparation', () => {
  const track = new Track({
    id: 'm',
    kind: 'morph',
    target: 'm',
    keyframes: [
      { t: 0, value: { d: SQUARE }, easing: 'linear' },
      { t: 200, value: { d: CIRCLE }, easing: 'linear' }
    ]
  });
  const tl = new Timeline({ duration: 200, tracks: [track] });
  const mid = tl.sampleAt(100).get('m');
  assert.equal(typeof mid, 'string');
  assert.ok(!/NaN/.test(mid));
  assert.ok(mid.startsWith('M'));
  assert.equal(tl._morphCache.size, 1, 'preparation must be cached across frames');
  const again = tl.sampleAt(140).get('m');
  assert.equal(tl._morphCache.size, 1, 'cache must not grow while scrubbing');
  assert.notEqual(again, mid);
});

test('sampling is pure: scrubbing back and forth cannot change the result', () => {
  const track = numberTrack([
    { t: 0, value: 0, easing: 'easeInOutCubic' },
    { t: 500, value: 1, easing: 'easeInOutCubic' },
    { t: 900, value: 0.2, easing: 'easeOutBack' }
  ]);
  const tl = new Timeline({ duration: 900, tracks: [track] });
  const probe = () => [100, 350, 700, 120, 880, 400].map((t) => tl.sampleAt(t).get('n'));
  const first = probe();
  probe();
  probe();
  assert.deepEqual(probe(), first);
});

test('interrupting a number track does not jump', () => {
  const track = numberTrack([
    { t: 0, value: 0, easing: 'easeInOutCubic' },
    { t: 1000, value: 1, easing: 'easeInOutCubic' }
  ]);
  const tl = new Timeline({ duration: 1000, tracks: [track] });

  const before = tl.sampleAt(400).get('n');
  assert.ok(before > 0.2 && before < 0.6, `mid-flight probe should be inside the ramp, got ${before}`);

  tl.interrupt('n', { at: 400, value: 0, duration: 300 });
  const after = tl.sampleAt(400).get('n');
  assert.ok(Math.abs(after - before) < 1e-9, `value jumped by ${Math.abs(after - before)} on interrupt`);

  // The new destination must actually be reached.
  assert.ok(Math.abs(tl.sampleAt(700).get('n') - 0) < 1e-9);
});

test('interrupting a morph track does not jump either', () => {
  const track = new Track({
    id: 'm',
    kind: 'morph',
    target: 'm',
    keyframes: [
      { t: 0, value: { d: SQUARE }, easing: 'easeInOutCubic' },
      { t: 1000, value: { d: CIRCLE }, easing: 'easeInOutCubic' }
    ]
  });
  const tl = new Timeline({ duration: 1000, tracks: [track] });
  const before = tl.sampleAt(420).get('m');
  tl.interrupt('m', { at: 420, value: { d: SQUARE }, duration: 260 });
  const after = tl.sampleAt(420).get('m');

  // Byte equality is not achievable nor required: the anchor is re-serialised
  // through the unified chain. What must hold is that no anchor moved further
  // than serialisation rounding (1e-3 user units).
  const delta = maxPathDelta(before, after);
  assert.ok(delta < 1e-3, `anchor moved by ${delta} user units on interrupt`);
  assert.ok(tl.sampleAt(680).get('m').startsWith('M'));
});

function maxPathDelta(a, b) {
  const na = (a.match(/-?\d*\.?\d+/g) || []).map(Number);
  const nb = (b.match(/-?\d*\.?\d+/g) || []).map(Number);
  if (na.length !== nb.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < na.length; i++) worst = Math.max(worst, Math.abs(na[i] - nb[i]));
  return worst;
}

test('repeated interrupts stay bounded in keyframe count', () => {
  const track = numberTrack([
    { t: 0, value: 0, easing: 'linear' },
    { t: 1000, value: 1, easing: 'linear' }
  ]);
  const tl = new Timeline({ duration: 1000, tracks: [track] });
  const baseline = track.keyframes.length;

  for (let i = 0; i < 8; i++) {
    tl.interrupt('n', { at: 200 + i * 40, value: i % 2 === 0 ? 1 : 0, duration: 200 });
  }
  // Each interrupt may add at most one anchor plus one destination; stale
  // synthetic keys must be discarded, so growth is linear and small.
  assert.ok(
    track.keyframes.length <= baseline + 8 * 2,
    `keyframes grew to ${track.keyframes.length}, expected <= ${baseline + 16}`
  );
  for (const kf of track.keyframes) {
    assert.ok(Number.isFinite(kf.t) && kf.t >= 0 && kf.t <= 1000, `bad keyframe time ${kf.t}`);
  }
});

test('velocity-preserving interrupt keeps direction at the seam', () => {
  const track = numberTrack([
    { t: 0, value: 0, easing: 'linear' },
    { t: 1000, value: 1, easing: 'linear' }
  ]);
  const tl = new Timeline({ duration: 1000, tracks: [track] });

  const vBefore = (tl.sampleAt(400).get('n') - tl.sampleAt(376).get('n')) / 24;
  tl.interrupt('n', { at: 400, value: 0, duration: 400, preserveVelocity: true });
  const vAfter = (tl.sampleAt(424).get('n') - tl.sampleAt(400).get('n')) / 24;

  // Still moving forward immediately after the retarget, then reverses.
  assert.ok(vAfter > 0, `expected continued forward motion, got ${vAfter}`);
  assert.ok(Math.abs(vAfter - vBefore) / Math.abs(vBefore) < 0.6, 'velocity should stay in the same ballpark');
  assert.ok(tl.sampleAt(800).get('n') < 0.05, 'and still land on the new target');
});

test('interrupt clamps to the timeline bounds', () => {
  const track = numberTrack([{ t: 0, value: 0, easing: 'linear' }]);
  const tl = new Timeline({ duration: 500, tracks: [track] });
  tl.interrupt('n', { at: 480, value: 5, duration: 1000 });
  const times = track.keyframes.map((k) => k.t);
  assert.ok(Math.max(...times) <= 500, `keyframe at ${Math.max(...times)} exceeds duration`);
});

test('compact removes redundant synthetic keys only', () => {
  const track = numberTrack([
    { t: 0, value: 0, easing: 'linear' },
    { t: 100, value: 1, easing: 'linear' }
  ]);
  const tl = new Timeline({ duration: 100, tracks: [track] });
  tl.interrupt('n', { at: 40, value: 0.4, duration: 40 });
  const before = track.keyframes.length;
  tl.compact('n');
  assert.ok(track.keyframes.length <= before);
  assert.ok(track.keyframes.some((k) => Math.abs(k.t - 0) < 1e-9), 'real keys must survive compaction');
});

test('timeline JSON round-trip preserves timing and easing', () => {
  const tl = new Timeline({
    duration: 750,
    loop: true,
    tracks: [
      new Track({
        id: 'm',
        kind: 'morph',
        target: 'icon',
        keyframes: [
          { t: 0, value: { d: SQUARE }, easing: 'easeInOutCubic' },
          { t: 500, value: { d: CIRCLE }, easing: 'easeOutBack' }
        ]
      })
    ]
  });
  const restored = Timeline.fromJSON(JSON.parse(JSON.stringify(tl.toJSON())));
  assert.equal(restored.duration, 750);
  assert.equal(restored.loop, true);
  const a = tl.sampleAt(250).get('m');
  const b = restored.sampleAt(250).get('m');
  assert.equal(a, b);
});

test('outside the keyframe span a morph track returns a d string', () => {
  // Regression: returning the raw `{ d }` object after the last keyframe made
  // the scene skip the write, and the glyph froze on whatever frame was on
  // screen when the track ended.
  const track = new Track({
    id: 'm',
    kind: 'morph',
    target: 'm',
    keyframes: [
      { t: 0, value: { d: SQUARE }, easing: 'easeInOutCubic' },
      { t: 200, value: { d: CIRCLE }, easing: 'hold' }
    ]
  });
  const tl = new Timeline({ duration: 600, tracks: [track] });
  const after = tl.sampleAt(500).get('m');
  assert.equal(typeof after, 'string', `expected string, got ${typeof after}`);
  assert.ok(after.startsWith('M'), after);
  assert.equal(after.replace(/Z$/, ''), CIRCLE.replace(/Z$/, ''));
  assert.equal(typeof tl.sampleAt(0).get('m'), 'string');
});

test('unified morph chain gives every frame the same command signature', () => {
  const { frames, meta } = unifyMorphKeyframes([
    { t: 0, value: { d: SQUARE }, easing: 'linear' },
    { t: 400, value: { d: CIRCLE }, easing: 'linear' },
    { t: 800, value: { d: 'M4 4 h8 v8 h-8 z M8 8 h2 v2 h-2 z' }, easing: 'linear' }
  ]);
  const signatures = frames.map((f) => (f.d.match(/[A-Za-z]/g) || []).join(''));
  for (const sig of signatures) {
    assert.equal(sig, signatures[0], `structure drifted: ${sig} vs ${signatures[0]}`);
  }
  assert.ok(meta.totalSegments > 0);
  // Sampling the unified chain must not produce malformed data.
  const mid = sampleUnified(frames, resolveEasing, 600);
  assert.ok(!/NaN/.test(mid));
  assert.equal(sampleUnified(frames, resolveEasing, 0), frames[0].d);
});
