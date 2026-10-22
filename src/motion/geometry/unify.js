/**
 * Morph-chain unification, needed before a track can be written as a single
 * SMIL `values` list.
 *
 * SMIL interpolates `d` only when every value in the list has the same command
 * signature. A timeline is free to jump between incompatible outlines (a hold
 * keyframe, an icon swap), so the exporter first rewrites the whole track into
 * one canonical structure:
 *
 *   1. sort sub-paths by area so index assignment is stable across keyframes
 *   2. resample every keyframe to the largest segment count seen in the track
 *   3. re-anchor (rotate/reverse) each keyframe against its predecessor
 *
 * Resampling uses exact de Casteljau splits and re-anchoring only rotates or
 * reverses the traversal, so no keyframe changes shape. The timeline's own
 * pairwise preparation is still used at playback time; this pass exists purely
 * so the export has one consistent geometry description.
 */

import { normalizePath, serializePath } from './normalize.js';
import {
  resampleSubpath,
  reverseSubpath,
  rotateSubpath,
  pairCost,
  subpathArea,
  subpathCentroid
} from './compat.js';

/**
 * @param {Array<{t: number, value: {d: string}, easing: string}>} keyframes
 * @returns {{frames: Array<{t: number, d: string, easing: string}>, meta: object}}
 */
export function unifyMorphKeyframes(keyframes) {
  const parsed = keyframes.map((kf) => {
    const norm = normalizePath(kf.value?.d ?? '');
    const subpaths = norm.subpaths
      .slice()
      // Stable ordering: largest area first, ties broken by centroid position.
      .sort((a, b) => {
        const da = subpathArea(b) - subpathArea(a);
        if (Math.abs(da) > 1e-6) return da;
        const ca = subpathCentroid(a);
        const cb = subpathCentroid(b);
        return ca[0] - cb[0] || ca[1] - cb[1];
      });
    return { t: kf.t, easing: kf.easing, subpaths, raw: kf.value?.d ?? '' };
  });

  const targetSubpaths = Math.max(1, ...parsed.map((p) => p.subpaths.length));
  const targetSegments = [];
  for (let j = 0; j < targetSubpaths; j++) {
    let count = 1;
    for (const frame of parsed) {
      const sp = frame.subpaths[j];
      if (sp) count = Math.max(count, sp.segments.length);
    }
    targetSegments.push(count);
  }

  // Pad / resample every frame to the canonical structure.
  const canonical = parsed.map((frame) => {
    const subpaths = [];
    for (let j = 0; j < targetSubpaths; j++) {
      const sp = frame.subpaths[j];
      if (!sp) {
        const ref = frame.subpaths[0];
        const [cx, cy] = ref ? subpathCentroid(ref) : [0, 0];
        subpaths.push({
          start: [cx, cy],
          segments: Array.from({ length: targetSegments[j] }, () => ({
            c1: [cx, cy],
            c2: [cx, cy],
            to: [cx, cy]
          })),
          closed: false
        });
      } else {
        subpaths.push(resampleSubpath(sp, targetSegments[j]));
      }
    }
    return { ...frame, subpaths };
  });

  // Re-anchor each frame against its predecessor (closed outlines only).
  for (let i = 1; i < canonical.length; i++) {
    for (let j = 0; j < targetSubpaths; j++) {
      const prev = canonical[i - 1].subpaths[j];
      const cur = canonical[i].subpaths[j];
      if (!prev || !cur || !prev.closed || !cur.closed) continue;
      const best = bestOrientation(prev, cur);
      canonical[i].subpaths[j] = best;
    }
  }

  // The closing edge is already materialised as a real segment during
  // normalisation, so dropping the `Z` marker at serialisation time cannot
  // change the filled outline. Doing it makes every frame end with the same
  // command signature, which is what SMIL requires to interpolate `d` at all.
  for (const frame of canonical) {
    for (const sp of frame.subpaths) sp.closed = false;
  }

  const frames = canonical.map((frame) => ({
    t: frame.t,
    easing: frame.easing,
    d: serializePath(frame.subpaths, 3)
  }));

  return {
    frames,
    meta: {
      subpaths: targetSubpaths,
      segmentsPerSubpath: targetSegments,
      totalSegments: targetSegments.reduce((a, b) => a + b, 0),
      rewritten: parsed.some(
        (p, i) => p.subpaths.reduce((s, sp) => s + sp.segments.length, 0) !== frames[i].d.split('C').length - 1
      )
    }
  };
}

function bestOrientation(prev, cur) {
  const n = cur.segments.length;
  let best = { cost: Infinity, sp: cur };
  for (const reversed of [false, true]) {
    const base = reversed ? reverseSubpath(cur) : cur;
    for (let k = 0; k < n; k++) {
      const rotated = rotateSubpath(base, k);
      const cost = pairCost(prev, rotated);
      if (cost < best.cost - 1e-9) best = { cost, sp: rotated };
    }
  }
  return best.sp;
}

/**
 * Sample a unified morph chain at a given time.
 *
 * @param {Array<{t:number,d:string,easing:string}>} frames
 * @param {Function} resolveEasing
 * @param {number} time
 */
export function sampleUnified(frames, resolveEasing, time) {
  if (!frames.length) return '';
  if (frames.length === 1) return frames[0].d;
  if (time <= frames[0].t) return frames[0].d;
  if (time >= frames[frames.length - 1].t) return frames[frames.length - 1].d;

  let i = 0;
  while (i < frames.length - 2 && frames[i + 1].t <= time) i++;
  const from = frames[i];
  const to = frames[i + 1];
  const span = to.t - from.t;
  const local = span <= 0 ? 1 : (time - from.t) / span;
  const eased = resolveEasing(from.easing)(local);
  return interpolateBetweenD(from.d, to.d, eased);
}

/**
 * Interpolate two structurally identical path strings without re-parsing the
 * command semantics: both sides came out of `serializePath`, so the numeric
 * fields line up one to one.
 */
export function interpolateBetweenD(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const na = a.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const nb = b.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  if (na.length !== nb.length) return t < 0.5 ? a : b;

  let index = 0;
  return a.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, () => {
    const va = parseFloat(na[index]);
    const vb = parseFloat(nb[index]);
    index++;
    const v = va + (vb - va) * t;
    return String(Math.round(v * 1000) / 1000);
  });
}
