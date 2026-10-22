import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePathCommands } from '../../src/motion/geometry/parse.js';
import { normalizePath, serializePath } from '../../src/motion/geometry/normalize.js';
import {
  prepareMorph,
  interpolatePaths,
  resampleSubpath,
  rotateSubpath,
  reverseSubpath,
  subpathLength,
  samplePolygon,
  subpathArea
} from '../../src/motion/geometry/compat.js';

const CIRCLE_4ARCES =
  'M 12 2 A 10 10 0 1 1 11.99 2 Z';

const SQUARE = 'M2 2 L22 2 L22 22 L2 22 Z';
const TRIANGLE = 'M12 2 L22 22 L2 22 Z';
const STAR =
  'M12 2 L14.9 9.1 L22.5 9.6 L16.7 14.3 L18.5 21.7 L12 17.6 L5.5 21.7 L7.3 14.3 L1.5 9.6 L9.1 9.1 Z';

function closeTo(actual, expected, tol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? 'value'}: expected ${expected} ± ${tol}, got ${actual}`
  );
}

test('parser handles implicit repetition and relative commands', () => {
  const cmds = parsePathCommands('M1 2 3 4 5 6');
  assert.equal(cmds.length, 3);
  assert.equal(cmds[0].cmd, 'M');
  assert.deepEqual(cmds[1], { cmd: 'L', params: [3, 4] });
  assert.deepEqual(cmds[2], { cmd: 'L', params: [5, 6] });

  const rel = parsePathCommands('m10 10 l5 0');
  assert.equal(rel[0].cmd, 'm');
  assert.deepEqual(rel[1], { cmd: 'l', params: [5, 0] });
});

test('parser reads arc flags that are not space separated', () => {
  // "0 011 1" style: flags may abut the coordinates.
  const cmds = parsePathCommands('M0 0a1 1 0 011 1');
  assert.equal(cmds.length, 2);
  assert.deepEqual(cmds[1].params, [1, 1, 0, 0, 1, 1, 1]);
});

test('parser rejects unsupported commands with a useful message', () => {
  assert.throws(() => parsePathCommands('M0 0 X5 5'), /unsupported path command/);
  assert.throws(() => parsePathCommands('10 10'), /must start with a command/);
});

test('normaliser converts every command type into cubics', () => {
  const d = 'M0 0 H10 V10 Q15 15 20 10 T30 10 A5 5 0 0 1 35 15 Z';
  const { subpaths, stats } = normalizePath(d);
  assert.equal(subpaths.length, 1);
  assert.ok(subpaths[0].closed);
  assert.ok(stats.arcs === 1 && stats.quadratics === 2);
  for (const seg of subpaths[0].segments) {
    assert.equal(seg.c1.length, 2);
    assert.equal(seg.c2.length, 2);
    assert.equal(seg.to.length, 2);
  }
});

test('arc conversion lands on the endpoints and keeps radius accuracy', () => {
  // Half circle from (2,12) to (22,12): the centre is unambiguous at (12,12).
  const { subpaths } = normalizePath('M2 12 A10 10 0 0 1 22 12');
  const sp = subpaths[0];
  const first = sp.start;
  const last = sp.segments[sp.segments.length - 1].to;
  assert.ok(Math.abs(first[0] - 2) < 1e-9 && Math.abs(first[1] - 12) < 1e-9);
  assert.ok(Math.abs(last[0] - 22) < 1e-6 && Math.abs(last[1] - 12) < 1e-6);

  // Every sampled point of the arc must sit 10 units from the centre.
  const pts = samplePolygon(sp, 24);
  let worst = 0;
  for (const [x, y] of pts) {
    const r = Math.hypot(x - 12, y - 12);
    worst = Math.max(worst, Math.abs(r - 10) / 10);
  }
  assert.ok(worst < 5e-4, `radial error ${(worst * 100).toFixed(4)}% should stay under 0.05%`);
});

test('resampling preserves the outline exactly', () => {
  const { subpaths } = normalizePath(SQUARE);
  const original = subpaths[0];
  const densified = resampleSubpath(original, 16);
  assert.equal(densified.segments.length, 16);

  const a = samplePolygon(original, 12);
  const b = samplePolygon(densified, 3);
  // Both must trace the same square: area and perimeter agree to within 1e-6.
  const area = (pts) => {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      sum += x0 * y1 - x1 * y0;
    }
    return Math.abs(sum) / 2;
  };
  closeTo(area(b), area(a), 1e-6, 'area after split');
  closeTo(subpathLength(densified), subpathLength(original), 1e-3, 'perimeter after split');
});

test('rotation re-anchors without changing the outline', () => {
  const { subpaths } = normalizePath(SQUARE);
  const sp = subpaths[0];
  const rotated = rotateSubpath(sp, 1);
  assert.equal(rotated.segments.length, sp.segments.length);
  // The new start anchor must be the second corner of the square.
  closeTo(rotated.start[0], 22, 1e-9, 'x');
  closeTo(rotated.start[1], 2, 1e-9, 'y');
  // Last segment must close back onto the new start.
  const last = rotated.segments[rotated.segments.length - 1].to;
  closeTo(last[0], rotated.start[0], 1e-9, 'closing x');
  closeTo(last[1], rotated.start[1], 1e-9, 'closing y');
  closeTo(subpathArea(rotated), subpathArea(sp), 1e-6, 'area');
});

test('reversal keeps the outline and flips traversal', () => {
  const { subpaths } = normalizePath(TRIANGLE);
  const sp = subpaths[0];
  const rev = reverseSubpath(sp);
  closeTo(subpathArea(rev), subpathArea(sp), 1e-6, 'area');
  closeTo(subpathLength(rev), subpathLength(sp), 1e-3, 'perimeter');
  // A closed outline reversed still starts on the same anchor, but the first
  // segment now heads to the previous vertex.
  closeTo(rev.start[0], 12, 1e-9, 'reversed start x');
  closeTo(rev.start[1], 2, 1e-9, 'reversed start y');
  closeTo(rev.segments[0].to[0], 2, 1e-9, 'first hop x');
  closeTo(rev.segments[0].to[1], 22, 1e-9, 'first hop y');
});

test('morph between different command mixes produces equal segment counts', () => {
  const from = normalizePath(CIRCLE_4ARCES);
  const to = normalizePath(STAR);
  const prepared = prepareMorph(from, to);
  assert.equal(prepared.from.length, prepared.to.length);
  for (let i = 0; i < prepared.from.length; i++) {
    assert.equal(prepared.from[i].segments.length, prepared.to[i].segments.length);
  }
  assert.ok(prepared.report.segments >= 5);
});

test('morph endpoints reproduce the source and target outlines', () => {
  const from = normalizePath(SQUARE);
  const to = normalizePath(STAR);
  const prepared = prepareMorph(from, to);

  const at0 = interpolatePaths(prepared.from, prepared.to, 0, 4);
  const at1 = interpolatePaths(prepared.from, prepared.to, 1, 4);

  const areaOf = (d) => {
    const { subpaths } = normalizePath(d);
    return subpaths.reduce((s, sp) => s + subpathArea(sp), 0);
  };
  const srcArea = from.subpaths.reduce((s, sp) => s + subpathArea(sp), 0);
  const dstArea = to.subpaths.reduce((s, sp) => s + subpathArea(sp), 0);
  closeTo(areaOf(at0), srcArea, 1e-4, 't=0 area');
  closeTo(areaOf(at1), dstArea, 1e-4, 't=1 area');
});

test('morph never emits NaN or infinite coordinates', () => {
  const pairs = [
    ['M12 2 A10 10 0 1 1 11.99 2 Z', STAR],
    ['M2 2 H22 V22 H2 Z', 'M12 2 A10 10 0 1 1 11.99 2 Z'],
    ['M0 0 L10 0', 'M5 5 A3 3 0 0 1 11 11 Z'],
    ['M4 4 h8 v8 h-8 z M8 8 h2 v2 h-2 z', 'M12 2 L22 22 L2 22 Z']
  ];
  for (const [a, b] of pairs) {
    const prepared = prepareMorph(normalizePath(a), normalizePath(b));
    for (let step = 0; step <= 10; step++) {
      const d = interpolatePaths(prepared.from, prepared.to, step / 10, 3);
      assert.ok(!/NaN|Infinity/.test(d), `invalid output at t=${step / 10}: ${d}`);
    }
  }
});

test('sub-path count mismatch collapses extras instead of dropping them', () => {
  const ring = 'M12 2 A10 10 0 1 1 11.99 2 Z M12 8 A4 4 0 1 1 11.99 8 Z';
  const disc = 'M12 2 A10 10 0 1 1 11.99 2 Z';
  const prepared = prepareMorph(normalizePath(ring), normalizePath(disc));
  assert.equal(prepared.from.length, prepared.to.length);
  assert.ok(prepared.from.length >= 2, 'both sub-paths must survive the transition');
  assert.ok(prepared.report.collapsed >= 1);
});

test('serialisation is stable and precision-limited', () => {
  const { subpaths } = normalizePath('M1.23456 2.34567 L3.45678 4.56789');
  const d = serializePath(subpaths, 2);
  assert.ok(/^M1\.23 2\.35C/.test(d), d);
  assert.equal(serializePath(normalizePath(d).subpaths, 2), d, 'round-trip must be idempotent');
});
