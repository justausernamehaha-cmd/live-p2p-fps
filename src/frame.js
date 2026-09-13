// Which way is up, per player. A portal can turn you over, so "vertical" means
// along `up`. There are eighteen ups: the six world axes (the fast path, where
// the body's box stays axis-aligned) and the twelve 45-degree diagonals (tilted:
// collided as a capsule, see Player._moveTilted). No three.js, so it runs in node.

const R2 = Math.SQRT1_2;

// Fixed order: an index means the same up on every machine.
export const UPS = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  { x: R2, y: R2, z: 0 }, { x: R2, y: -R2, z: 0 },
  { x: -R2, y: R2, z: 0 }, { x: -R2, y: -R2, z: 0 },
  { x: R2, y: 0, z: R2 }, { x: R2, y: 0, z: -R2 },
  { x: -R2, y: 0, z: R2 }, { x: -R2, y: 0, z: -R2 },
  { x: 0, y: R2, z: R2 }, { x: 0, y: R2, z: -R2 },
  { x: 0, y: -R2, z: R2 }, { x: 0, y: -R2, z: -R2 }
];

export const UP_Y = UPS[2];

/** An up's index in UPS, which is how it travels over the network. */
export function upIndex(up) {
  for (let i = 0; i < UPS.length; i++) {
    if (UPS[i].x === up.x && UPS[i].y === up.y && UPS[i].z === up.z) return i;
  }
  return 2;
}

export function upFromIndex(i) {
  const k = i | 0;
  return UPS[k >= 0 && k < UPS.length ? k : 2];
}

/** Nearest of the eighteen ups to any direction. */
export function snapUp(d) {
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  const v = { x: d.x / len, y: d.y / len, z: d.z / len };
  let best = UPS[2], bestDot = -Infinity;
  for (const u of UPS) {
    const k = u.x * v.x + u.y * v.y + u.z * v.z;
    if (k > bestDot) { bestDot = k; best = u; }
  }
  return best;
}

const AX = 1 - 1e-6;
/** The world axis this up lies along, or null when the body is tilted. */
export function axisKey(up) {
  if (Math.abs(up.x) > AX) return 'x';
  if (Math.abs(up.y) > AX) return 'y';
  if (Math.abs(up.z) > AX) return 'z';
  return null;
}
export function axisSign(up) {
  const k = axisKey(up);
  return k ? Math.sign(up[k]) : 0;
}

/** The two world axes the body is wide along, or null when tilted. */
export function crossKeys(up) {
  const k = axisKey(up);
  if (!k) return null;
  return k === 'x' ? ['y', 'z'] : k === 'y' ? ['x', 'z'] : ['x', 'y'];
}

/** Where yaw is measured from, per up: (0,0,-1) for the ordinary up. */
function northFor(up) {
  const k = axisKey(up);
  if (k) return up.y !== 0 ? { x: 0, y: 0, z: -1 } : { x: 0, y: -1, z: 0 };
  const c = Math.abs(up.z) < 0.9 ? { x: 0, y: 0, z: -1 } : { x: 0, y: -1, z: 0 };
  const d = c.x * up.x + c.y * up.y + c.z * up.z;
  const v = { x: c.x - up.x * d, y: c.y - up.y * d, z: c.z - up.z * d };
  const L = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / L, y: v.y / L, z: v.z / L };
}

/** Two orthonormal directions spanning the walking plane. For an axis up these
 *  are exactly the crossKeys() axes, so the movement arithmetic is unchanged. */
export function flatBasis(up) {
  const k = crossKeys(up);
  if (k) {
    const e = a => ({ x: a === 'x' ? 1 : 0, y: a === 'y' ? 1 : 0, z: a === 'z' ? 1 : 0 });
    return [e(k[0]), e(k[1])];
  }
  const n = northFor(up);
  return [cross(n, up), n];
}

const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});

export const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Flat forward and right. For up=(0,1,0): f = (-sin yaw, 0, -cos yaw),
 *  r = (cos yaw, 0, -sin yaw). A sign wrong here mirrors the controls. */
export function basisFor(up, yaw) {
  const n = northFor(up);
  const r = cross(n, up);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    f: { x: n.x * c - r.x * s, y: n.y * c - r.y * s, z: n.z * c - r.z * s },
    r: { x: r.x * c + n.x * s, y: r.y * c + n.y * s, z: r.z * c + n.z * s }
  };
}

/** The look direction from yaw and pitch. */
export function lookFrom(up, yaw, pitch) {
  const { f } = basisFor(up, yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return {
    x: f.x * cp + up.x * sp,
    y: f.y * cp + up.y * sp,
    z: f.z * cp + up.z * sp
  };
}

/** The inverse of lookFrom. */
export function anglesIn(up, d) {
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  const v = { x: d.x / len, y: d.y / len, z: d.z / len };
  const sp = Math.max(-1, Math.min(1, dot3(v, up)));
  const n = northFor(up);
  const r = cross(n, up);
  return { yaw: Math.atan2(-dot3(v, r), dot3(v, n)), pitch: Math.asin(sp) };
}
