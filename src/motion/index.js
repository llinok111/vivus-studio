/**
 * Public entry point of the motion runtime.
 *
 * The runtime is intentionally split from the editor: everything here is
 * headless-friendly (no DOM access except inside `MotionScene`, `StrokePainter`
 * and the exporters), so it can be embedded in a framework component, used in
 * a Node test, or bundled into a product page.
 */

export { parsePathCommands, round } from './geometry/parse.js';
export { arcToCubicSegments } from './geometry/arc.js';
export { normalizePath, serializePath, quadToCubic } from './geometry/normalize.js';
export {
  prepareMorph,
  interpolatePaths,
  alignSubpaths,
  resampleSubpath,
  reverseSubpath,
  rotateSubpath,
  pairCost,
  subpathCentroid,
  subpathArea,
  subpathLength,
  splitSegment
} from './geometry/compat.js';
export { unifyMorphKeyframes, sampleUnified, interpolateBetweenD } from './geometry/unify.js';
export { EASINGS, EASING_NAMES, resolveEasing, cubicBezier } from './easing.js';
export { Timeline, Track, makeKeyframe } from './timeline.js';
export { MotionScene } from './scene.js';
export { StrokePainter, measureStroke, staggerSchedule, screenScale } from './stroke.js';
export { extractIcon, planIconTransition, normalizeIconPair, collapsePath, ICON_PRESETS } from './icon.js';
export { exportSmil } from './export/smil.js';
export { exportHtml } from './export/html.js';

export const VERSION = '0.1.0';
