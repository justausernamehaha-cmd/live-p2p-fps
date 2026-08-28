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

export const hueFor = id => hash(id) % 360;

/** CSS colour for the DOM. Note the commas: THREE.Color's parser rejects the
 *  space-separated form and silently falls back to white. */
export function colorFor(id) {
  return `hsl(${hueFor(id)}, 75%, 58%)`;
}

const WORDS = ['iron', 'dust', 'nova', 'echo', 'vault', 'onyx', 'flare', 'rift', 'ghost', 'delta',
               'ember', 'north', 'sable', 'quartz', 'raven', 'stark'];

export function randomRoom() {
  const w = WORDS[(Math.random() * WORDS.length) | 0];
  return w + '-' + Math.floor(Math.random() * 9000 + 1000);
}

export const round2 = n => Math.round(n * 100) / 100;

/** Anything arriving from a peer is untrusted: coerce or fall back. */
export const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
