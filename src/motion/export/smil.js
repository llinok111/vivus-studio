/**
 * SMIL exporter.
 *
 * Output is a single `.svg` file that plays with no JavaScript, no network
 * access and no external CSS. Everything the animation needs is baked into the
 * document: geometry as `values` lists, timing as `keyTimes`, and stroke reveal
 * as `pathLength`-normalised dash offsets.
 *
 * Two decisions shape this file:
 *
 * 1. `pathLength="1"` instead of `getTotalLength()`. Dash lengths are distances
 *    along the path; written in user units they are only valid at the size they
 *    were measured at, and `vector-effect: non-scaling-stroke` invalidates them
 *    immediately. `pathLength="1"` says "1 means the whole path", so
 *    `dasharray="1 1"` covers the path at every size and zoom.
 *
 * 2. Transforms are baked into the path data instead of emitted as
 *    `animateTransform`. Matrix interpolation between keyframes is not
 *    rotation-aware: it collapses the determinant and the shape shrinks as it
 *    turns. Baking produces exactly the numbers the editor rendered, and it
 *    also lets a rotation on a wrapping `<g>` reach the paths inside it.
 */

import { unifyMorphKeyframes, sampleUnified } from '../geometry/unify.js';
import { normalizePath, serializePath } from '../geometry/normalize.js';
import { resolveEasing } from '../easing.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {SVGSVGElement} root live scene root (used for measuring only)
 * @param {import('../timeline.js').Timeline} timeline
 * @param {{fps?: number, loop?: boolean, title?: string}} options
 * @returns {{svg: string, report: object}}
 */
export function exportSmil(root, timeline, options = {}) {
  const fps = options.fps ?? 30;
  const loop = options.loop ?? timeline.loop ?? false;
  const duration = timeline.duration;
  const frameCount = Math.max(2, Math.round((duration / 1000) * fps) + 1);
  const report = {
    fps,
    frameCount,
    duration,
    tracks: [],
    unsupported: [],
    bytes: 0
  };

  const clone = root.cloneNode(true);
  clone.setAttribute('xmlns', SVG_NS);
  clone.removeAttribute('class');

  if (!clone.getAttribute('viewBox')) {
    const box = root.getBBox ? root.getBBox() : { x: 0, y: 0, width: 24, height: 24 };
    clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  }
  // A standalone file should fill whatever viewport it is opened in and keep
  // its aspect ratio; the viewBox still carries the intrinsic geometry.
  clone.setAttribute('width', '100%');
  clone.setAttribute('height', '100%');
  clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  clone.setAttribute('role', 'img');
  if (options.title) {
    const title = clone.ownerDocument.createElementNS(SVG_NS, 'title');
    title.textContent = options.title;
    clone.insertBefore(title, clone.firstChild);
  }
  clone.style.overflow = 'visible';
  // `currentColor` is how these diagrams get their ink colour. Baking the
  // editor's resolved colour onto the root keeps the exported file looking the
  // same when it is opened on its own, instead of inheriting black from the
  // browser's initial value.
  if (typeof getComputedStyle === 'function' && root.isConnected) {
    const resolved = getComputedStyle(root).color;
    if (resolved) clone.style.color = resolved;
  }

  const dur = `${(duration / 1000).toFixed(3)}s`;
  const repeat = loop ? 'indefinite' : '1';

  // Resolve every track to its cloned element.
  const resolved = [];
  for (const track of timeline.tracks) {
    const el = clone.querySelector(`[data-motion="${cssEscape(track.target || track.id)}"]`);
    if (!el) {
      report.unsupported.push({ track: track.id, reason: 'target-missing' });
      continue;
    }
    resolved.push({ track, el });
  }

  const transformTracks = resolved.filter((r) => r.track.kind === 'transform');
  const morphTracks = new Map(resolved.filter((r) => r.track.kind === 'morph').map((r) => [r.el, r.track]));
  const numberTracks = new Map(resolved.filter((r) => r.track.kind === 'number').map((r) => [r.el, r.track]));
  const styleTracks = new Map(resolved.filter((r) => r.track.kind === 'style').map((r) => [r.el, r.track]));

  // The pivot must match the one the preview used. `options.origins` carries the
  // scene's bind-time values; the live bbox is the fallback for headless use.
  for (const { track, el } of transformTracks) {
    const name = track.target || track.id;
    const preset = options.origins && options.origins[name];
    const origin = preset || liveOrigin(root, name);
    if (origin) el.setAttribute('data-motion-origin', `${origin[0]} ${origin[1]}`);
  }

  // Geometry baking only applies to paths.
  const paths = [...clone.querySelectorAll('path')];
  for (const path of paths) {
    const morph = morphTracks.get(path) || null;
    const affine = transformTracks.filter((r) => contains(r.el, path));
    const number = numberTracks.get(path) || null;
    if (!morph && !affine.length) {
      if (number) report.unsupported.push({ track: number.track.id, reason: 'no-geometry-track' });
      continue;
    }

    const baseD = path.getAttribute('d') || '';
    if (!baseD) continue;

    // Pre-normalise once: the per-frame loop only interpolates and transforms.
    const frames = morph
      ? unifyMorphKeyframes(morph.keyframes).frames
      : [{ t: 0, d: serializePath(normalizePath(baseD).subpaths, 3), easing: 'linear' }];

    const values = [];
    const keyTimes = [];
    for (let i = 0; i < frameCount; i++) {
      const time = (i / (frameCount - 1)) * duration;
      const d = morph ? sampleUnified(frames, resolveEasing, time) : frames[0].d;
      const matrix = composeMatrix(affine, time, path);
      values.push(matrix ? bakeTransform(d, matrix) : d);
      keyTimes.push(i / (frameCount - 1));
    }

    const animate = createAnimate(doc(path), {
      attributeName: 'd',
      values,
      keyTimes,
      dur,
      repeat
    });
    animate.setAttribute('data-motion-track', morph ? morph.id : affine[0].track.id);
    path.setAttribute('d', values[0]);
    path.appendChild(animate);
    report.tracks.push({ id: animate.getAttribute('data-motion-track'), kind: 'geometry' });
  }

  // Stroke reveal, measured on the live element so dash lengths are real.
  for (const [el, track] of numberTracks) {
    if (!isPath(el)) {
      // Non-path targets fade instead: a dash reveal has nothing to reveal.
      const values = sampleSeries(track, frameCount, duration, (t) => String(round3(sampleNumber(track, t))));
      el.appendChild(
        createAnimate(doc(el), { attributeName: 'opacity', values, keyTimes: uniformKeyTimes(frameCount), dur, repeat })
      );
      el.setAttribute('opacity', values[0]);
      report.tracks.push({ id: track.id, kind: 'opacity' });
      continue;
    }
    if (!inheritsStroke(el)) {
      report.unsupported.push({ track: track.id, reason: 'no-stroke' });
      continue;
    }
    el.setAttribute('pathLength', '1');
    // Dash 1, gap 3: the pattern repeats every 4 path lengths, so pushing the
    // offset past the start (to hide the round cap) cannot drag the *next*
    // dash into view at the far end. A gap of 1 would.
    el.style.strokeDasharray = '1 3';

    // Round line caps paint a half-disc past the end of a dash. With an offset
    // of exactly 1 that cap still shows as a dot at the start of every path,
    // so the offset is pushed out by half a stroke width, expressed in
    // pathLength units.
    const pad = capPadding(root, el);
    const values = sampleSeries(track, frameCount, duration, (t) =>
      String(round3((1 - sampleNumber(track, t)) * (1 + pad)))
    );
    el.appendChild(
      createAnimate(doc(el), {
        attributeName: 'stroke-dashoffset',
        values,
        keyTimes: uniformKeyTimes(frameCount),
        dur,
        repeat
      })
    );
    el.style.strokeDashoffset = values[0];
    report.tracks.push({ id: track.id, kind: 'stroke' });
  }

  // Opacity / colour tracks.
  for (const [el, track] of styleTracks) {
    const values = sampleSeries(track, frameCount, duration, (t) =>
      String(round3(sampleStyle(track, t).opacity ?? 1))
    );
    el.appendChild(
      createAnimate(doc(el), { attributeName: 'opacity', values, keyTimes: uniformKeyTimes(frameCount), dur, repeat })
    );
    el.setAttribute('opacity', values[0]);
    report.tracks.push({ id: track.id, kind: 'opacity' });
  }

  applyStaticFrame(clone, timeline, 0);

  const svg = serialize(clone);
  report.bytes = new TextEncoder().encode(svg).length;
  return { svg, report };
}

/* ------------------------------------------------------------------ *
 * Track sampling
 * ------------------------------------------------------------------ */

function sampleSeries(track, frameCount, duration, map) {
  const values = [];
  for (let i = 0; i < frameCount; i++) {
    values.push(map((i / (frameCount - 1)) * duration));
  }
  return values;
}

function uniformKeyTimes(frameCount) {
  return Array.from({ length: frameCount }, (_, i) => i / (frameCount - 1));
}

function sampleNumber(track, time) {
  const kfs = track.keyframes;
  if (!kfs.length) return 0;
  if (time <= kfs[0].t) return kfs[0].value;
  if (time >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].value;
  let i = 0;
  while (i < kfs.length - 2 && kfs[i + 1].t <= time) i++;
  const from = kfs[i];
  const to = kfs[i + 1];
  const span = to.t - from.t;
  const local = span <= 0 ? 1 : (time - from.t) / span;
  const eased = resolveEasing(from.easing)(local);
  return from.value + (to.value - from.value) * eased;
}

function sampleStyle(track, time) {
  const kfs = track.keyframes;
  if (!kfs.length) return {};
  if (time <= kfs[0].t) return { ...kfs[0].value };
  if (time >= kfs[kfs.length - 1].t) return { ...kfs[kfs.length - 1].value };
  let i = 0;
  while (i < kfs.length - 2 && kfs[i + 1].t <= time) i++;
  const from = kfs[i];
  const to = kfs[i + 1];
  const span = to.t - from.t;
  const local = span <= 0 ? 1 : (time - from.t) / span;
  const eased = resolveEasing(from.easing)(local);
  const out = {};
  const keys = new Set([...Object.keys(from.value || {}), ...Object.keys(to.value || {})]);
  for (const key of keys) {
    const a = from.value?.[key];
    const b = to.value?.[key];
    out[key] = typeof a === 'number' && typeof b === 'number' ? a + (b - a) * eased : local < 0.5 ? a : b;
  }
  return out;
}

function sampleTransform(track, time) {
  const kfs = track.keyframes;
  if (!kfs.length) return {};
  if (time <= kfs[0].t) return { ...kfs[0].value };
  if (time >= kfs[kfs.length - 1].t) return { ...kfs[kfs.length - 1].value };
  let i = 0;
  while (i < kfs.length - 2 && kfs[i + 1].t <= time) i++;
  const from = kfs[i];
  const to = kfs[i + 1];
  const span = to.t - from.t;
  const local = span <= 0 ? 1 : (time - from.t) / span;
  const eased = resolveEasing(from.easing)(local);
  const out = {};
  const keys = new Set([...Object.keys(from.value || {}), ...Object.keys(to.value || {})]);
  for (const key of keys) {
    const a = from.value?.[key];
    const b = to.value?.[key];
    if (typeof a === 'number' && typeof b === 'number') out[key] = a + (b - a) * eased;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

function contains(ancestor, node) {
  if (ancestor === node) return true;
  return typeof ancestor.contains === 'function' ? ancestor.contains(node) : false;
}

function liveOrigin(root, name) {
  const live = root.querySelector(`[data-motion="${cssEscape(name)}"]`);
  if (!live || typeof live.getBBox !== 'function') return null;
  try {
    const box = live.getBBox();
    if (!box.width && !box.height) return null;
    return [round3(box.x + box.width / 2), round3(box.y + box.height / 2)];
  } catch {
    return null;
  }
}

/**
 * Compose every transform that encloses `path` at `time` into a 2×3 matrix.
 * Outermost first, matching how the renderer nests the transforms.
 */
function composeMatrix(affineTracks, time, path) {
  let matrix = null;
  for (const { el, track } of affineTracks) {
    const v = sampleTransform(track, time);
    const local = localMatrix(v, el, path);
    matrix = matrix ? multiply(matrix, local) : local;
  }
  return matrix;
}

function localMatrix(value, el, path) {
  const { x = 0, y = 0, scale = 1, rotate = 0 } = value || {};
  const [cx, cy] = originOf(el, path);
  const rad = (rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // translate(cx + x, cy + y) rotate(r) scale(s) translate(-cx, -cy)
  const a = scale * cos;
  const b = scale * sin;
  const c = -scale * sin;
  const d = scale * cos;
  return [a, b, c, d, cx + x - (a * cx + c * cy), cy + y - (b * cx + d * cy)];
}

function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ];
}

/**
 * Pivot for a rotation: the transformed element's own box when it is a path,
 * otherwise the box of the subtree it wraps. A detached clone has no layout, so
 * the live element's box is copied onto the clone as `data-motion-origin`
 * during export.
 */
function originOf(el, path) {
  const attr = el.getAttribute('data-motion-origin');
  if (attr) {
    const [x, y] = attr.split(/[\s,]+/).map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  try {
    const box = path && path.getBBox ? path.getBBox() : el.getBBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  } catch {
    return [0, 0];
  }
}

/**
 * Apply an affine matrix to serialised path data.
 *
 * The path is normalised first: transforming raw `d` text would corrupt arc
 * parameters (`rx ry rotation flags`) because those numbers are not
 * coordinates.
 */
export function bakeTransform(d, matrix) {
  const { subpaths } = normalizePath(d);
  const [a, b, c, dd, e, f] = matrix;
  const apply = (p) => [a * p[0] + c * p[1] + e, b * p[0] + dd * p[1] + f];
  const out = subpaths.map((sp) => ({
    start: apply(sp.start),
    segments: sp.segments.map((seg) => ({
      c1: apply(seg.c1),
      c2: apply(seg.c2),
      to: apply(seg.to)
    })),
    closed: sp.closed
  }));
  return serializePath(out, 3);
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

function createAnimate(document_, attrs) {
  const el = document_.createElementNS(SVG_NS, 'animate');
  el.setAttribute('attributeName', attrs.attributeName);
  el.setAttribute('values', attrs.values.join(';'));
  el.setAttribute('keyTimes', attrs.keyTimes.map((k) => k.toFixed(4)).join(';'));
  el.setAttribute('calcMode', 'linear');
  el.setAttribute('dur', attrs.dur);
  el.setAttribute('repeatCount', attrs.repeat);
  el.setAttribute('fill', 'freeze');
  return el;
}

function doc(node) {
  return node.ownerDocument;
}

function isPath(el) {
  return el.tagName && el.tagName.toLowerCase() === 'path';
}

/** Half a stroke width, expressed as a fraction of the path length. */
function capPadding(root, cloneEl) {
  const name = cloneEl.getAttribute('data-motion');
  const live = name ? root.querySelector(`[data-motion="${cssEscape(name)}"]`) : null;
  if (!live || typeof live.getTotalLength !== 'function') return 0.02;
  try {
    const len = live.getTotalLength();
    if (!len) return 0.02;
    const sw =
      (typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(live).strokeWidth) : NaN) ||
      parseFloat(live.getAttribute('stroke-width')) ||
      1;
    return Math.min(0.06, Math.max(0.004, sw / 2 / len));
  } catch {
    return 0.02;
  }
}

/**
 * Stroke can be declared on the path itself or inherited from a parent <g>,
 * which is how icon sets are usually authored. Ask the cascade first and fall
 * back to walking the tree, so the check works on a detached clone too.
 */
function inheritsStroke(el) {
  let node = el;
  while (node && node.getAttribute) {
    const computed =
      typeof getComputedStyle === 'function' && node.isConnected ? getComputedStyle(node).stroke : null;
    if (computed && computed !== 'none') return true;
    const stroke = node.getAttribute('stroke');
    if (stroke) return stroke !== 'none';
    const style = node.getAttribute('style') || '';
    const match = style.match(/stroke\s*:\s*([^;]+)/);
    if (match) return match[1].trim() !== 'none';
    node = node.parentNode;
  }
  return false;
}

/** Bake frame 0 into static attributes so the file is meaningful if frozen. */
function applyStaticFrame(clone, timeline, time) {
  const sampled = timeline.sampleAt(time);
  for (const [trackId, value] of sampled) {
    const track = timeline.getTrack(trackId);
    if (!track) continue;
    if (track.kind !== 'style') continue;
    const el = clone.querySelector(`[data-motion="${cssEscape(track.target || trackId)}"]`);
    if (el && value && typeof value.opacity === 'number') {
      el.setAttribute('opacity', String(round3(value.opacity)));
    }
  }
}

function round3(v) {
  return Math.round(Number(v) * 1000) / 1000;
}

function serialize(node) {
  if (typeof XMLSerializer === 'function') {
    return new XMLSerializer().serializeToString(node);
  }
  return node.outerHTML;
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}
