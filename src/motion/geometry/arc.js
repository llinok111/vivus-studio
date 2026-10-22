/**
 * Elliptical arc -> cubic Bezier conversion.
 *
 * Implements the endpoint-to-centre parameterisation from SVG 1.1 appendix
 * F.6.5, then slices the arc into pieces of at most 90 degrees. Each piece is
 * approximated by a cubic with the standard alpha = 4/3 * tan(theta / 4)
 * control-point offset.
 *
 * Why this lives here rather than in a dependency: the morphing engine can
 * only interpolate curves of the same degree. Arcs are parameterised
 * differently (rx, ry, rotation, large-arc, sweep) and cannot be lerped, so
 * every arc must become cubics before any animation can happen.
 */

const TAU = Math.PI * 2;
const MAX_ANGLE = Math.PI / 2; // 90 degrees per cubic segment

/**
 * @param {number[]} p0 start point [x, y]
 * @param {number} rx
 * @param {number} ry
 * @param {number} xAxisRotation degrees
 * @param {0|1} largeArcFlag
 * @param {0|1} sweepFlag
 * @param {number[]} p1 end point [x, y]
 * @returns {Array<{c1:number[], c2:number[], to:number[]}>} cubic segments
 */
export function arcToCubicSegments(p0, rx, ry, xAxisRotation, largeArcFlag, sweepFlag, p1) {
  const [x1, y1] = p0;
  const [x2, y2] = p1;

  // F.6.2: degenerate radii mean a straight line.
  if (rx === 0 || ry === 0) {
    return [{ c1: [x1, y1], c2: [x2, y2], to: [x2, y2] }];
  }
  // F.6.2: identical endpoints mean the arc is a no-op.
  if (x1 === x2 && y1 === y2) {
    return [];
  }

  rx = Math.abs(rx);
  ry = Math.abs(ry);

  const phi = (xAxisRotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // F.6.5.1: compute (x1', y1')
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // F.6.6.2: correct out-of-range radii.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  // F.6.5.2: compute (cx', cy')
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArcFlag === sweepFlag) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  // F.6.5.3: compute (cx, cy)
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  // F.6.5.5 / F.6.5.6: start angle and sweep
  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angleBetween(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  );

  if (!sweepFlag && delta > 0) delta -= TAU;
  if (sweepFlag && delta < 0) delta += TAU;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / MAX_ANGLE));
  const step = delta / segments;
  const alpha = (4 / 3) * Math.tan(step / 4);

  const segmentsOut = [];
  let theta = theta1;

  for (let i = 0; i < segments; i++) {
    const thetaNext = theta + step;

    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const cosT2 = Math.cos(thetaNext);
    const sinT2 = Math.sin(thetaNext);

    // Point and derivative on the unit circle, then mapped through the
    // ellipse transform (scale by rx/ry, rotate by phi, translate to centre).
    const e0 = mapPoint(cosT, sinT, cx, cy, rx, ry, cosPhi, sinPhi);
    const e1 = mapPoint(cosT2, sinT2, cx, cy, rx, ry, cosPhi, sinPhi);

    const d0 = mapVector(-sinT, cosT, rx, ry, cosPhi, sinPhi);
    const d1 = mapVector(-sinT2, cosT2, rx, ry, cosPhi, sinPhi);

    segmentsOut.push({
      c1: [e0[0] + alpha * d0[0], e0[1] + alpha * d0[1]],
      c2: [e1[0] - alpha * d1[0], e1[1] - alpha * d1[1]],
      to: e1
    });

    theta = thetaNext;
  }

  // Guarantee the final point is numerically exact; accumulated floating point
  // error would otherwise leave a sub-pixel gap in closed shapes.
  if (segmentsOut.length) {
    segmentsOut[segmentsOut.length - 1].to = [x2, y2];
  }

  return segmentsOut;
}

function angleBetween(ux, uy, vx, vy) {
  const dot = ux * vx + uy * vy;
  const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  if (len === 0) return 0;
  let ang = Math.acos(Math.max(-1, Math.min(1, dot / len)));
  if (ux * vy - uy * vx < 0) ang = -ang;
  return ang;
}

function mapPoint(cosT, sinT, cx, cy, rx, ry, cosPhi, sinPhi) {
  const x = rx * cosT;
  const y = ry * sinT;
  return [cosPhi * x - sinPhi * y + cx, sinPhi * x + cosPhi * y + cy];
}

function mapVector(vx, vy, rx, ry, cosPhi, sinPhi) {
  const x = rx * vx;
  const y = ry * vy;
  return [cosPhi * x - sinPhi * y, sinPhi * x + cosPhi * y];
}
