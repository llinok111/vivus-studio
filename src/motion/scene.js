/**
 * Scene: binds a Timeline to live SVG elements and drives playback.
 *
 * Separation of concerns that pays off in the export step:
 *
 *   Timeline  - pure data, `sampleAt(t)` is a total function with no side effects
 *   Scene     - the only place that touches the DOM
 *   Exporter  - reads the Timeline, never the DOM
 *
 * Because the exporter does not read the DOM, an exported file cannot inherit
 * editor-only state (selection outlines, hover styles, temporary groups), and
 * because playback goes through the same `sampleAt`, the export matches the
 * preview frame for frame.
 */

import { Timeline, cloneValue } from './timeline.js';
import { StrokePainter } from './stroke.js';

const TARGET_ATTR = 'data-motion';

export class MotionScene {
  /**
   * @param {SVGSVGElement} root
   * @param {{timeline?: Timeline, rate?: number, loop?: boolean}} options
   */
  constructor(root, options = {}) {
    this.root = root;
    this.timeline = options.timeline || new Timeline({ duration: 3000 });
    this.rate = options.rate ?? 1;
    this.time = 0;
    this.playing = false;
    this.loop = options.loop ?? this.timeline.loop;

    /** @type {Map<string, {el: Element, painter: StrokePainter|null, origin: number[]}>} */
    this.bindings = new Map();
    this._handle = null;
    this._epoch = 0;
    this._listeners = { tick: new Set(), end: new Set(), interrupt: new Set() };
    this._lastKey = null;

    this.bind();
  }

  /**
   * Resolve `data-motion="name"` targets.
   * Idempotent: safe to call after the editor mutates the scene graph.
   *
   * Stroke painters are *not* created here. A painter applies a dash pattern
   * that hides the path until its progress rises, so attaching one to a path
   * that is only ever morphed would erase it. They are created on first use by
   * a `number` track instead.
   */
  bind() {
    for (const binding of this.bindings.values()) {
      if (binding.painter) binding.painter.destroy();
    }
    this.bindings.clear();

    const nodes = this.root.querySelectorAll(`[${TARGET_ATTR}]`);
    for (const el of nodes) {
      const name = el.getAttribute(TARGET_ATTR);
      this.bindings.set(name, { el, painter: null, origin: centerOf(el) });
    }
    this._lastKey = null;
    return this.bindings;
  }

  getBinding(name) {
    return this.bindings.get(name) || null;
  }

  /** Render a single instant. Pure with respect to the timeline. */
  renderAt(time) {
    const t = Math.max(0, Math.min(this.timeline.duration, time));
    this.time = t;
    const sampled = this.timeline.sampleAt(t);
    for (const [trackId, value] of sampled) {
      const track = this.timeline.getTrack(trackId);
      if (!track) continue;
      const binding = this.bindings.get(track.target || trackId);
      if (!binding) continue;
      applyValue(track, binding, value);
    }
    this._emit('tick', { time: t });
    return t;
  }

  play(options = {}) {
    if (options.from !== undefined) this.seek(options.from);
    if (options.rate !== undefined) this.rate = options.rate;
    if (this.rate === 0) return;
    if (this.playing) this.pause();

    this.playing = true;
    this._epoch++;
    const epoch = this._epoch;
    const startTime = now();
    const startAt = this.time;
    // Set a fresh callback identity on every play() so an in-flight rAF from a
    // previous run cannot resurrect itself after pause/seek.
    const step = () => {
      if (!this.playing || epoch !== this._epoch) return;
      const elapsed = (now() - startTime) * this.rate;
      let t = startAt + elapsed;
      const duration = this.timeline.duration;

      if (this.loop && duration > 0) {
        t = ((t % duration) + duration) % duration;
      } else if (t >= duration || t <= 0) {
        t = Math.max(0, Math.min(duration, t));
        this.renderAt(t);
        this.playing = false;
        this._handle = null;
        this._emit('end', { time: t });
        return;
      }

      this.renderAt(t);
      this._handle = raf(step);
    };
    this._handle = raf(step);
    return this;
  }

  pause() {
    this.playing = false;
    this._epoch++;
    if (this._handle !== null) {
      cancelRaf(this._handle);
      this._handle = null;
    }
    return this;
  }

  seek(time) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    const t = Math.max(0, Math.min(this.timeline.duration, time));
    this.renderAt(t);
    if (wasPlaying) this.play();
    return t;
  }

  stop() {
    this.pause();
    this.renderAt(0);
    return this;
  }

  /**
   * Interrupt a track mid-flight. See Timeline#interrupt for the semantics.
   *
   * The scene re-renders at the *current* playhead so the visual state is
   * consistent immediately, even while paused.
   */
  interrupt(trackId, opts) {
    const result = this.timeline.interrupt(trackId, { ...opts, at: opts.at ?? this.time });
    this.renderAt(this.time);
    this._emit('interrupt', { trackId, time: this.time, result });
    return result;
  }

  on(event, fn) {
    const set = this._listeners[event];
    if (!set) throw new Error(`unknown scene event "${event}"`);
    set.add(fn);
    return () => set.delete(fn);
  }

  _emit(event, payload) {
    const set = this._listeners[event];
    if (!set) return;
    for (const fn of set) fn(payload);
  }

  /** Re-measure stroke plans, e.g. after a viewport resize. */
  refreshStrokes() {
    for (const binding of this.bindings.values()) {
      if (binding.painter) {
        const p = binding.painter.progress;
        binding.painter.refresh();
        binding.painter.setProgress(p);
      }
    }
  }

  destroy() {
    this.pause();
    for (const binding of this.bindings.values()) {
      if (binding.painter) binding.painter.destroy();
    }
    this.bindings.clear();
  }
}

/**
 * Apply a sampled track value to its bound element.
 *
 * Only writes when the resolved string actually changed: a morph track writes
 * a `d` attribute every frame, but a static style track must not thrash.
 */
function applyValue(track, binding, value) {
  const el = binding.el;
  switch (track.kind) {
    case 'morph': {
      if (typeof value === 'string' && el.getAttribute('d') !== value) {
        el.setAttribute('d', value);
        // A draw track on the same element measures the path length, and that
        // length changes as the outline morphs. Re-measure so the reveal keeps
        // ending exactly at the end of the stroke.
        if (binding.painter) binding.painter.refresh();
      }
      break;
    }
    case 'number': {
      if (el.tagName && el.tagName.toLowerCase() === 'path') {
        if (!binding.painter) binding.painter = new StrokePainter(el, { gap: 0 });
        binding.painter.setProgress(value);
      } else {
        el.style.opacity = String(value);
      }
      break;
    }
    case 'transform': {
      const { x = 0, y = 0, scale = 1, rotate = 0 } = value || {};
      const [cx, cy] = binding.origin;
      const transform =
        `translate(${fmt(cx + x)} ${fmt(cy + y)}) rotate(${fmt(rotate)}) ` +
        `scale(${fmt(scale)}) translate(${fmt(-cx)} ${fmt(-cy)})`;
      if (el.getAttribute('transform') !== transform) el.setAttribute('transform', transform);
      break;
    }
    case 'style': {
      const style = value || {};
      for (const [key, v] of Object.entries(style)) {
        if (key === 'opacity') {
          const s = String(round3(v));
          if (el.style.opacity !== s) el.style.opacity = s;
        } else if (key === 'fill' || key === 'stroke') {
          if (el.style[key] !== v) el.style[key] = v;
        } else if (key === 'strokeWidth') {
          const s = String(round3(v));
          if (el.style.strokeWidth !== s) el.style.strokeWidth = s;
        }
      }
      break;
    }
    default:
      break;
  }
}

function centerOf(el) {
  try {
    if (typeof el.getBBox === 'function') {
      const box = el.getBBox();
      return [box.x + box.width / 2, box.y + box.height / 2];
    }
  } catch {
    /* detached element */
  }
  return [0, 0];
}

function fmt(v) {
  return String(Math.round(v * 1000) / 1000);
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function raf(fn) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  return setTimeout(() => fn(), 16);
}

function cancelRaf(handle) {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

export { applyValue, cloneValue };
