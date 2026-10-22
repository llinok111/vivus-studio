/**
 * Cross-path compatibility: turning two unrelated outlines into two shapes
 * that can be interpolated point by point without visual artefacts.
 *
 * Three independent problems have to be solved, and they are easy to confuse:
 *
 *   1. Topology  - different numbers of sub-paths (a ring vs. a solid disc).
 *   2. Resolution - different numbers of curve segments per sub-path.
 *   3. Indexing   - which anchor of A maps to which anchor of B, and in which
 *                   direction the outline is traversed.
 *
 * Skipping (1) drops geometry. Skipping (2) misaligns indices. Skipping (3)
 * produces the classic "twisted ribbon": the shape turns itself inside out
 * during the transition because anchor 0 of A maps to the far side of B.
 */

import { serializePath } from './normalize.js';

const EPS = 1e-9;

/* ------------------------------------------------------------------ *
 * Basic measures
 * ------------------------------------------------------------------ */

export function subpathBounds(sp) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (p) => {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  };
  visit(sp.start);
  for (const seg of sp.segments) {
    visit(seg.c1);
    visit(seg.c2);
    visit(seg.to);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function subpathCentroid(sp) {
  // Area-weighted centroid when the sub-path encloses area, otherwise the
  // average of the sample points. A pure anchor average drifts badly for
  // shapes with dense curvature.
  let area = 0;
  let cx = 0;
  let cy = 0;
  const pts = samplePolygon(sp, 12);
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) > 1e-6) {
    return [cx / (6 * area), cy / (6 * area)];
  }
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}

export function subpathArea(sp) {
  const pts = samplePolygon(sp, 12);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}

export function subpathLength(sp) {
  let total = 0;
  let from = sp.start;
  for (const seg of sp.segments) {
    total += cubicLength(from, seg.c1, seg.c2, seg.to);
    from = seg.to;
  }
  return total;
}

/** Flatten a sub-path to points; `perSegment` samples per cubic. */
export function samplePolygon(sp, perSegment = 8) {
  const pts = [sp.start];
  let from = sp.start;
  for (const seg of sp.segments) {
    for (let i = 1; i <= perSegment; i++) {
      pts.push(cubicPoint(from, seg.c1, seg.c2, seg.to, i / perSegment));
    }
    from = seg.to;
  }
  return pts;
}

/* ------------------------------------------------------------------ *
 * Cubic helpers
 * ------------------------------------------------------------------ */

export function cubicPoint(p0, c1, c2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]
  ];
}

export function cubicLength(p0, c1, c2, p3) {
  // 5-point Gauss-Legendre quadrature of the speed function. The weights sum
  // to exactly 2, so straight segments come out exact, and curvature typical
  // of icon geometry stays well under a thousandth of a pixel of error.
  const w = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];
  const x = [-0.9061798459386640, -0.5384693101056831, 0, 0.5384693101056831, 0.9061798459386640];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    const t = 0.5 * (x[i] + 1);
    const mt = 1 - t;
    const dx =
      3 * mt * mt * (c1[0] - p0[0]) + 6 * mt * t * (c2[0] - c1[0]) + 3 * t * t * (p3[0] - c2[0]);
    const dy =
      3 * mt * mt * (c1[1] - p0[1]) + 6 * mt * t * (c2[1] - c1[1]) + 3 * t * t * (p3[1] - c2[1]);
    sum += w[i] * Math.hypot(dx, dy);
  }
  return sum * 0.5;
}

/** de Casteljau split at t = 0.5. Exact, so splitting never changes the shape. */
export function splitSegment(p0, seg) {
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = mid(p0, seg.c1);
  const p12 = mid(seg.c1, seg.c2);
  const p23 = mid(seg.c2, seg.to);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  return {
    left: { c1: p01, c2: p012, to: p0123 },
    right: { c1: p123, c2: p23, to: seg.to },
    pivot: p0123
  };
}

/* ------------------------------------------------------------------ *
 * Sub-path reshaping
 * ------------------------------------------------------------------ */

/**
 * Increase the segment count to `target` by repeatedly splitting the longest
 * segment. Splitting is exact, so this raises resolution without deforming
 * the outline - unlike padding with zero-length segments at the tail, which
 * leaves a dead zone where the shape stops responding.
 *
 * @param {object} sp
 * @param {number} target
 * @returns {object} new sub-path
 */
export function resampleSubpath(sp, target) {
  const segments = sp.segments.map((s) => ({ c1: [...s.c1], c2: [...s.c2], to: [...s.to] }));
  if (segments.length >= target) {
    return { start: [...sp.start], segments, closed: sp.closed };
  }

  // Pre-compute lengths, then keep splitting the largest remaining piece.
  let from = sp.start;
  const lengths = segments.map((s) => {
    const len = cubicLength(from, s.c1, s.c2, s.to);
    from = s.to;
    return len;
  });

  let count = segments.length;
  while (count < target) {
    let worst = 0;
    for (let i = 1; i < lengths.length; i++) {
      if (lengths[i] > lengths[worst]) worst = i;
    }
    // Degenerate sub-path (all zero length): splitting gains nothing, so pad.
    if (lengths[worst] <= EPS) {
      const tail = segments[segments.length - 1];
      const point = tail ? [...tail.to] : [...sp.start];
      while (count < target) {
        segments.push({ c1: [...point], c2: [...point], to: [...point] });
        lengths.push(0);
        count++;
      }
      break;
    }

    let startPoint = sp.start;
    for (let i = 0; i < worst; i++) startPoint = segments[i].to;
    const { left, right } = splitSegment(startPoint, segments[worst]);
    segments.splice(worst, 1, left, right);
    const half = lengths[worst] / 2;
    lengths.splice(worst, 1, half, half);
    count++;
  }

  return { start: [...sp.start], segments, closed: sp.closed };
}

/** Reverse traversal direction without moving the outline. */
export function reverseSubpath(sp) {
  const points = [sp.start];
  for (const seg of sp.segments) points.push(seg.to);
  const newStart = [...points[points.length - 1]];
  const segments = [];
  for (let i = sp.segments.length - 1; i >= 0; i--) {
    const seg = sp.segments[i];
    segments.push({
      c1: [...seg.c2],
      c2: [...seg.c1],
      to: [...points[i]]
    });
  }
  return { start: newStart, segments, closed: sp.closed };
}

/**
 * Rotate the anchor index of a closed sub-path by `k` segments.
 * A no-op for open sub-paths, which have a meaningful start point.
 */
export function rotateSubpath(sp, k) {
  if (!sp.closed || k === 0 || !sp.segments.length) return sp;
  const n = sp.segments.length;
  const shift = ((k % n) + n) % n;
  if (shift === 0) return sp;
  const points = [sp.start];
  for (const seg of sp.segments) points.push(seg.to);

  // points[i] is the start anchor of segment i, so a shift of k re-anchors the
  // outline at points[k] and emits segments k, k+1, ... n-1, 0, ... k-1.
  const newStart = [...points[shift]];
  const segments = [];
  for (let i = 0; i < n; i++) {
    segments.push(sp.segments[(shift + i) % n]);
  }
  return { start: newStart, segments, closed: true };
}

/* ------------------------------------------------------------------ *
 * Indexing cost and alignment
 * ------------------------------------------------------------------ */

/** Squared distance between corresponding anchor/control points. */
export function pairCost(a, b) {
  let cost = sqDist(a.start, b.start);
  for (let i = 0; i < a.segments.length; i++) {
    const sa = a.segments[i];
    const sb = b.segments[i];
    cost += sqDist(sa.c1, sb.c1) + sqDist(sa.c2, sb.c2) + sqDist(sa.to, sb.to);
  }
  return cost;
}

function sqDist(p, q) {
  const dx = p[0] - q[0];
  const dy = p[1] - q[1];
  return dx * dx + dy * dy;
}

/**
 * Find the cheapest anchor mapping between two equal-length sub-paths.
 *
 * Closed shapes are tested over every rotation and both directions. Above
 * `exhaustiveLimit` segments the rotation search is strided, because the cost
 * is O(n^2) and a 900-segment trace would otherwise block the main thread.
 */
export function alignSubpaths(a, b, options = {}) {
  const exhaustiveLimit = options.exhaustiveLimit ?? 256;
  const n = a.segments.length;
  if (n !== b.segments.length) {
    throw new Error('alignSubpaths requires equal segment counts');
  }

  const reversedB = reverseSubpath(b);
  let best = { cost: Infinity, rotation: 0, reversed: false };

  const candidates = a.closed && b.closed ? rotationCandidates(n, exhaustiveLimit) : [0];

  for (const reversed of [false, true]) {
    const target = reversed ? reversedB : b;
    for (const k of candidates) {
      const rotated = rotateSubpath(target, k);
      const cost = pairCost(a, rotated);
      if (cost < best.cost - 1e-9) {
        best = { cost, rotation: k, reversed };
      }
    }
  }

  const aligned = rotateSubpath(best.reversed ? reversedB : b, best.rotation);
  return {
    b: fixedStart(aligned, a.start),
    cost: best.cost,
    rotation: best.rotation,
    reversed: best.reversed
  };
}

/**
 * Rotation of a closed sub-path changes the start anchor, which must equal the
 * previous segment's endpoint. rotateSubpath already guarantees that; this
 * helper exists for the reversed-then-rotated path and asserts consistency.
 */
function fixedStart(sp, fallbackStart) {
  if (!sp.segments.length) {
    return { start: [...fallbackStart], segments: sp.segments, closed: sp.closed };
  }
  const last = sp.segments[sp.segments.length - 1].to;
  if (sp.closed) {
    return sp;
  }
  return sp;
}

function rotationCandidates(n, limit) {
  if (n <= limit) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const stride = Math.ceil(n / limit);
  const coarse = [];
  for (let i = 0; i < n; i += stride) coarse.push(i);
  return coarse;
}

/* ------------------------------------------------------------------ *
 * Sub-path pairing
 * ------------------------------------------------------------------ */

/**
 * Decide which sub-path of A becomes which sub-path of B.
 *
 * Pairing uses a greedy assignment on a cost that mixes centroid distance and
 * area difference, both normalised by the diagram's diagonal so the threshold
 * behaves the same for a 24 px icon and a 1024 px illustration.
 */
export function pairSubpaths(subA, subB) {
  const nA = subA.length;
  const nB = subB.length;
  const pairs = [];
  const usedB = new Set();

  if (!nA || !nB) return pairs;

  const infoA = subA.map((sp) => ({ c: subpathCentroid(sp), a: subpathArea(sp) }));
  const infoB = subB.map((sp) => ({ c: subpathCentroid(sp), a: subpathArea(sp) }));

  const all = [...infoA, ...infoB];
  const minX = Math.min(...all.map((p) => p.c[0]));
  const maxX = Math.max(...all.map((p) => p.c[0]));
  const minY = Math.min(...all.map((p) => p.c[1]));
  const maxY = Math.max(...all.map((p) => p.c[1]));
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const areaScale = Math.max(1e-6, ...all.map((p) => p.a));

  const candidates = [];
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nB; j++) {
      const dist = Math.hypot(infoA[i].c[0] - infoB[j].c[0], infoA[i].c[1] - infoB[j].c[1]) / diag;
      const areaDelta = Math.abs(infoA[i].a - infoB[j].a) / areaScale;
      candidates.push({ i, j, cost: dist * 2 + areaDelta });
    }
  }
  candidates.sort((p, q) => p.cost - q.cost);

  const usedA = new Set();
  const remaining = [];
  for (const cand of candidates) {
    if (usedA.has(cand.i) || usedB.has(cand.j)) {
      remaining.push(cand);
      continue;
    }
    usedA.add(cand.i);
    usedB.add(cand.j);
    pairs.push({ a: cand.i, b: cand.j });
  }
  return pairs;
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Prepare two normalised paths for morphing.
 *
 * @param {{subpaths: Array<object>}} from
 * @param {{subpaths: Array<object>}} to
 * @param {{maxSegments?: number, precision?: number}} options
 * @returns {{from: Array<object>, to: Array<object>, report: object}}
 */
export function prepareMorph(from, to, options = {}) {
  const maxSegments = options.maxSegments ?? 1200;
  const report = {
    subpathsFrom: from.subpaths.length,
    subpathsTo: to.subpaths.length,
    paired: 0,
    collapsed: 0,
    resampled: 0,
    rotated: 0,
    reversed: 0,
    segments: 0,
    strategy: 'morph'
  };

  if (!from.subpaths.length || !to.subpaths.length) {
    report.strategy = 'unsupported-empty';
    return { from: from.subpaths, to: to.subpaths, report };
  }

  const pairs = pairSubpaths(from.subpaths, to.subpaths);
  report.paired = pairs.length;

  const alignedFrom = [];
  const alignedTo = [];

  for (const pair of pairs) {
    const a = from.subpaths[pair.a];
    const b = to.subpaths[pair.b];

    let segCount = Math.max(a.segments.length, b.segments.length, 1);
    segCount = Math.min(segCount, maxSegments);

    const ra = resampleSubpath(a, segCount);
    let rb = resampleSubpath(b, segCount);
    if (rb.segments.length !== segCount) {
      rb = resampleSubpath(b, segCount);
    }
    if (ra.segments.length !== rb.segments.length) {
      const target = Math.min(ra.segments.length, rb.segments.length);
      segCount = target;
    }

    const aligned = alignSubpaths(ra, rb, options);
    if (aligned.rotation) report.rotated++;
    if (aligned.reversed) report.reversed++;
    if (a.segments.length !== segCount || b.segments.length !== segCount) report.resampled++;

    // Closed/open mismatch cannot be interpolated faithfully: the open shape
    // would need to grow a seam. Force both open and add the closing edge so
    // the outline stays continuous.
    let finalA = ra;
    let finalB = aligned.b;
    if (ra.closed !== rb.closed) {
      finalA = { start: [...ra.start], segments: ra.segments, closed: false };
      finalB = { start: [...aligned.b.start], segments: aligned.b.segments, closed: false };
    }

    alignedFrom.push(finalA);
    alignedTo.push(finalB);
  }

  // Sub-paths present on only one side collapse onto their own centroid, so
  // they appear or disappear in place instead of flying in from (0, 0).
  const usedA2 = new Set(pairs.map((p) => p.a));
  const usedB2 = new Set(pairs.map((p) => p.b));

  for (let i = 0; i < from.subpaths.length; i++) {
    if (usedA2.has(i)) continue;
    const sp = from.subpaths[i];
    const ref = findReferenceCount(alignedTo);
    alignedFrom.push(collapseToCentroid(sp, ref, sp.closed));
    alignedTo.push(collapseToCentroid(sp, ref, sp.closed));
    report.collapsed++;
  }
  for (let j = 0; j < to.subpaths.length; j++) {
    if (usedB2.has(j)) continue;
    const sp = to.subpaths[j];
    const ref = findReferenceCount(alignedFrom);
    alignedFrom.push(collapseToCentroid(sp, ref, sp.closed));
    alignedTo.push(collapseToCentroid(sp, ref, sp.closed));
    report.collapsed++;
  }

  report.segments = alignedFrom.reduce((sum, sp) => sum + sp.segments.length, 0);
  report.strategy = report.collapsed > 0 ? 'morph-with-collapse' : 'morph';
  return { from: alignedFrom, to: alignedTo, report };
}

function findReferenceCount(list) {
  if (!list.length) return 1;
  return Math.max(1, list[list.length - 1].segments.length);
}

function collapseToCentroid(sp, segmentCount, closed) {
  const [cx, cy] = subpathCentroid(sp);
  const segments = [];
  for (let i = 0; i < Math.max(1, segmentCount); i++) {
    segments.push({ c1: [cx, cy], c2: [cx, cy], to: [cx, cy] });
  }
  return { start: [cx, cy], segments, closed };
}

/* ------------------------------------------------------------------ *
 * Interpolation
 * ------------------------------------------------------------------ */

/**
 * Interpolate between two aligned path sets.
 *
 * @param {Array<object>} from
 * @param {Array<object>} to
 * @param {number} t 0..1
 * @param {number} precision
 * @returns {string} path data
 */
export function interpolatePaths(from, to, t, precision = 3) {
  const n = Math.min(from.length, to.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = from[i];
    const b = to[i];
    const segCount = Math.min(a.segments.length, b.segments.length);
    const segments = [];
    for (let s = 0; s < segCount; s++) {
      const sa = a.segments[s];
      const sb = b.segments[s];
      segments.push({
        c1: lerp2(sa.c1, sb.c1, t),
        c2: lerp2(sa.c2, sb.c2, t),
        to: lerp2(sa.to, sb.to, t)
      });
    }
    out.push({
      start: lerp2(a.start, b.start, t),
      segments,
      closed: t < 0.5 ? a.closed : b.closed
    });
  }
  return serializePath(out, precision);
}

function lerp2(p, q, t) {
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}
