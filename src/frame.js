// Which way is up, for one player.
//
// Until portals started turning people over, up was (0,1,0) everywhere and the
// physics could say `vel.y` and mean "vertical". It cannot any more: coming out
// of a portal, the direction your feet point is the direction gravity pulls, so
// a player standing on a wall has up = (1,0,0) and everything the movement code
// calls vertical is measured along that instead.
//
// Eighteen directions: the six world axes, and the twelve that sit at 45 degrees
// between two of them. Every slope in the game is 45 degrees, so a mouth on one
// turns you by 45 degrees, and "my gravitational force should be able to rotate
// 45 degrees" is exactly the twelve.
//
// The six come first and are exact, because they are the cheap case and the one
// everything else was built on: with up along a world axis the body's box is
// still axis-aligned however it is standing, so collision, the step-up and the
// platform code all keep working on AABBs and only have to be told which letter
// is "up". A tilted body is not an AABB in any world frame, so it is collided as
// the capsule it really is — see Player._moveTilted. Both paths are live; which
// one runs is decided by whether axisKey() has an answer.
//
// Deliberately free of three.js so it runs in node, like solid.js and portal.js.

const R2 = Math.SQRT1_2;

export const UPS = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  // ...and the twelve edge diagonals, in a fixed order so an index means the
  // same thing on every machine
  { x: R2, y: R2, z: 0 }, { x: R2, y: -R2, z: 0 },
  { x: -R2, y: R2, z: 0 }, { x: -R2, y: -R2, z: 0 },
  { x: R2, y: 0, z: R2 }, { x: R2, y: 0, z: -R2 },
  { x: -R2, y: 0, z: R2 }, { x: -R2, y: 0, z: -R2 },
  { x: 0, y: R2, z: R2 }, { x: 0, y: R2, z: -R2 },
  { x: 0, y: -R2, z: R2 }, { x: 0, y: -R2, z: -R2 }
];

export const UP_Y = UPS[2];

/** The index of an up in UPS, which is how it travels over the network — three
 *  bits instead of three floats, and it cannot arrive as anything invalid. */
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

/** Nearest world axis to an arbitrary direction. Still six-way: the places that
 *  genuinely cannot take a tilted answer ask for this one. */
export function snapAxis(d) {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  if (ax >= ay && ax >= az) return d.x >= 0 ? UPS[0] : UPS[1];
  if (ay >= az) return d.y >= 0 ? UPS[2] : UPS[3];
  return d.z >= 0 ? UPS[4] : UPS[5];
}

/** Nearest of the eighteen. A portal's transform is a real rotation and its
 *  image of your up can point anywhere; this is where that is rounded off, and
 *  a mouth on a 45-degree face now rounds to the 45 degrees it actually is
 *  rather than to whichever axis was nearer. */
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
/** Which world axis this up lies along, or null when it lies along none of them
 *  — which is the whole test for "is this body tilted". */
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

/** The two world axes the body is *wide* along, given which one it is tall
 *  along. Order is fixed so a frame is reproducible. Null for a tilted up: the
 *  body is not wide along any pair of world axes then. */
export function crossKeys(up) {
  const k = axisKey(up);
  if (!k) return null;
  return k === 'x' ? ['y', 'z'] : k === 'y' ? ['x', 'z'] : ['x', 'y'];
}

/** Yaw's zero, per up. Any vector perpendicular to up would do — it only fixes
 *  where the angle is measured from — but it has to be the same one every time
 *  or a player's heading would jump about. For the ordinary up this is
 *  (0,0,-1), which is what the game has always measured yaw from.
 *
 *  The six axes keep their exact historical answers. A tilted up takes the same
 *  two candidates and flattens the usable one into its own plane, which is the
 *  same rule stated for a case where the candidate is not already perpendicular. */
export function northFor(up) {
  const k = axisKey(up);
  if (k) return up.y !== 0 ? { x: 0, y: 0, z: -1 } : { x: 0, y: -1, z: 0 };
  const c = Math.abs(up.z) < 0.9 ? { x: 0, y: 0, z: -1 } : { x: 0, y: -1, z: 0 };
  const d = c.x * up.x + c.y * up.y + c.z * up.z;
  const v = { x: c.x - up.x * d, y: c.y - up.y * d, z: c.z - up.z * d };
  const L = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / L, y: v.y / L, z: v.z / L };
}

/** Two orthonormal directions spanning the plane the player walks in.
 *
 *  For an up along a world axis these are exactly the two world axes crossKeys()
 *  names, as unit vectors and in the same order — so movement written against
 *  them is the same arithmetic it has always been, to the last bit, and the
 *  tilted case is the same code with a different pair. */
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

/** Forward and right, flat in the plane the player walks in.
 *
 *  For up = (0,1,0) this is exactly the basis the camera has always used:
 *  forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw). Getting a
 *  sign wrong here mirrors the controls, so it is checked in test/frame.mjs
 *  against that closed form at every up. */
export function basisFor(up, yaw) {
  const n = northFor(up);
  const r = cross(n, up);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    f: { x: n.x * c - r.x * s, y: n.y * c - r.y * s, z: n.z * c - r.z * s },
    r: { x: r.x * c + n.x * s, y: r.y * c + n.y * s, z: r.z * c + n.z * s }
  };
}

/** The direction the player is looking, from their own angles. */
export function lookFrom(up, yaw, pitch) {
  const { f } = basisFor(up, yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return {
    x: f.x * cp + up.x * sp,
    y: f.y * cp + up.y * sp,
    z: f.z * cp + up.z * sp
  };
}

/** ...and back again: the angles that look along `d` in the frame `up`. The
 *  inverse of lookFrom, which is what a portal traversal needs — the view has to
 *  come through the mouth with the body. */
export function anglesIn(up, d) {
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  const v = { x: d.x / len, y: d.y / len, z: d.z / len };
  const sp = Math.max(-1, Math.min(1, dot3(v, up)));
  const n = northFor(up);
  const r = cross(n, up);
  return { yaw: Math.atan2(-dot3(v, r), dot3(v, n)), pitch: Math.asin(sp) };
}
