type RGB = [number, number, number];

export function parseColor(input: string): RGB | null {
  const s = (input || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i], 16) * 17) as RGB;
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB;
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])] as RGB;
  return null;
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255)) as RGB;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255)) as RGB;
}

const toHex = (rgb: RGB) => `#${rgb.map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('')}`;

/**
 * The colour, nudged light or dark — hue and saturation preserved — until it
 * reads against `background`. "A grouping titled in navy" stays recognisably
 * navy-ish on a dark panel; it just stops being invisible. Direction follows
 * the background's own luminance, so it works unchanged on a future light
 * theme with no code change — only `background` (read live) differs.
 */
export function readableOn(color: string, background: string, minContrast = 4.5): string {
  const fg = parseColor(color);
  const bg = parseColor(background);
  if (!fg || !bg) return color;
  const bgLum = luminance(bg);
  if (contrast(luminance(fg), bgLum) >= minContrast) return color;
  const [h, s, l] = rgbToHsl(fg);
  const lighten = bgLum < 0.5; // dark panel -> push toward white, and vice versa
  for (let step = 1; step <= 24; step++) {
    const next = lighten ? Math.min(1, l + step * 0.04) : Math.max(0, l - step * 0.04);
    const rgb = hslToRgb([h, s, next]);
    if (contrast(luminance(rgb), bgLum) >= minContrast) return toHex(rgb);
  }
  return lighten ? '#ffffff' : '#000000';
}

/** The panel colour as it actually is — a light theme changes this, not the code. */
export function cssColor(variable: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
}
