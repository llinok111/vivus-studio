/**
 * Stroke reveal geometry ("draw-on" animation).
 *
 * The technique is old: give the path a dash pattern as long as the path
 * itself, then slide `stroke-dashoffset` from `length` down to `0`. The devil
 * is in three details that the popular implementations get wrong:
 *
 *   1. Rounding. `Math.ceil(getTotalLength())` overshoots by up to one user
 *      unit. On a 16 px icon that is a visible stub of stroke that never
 *      retracts, and a visible gap at the end of a closed path.
 *   2. Non-scaling strokes. With `vector-effect: non-scaling-stroke` the dash
 *      pattern is resolved in the *rendered* coordinate space, so the user-unit
 *      length no longer describes the dash needed to cover the path.
 *   3. Resizing. Dash lengths are baked at measure time; a responsive SVG that
 *      changes size afterwards drifts out of sync unless re-measured.
 */

const NON_SCALING = 'non-scaling-stroke';

/**
 * Uniform scale factor of the element's current screen transform.
 *
 * `sqrt(|det|)` is exact for uniform scale and a sane average for the
 * non-uniform case, where no single scalar can be correct. Vivus uses the
 * bounding-box ratio instead, which is skewed by rotation.
 */
export function screenScale(el) {
  if (typeof el.getScreenCTM !== 'function') return 1;
  const ctm = el.getScreenCTM();
  if (!ctm) return 1;
  const det = Math.abs(ctm.a * ctm.d - ctm.b * ctm.c);
  if (!Number.isFinite(det) || det === 0) return 1;
  return Math.sqrt(det);
}

/**
 * Measure a path and build its dash plan.
 *
 * @param {SVGPathElement} el
 * @param {{gap?: number, forceScale?: number}} options
 */
export function measureStroke(el, options = {}) {
  const gap = Math.max(0, options.gap ?? 0);
  const userLength = typeof el.getTotalLength === 'function' ? el.getTotalLength() : 0;
  const nonScaling = el.getAttribute && el.getAttribute('vector-effect') === NON_SCALING;
  const scale = options.forceScale ?? (nonScaling ? screenScale(el) : 1);

  // pathLength normalises dash units in the author's own coordinate system.
  const pathLengthAttr = el.getAttribute && parseFloat(el.getAttribute('pathLength'));
  const normalised = Number.isFinite(pathLengthAttr) && pathLengthAttr > 0
    ? userLength / pathLengthAttr
    : 1;

  const length = Math.max(0.001, userLength * scale * normalised);

  return {
    length,
    userLength,
    scale,
    nonScaling,
    dashArray: `${length} ${length + gap * 2}`,
    /** stroke-dashoffset for a reveal progress in 0..1 */
    offsetAt(p) {
      const clamped = Math.max(0, Math.min(1, p));
      return (length + gap) * (1 - clamped);
    }
  };
}

/**
 * Binds a dash plan to a live element and keeps it correct across resizes.
 *
 * `setProgress` is intentionally idempotent and allocation-free: the player
 * calls it on every frame.
 */
export class StrokePainter {
  /**
   * @param {SVGPathElement} el
   * @param {{gap?: number, autoRefresh?: boolean}} options
   */
  constructor(el, options = {}) {
    this.el = el;
    this.options = options;
    this.plan = measureStroke(el, options);
    this.progress = 0;
    this._lastOffset = null;
    this._observer = null;
    this._onResize = null;
    this._attach();

    el.style.strokeDasharray = this.plan.dashArray;
    this.setProgress(0);
  }

  _attach() {
    if (this.options.autoRefresh === false) return;
    const root = this.el.ownerSVGElement;
    if (!root) return;

    const refresh = () => {
      const progress = this.progress;
      this.refresh();
      this.setProgress(progress);
    };

    if (typeof ResizeObserver === 'function') {
      this._observer = new ResizeObserver(refresh);
      this._observer.observe(root);
    }
    if (typeof window !== 'undefined') {
      this._onResize = refresh;
      window.addEventListener('resize', this._onResize, { passive: true });
    }
  }

  /** Re-measure. Required after the SVG is resized or re-scaled. */
  refresh() {
    this.plan = measureStroke(this.el, this.options);
    this.el.style.strokeDasharray = this.plan.dashArray;
    this._lastOffset = null;
    return this.plan;
  }

  /**
   * @param {number} p reveal progress, 0 (invisible) to 1 (fully drawn)
   */
  setProgress(p) {
    this.progress = Math.max(0, Math.min(1, p));
    const offset = this.plan.offsetAt(this.progress);
    // Sub-pixel writes are wasted: the rendered difference is below one device
    // pixel but every write invalidates layout for the stroke.
    if (this._lastOffset !== null && Math.abs(offset - this._lastOffset) < 0.01) return;
    this._lastOffset = offset;
    this.el.style.strokeDashoffset = String(offset);
  }

  destroy() {
    if (this._observer) this._observer.disconnect();
    if (this._onResize && typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onResize);
    }
    this.el.style.strokeDasharray = '';
    this.el.style.strokeDashoffset = '';
    this._observer = null;
  }
}

/**
 * Compute a stagger schedule for a group of strokes.
 *
 * Returns, per element index, `{ startAt, duration }` in the same time unit as
 * the inputs. `mode` mirrors the vocabulary of the upstream library so existing
 * mental models transfer: sync, delayed, oneByOne.
 *
 * @param {number[]} lengths per-element path length
 * @param {{mode?: 'sync'|'delayed'|'oneByOne', duration?: number, delay?: number}} options
 */
export function staggerSchedule(lengths, options = {}) {
  const mode = options.mode ?? 'delayed';
  const duration = options.duration ?? 1000;
  const count = lengths.length;
  if (!count) return [];

  if (mode === 'sync') {
    return lengths.map(() => ({ startAt: 0, duration }));
  }

  const total = lengths.reduce((a, b) => a + b, 0) || 1;

  if (mode === 'oneByOne') {
    let cursor = 0;
    return lengths.map((len) => {
      const span = (len / total) * duration;
      const entry = { startAt: cursor, duration: Math.max(1, span) };
      cursor += span;
      return entry;
    });
  }

  // delayed: every path starts within `delay`, then runs for the remainder.
  const delay = options.delay ?? duration / 3;
  const unit = count > 1 ? delay / (count - 1) : 0;
  return lengths.map((_, i) => ({ startAt: unit * i, duration: Math.max(1, duration - delay) }));
}
