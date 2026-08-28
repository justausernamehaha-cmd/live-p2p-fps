export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// shortest-path angular interpolation (radians)
export function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const now = () => performance.now();

// deterministic 32-bit hash -> used for per-player colours
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Hand-picked and widely separated in hue, and deliberately clear of the
// blue-grey the level is built from. Players are assigned these by their sorted
// position in the room, not by hashing their id, so two people can never end up
// with near-identical colours.
export const PLAYER_COLORS = [
  0xff8a3d,  // orange
  0x35d6f5,  // cyan
  0x8bf03a,  // lime
  0xff4fd8,  // magenta
  0xffd93b,  // yellow
  0xff4d5e,  // red
  0xa872ff,  // violet
  0x2ce8a4,  // spring green
  0xffffff,  // white
  0x7a8cff   // periwinkle
];

/** Everyone in a room sorted the same way gets the same colour on every screen. */
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
