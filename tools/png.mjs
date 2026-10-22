/**
 * Minimal PNG decoder for pixel assertions in the DOM test suite.
 *
 * Only what Chrome's screenshots contain: 8-bit RGB or RGBA, no interlacing,
 * no palette. Node's zlib does the inflate; the five scanline filters are
 * implemented here.
 */

import zlib from 'node:zlib';

export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  let bitDepth = 8;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos++];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const up = y > 0 ? pixels[rowStart - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[rowStart - stride + x - channels] : 0;
      let out;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      pixels[rowStart + x] = out & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Statistics about "ink": pixels that differ from the background by more than
 * a threshold. Returns coverage plus the bounding box, which is what scaling
 * assertions actually need.
 */
export function inkStats(png, { background = [23, 17, 13], threshold = 26 } = {}) {
  const { width, height, channels, pixels } = png;
  let count = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const dr = pixels[i] - background[0];
      const dg = pixels[i + 1] - background[1];
      const db = pixels[i + 2] - background[2];
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > threshold) {
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    width,
    height,
    count,
    coverage: count / (width * height),
    bbox: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  };
}

/** FNV-1a over raw pixels; stable across runs, unlike a Date-based hash. */
export function pixelHash(png) {
  let h = 0x811c9dc5;
  for (let i = 0; i < png.pixels.length; i += 7) {
    h ^= png.pixels[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Downsample an image into a square binary ink mask.
 *
 * Used to compare the editor preview against the exported file: both are
 * rasterised at different sizes, so the comparison has to happen in a
 * resolution-independent space. Block coverage above 6% counts as ink.
 */
export function inkMask(png, size = 48, { background = [255, 255, 255], threshold = 26, crop = false } = {}) {
  const { width, height, channels, pixels } = png;
  let x0base = 0;
  let y0base = 0;
  let w = width;
  let h = height;

  if (crop) {
    const box = inkStats(png, { background, threshold }).bbox;
    if (box) {
      x0base = box.x;
      y0base = box.y;
      w = box.width;
      h = box.height;
    }
  }

  const mask = new Uint8Array(size * size);
  for (let by = 0; by < size; by++) {
    for (let bx = 0; bx < size; bx++) {
      const x0 = x0base + Math.floor((bx * w) / size);
      const x1 = x0base + Math.max(Math.floor((bx * w) / size) + 1, Math.floor(((bx + 1) * w) / size));
      const y0 = y0base + Math.floor((by * h) / size);
      const y1 = y0base + Math.max(Math.floor((by * h) / size) + 1, Math.floor(((by + 1) * h) / size));
      let hits = 0;
      let total = 0;
      for (let y = Math.min(y0, height - 1); y < Math.min(y1, height); y++) {
        for (let x = Math.min(x0, width - 1); x < Math.min(x1, width); x++) {
          const i = (y * width + x) * channels;
          const d =
            Math.abs(pixels[i] - background[0]) +
            Math.abs(pixels[i + 1] - background[1]) +
            Math.abs(pixels[i + 2] - background[2]);
          total++;
          if (d > threshold) hits++;
        }
      }
      mask[by * size + bx] = total && hits / total > 0.06 ? 1 : 0;
    }
  }
  return mask;
}

/**
 * Intersection over union of two equal-length binary masks.
 *
 * `tolerance` dilates both masks by that many cells first. Stroke-only artwork
 * is a one- or two-cell-wide line after downsampling, so a half-pixel
 * difference in where the line lands can halve the raw IoU even when the
 * drawings are visually identical. Dilating both sides measures "the same ink
 * in the same place", not "the same antialiasing".
 */
export function maskIoU(a, b, { tolerance = 0 } = {}) {
  const m1 = tolerance ? dilate(a, tolerance) : a;
  const m2 = tolerance ? dilate(b, tolerance) : b;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < m1.length; i++) {
    if (m1[i] && m2[i]) inter++;
    if (m1[i] || m2[i]) union++;
  }
  return union === 0 ? 1 : inter / union;
}

function dilate(mask, radius) {
  const size = Math.round(Math.sqrt(mask.length));
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!mask[y * size + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < size && nx >= 0 && nx < size) out[ny * size + nx] = 1;
        }
      }
    }
  }
  return out;
}
