/**
 * Normalise path commands into sub-paths made purely of cubic Bezier segments.
 *
 * Output shape:
 *   {
 *     subpaths: [{ start: [x, y], segments: [{ c1, c2, to }], closed: boolean }],
 *     stats: { arcs, quadratics, lines, implicitClose, empty }
 *   }
 *
 * Every command becomes a cubic, so two paths built from different command
 * mixes (one uses `Q`, the other `C`, a third `A`) end up in a comparable
 * representation. That comparability is the precondition for interpolation.
 */

import { parsePathCommands } from './parse.js';
import { arcToCubicSegments } from './arc.js';

/**
 * @param {string} d
 * @returns {{subpaths: Array<object>, stats: object}}
 */
export function normalizePath(d) {
  const commands = parsePathCommands(d);
  const subpaths = [];
  const stats = { arcs: 0, quadratics: 0, lines: 0, implicitClose: 0, empty: false };

  let current = null;
  let cx = 0;
  let cy = 0;
  let subStartX = 0;
  let subStartY = 0;
  // Reflection state for S/T: previous control point, if the previous command
  // was of the matching type.
  let lastCubicCtrl = null;
  let lastQuadCtrl = null;
  let prevCmd = null;

  const push = (subpath) => {
    subpaths.push(subpath);
    current = subpath;
  };

  const ensureSubpath = () => {
    if (!current) {
      push({ start: [cx, cy], segments: [], closed: false });
    }
    return current;
  };

  for (const { cmd, params } of commands) {
    const upper = cmd.toUpperCase();
    const relative = cmd !== upper;

    switch (upper) {
      case 'M': {
        cx = relative ? cx + params[0] : params[0];
        cy = relative ? cy + params[1] : params[1];
        subStartX = cx;
        subStartY = cy;
        // Starting a new sub-path terminates the previous one implicitly.
        if (current && current.segments.length === 0 && subpaths.length) {
          subpaths.pop();
        }
        push({ start: [cx, cy], segments: [], closed: false });
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }

      case 'L': {
        const to = [relative ? cx + params[0] : params[0], relative ? cy + params[1] : params[1]];
        const sp = ensureSubpath();
        sp.segments.push({ c1: [cx, cy], c2: [cx, cy], to });
        stats.lines++;
        cx = to[0];
        cy = to[1];
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }

      case 'H': {
        const to = [relative ? cx + params[0] : params[0], cy];
        const sp = ensureSubpath();
        sp.segments.push({ c1: [cx, cy], c2: [cx, cy], to });
        stats.lines++;
        cx = to[0];
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }

      case 'V': {
        const to = [cx, relative ? cy + params[0] : params[0]];
        const sp = ensureSubpath();
        sp.segments.push({ c1: [cx, cy], c2: [cx, cy], to });
        stats.lines++;
        cy = to[1];
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }

      case 'C': {
        const c1 = [relative ? cx + params[0] : params[0], relative ? cy + params[1] : params[1]];
        const c2 = [relative ? cx + params[2] : params[2], relative ? cy + params[3] : params[3]];
        const to = [relative ? cx + params[4] : params[4], relative ? cy + params[5] : params[5]];
        const sp = ensureSubpath();
        sp.segments.push({ c1, c2, to });
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        cx = to[0];
        cy = to[1];
        break;
      }

      case 'S': {
        const c1 =
          prevCmd && (prevCmd.cmd.toUpperCase() === 'C' || prevCmd.cmd.toUpperCase() === 'S') && lastCubicCtrl
            ? [2 * cx - lastCubicCtrl[0], 2 * cy - lastCubicCtrl[1]]
            : [cx, cy];
        const c2 = [relative ? cx + params[0] : params[0], relative ? cy + params[1] : params[1]];
        const to = [relative ? cx + params[2] : params[2], relative ? cy + params[3] : params[3]];
        const sp = ensureSubpath();
        sp.segments.push({ c1, c2, to });
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        cx = to[0];
        cy = to[1];
        break;
      }

      case 'Q': {
        const q = [relative ? cx + params[0] : params[0], relative ? cy + params[1] : params[1]];
        const to = [relative ? cx + params[2] : params[2], relative ? cy + params[3] : params[3]];
        const cubic = quadToCubic([cx, cy], q, to);
        const sp = ensureSubpath();
        sp.segments.push(cubic);
        stats.quadratics++;
        lastQuadCtrl = q;
        lastCubicCtrl = null;
        cx = to[0];
        cy = to[1];
        break;
      }

      case 'T': {
        const q =
          prevCmd && (prevCmd.cmd.toUpperCase() === 'Q' || prevCmd.cmd.toUpperCase() === 'T') && lastQuadCtrl
            ? [2 * cx - lastQuadCtrl[0], 2 * cy - lastQuadCtrl[1]]
            : [cx, cy];
        const to = [relative ? cx + params[0] : params[0], relative ? cy + params[1] : params[1]];
        const cubic = quadToCubic([cx, cy], q, to);
        const sp = ensureSubpath();
        sp.segments.push(cubic);
        stats.quadratics++;
        lastQuadCtrl = q;
        lastCubicCtrl = null;
        cx = to[0];
        cy = to[1];
        break;
      }

      case 'A': {
        const to = [relative ? cx + params[5] : params[5], relative ? cy + params[6] : params[6]];
        const cubics = arcToCubicSegments(
          [cx, cy],
          params[0],
          params[1],
          params[2],
          params[3],
          params[4],
          to
        );
        const sp = ensureSubpath();
        for (const seg of cubics) sp.segments.push(seg);
        stats.arcs++;
        cx = to[0];
        cy = to[1];
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }

      case 'Z': {
        const sp = current;
        if (sp) {
          const last = sp.segments.length ? sp.segments[sp.segments.length - 1].to : sp.start;
          if (Math.abs(last[0] - sp.start[0]) > 1e-9 || Math.abs(last[1] - sp.start[1]) > 1e-9) {
            sp.segments.push({ c1: [last[0], last[1]], c2: [last[0], last[1]], to: [sp.start[0], sp.start[1]] });
            stats.implicitClose++;
          }
          sp.closed = true;
          cx = sp.start[0];
          cy = sp.start[1];
        }
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }

      default:
        throw new SyntaxError(`unsupported command "${cmd}"`);
    }

    prevCmd = { cmd };
  }

  // Drop trailing sub-paths that carry no geometry (a bare "M 10 10").
  while (subpaths.length && subpaths[subpaths.length - 1].segments.length === 0) {
    subpaths.pop();
  }

  stats.empty = subpaths.length === 0;
  return { subpaths, stats };
  }

/**
 * Quadratic to cubic: control points sit at 1/3 and 2/3 along the legs.
 *
 * @param {number[]} p0
 * @param {number[]} q
 * @param {number[]} p2
 * @returns {{c1:number[], c2:number[], to:number[]}}
 */
export function quadToCubic(p0, q, p2) {
  return {
    c1: [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
    c2: [p2[0] + (2 / 3) * (q[0] - p2[0]), p2[1] + (2 / 3) * (q[1] - p2[1])],
    to: [p2[0], p2[1]]
  };
}

/**
 * Serialise normalised sub-paths back to a `d` string.
 *
 * @param {Array<object>} subpaths
 * @param {number} precision decimal places
 * @returns {string}
 */
export function serializePath(subpaths, precision = 3) {
  const f = Math.pow(10, precision);
  const num = (v) => {
    const r = Math.round(v * f) / f;
    return Object.is(r, -0) ? '0' : String(r);
  };

  const parts = [];
  for (const sp of subpaths) {
    if (!sp.segments.length) continue;
    parts.push(`M${num(sp.start[0])} ${num(sp.start[1])}`);
    for (const seg of sp.segments) {
      parts.push(
        `C${num(seg.c1[0])} ${num(seg.c1[1])} ${num(seg.c2[0])} ${num(seg.c2[1])} ${num(seg.to[0])} ${num(seg.to[1])}`
      );
    }
    if (sp.closed) parts.push('Z');
  }
  return parts.join('');
}
