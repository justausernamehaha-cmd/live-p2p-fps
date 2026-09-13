export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// shortest-path angular interpolation (radians)
export function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const now = () => performance.now();

// FNV-1a, 32 bit
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Widely separated hues, clear of the level's blue-grey. Assigned by sorted
// position in the room so two players never get near-identical colours.
export const PLAYER_COLORS = [
  0xff8a3d, 0x35d6f5, 0x8bf03a, 0xff4fd8, 0xffd93b,
  0xff4d5e, 0xa872ff, 0x2ce8a4, 0xffffff, 0x7a8cff
];

export function colorIndexFor(id, allIds) {
  const i = [...allIds].sort().indexOf(id);
  return (i < 0 ? 0 : i) % PLAYER_COLORS.length;
}

export const cssColor = hex => '#' + hex.toString(16).padStart(6, '0');

const WORDS = ['iron', 'dust', 'nova', 'echo', 'vault', 'onyx', 'flare', 'rift', 'ghost', 'delta',
               'ember', 'north', 'sable', 'quartz', 'raven', 'stark'];

export function randomRoom() {
  const w = WORDS[(Math.random() * WORDS.length) | 0];
  return w + '-' + Math.floor(Math.random() * 9000 + 1000);
}

export const round2 = n => Math.round(n * 100) / 100;

/** Anything arriving from a peer is untrusted: coerce or fall back. */
export const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
