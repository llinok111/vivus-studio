/**
 * SVG path data tokenizer and command parser.
 *
 * This module deliberately does not normalise anything: it only turns a `d`
 * string into a list of absolute commands with explicit parameters, so the
 * normaliser can reason about command types without re-parsing text.
 *
 * Zero dependencies, no DOM. Runs identically in the browser and in Node.
 */

const COMMAND_ARITY = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0
};

const NUMBER_RE = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

/**
 * Split a path data string into raw tokens: commands and numbers.
 *
 * Arc flags are a well known trap: `a1 1 0 011 1` is legal because the flags
 * are single characters and need no separator. A generic number tokenizer
 * would read `011` as one number. We therefore parse the arc parameter list
 * positionally instead of tokenizing the whole string up front.
 *
 * @param {string} d
 * @returns {Array<{cmd: string, params: number[]}>}
 */
export function parsePathCommands(d) {
  if (typeof d !== 'string') {
    throw new TypeError('path data must be a string');
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
    if (d[i] === '+' || d[i] === '-') i++;
    while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    if (d[i] === '.') {
      i++;
      while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    }
    if (i === start) return NaN;
    if (d[i] === 'e' || d[i] === 'E') {
      const save = i;
      i++;
      if (d[i] === '+' || d[i] === '-') i++;
      let digits = 0;
      while (i < n && d[i] >= '0' && d[i] <= '9') { i++; digits++; }
      if (digits === 0) i = save;
    }
    if (i === start) return NaN;
    return parseFloat(d.slice(start, i));
  };

  const readFlag = () => {
    skipSeparators();
    if (d[i] === '0' || d[i] === '1') return Number(d[i++]);
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
    } else if (cmd === 'Z' || cmd === 'z') {
      // A number after Z is invalid; treat Z as a no-arg separator.
      skipSeparators();
      continue;
    }

    const upper = cmd.toUpperCase();
    const arity = COMMAND_ARITY[upper];
    if (arity === undefined) {
      throw new SyntaxError(`unsupported path command "${cmd}"`);
    }
    if (arity === 0) {
      out.push({ cmd: upper, params: [] });
      // Z may be followed directly by another command; a repeated Z is a no-op.
      cmd = null;
      skipSeparators();
      continue;
    }

    const params = [];
    if (upper === 'A') {
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

    // Implicit repetition: "M 0 0 10 10" means M then L.
    if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
  }

  return out;
}

/**
 * Normalise numbers the way SVG does for flags, kept here for callers that
 * re-serialise parsed commands.
 *
 * @param {number} value
 * @param {number} precision
 */
export function round(value, precision = 3) {
  const f = Math.pow(10, precision);
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export { NUMBER_RE };
