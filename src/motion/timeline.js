/**
 * Keyframe timeline.
 *
 * A timeline is a set of tracks sharing one clock. Each track owns keyframes
 * `{ t, value, easing }`; the easing on a keyframe governs the segment that
 * *starts* there, which is the convention every DCC tool uses and the one that
 * survives retiming without ambiguity.
 *
 * Two properties matter more than features here:
 *
 *   1. `sampleAt(t)` is pure. Scrubbing, playback and export all go through
 *      it, so an exported file cannot disagree with the editor preview.
 *   2. Interruption never jumps. `interrupt()` bakes the currently sampled
 *      value as a keyframe before retargeting, so a transition caught halfway
 *      continues from where it visually was.
 */

import { resolveEasing } from './easing.js';
import { unifyMorphKeyframes, sampleUnified } from './geometry/unify.js';

let kfSeq = 0;
let trackSeq = 0;

export function makeKeyframe(t, value, easing = 'easeInOutCubic', extra = {}) {
  return { id: `kf${++kfSeq}`, t, value, easing, synthetic: false, ...extra };
}

const VALUE_KINDS = new Set(['morph', 'number', 'transform', 'style']);

export class Track {
  /**
   * @param {{id?: string, kind: string, name?: string, target?: string, keyframes?: Array<object>}} spec
   */
  constructor(spec) {
    if (!VALUE_KINDS.has(spec.kind)) {
      throw new Error(`unknown track kind "${spec.kind}"`);
    }
    this.id = spec.id || `tr${++trackSeq}`;
    this.kind = spec.kind;
    this.name = spec.name || spec.id || this.id;
    this.target = spec.target || null;
    this.keyframes = (spec.keyframes || []).slice().sort((a, b) => a.t - b.t);
  }

  /** Insert or replace the keyframe at exactly `t` (within `tolerance`). */
  setKeyframe(t, value, easing = 'easeInOutCubic', extra = {}, tolerance = 0.5) {
    const existing = this.keyframes.find((k) => Math.abs(k.t - t) <= tolerance);
    if (existing) {
      existing.value = value;
      existing.easing = easing;
      existing.synthetic = extra.synthetic === true;
      Object.assign(existing, extra);
      this.keyframes.sort((a, b) => a.t - b.t);
      return existing;
    }
    const kf = makeKeyframe(t, value, easing, extra);
    this.keyframes.push(kf);
    this.keyframes.sort((a, b) => a.t - b.t);
    return kf;
  }

  /** Insert a keyframe at exactly `t`, never merging with neighbours. */
  insertKeyframe(t, value, easing = 'easeInOutCubic', extra = {}) {
    const kf = makeKeyframe(t, value, easing, extra);
    this.keyframes.push(kf);
    this.keyframes.sort((a, b) => a.t - b.t);
    return kf;
  }

  removeKeyframe(id) {
    const i = this.keyframes.findIndex((k) => k.id === id);
    if (i >= 0) this.keyframes.splice(i, 1);
    return i >= 0;
  }

  /** Bracket lookup: the pair of keyframes surrounding `t`. */
  bracket(t) {
    const kfs = this.keyframes;
    if (!kfs.length) return null;
    if (t <= kfs[0].t) return { from: kfs[0], to: kfs[0], local: 0 };
    if (t >= kfs[kfs.length - 1].t) {
      const last = kfs[kfs.length - 1];
      return { from: last, to: last, local: 1 };
    }
    let lo = 0;
    let hi = kfs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (kfs[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const from = kfs[lo];
    const to = kfs[hi];
    const span = to.t - from.t;
    const local = span <= 0 ? 1 : (t - from.t) / span;
    return { from, to, local };
  }
}

export class Timeline {
  /**
   * @param {{duration?: number, tracks?: Array<Track|object>, loop?: boolean}} spec
   */
  constructor(spec = {}) {
    this.duration = spec.duration ?? 3000;
    this.loop = spec.loop ?? false;
    this.tracks = (spec.tracks || []).map((t) => (t instanceof Track ? t : new Track(t)));
    /** @type {Map<string, {fromD: string, toD: string, prepared: object}>} */
    this._morphCache = new Map();
    this._listeners = new Set();
  }

  getTrack(id) {
    return this.tracks.find((t) => t.id === id) || null;
  }

  addTrack(spec) {
    const track = spec instanceof Track ? spec : new Track(spec);
    this.tracks.push(track);
    return track;
  }

  removeTrack(id) {
    const i = this.tracks.findIndex((t) => t.id === id);
    if (i >= 0) this.tracks.splice(i, 1);
    return i >= 0;
  }

  /**
   * Sample a single track at an absolute time.
   *
   * @param {Track} track
   * @param {number} t
   * @returns {*} resolved value
   */
  sampleTrack(track, t) {
    const bracket = track.bracket(t);
    if (!bracket) return null;
    const { from, to, local } = bracket;
    // Outside the keyframe span the track is constant. The value must still be
    // normalised per kind: a morph keyframe stores `{ d }` but the renderer
    // consumes a bare `d` string, and returning the raw object here silently
    // froze every morph track past its last keyframe.
    if (from === to) return constantValue(track.kind, from.value);

    const eased = resolveEasing(from.easing)(local);
    switch (track.kind) {
      case 'morph':
        // Sampling goes through the same unified chain the exporter writes, so
        // the preview cannot drift from the exported file.
        return this._sampleMorph(track, t);
      case 'number':
        return lerp(from.value, to.value, eased);
      case 'transform':
      case 'style':
        return lerpObject(from.value, to.value, eased);
      default:
        return cloneValue(from.value);
    }
  }

  /**
   * The unified chain is a pure function of the track's keyframes, so it can be
   * cached: rebuild only when the keyframe signature changes. That keeps
   * scrubbing allocation-free while edits take effect on the next frame.
   */
  _sampleMorph(track, t) {
    const signature = track.keyframes
      .map((k) => `${Math.round(k.t)}:${(k.value?.d || '').length}:${(k.value?.d || '').slice(0, 18)}`)
      .join('|');
    let cached = this._morphCache.get(track.id);
    if (!cached || cached.signature !== signature) {
      const { frames, meta } = unifyMorphKeyframes(track.keyframes);
      cached = { signature, frames, meta };
      this._morphCache.set(track.id, cached);
    }
    return sampleUnified(cached.frames, resolveEasing, t);
  }

  /** Geometry report for the inspector, using the cached unified chain. */
  morphReport(trackId) {
    const track = this.getTrack(trackId);
    if (!track || track.kind !== 'morph' || track.keyframes.length < 2) return null;
    this._sampleMorph(track, 0);
    return this._morphCache.get(track.id)?.meta || null;
  }

  /**
   * Sample the whole timeline.
   *
   * @param {number} time ms
   * @returns {Map<string, *>} trackId -> value
   */
  sampleAt(time) {
    const t = Math.max(0, Math.min(this.duration, time));
    const out = new Map();
    for (const track of this.tracks) {
      out.set(track.id, this.sampleTrack(track, t));
    }
    return out;
  }

  /** Drop cached geometry; call after editing a keyframe value in place. */
  invalidate(trackId) {
    if (!trackId) {
      this._morphCache.clear();
      return;
    }
    this._morphCache.delete(trackId);
  }

  /**
   * Retarget a track mid-flight.
   *
   * This is the operation people mean by "the animation got interrupted":
   * the user changes direction, or a state machine switches state, while the
   * transition is still running. Naively rewriting the destination keyframe
   * makes the shape teleport. We instead:
   *
   *   1. sample the current value at `at`,
   *   2. drop keys that were produced by a previous interruption at or after
   *      `at` (they describe a future that no longer exists),
   *   3. write the sampled value as the new origin keyframe,
   *   4. write the destination keyframe `duration` ms later,
   *   5. optionally insert a velocity-matched midpoint so the hand-off does
   *      not visibly decelerate to zero at the interruption instant.
   *
   * @param {string} trackId
   * @param {{at: number, value: *, duration?: number, easing?: string,
   *          preserveVelocity?: boolean, velocityWindow?: number}} opts
   */
  interrupt(trackId, opts) {
    const track = this.getTrack(trackId);
    if (!track) throw new Error(`no track "${trackId}"`);
    const at = Math.max(0, Math.min(this.duration, opts.at));
    const duration = Math.max(1, opts.duration ?? 300);
    const easing = opts.easing ?? 'easeInOutCubic';

    const current = this.sampleTrack(track, at);
    // `morph` tracks already sample to a bare `d` string.
    const currentValue = track.kind === 'morph' ? { d: String(current ?? '') } : cloneValue(current);

    // 1. Forget synthetic future keys: they belonged to the interrupted plan.
    track.keyframes = track.keyframes.filter((k) => !(k.synthetic && k.t >= at - 0.5));

    // 2. Anchor the present. If a real keyframe already sits on `at`, the
    //    sampled value *is* that keyframe and no anchor is needed.
    const onKeyframe = track.keyframes.some((k) => Math.abs(k.t - at) <= 0.5);
    const origin = onKeyframe
      ? track.keyframes.find((k) => Math.abs(k.t - at) <= 0.5)
      : track.insertKeyframe(at, currentValue, easing, { synthetic: true });

    // 3. Aim at the new target.
    const endT = Math.min(this.duration, at + duration);
    const goal =
      track.kind === 'morph' && typeof opts.value === 'string' ? { d: opts.value } : cloneValue(opts.value);
    const target = track.insertKeyframe(endT, goal, opts.easingOut ?? 'easeInOutCubic', {
      synthetic: endT < at + duration
    });

    // 4. Optional velocity blend. The seam leg is linear on purpose: an eased
    //    leg would start at 2x or 1.57x the incoming slope and the hand-off
    //    would read as a kick rather than a continuation.
    let blend = null;
    if (opts.preserveVelocity && track.kind === 'number' && origin !== target) {
      const window = opts.velocityWindow ?? 24;
      const before = this.sampleTrack(track, Math.max(0, at - window));
      const velocity = (current - before) / Math.max(1, window);
      const projected = current + velocity * duration * 0.35;
      const midT = at + Math.max(16, duration * 0.35);
      blend = track.insertKeyframe(midT, projected, 'easeInOutCubic', { synthetic: true });
      origin.easing = 'linear';
    }

    this._listeners.forEach((fn) => fn({ type: 'interrupt', trackId, at }));
    return { origin, target, blend, previous: current };
  }

  /** Compact a track by removing synthetic keys that are redundant. */
  compact(trackId, epsilon = 1e-6) {
    const track = this.getTrack(trackId);
    const kfs = track.keyframes;
    const kept = [];
    for (const kf of kfs) {
      const prev = kept[kept.length - 1];
      if (
        prev &&
        kf.synthetic &&
        prev.synthetic &&
        Math.abs(prev.t - kf.t) < 1 &&
        sameValue(prev.value, kf.value, epsilon)
      ) {
        continue;
      }
      kept.push(kf);
    }
    track.keyframes = kept;
    return kfs.length - kept.length;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  toJSON() {
    return {
      duration: this.duration,
      loop: this.loop,
      tracks: this.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        target: t.target,
        keyframes: t.keyframes.map((k) => ({ t: k.t, value: k.value, easing: k.easing }))
      }))
    };
  }

  static fromJSON(json) {
    return new Timeline({
      duration: json.duration,
      loop: json.loop,
      tracks: (json.tracks || []).map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        target: t.target,
        keyframes: (t.keyframes || []).map((k) => makeKeyframe(k.t, k.value, k.easing))
      }))
    });
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Value of a track outside its animated span.
 *
 * `morph` tracks store `{ d }` per keyframe but the renderer needs a `d`
 * string; `style` and `transform` keys are plain objects and can be copied.
 */
function constantValue(kind, value) {
  if (kind === 'morph') return String(value?.d ?? '');
  return cloneValue(value);
}

function lerpObject(a, b, t) {
  const out = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    const av = a?.[key];
    const bv = b?.[key];
    if (typeof av === 'number' && typeof bv === 'number') out[key] = av + (bv - av) * t;
    else out[key] = t < 0.5 ? av : bv;
  }
  return out;
}

function cloneValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneValue);
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneValue(v[k]);
  return out;
}

function sameValue(a, b, eps) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps;
  if (typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) if (!sameValue(a?.[k], b?.[k], eps)) return false;
    return true;
  }
  return a === b;
}

export { cloneValue };
