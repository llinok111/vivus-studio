/**
 * Icon transition planning.
 *
 * An "icon transition" is the shape-level equivalent of a page transition: one
 * glyph leaves while the next arrives. Naively you just swap the `d` attribute,
 * which reads as a jump cut. The interesting cases are:
 *
 *   - the two icons have different path counts (a 1-path glyph to a 3-path one)
 *   - one is filled and the other is stroked
 *   - the outline count differs by an order of magnitude (a circle to a
 *     detailed logo), where a morph reads as noise and a cross-fade reads better
 *
 * `planIconTransition` returns track specs plus a report explaining which
 * strategy it picked and why, so the editor can show the reasoning instead of
 * silently producing a bad transition.
 */

import { normalizePath, serializePath } from './geometry/normalize.js';
import { subpathCentroid, subpathArea } from './geometry/compat.js';

export const ICON_PRESETS = {
  morph: { label: '几何变形', kind: 'morph' },
  draw: { label: '换笔描边', kind: 'swap-draw' },
  fade: { label: '交叉淡入', kind: 'fade' },
  morphDraw: { label: '变形+描边', kind: 'morph-draw' }
};

/** Extract a path list from an <svg> element. */
export function extractIcon(svgEl) {
  const paths = [...svgEl.querySelectorAll('path')].map((p) => ({
    d: p.getAttribute('d') || '',
    fill: p.getAttribute('fill'),
    stroke: p.getAttribute('stroke'),
    strokeWidth: p.getAttribute('stroke-width'),
    opacity: p.getAttribute('opacity') || p.style.opacity || null
  }));
  return {
    viewBox: svgEl.getAttribute('viewBox') || '0 0 24 24',
    paths,
    width: svgEl.getAttribute('width'),
    height: svgEl.getAttribute('height')
  };
}

/** A degenerate path sitting still at the outline's centroid. */
export function collapsePath(d) {
  const { subpaths } = normalizePath(d);
  if (!subpaths.length) {
    return { d: 'M0 0C0 0 0 0 0 0', centroid: [0, 0], segments: 1 };
  }
  // Use the dominant sub-path (largest area) so a multi-part glyph collapses
  // toward the part that carries the visual weight.
  let best = subpaths[0];
  let bestArea = -1;
  for (const sp of subpaths) {
    const area = subpathArea(sp);
    if (area > bestArea) {
      bestArea = area;
      best = sp;
    }
  }
  const [cx, cy] = subpathCentroid(best);
  const segments = Math.max(1, best.segments.length);
  const collapsed = [
    {
      start: [cx, cy],
      segments: Array.from({ length: segments }, () => ({ c1: [cx, cy], c2: [cx, cy], to: [cx, cy] })),
      closed: best.closed
    }
  ];
  return { d: serializePath(collapsed, 3), centroid: [cx, cy], segments };
}

/**
 * Pair two icon path lists and annotate each pair with a strategy.
 *
 * @param {{paths: Array<object>}} from
 * @param {{paths: Array<object>}} to
 */
export function normalizeIconPair(from, to) {
  const count = Math.max(from.paths.length, to.paths.length, 1);
  const items = [];
  const report = {
    pairs: 0,
    added: 0,
    removed: 0,
    swappedFill: 0,
    collapsedSide: null
  };

  for (let i = 0; i < count; i++) {
    const a = from.paths[i];
    const b = to.paths[i];

    if (a && b) {
      items.push({ fromD: a.d, toD: b.d, fromAttrs: a, toAttrs: b, mode: 'morph' });
      report.pairs++;
      const aStroked = !!a.stroke && a.stroke !== 'none';
      const bStroked = !!b.stroke && b.stroke !== 'none';
      if (aStroked !== bStroked) report.swappedFill++;
    } else if (a) {
      const collapsed = collapsePath(a.d);
      items.push({ fromD: a.d, toD: collapsed.d, fromAttrs: a, toAttrs: a, mode: 'collapse-out' });
      report.removed++;
    } else {
      const collapsed = collapsePath(b.d);
      items.push({ fromD: collapsed.d, toD: b.d, fromAttrs: b, toAttrs: b, mode: 'collapse-in' });
      report.added++;
    }
  }

  if (!from.paths.length && to.paths.length) report.collapsedSide = 'from';
  if (!to.paths.length && from.paths.length) report.collapsedSide = 'to';
  return { items, report };
}

/**
 * Build track specs for an icon transition.
 *
 * @param {{paths: Array<object>}} from
 * @param {{paths: Array<object>}} to
 * @param {{preset?: string, duration?: number, stagger?: number, easing?: string,
 *          drawFrom?: boolean}} options
 * @returns {{tracks: Array<object>, report: object, elements: Array<object>}}
 */
export function planIconTransition(from, to, options = {}) {
  const preset = options.preset ?? 'morph';
  const duration = options.duration ?? 900;
  const stagger = options.stagger ?? 60;
  const easing = options.easing ?? 'easeInOutCubic';
  const { items, report } = normalizeIconPair(from, to);

  const tracks = [];
  const elements = [];

  items.forEach((item, index) => {
    const target = `icon-${index}`;
    elements.push({
      target,
      fromD: item.fromD,
      toD: item.toD,
      attrs: { ...item.toAttrs },
      mode: item.mode
    });

    const start = index * stagger;
    const end = Math.min(duration, start + Math.max(1, duration - stagger * (items.length - 1)));
    const span = Math.max(1, end - start);

    if (preset === 'draw' || preset === 'morph-draw') {
      // Swap the outline while it is invisible, so the switch is never seen.
      const mid = start + span * 0.5;
      tracks.push({
        id: `${target}-morph`,
        kind: 'morph',
        target,
        name: `${target} 轮廓`,
        keyframes: [
          { t: 0, value: { d: item.fromD }, easing: 'hold' },
          { t: start, value: { d: item.fromD }, easing: 'hold' },
          { t: mid - 1, value: { d: item.fromD }, easing: 'hold' },
          { t: mid, value: { d: item.toD }, easing: 'hold' },
          { t: duration, value: { d: item.toD }, easing: 'hold' }
        ]
      });
      tracks.push({
        id: `${target}-draw`,
        kind: 'number',
        target,
        name: `${target} 描边`,
        keyframes: [
          { t: 0, value: 0, easing: 'hold' },
          { t: start, value: 0, easing: easing },
          { t: mid, value: 1, easing: 'hold' },
          { t: mid, value: 0, easing: easing },
          { t: end, value: 1, easing: 'hold' },
          { t: duration, value: 1, easing: 'hold' }
        ]
      });
      if (preset === 'morph-draw') {
        tracks.push({
          id: `${target}-morphonly`,
          kind: 'morph',
          target,
          name: `${target} 变形`,
          keyframes: [
            { t: 0, value: { d: item.fromD }, easing: 'hold' },
            { t: start, value: { d: item.fromD }, easing: easing },
            { t: end, value: { d: item.toD }, easing: 'hold' },
            { t: duration, value: { d: item.toD }, easing: 'hold' }
          ]
        });
      }
    } else if (preset === 'fade') {
      tracks.push({
        id: `${target}-morph`,
        kind: 'morph',
        target,
        name: `${target} 轮廓`,
        keyframes: [
          { t: 0, value: { d: item.fromD }, easing: 'hold' },
          { t: start, value: { d: item.fromD }, easing: 'hold' },
          { t: start + span * 0.5, value: { d: item.toD }, easing: 'hold' },
          { t: duration, value: { d: item.toD }, easing: 'hold' }
        ]
      });
      tracks.push({
        id: `${target}-fade`,
        kind: 'style',
        target,
        name: `${target} 透明度`,
        keyframes: [
          { t: 0, value: { opacity: 1 }, easing: 'easeOutQuad' },
          { t: start + span * 0.5, value: { opacity: 0 }, easing: 'hold' },
          { t: start + span * 0.5 + 1, value: { opacity: 0 }, easing: 'easeInQuad' },
          { t: end, value: { opacity: 1 }, easing: 'hold' },
          { t: duration, value: { opacity: 1 }, easing: 'hold' }
        ]
      });
    } else {
      tracks.push({
        id: `${target}-morph`,
        kind: 'morph',
        target,
        name: `${target} 变形`,
        keyframes: [
          { t: 0, value: { d: item.fromD }, easing: 'hold' },
          { t: start, value: { d: item.fromD }, easing },
          { t: end, value: { d: item.toD }, easing: 'hold' },
          { t: duration, value: { d: item.toD }, easing: 'hold' }
        ]
      });
      // Filled icons still need a reveal, otherwise the arrival is a jump cut
      // in ink coverage even though the outline is continuous.
      tracks.push({
        id: `${target}-draw`,
        kind: 'number',
        target,
        name: `${target} 描边`,
        keyframes: [
          { t: 0, value: 1, easing: 'hold' },
          { t: duration, value: 1, easing: 'hold' }
        ]
      });
    }
  });

  report.preset = preset;
  report.duration = duration;
  report.strategy =
    report.added + report.removed > 0 ? `${preset}-with-collapse` : preset;
  if (report.swappedFill > 0) {
    report.note = '描边/填充状态在两端不一致，导出时会固化为目标端的样式';
  }
  return { tracks, report, elements };
}
