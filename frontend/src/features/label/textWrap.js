// Line breaking for SVG text (the developer label), where the browser does
// not wrap. Widths are estimated from the system sans's proportions, which is
// close enough for a fixed-width sheet with generous margins; a word longer
// than a line (a URL, an address) breaks after a separator (/ ? & = , : @ .) where one fits,
// otherwise between characters.

const NARROW = new Set([...'iljtfr.,:;|!\'"()[] /-']);
const WIDE = new Set([...'mwMW@%']);
const SYMBOL = new Set([...'+=_&?~#']);

/** Estimated advance of one character at 1px font size. */
function advance(char, bold) {
  let width;
  if (NARROW.has(char)) width = 0.3;
  else if (WIDE.has(char)) width = 0.82;
  else if (SYMBOL.has(char)) width = 0.64;
  else if (/[A-Z]/.test(char)) width = 0.68;
  else if (/[0-9]/.test(char)) width = 0.6;
  else width = 0.56;
  // A little over the system sans's real advances, so a line never overruns.
  return bold ? width * 1.08 : width;
}

export function textWidth(text, fontSize, { bold = false } = {}) {
  let width = 0;
  for (const char of String(text)) width += advance(char, bold);
  return width * fontSize;
}

/**
 * @param {string} text
 * @param {number} maxWidth px
 * @param {number} fontSize px
 * @param {{ bold?: boolean, maxLines?: number }} [options] the last line ends in "…" when lines run out
 * @returns {string[]}
 */
export function wrapText(text, maxWidth, fontSize, { bold = false, maxLines = Infinity } = {}) {
  const fits = (value) => textWidth(value, fontSize, { bold }) <= maxWidth;
  const lines = [];
  let line = '';
  const push = () => {
    if (line) lines.push(line);
    line = '';
  };
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    push();
    if (fits(word)) {
      line = word;
      continue;
    }
    // A word wider than the line: break it after a separator, or between characters.
    const parts = breakWord(word, fits);
    lines.push(...parts.slice(0, -1));
    line = parts[parts.length - 1] ?? '';
  }
  push();
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && !fits(`${last}…`)) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }
  return lines;
}

const SEPARATORS = new Set([...'/?&=,:@.']);

/**
 * Breaks a word that is wider than a line into pieces that fit: after the
 * last separator that still fits (so a URL breaks at "/", "?", or "&"), or
 * between characters when no separator does.
 *
 * @param {string} word
 * @param {(value: string) => boolean} fits
 * @returns {string[]}
 */
export function breakWord(word, fits) {
  const pieces = [];
  let rest = String(word);
  while (rest && !fits(rest)) {
    let end = 0;
    let lastSeparator = 0;
    for (const char of rest) {
      if (!fits(rest.slice(0, end + char.length))) break;
      end += char.length;
      if (SEPARATORS.has(char)) lastSeparator = end;
    }
    const cut = lastSeparator > end / 3 ? lastSeparator : Math.max(end, 1);
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}
