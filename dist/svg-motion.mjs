// src/motion/geometry/parse.js
var COMMAND_ARITY = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0
};
function parsePathCommands(d) {
  if (typeof d !== "string") {
    throw new TypeError("path data must be a string");
  }
  const out = [];
  let i = 0;
  let cmd = null;
  const n = d.length;
  const skipSeparators = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  const readNumber = () => {
    skipSeparators();
    const start = i;
    if (d[i] === "+" || d[i] === "-") i++;
    while (i < n && d[i] >= "0" && d[i] <= "9") i++;
    if (d[i] === ".") {
      i++;
      while (i < n && d[i] >= "0" && d[i] <= "9") i++;
    }
    if (i === start) return NaN;
    if (d[i] === "e" || d[i] === "E") {
      const save = i;
      i++;
      if (d[i] === "+" || d[i] === "-") i++;
      let digits = 0;
      while (i < n && d[i] >= "0" && d[i] <= "9") {
        i++;
        digits++;
      }
      if (digits === 0) i = save;
    }
    if (i === start) return NaN;
    return parseFloat(d.slice(start, i));
  };
  const readFlag = () => {
    skipSeparators();
    if (d[i] === "0" || d[i] === "1") return Number(d[i++]);
    return NaN;
  };
  skipSeparators();
  while (i < n) {
    const ch = d[i];
    if (/[a-zA-Z]/.test(ch)) {
      cmd = ch;
      i++;
    } else if (cmd === null) {
      throw new SyntaxError(`path data must start with a command, got "${ch}"`);
    } else if (cmd === "Z" || cmd === "z") {
      skipSeparators();
      continue;
    }
    const upper = cmd.toUpperCase();
    const arity = COMMAND_ARITY[upper];
    if (arity === void 0) {
      throw new SyntaxError(`unsupported path command "${cmd}"`);
    }
    if (arity === 0) {
      out.push({ cmd: upper, params: [] });
      cmd = null;
      skipSeparators();
      continue;
    }
    const params = [];
    if (upper === "A") {
      for (let k = 0; k < 7; k++) {
        if (k === 3 || k === 4) {
          const flag = readFlag();
          if (Number.isNaN(flag)) {
            throw new SyntaxError(`arc flag expected at index ${i} of "${d}"`);
          }
          params.push(flag);
        } else {
          const num = readNumber();
          if (Number.isNaN(num)) {
            throw new SyntaxError(`arc parameter ${k} expected at index ${i} of "${d}"`);
          }
          params.push(num);
        }
      }
    } else {
      for (let k = 0; k < arity; k++) {
        const num = readNumber();
        if (Number.isNaN(num)) {
          throw new SyntaxError(`parameter ${k} of "${cmd}" expected at index ${i} of "${d}"`);
        }
        params.push(num);
      }
    }
    out.push({ cmd, params });
    skipSeparators();
    if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
  }
  return out;
}
function round(value, precision = 3) {
  const f = Math.pow(10, precision);
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

// src/motion/geometry/arc.js
var TAU = Math.PI * 2;
var MAX_ANGLE = Math.PI / 2;
function arcToCubicSegments(p0, rx, ry, xAxisRotation, largeArcFlag, sweepFlag, p1) {
  const [x1, y1] = p0;
  const [x2, y2] = p1;
  if (rx === 0 || ry === 0) {
    return [{ c1: [x1, y1], c2: [x2, y2], to: [x2, y2] }];
  }
  if (x1 === x2 && y1 === y2) {
    return [];
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = xAxisRotation * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  const lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArcFlag === sweepFlag) coef = -coef;
  const cxp = coef * rx * y1p / ry;
  const cyp = -coef * ry * x1p / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
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
  const alpha = 4 / 3 * Math.tan(step / 4);
  const segmentsOut = [];
  let theta = theta1;
  for (let i = 0; i < segments; i++) {
    const thetaNext = theta + step;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const cosT2 = Math.cos(thetaNext);
    const sinT2 = Math.sin(thetaNext);
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

// src/motion/geometry/normalize.js
function normalizePath(d) {
  const commands = parsePathCommands(d);
  const subpaths = [];
  const stats = { arcs: 0, quadratics: 0, lines: 0, implicitClose: 0, empty: false };
  let current = null;
  let cx = 0;
  let cy = 0;
  let subStartX = 0;
  let subStartY = 0;
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
      case "M": {
        cx = relative ? cx + params[0] : params[0];
        cy = relative ? cy + params[1] : params[1];
        subStartX = cx;
        subStartY = cy;
        if (current && current.segments.length === 0 && subpaths.length) {
          subpaths.pop();
        }
        push({ start: [cx, cy], segments: [], closed: false });
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }
      case "L": {
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
      case "H": {
        const to = [relative ? cx + params[0] : params[0], cy];
        const sp = ensureSubpath();
        sp.segments.push({ c1: [cx, cy], c2: [cx, cy], to });
        stats.lines++;
        cx = to[0];
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }
      case "V": {
        const to = [cx, relative ? cy + params[0] : params[0]];
        const sp = ensureSubpath();
        sp.segments.push({ c1: [cx, cy], c2: [cx, cy], to });
        stats.lines++;
        cy = to[1];
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }
      case "C": {
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
      case "S": {
        const c1 = prevCmd && (prevCmd.cmd.toUpperCase() === "C" || prevCmd.cmd.toUpperCase() === "S") && lastCubicCtrl ? [2 * cx - lastCubicCtrl[0], 2 * cy - lastCubicCtrl[1]] : [cx, cy];
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
      case "Q": {
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
      case "T": {
        const q = prevCmd && (prevCmd.cmd.toUpperCase() === "Q" || prevCmd.cmd.toUpperCase() === "T") && lastQuadCtrl ? [2 * cx - lastQuadCtrl[0], 2 * cy - lastQuadCtrl[1]] : [cx, cy];
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
      case "A": {
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
      case "Z": {
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
  while (subpaths.length && subpaths[subpaths.length - 1].segments.length === 0) {
    subpaths.pop();
  }
  stats.empty = subpaths.length === 0;
  return { subpaths, stats };
}
function quadToCubic(p0, q, p2) {
  return {
    c1: [p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])],
    c2: [p2[0] + 2 / 3 * (q[0] - p2[0]), p2[1] + 2 / 3 * (q[1] - p2[1])],
    to: [p2[0], p2[1]]
  };
}
function serializePath(subpaths, precision = 3) {
  const f = Math.pow(10, precision);
  const num = (v) => {
    const r = Math.round(v * f) / f;
    return Object.is(r, -0) ? "0" : String(r);
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
    if (sp.closed) parts.push("Z");
  }
  return parts.join("");
}

// src/motion/geometry/compat.js
var EPS = 1e-9;
function subpathCentroid(sp) {
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
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  return [sx / pts.length, sy / pts.length];
}
function subpathArea(sp) {
  const pts = samplePolygon(sp, 12);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}
function subpathLength(sp) {
  let total = 0;
  let from = sp.start;
  for (const seg of sp.segments) {
    total += cubicLength(from, seg.c1, seg.c2, seg.to);
    from = seg.to;
  }
  return total;
}
function samplePolygon(sp, perSegment = 8) {
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
function cubicPoint(p0, c1, c2, p3, t) {
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
function cubicLength(p0, c1, c2, p3) {
  const w = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];
  const x = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    const t = 0.5 * (x[i] + 1);
    const mt = 1 - t;
    const dx = 3 * mt * mt * (c1[0] - p0[0]) + 6 * mt * t * (c2[0] - c1[0]) + 3 * t * t * (p3[0] - c2[0]);
    const dy = 3 * mt * mt * (c1[1] - p0[1]) + 6 * mt * t * (c2[1] - c1[1]) + 3 * t * t * (p3[1] - c2[1]);
    sum += w[i] * Math.hypot(dx, dy);
  }
  return sum * 0.5;
}
function splitSegment(p0, seg) {
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
function resampleSubpath(sp, target) {
  const segments = sp.segments.map((s) => ({ c1: [...s.c1], c2: [...s.c2], to: [...s.to] }));
  if (segments.length >= target) {
    return { start: [...sp.start], segments, closed: sp.closed };
  }
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
function reverseSubpath(sp) {
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
function rotateSubpath(sp, k) {
  if (!sp.closed || k === 0 || !sp.segments.length) return sp;
  const n = sp.segments.length;
  const shift = (k % n + n) % n;
  if (shift === 0) return sp;
  const points = [sp.start];
  for (const seg of sp.segments) points.push(seg.to);
  const newStart = [...points[shift]];
  const segments = [];
  for (let i = 0; i < n; i++) {
    segments.push(sp.segments[(shift + i) % n]);
  }
  return { start: newStart, segments, closed: true };
}
function pairCost(a, b) {
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
function alignSubpaths(a, b, options = {}) {
  const exhaustiveLimit = options.exhaustiveLimit ?? 256;
  const n = a.segments.length;
  if (n !== b.segments.length) {
    throw new Error("alignSubpaths requires equal segment counts");
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
function pairSubpaths(subA, subB) {
  const nA = subA.length;
  const nB = subB.length;
  const pairs = [];
  const usedB = /* @__PURE__ */ new Set();
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
  const usedA = /* @__PURE__ */ new Set();
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
function prepareMorph(from, to, options = {}) {
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
    strategy: "morph"
  };
  if (!from.subpaths.length || !to.subpaths.length) {
    report.strategy = "unsupported-empty";
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
    let finalA = ra;
    let finalB = aligned.b;
    if (ra.closed !== rb.closed) {
      finalA = { start: [...ra.start], segments: ra.segments, closed: false };
      finalB = { start: [...aligned.b.start], segments: aligned.b.segments, closed: false };
    }
    alignedFrom.push(finalA);
    alignedTo.push(finalB);
  }
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
  report.strategy = report.collapsed > 0 ? "morph-with-collapse" : "morph";
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
function interpolatePaths(from, to, t, precision = 3) {
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

// src/motion/geometry/unify.js
function unifyMorphKeyframes(keyframes) {
  const parsed = keyframes.map((kf) => {
    const norm = normalizePath(kf.value?.d ?? "");
    const subpaths = norm.subpaths.slice().sort((a, b) => {
      const da = subpathArea(b) - subpathArea(a);
      if (Math.abs(da) > 1e-6) return da;
      const ca = subpathCentroid(a);
      const cb = subpathCentroid(b);
      return ca[0] - cb[0] || ca[1] - cb[1];
    });
    return { t: kf.t, easing: kf.easing, subpaths, raw: kf.value?.d ?? "" };
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
  for (let i = 1; i < canonical.length; i++) {
    for (let j = 0; j < targetSubpaths; j++) {
      const prev = canonical[i - 1].subpaths[j];
      const cur = canonical[i].subpaths[j];
      if (!prev || !cur || !prev.closed || !cur.closed) continue;
      const best = bestOrientation(prev, cur);
      canonical[i].subpaths[j] = best;
    }
  }
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
        (p, i) => p.subpaths.reduce((s, sp) => s + sp.segments.length, 0) !== frames[i].d.split("C").length - 1
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
function sampleUnified(frames, resolveEasing2, time) {
  if (!frames.length) return "";
  if (frames.length === 1) return frames[0].d;
  if (time <= frames[0].t) return frames[0].d;
  if (time >= frames[frames.length - 1].t) return frames[frames.length - 1].d;
  let i = 0;
  while (i < frames.length - 2 && frames[i + 1].t <= time) i++;
  const from = frames[i];
  const to = frames[i + 1];
  const span = to.t - from.t;
  const local = span <= 0 ? 1 : (time - from.t) / span;
  const eased = resolveEasing2(from.easing)(local);
  return interpolateBetweenD(from.d, to.d, eased);
}
function interpolateBetweenD(a, b, t) {
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
    return String(Math.round(v * 1e3) / 1e3);
  });
}

// src/motion/easing.js
var EASINGS = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeInQuart: (t) => t * t * t * t,
  easeOutQuart: (t) => 1 - Math.pow(1 - t, 4),
  easeInOutQuart: (t) => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
  easeInSine: (t) => 1 - Math.cos(t * Math.PI / 2),
  easeOutSine: (t) => Math.sin(t * Math.PI / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInExpo: (t) => t === 0 ? 0 : Math.pow(2, 10 * t - 10),
  easeOutExpo: (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  easeInOutExpo: (t) => t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeInBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return c3 * t * t * t - c1 * t * t;
  },
  easeInOutBack: (t) => {
    const c1 = 1.70158;
    const c2 = c1 * 1.525;
    return t < 0.5 ? Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2) / 2 : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
  },
  easeOutElastic: (t) => {
    const c4 = 2 * Math.PI / 3;
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  hold: (t) => t >= 1 ? 1 : 0
};
var EASING_NAMES = Object.keys(EASINGS);
function resolveEasing(easing) {
  if (typeof easing === "function") return easing;
  const fn = EASINGS[easing];
  if (fn) return fn;
  throw new Error(`unknown easing "${easing}"; expected one of ${EASING_NAMES.join(", ")}`);
}
function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
  return function bezierEasing(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const dx = calc(t, x1, x2) - x;
      if (Math.abs(dx) < 1e-6) break;
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    return calc(t, y1, y2);
  };
}

// src/motion/timeline.js
var kfSeq = 0;
var trackSeq = 0;
function makeKeyframe(t, value, easing = "easeInOutCubic", extra = {}) {
  return { id: `kf${++kfSeq}`, t, value, easing, synthetic: false, ...extra };
}
var VALUE_KINDS = /* @__PURE__ */ new Set(["morph", "number", "transform", "style"]);
var Track = class {
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
  setKeyframe(t, value, easing = "easeInOutCubic", extra = {}, tolerance = 0.5) {
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
  insertKeyframe(t, value, easing = "easeInOutCubic", extra = {}) {
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
      const mid = lo + hi >> 1;
      if (kfs[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const from = kfs[lo];
    const to = kfs[hi];
    const span = to.t - from.t;
    const local = span <= 0 ? 1 : (t - from.t) / span;
    return { from, to, local };
  }
};
var Timeline = class _Timeline {
  /**
   * @param {{duration?: number, tracks?: Array<Track|object>, loop?: boolean}} spec
   */
  constructor(spec = {}) {
    this.duration = spec.duration ?? 3e3;
    this.loop = spec.loop ?? false;
    this.tracks = (spec.tracks || []).map((t) => t instanceof Track ? t : new Track(t));
    this._morphCache = /* @__PURE__ */ new Map();
    this._listeners = /* @__PURE__ */ new Set();
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
    if (from === to) return constantValue(track.kind, from.value);
    const eased = resolveEasing(from.easing)(local);
    switch (track.kind) {
      case "morph":
        return this._sampleMorph(track, t);
      case "number":
        return lerp(from.value, to.value, eased);
      case "transform":
      case "style":
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
    const signature = track.keyframes.map((k) => `${Math.round(k.t)}:${(k.value?.d || "").length}:${(k.value?.d || "").slice(0, 18)}`).join("|");
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
    if (!track || track.kind !== "morph" || track.keyframes.length < 2) return null;
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
    const out = /* @__PURE__ */ new Map();
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
    const easing = opts.easing ?? "easeInOutCubic";
    const current = this.sampleTrack(track, at);
    const currentValue = track.kind === "morph" ? { d: String(current ?? "") } : cloneValue(current);
    track.keyframes = track.keyframes.filter((k) => !(k.synthetic && k.t >= at - 0.5));
    const onKeyframe = track.keyframes.some((k) => Math.abs(k.t - at) <= 0.5);
    const origin = onKeyframe ? track.keyframes.find((k) => Math.abs(k.t - at) <= 0.5) : track.insertKeyframe(at, currentValue, easing, { synthetic: true });
    const endT = Math.min(this.duration, at + duration);
    const goal = track.kind === "morph" && typeof opts.value === "string" ? { d: opts.value } : cloneValue(opts.value);
    const target = track.insertKeyframe(endT, goal, opts.easingOut ?? "easeInOutCubic", {
      synthetic: endT < at + duration
    });
    let blend = null;
    if (opts.preserveVelocity && track.kind === "number" && origin !== target) {
      const window2 = opts.velocityWindow ?? 24;
      const before = this.sampleTrack(track, Math.max(0, at - window2));
      const velocity = (current - before) / Math.max(1, window2);
      const projected = current + velocity * duration * 0.35;
      const midT = at + Math.max(16, duration * 0.35);
      blend = track.insertKeyframe(midT, projected, "easeInOutCubic", { synthetic: true });
      origin.easing = "linear";
    }
    this._listeners.forEach((fn) => fn({ type: "interrupt", trackId, at }));
    return { origin, target, blend, previous: current };
  }
  /** Compact a track by removing synthetic keys that are redundant. */
  compact(trackId, epsilon = 1e-6) {
    const track = this.getTrack(trackId);
    const kfs = track.keyframes;
    const kept = [];
    for (const kf of kfs) {
      const prev = kept[kept.length - 1];
      if (prev && kf.synthetic && prev.synthetic && Math.abs(prev.t - kf.t) < 1 && sameValue(prev.value, kf.value, epsilon)) {
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
    return new _Timeline({
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
};
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function constantValue(kind, value) {
  if (kind === "morph") return String(value?.d ?? "");
  return cloneValue(value);
}
function lerpObject(a, b, t) {
  const out = {};
  const keys = /* @__PURE__ */ new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    const av = a?.[key];
    const bv = b?.[key];
    if (typeof av === "number" && typeof bv === "number") out[key] = av + (bv - av) * t;
    else out[key] = t < 0.5 ? av : bv;
  }
  return out;
}
function cloneValue(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(cloneValue);
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneValue(v[k]);
  return out;
}
function sameValue(a, b, eps) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= eps;
  if (typeof a === "object" && typeof b === "object") {
    const keys = /* @__PURE__ */ new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) if (!sameValue(a?.[k], b?.[k], eps)) return false;
    return true;
  }
  return a === b;
}

// src/motion/stroke.js
var NON_SCALING = "non-scaling-stroke";
function screenScale(el) {
  if (typeof el.getScreenCTM !== "function") return 1;
  const ctm = el.getScreenCTM();
  if (!ctm) return 1;
  const det = Math.abs(ctm.a * ctm.d - ctm.b * ctm.c);
  if (!Number.isFinite(det) || det === 0) return 1;
  return Math.sqrt(det);
}
function measureStroke(el, options = {}) {
  const gap = Math.max(0, options.gap ?? 0);
  const userLength = typeof el.getTotalLength === "function" ? el.getTotalLength() : 0;
  const nonScaling = el.getAttribute && el.getAttribute("vector-effect") === NON_SCALING;
  const scale = options.forceScale ?? (nonScaling ? screenScale(el) : 1);
  const pathLengthAttr = el.getAttribute && parseFloat(el.getAttribute("pathLength"));
  const normalised = Number.isFinite(pathLengthAttr) && pathLengthAttr > 0 ? userLength / pathLengthAttr : 1;
  const length = Math.max(1e-3, userLength * scale * normalised);
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
var StrokePainter = class {
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
    if (typeof ResizeObserver === "function") {
      this._observer = new ResizeObserver(refresh);
      this._observer.observe(root);
    }
    if (typeof window !== "undefined") {
      this._onResize = refresh;
      window.addEventListener("resize", this._onResize, { passive: true });
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
    if (this._lastOffset !== null && Math.abs(offset - this._lastOffset) < 0.01) return;
    this._lastOffset = offset;
    this.el.style.strokeDashoffset = String(offset);
  }
  destroy() {
    if (this._observer) this._observer.disconnect();
    if (this._onResize && typeof window !== "undefined") {
      window.removeEventListener("resize", this._onResize);
    }
    this.el.style.strokeDasharray = "";
    this.el.style.strokeDashoffset = "";
    this._observer = null;
  }
};
function staggerSchedule(lengths, options = {}) {
  const mode = options.mode ?? "delayed";
  const duration = options.duration ?? 1e3;
  const count = lengths.length;
  if (!count) return [];
  if (mode === "sync") {
    return lengths.map(() => ({ startAt: 0, duration }));
  }
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  if (mode === "oneByOne") {
    let cursor = 0;
    return lengths.map((len) => {
      const span = len / total * duration;
      const entry = { startAt: cursor, duration: Math.max(1, span) };
      cursor += span;
      return entry;
    });
  }
  const delay = options.delay ?? duration / 3;
  const unit = count > 1 ? delay / (count - 1) : 0;
  return lengths.map((_, i) => ({ startAt: unit * i, duration: Math.max(1, duration - delay) }));
}

// src/motion/scene.js
var TARGET_ATTR = "data-motion";
var MotionScene = class {
  /**
   * @param {SVGSVGElement} root
   * @param {{timeline?: Timeline, rate?: number, loop?: boolean}} options
   */
  constructor(root, options = {}) {
    this.root = root;
    this.timeline = options.timeline || new Timeline({ duration: 3e3 });
    this.rate = options.rate ?? 1;
    this.time = 0;
    this.playing = false;
    this.loop = options.loop ?? this.timeline.loop;
    this.bindings = /* @__PURE__ */ new Map();
    this._handle = null;
    this._epoch = 0;
    this._listeners = { tick: /* @__PURE__ */ new Set(), end: /* @__PURE__ */ new Set(), interrupt: /* @__PURE__ */ new Set() };
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
    this._emit("tick", { time: t });
    return t;
  }
  play(options = {}) {
    if (options.from !== void 0) this.seek(options.from);
    if (options.rate !== void 0) this.rate = options.rate;
    if (this.rate === 0) return;
    if (this.playing) this.pause();
    this.playing = true;
    this._epoch++;
    const epoch = this._epoch;
    const startTime = now();
    const startAt = this.time;
    const step = () => {
      if (!this.playing || epoch !== this._epoch) return;
      const elapsed = (now() - startTime) * this.rate;
      let t = startAt + elapsed;
      const duration = this.timeline.duration;
      if (this.loop && duration > 0) {
        t = (t % duration + duration) % duration;
      } else if (t >= duration || t <= 0) {
        t = Math.max(0, Math.min(duration, t));
        this.renderAt(t);
        this.playing = false;
        this._handle = null;
        this._emit("end", { time: t });
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
    this._emit("interrupt", { trackId, time: this.time, result });
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
};
function applyValue(track, binding, value) {
  const el = binding.el;
  switch (track.kind) {
    case "morph": {
      if (typeof value === "string" && el.getAttribute("d") !== value) {
        el.setAttribute("d", value);
        if (binding.painter) binding.painter.refresh();
      }
      break;
    }
    case "number": {
      if (el.tagName && el.tagName.toLowerCase() === "path") {
        if (!binding.painter) binding.painter = new StrokePainter(el, { gap: 0 });
        binding.painter.setProgress(value);
      } else {
        el.style.opacity = String(value);
      }
      break;
    }
    case "transform": {
      const { x = 0, y = 0, scale = 1, rotate = 0 } = value || {};
      const [cx, cy] = binding.origin;
      const transform = `translate(${fmt(cx + x)} ${fmt(cy + y)}) rotate(${fmt(rotate)}) scale(${fmt(scale)}) translate(${fmt(-cx)} ${fmt(-cy)})`;
      if (el.getAttribute("transform") !== transform) el.setAttribute("transform", transform);
      break;
    }
    case "style": {
      const style = value || {};
      for (const [key, v] of Object.entries(style)) {
        if (key === "opacity") {
          const s = String(round3(v));
          if (el.style.opacity !== s) el.style.opacity = s;
        } else if (key === "fill" || key === "stroke") {
          if (el.style[key] !== v) el.style[key] = v;
        } else if (key === "strokeWidth") {
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
    if (typeof el.getBBox === "function") {
      const box = el.getBBox();
      return [box.x + box.width / 2, box.y + box.height / 2];
    }
  } catch {
  }
  return [0, 0];
}
function fmt(v) {
  return String(Math.round(v * 1e3) / 1e3);
}
function round3(v) {
  return Math.round(v * 1e3) / 1e3;
}
function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
function raf(fn) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(fn);
  return setTimeout(() => fn(), 16);
}
function cancelRaf(handle) {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

// src/motion/icon.js
var ICON_PRESETS = {
  morph: { label: "\u51E0\u4F55\u53D8\u5F62", kind: "morph" },
  draw: { label: "\u6362\u7B14\u63CF\u8FB9", kind: "swap-draw" },
  fade: { label: "\u4EA4\u53C9\u6DE1\u5165", kind: "fade" },
  morphDraw: { label: "\u53D8\u5F62+\u63CF\u8FB9", kind: "morph-draw" }
};
function extractIcon(svgEl) {
  const paths = [...svgEl.querySelectorAll("path")].map((p) => ({
    d: p.getAttribute("d") || "",
    fill: p.getAttribute("fill"),
    stroke: p.getAttribute("stroke"),
    strokeWidth: p.getAttribute("stroke-width"),
    opacity: p.getAttribute("opacity") || p.style.opacity || null
  }));
  return {
    viewBox: svgEl.getAttribute("viewBox") || "0 0 24 24",
    paths,
    width: svgEl.getAttribute("width"),
    height: svgEl.getAttribute("height")
  };
}
function collapsePath(d) {
  const { subpaths } = normalizePath(d);
  if (!subpaths.length) {
    return { d: "M0 0C0 0 0 0 0 0", centroid: [0, 0], segments: 1 };
  }
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
function normalizeIconPair(from, to) {
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
      items.push({ fromD: a.d, toD: b.d, fromAttrs: a, toAttrs: b, mode: "morph" });
      report.pairs++;
      const aStroked = !!a.stroke && a.stroke !== "none";
      const bStroked = !!b.stroke && b.stroke !== "none";
      if (aStroked !== bStroked) report.swappedFill++;
    } else if (a) {
      const collapsed = collapsePath(a.d);
      items.push({ fromD: a.d, toD: collapsed.d, fromAttrs: a, toAttrs: a, mode: "collapse-out" });
      report.removed++;
    } else {
      const collapsed = collapsePath(b.d);
      items.push({ fromD: collapsed.d, toD: b.d, fromAttrs: b, toAttrs: b, mode: "collapse-in" });
      report.added++;
    }
  }
  if (!from.paths.length && to.paths.length) report.collapsedSide = "from";
  if (!to.paths.length && from.paths.length) report.collapsedSide = "to";
  return { items, report };
}
function planIconTransition(from, to, options = {}) {
  const preset = options.preset ?? "morph";
  const duration = options.duration ?? 900;
  const stagger = options.stagger ?? 60;
  const easing = options.easing ?? "easeInOutCubic";
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
    if (preset === "draw" || preset === "morph-draw") {
      const mid = start + span * 0.5;
      tracks.push({
        id: `${target}-morph`,
        kind: "morph",
        target,
        name: `${target} \u8F6E\u5ED3`,
        keyframes: [
          { t: 0, value: { d: item.fromD }, easing: "hold" },
          { t: start, value: { d: item.fromD }, easing: "hold" },
          { t: mid - 1, value: { d: item.fromD }, easing: "hold" },
          { t: mid, value: { d: item.toD }, easing: "hold" },
          { t: duration, value: { d: item.toD }, easing: "hold" }
        ]
      });
      tracks.push({
        id: `${target}-draw`,
        kind: "number",
        target,
        name: `${target} \u63CF\u8FB9`,
        keyframes: [
          { t: 0, value: 0, easing: "hold" },
          { t: start, value: 0, easing },
          { t: mid, value: 1, easing: "hold" },
          { t: mid, value: 0, easing },
          { t: end, value: 1, easing: "hold" },
          { t: duration, value: 1, easing: "hold" }
        ]
      });
      if (preset === "morph-draw") {
        tracks.push({
          id: `${target}-morphonly`,
          kind: "morph",
          target,
          name: `${target} \u53D8\u5F62`,
          keyframes: [
            { t: 0, value: { d: item.fromD }, easing: "hold" },
            { t: start, value: { d: item.fromD }, easing },
            { t: end, value: { d: item.toD }, easing: "hold" },
            { t: duration, value: { d: item.toD }, easing: "hold" }
          ]
        });
      }
    } else if (preset === "fade") {
      tracks.push({
        id: `${target}-morph`,
        kind: "morph",
        target,
        name: `${target} \u8F6E\u5ED3`,
        keyframes: [
          { t: 0, value: { d: item.fromD }, easing: "hold" },
          { t: start, value: { d: item.fromD }, easing: "hold" },
          { t: start + span * 0.5, value: { d: item.toD }, easing: "hold" },
          { t: duration, value: { d: item.toD }, easing: "hold" }
        ]
      });
      tracks.push({
        id: `${target}-fade`,
        kind: "style",
        target,
        name: `${target} \u900F\u660E\u5EA6`,
        keyframes: [
          { t: 0, value: { opacity: 1 }, easing: "easeOutQuad" },
          { t: start + span * 0.5, value: { opacity: 0 }, easing: "hold" },
          { t: start + span * 0.5 + 1, value: { opacity: 0 }, easing: "easeInQuad" },
          { t: end, value: { opacity: 1 }, easing: "hold" },
          { t: duration, value: { opacity: 1 }, easing: "hold" }
        ]
      });
    } else {
      tracks.push({
        id: `${target}-morph`,
        kind: "morph",
        target,
        name: `${target} \u53D8\u5F62`,
        keyframes: [
          { t: 0, value: { d: item.fromD }, easing: "hold" },
          { t: start, value: { d: item.fromD }, easing },
          { t: end, value: { d: item.toD }, easing: "hold" },
          { t: duration, value: { d: item.toD }, easing: "hold" }
        ]
      });
      tracks.push({
        id: `${target}-draw`,
        kind: "number",
        target,
        name: `${target} \u63CF\u8FB9`,
        keyframes: [
          { t: 0, value: 1, easing: "hold" },
          { t: duration, value: 1, easing: "hold" }
        ]
      });
    }
  });
  report.preset = preset;
  report.duration = duration;
  report.strategy = report.added + report.removed > 0 ? `${preset}-with-collapse` : preset;
  if (report.swappedFill > 0) {
    report.note = "\u63CF\u8FB9/\u586B\u5145\u72B6\u6001\u5728\u4E24\u7AEF\u4E0D\u4E00\u81F4\uFF0C\u5BFC\u51FA\u65F6\u4F1A\u56FA\u5316\u4E3A\u76EE\u6807\u7AEF\u7684\u6837\u5F0F";
  }
  return { tracks, report, elements };
}

// src/motion/export/smil.js
var SVG_NS = "http://www.w3.org/2000/svg";
function exportSmil(root, timeline, options = {}) {
  const fps = options.fps ?? 30;
  const loop = options.loop ?? timeline.loop ?? false;
  const duration = timeline.duration;
  const frameCount = Math.max(2, Math.round(duration / 1e3 * fps) + 1);
  const report = {
    fps,
    frameCount,
    duration,
    tracks: [],
    unsupported: [],
    bytes: 0
  };
  const clone = root.cloneNode(true);
  clone.setAttribute("xmlns", SVG_NS);
  clone.removeAttribute("class");
  if (!clone.getAttribute("viewBox")) {
    const box = root.getBBox ? root.getBBox() : { x: 0, y: 0, width: 24, height: 24 };
    clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  }
  clone.setAttribute("width", "100%");
  clone.setAttribute("height", "100%");
  clone.setAttribute("preserveAspectRatio", "xMidYMid meet");
  clone.setAttribute("role", "img");
  if (options.title) {
    const title = clone.ownerDocument.createElementNS(SVG_NS, "title");
    title.textContent = options.title;
    clone.insertBefore(title, clone.firstChild);
  }
  clone.style.overflow = "visible";
  if (typeof getComputedStyle === "function" && root.isConnected) {
    const resolved2 = getComputedStyle(root).color;
    if (resolved2) clone.style.color = resolved2;
  }
  const dur = `${(duration / 1e3).toFixed(3)}s`;
  const repeat = loop ? "indefinite" : "1";
  const resolved = [];
  for (const track of timeline.tracks) {
    const el = clone.querySelector(`[data-motion="${cssEscape(track.target || track.id)}"]`);
    if (!el) {
      report.unsupported.push({ track: track.id, reason: "target-missing" });
      continue;
    }
    resolved.push({ track, el });
  }
  const transformTracks = resolved.filter((r) => r.track.kind === "transform");
  const morphTracks = new Map(resolved.filter((r) => r.track.kind === "morph").map((r) => [r.el, r.track]));
  const numberTracks = new Map(resolved.filter((r) => r.track.kind === "number").map((r) => [r.el, r.track]));
  const styleTracks = new Map(resolved.filter((r) => r.track.kind === "style").map((r) => [r.el, r.track]));
  for (const { track, el } of transformTracks) {
    const name = track.target || track.id;
    const preset = options.origins && options.origins[name];
    const origin = preset || liveOrigin(root, name);
    if (origin) el.setAttribute("data-motion-origin", `${origin[0]} ${origin[1]}`);
  }
  const paths = [...clone.querySelectorAll("path")];
  for (const path of paths) {
    const morph = morphTracks.get(path) || null;
    const affine = transformTracks.filter((r) => contains(r.el, path));
    const number = numberTracks.get(path) || null;
    if (!morph && !affine.length) {
      if (number) report.unsupported.push({ track: number.track.id, reason: "no-geometry-track" });
      continue;
    }
    const baseD = path.getAttribute("d") || "";
    if (!baseD) continue;
    const frames = morph ? unifyMorphKeyframes(morph.keyframes).frames : [{ t: 0, d: serializePath(normalizePath(baseD).subpaths, 3), easing: "linear" }];
    const values = [];
    const keyTimes = [];
    for (let i = 0; i < frameCount; i++) {
      const time = i / (frameCount - 1) * duration;
      const d = morph ? sampleUnified(frames, resolveEasing, time) : frames[0].d;
      const matrix = composeMatrix(affine, time, path);
      values.push(matrix ? bakeTransform(d, matrix) : d);
      keyTimes.push(i / (frameCount - 1));
    }
    const animate = createAnimate(doc(path), {
      attributeName: "d",
      values,
      keyTimes,
      dur,
      repeat
    });
    animate.setAttribute("data-motion-track", morph ? morph.id : affine[0].track.id);
    path.setAttribute("d", values[0]);
    path.appendChild(animate);
    report.tracks.push({ id: animate.getAttribute("data-motion-track"), kind: "geometry" });
  }
  for (const [el, track] of numberTracks) {
    if (!isPath(el)) {
      const values2 = sampleSeries(track, frameCount, duration, (t) => String(round32(sampleNumber(track, t))));
      el.appendChild(
        createAnimate(doc(el), { attributeName: "opacity", values: values2, keyTimes: uniformKeyTimes(frameCount), dur, repeat })
      );
      el.setAttribute("opacity", values2[0]);
      report.tracks.push({ id: track.id, kind: "opacity" });
      continue;
    }
    if (!inheritsStroke(el)) {
      report.unsupported.push({ track: track.id, reason: "no-stroke" });
      continue;
    }
    el.setAttribute("pathLength", "1");
    el.style.strokeDasharray = "1 3";
    const pad = capPadding(root, el);
    const values = sampleSeries(
      track,
      frameCount,
      duration,
      (t) => String(round32((1 - sampleNumber(track, t)) * (1 + pad)))
    );
    el.appendChild(
      createAnimate(doc(el), {
        attributeName: "stroke-dashoffset",
        values,
        keyTimes: uniformKeyTimes(frameCount),
        dur,
        repeat
      })
    );
    el.style.strokeDashoffset = values[0];
    report.tracks.push({ id: track.id, kind: "stroke" });
  }
  for (const [el, track] of styleTracks) {
    const values = sampleSeries(
      track,
      frameCount,
      duration,
      (t) => String(round32(sampleStyle(track, t).opacity ?? 1))
    );
    el.appendChild(
      createAnimate(doc(el), { attributeName: "opacity", values, keyTimes: uniformKeyTimes(frameCount), dur, repeat })
    );
    el.setAttribute("opacity", values[0]);
    report.tracks.push({ id: track.id, kind: "opacity" });
  }
  applyStaticFrame(clone, timeline, 0);
  const svg = serialize(clone);
  report.bytes = new TextEncoder().encode(svg).length;
  return { svg, report };
}
function sampleSeries(track, frameCount, duration, map) {
  const values = [];
  for (let i = 0; i < frameCount; i++) {
    values.push(map(i / (frameCount - 1) * duration));
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
  const keys = /* @__PURE__ */ new Set([...Object.keys(from.value || {}), ...Object.keys(to.value || {})]);
  for (const key of keys) {
    const a = from.value?.[key];
    const b = to.value?.[key];
    out[key] = typeof a === "number" && typeof b === "number" ? a + (b - a) * eased : local < 0.5 ? a : b;
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
  const keys = /* @__PURE__ */ new Set([...Object.keys(from.value || {}), ...Object.keys(to.value || {})]);
  for (const key of keys) {
    const a = from.value?.[key];
    const b = to.value?.[key];
    if (typeof a === "number" && typeof b === "number") out[key] = a + (b - a) * eased;
  }
  return out;
}
function contains(ancestor, node) {
  if (ancestor === node) return true;
  return typeof ancestor.contains === "function" ? ancestor.contains(node) : false;
}
function liveOrigin(root, name) {
  const live = root.querySelector(`[data-motion="${cssEscape(name)}"]`);
  if (!live || typeof live.getBBox !== "function") return null;
  try {
    const box = live.getBBox();
    if (!box.width && !box.height) return null;
    return [round32(box.x + box.width / 2), round32(box.y + box.height / 2)];
  } catch {
    return null;
  }
}
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
  const rad = rotate * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
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
function originOf(el, path) {
  const attr = el.getAttribute("data-motion-origin");
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
function bakeTransform(d, matrix) {
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
function createAnimate(document_, attrs) {
  const el = document_.createElementNS(SVG_NS, "animate");
  el.setAttribute("attributeName", attrs.attributeName);
  el.setAttribute("values", attrs.values.join(";"));
  el.setAttribute("keyTimes", attrs.keyTimes.map((k) => k.toFixed(4)).join(";"));
  el.setAttribute("calcMode", "linear");
  el.setAttribute("dur", attrs.dur);
  el.setAttribute("repeatCount", attrs.repeat);
  el.setAttribute("fill", "freeze");
  return el;
}
function doc(node) {
  return node.ownerDocument;
}
function isPath(el) {
  return el.tagName && el.tagName.toLowerCase() === "path";
}
function capPadding(root, cloneEl) {
  const name = cloneEl.getAttribute("data-motion");
  const live = name ? root.querySelector(`[data-motion="${cssEscape(name)}"]`) : null;
  if (!live || typeof live.getTotalLength !== "function") return 0.02;
  try {
    const len = live.getTotalLength();
    if (!len) return 0.02;
    const sw = (typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(live).strokeWidth) : NaN) || parseFloat(live.getAttribute("stroke-width")) || 1;
    return Math.min(0.06, Math.max(4e-3, sw / 2 / len));
  } catch {
    return 0.02;
  }
}
function inheritsStroke(el) {
  let node = el;
  while (node && node.getAttribute) {
    const computed = typeof getComputedStyle === "function" && node.isConnected ? getComputedStyle(node).stroke : null;
    if (computed && computed !== "none") return true;
    const stroke = node.getAttribute("stroke");
    if (stroke) return stroke !== "none";
    const style = node.getAttribute("style") || "";
    const match = style.match(/stroke\s*:\s*([^;]+)/);
    if (match) return match[1].trim() !== "none";
    node = node.parentNode;
  }
  return false;
}
function applyStaticFrame(clone, timeline, time) {
  const sampled = timeline.sampleAt(time);
  for (const [trackId, value] of sampled) {
    const track = timeline.getTrack(trackId);
    if (!track) continue;
    if (track.kind !== "style") continue;
    const el = clone.querySelector(`[data-motion="${cssEscape(track.target || trackId)}"]`);
    if (el && value && typeof value.opacity === "number") {
      el.setAttribute("opacity", String(round32(value.opacity)));
    }
  }
}
function round32(v) {
  return Math.round(Number(v) * 1e3) / 1e3;
}
function serialize(node) {
  if (typeof XMLSerializer === "function") {
    return new XMLSerializer().serializeToString(node);
  }
  return node.outerHTML;
}
function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

// src/motion/export/html.js
function exportHtml(opts) {
  const title = escapeHtml(opts.title || "SVG Motion");
  const duration = opts.duration;
  const svg = opts.svg.replace(/^<\?xml[^>]*\?>\s*/, "");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 20px; padding: 32px;
    background: #17110d;
    background-image: radial-gradient(circle at 50% 0%, #2a1d14 0%, #17110d 70%);
    color: #f2e6d8;
    font: 14px/1.5 "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  .stage {
    width: min(78vmin, 560px); aspect-ratio: 1; display: grid; place-items: center;
    background: #1f1712;
    background-image:
      linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px);
    background-size: 24px 24px;
    border: 1px solid #3a2a1e; border-radius: 18px;
    box-shadow: 0 30px 60px -30px #000;
  }
  .stage svg { width: 68%; height: 68%; overflow: visible; }
  .bar { display: flex; align-items: center; gap: 12px; width: min(78vmin, 560px); }
  button {
    width: 40px; height: 40px; border-radius: 12px; cursor: pointer;
    border: 1px solid #4a3524; background: #2a1d14; color: #f6b26b;
    font-size: 15px; display: grid; place-items: center;
  }
  button:hover { background: #35251a; }
  input[type="range"] { flex: 1; accent-color: #f6b26b; }
  .time { font-variant-numeric: tabular-nums; color: #b9a08a; min-width: 92px; text-align: right; }
  h1 { font-size: 15px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #b9a08a; margin: 0; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="stage" id="stage">${svg}</div>
<div class="bar">
  <button id="play" aria-label="\u64AD\u653E/\u6682\u505C">\u275A\u275A</button>
  <input id="scrub" type="range" min="0" max="${duration}" value="0" step="1" aria-label="\u65F6\u95F4\u8F74">
  <span class="time" id="time">0.00 / ${(duration / 1e3).toFixed(2)}s</span>
</div>
<script>
(function () {
  var svg = document.querySelector('#stage svg');
  var playBtn = document.getElementById('play');
  var scrub = document.getElementById('scrub');
  var timeLabel = document.getElementById('time');
  var duration = ${duration};
  var playing = true;
  var dragging = false;

  function currentTime() {
    try { return svg.getCurrentTime() * 1000; } catch (e) { return 0; }
  }
  function setTime(ms) {
    var s = Math.max(0, Math.min(duration, ms)) / 1000;
    try { svg.setCurrentTime(s); } catch (e) {}
    scrub.value = String(Math.round(s * 1000));
    timeLabel.textContent = s.toFixed(2) + ' / ' + (duration / 1000).toFixed(2) + 's';
  }
  function pause() { playing = false; playBtn.textContent = '\u25B6'; try { svg.pauseAnimations(); } catch (e) {} }
  function resume() { playing = true; playBtn.textContent = '\u275A\u275A'; try { svg.unpauseAnimations(); } catch (e) {} }

  playBtn.addEventListener('click', function () { playing ? pause() : resume(); });
  scrub.addEventListener('pointerdown', function () { dragging = true; pause(); });
  scrub.addEventListener('pointerup', function () { dragging = false; });
  scrub.addEventListener('input', function () { setTime(Number(scrub.value)); });

  setInterval(function () {
    if (dragging || !playing) return;
    var t = currentTime();
    scrub.value = String(Math.round(t));
    timeLabel.textContent = (t / 1000).toFixed(2) + ' / ' + (duration / 1000).toFixed(2) + 's';
  }, 60);

  setTime(0);
  resume();
})();
<\/script>
</body>
</html>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// src/motion/index.js
var VERSION = "0.5.0";
export {
  EASINGS,
  EASING_NAMES,
  ICON_PRESETS,
  MotionScene,
  StrokePainter,
  Timeline,
  Track,
  VERSION,
  alignSubpaths,
  arcToCubicSegments,
  collapsePath,
  cubicBezier,
  exportHtml,
  exportSmil,
  extractIcon,
  interpolateBetweenD,
  interpolatePaths,
  makeKeyframe,
  measureStroke,
  normalizeIconPair,
  normalizePath,
  pairCost,
  parsePathCommands,
  planIconTransition,
  prepareMorph,
  quadToCubic,
  resampleSubpath,
  resolveEasing,
  reverseSubpath,
  rotateSubpath,
  round,
  sampleUnified,
  screenScale,
  serializePath,
  splitSegment,
  staggerSchedule,
  subpathArea,
  subpathCentroid,
  subpathLength,
  unifyMorphKeyframes
};
