// Which way is up, for one player.
//
// Until portals started turning people over, up was (0,1,0) everywhere and the
// physics could say `vel.y` and mean "vertical". It cannot any more: coming out
// of a portal, the direction your feet point is the direction gravity pulls, so
// a player standing on a wall has up = (1,0,0) and everything the movement code
// calls vertical is measured along that instead.
//
// Up is always one of the six world axes. That is the whole reason this stays
// cheap: the body's box is still axis-aligned whichever way it is standing, so
// collision, the step-up and the platform code keep working on AABBs and only
// have to be told which letter is "up" and which way it points. A portal on a
// ramp therefore rounds the answer to the nearest axis rather than standing you
// on a slope — blunt on purpose, because half a frame of a tilted body is worth
// less than every other surface in the game staying exact.
//
// Deliberately free of three.js so it runs in node, like solid.js and portal.js.

export const UPS = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }
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

export function upFromIndex(i) { return UPS[(i | 0) >= 0 && (i | 0) < 6 ? (i | 0) : 2]; }

/** Nearest world axis to an arbitrary direction. A portal's transform is a real
 *  rotation and its image of your up can point anywhere; this is where that is
 *  rounded off. */
export function snapAxis(d) {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  if (ax >= ay && ax >= az) return d.x >= 0 ? UPS[0] : UPS[1];
  if (ay >= az) return d.y >= 0 ? UPS[2] : UPS[3];
  return d.z >= 0 ? UPS[4] : UPS[5];
}

export function axisKey(up) { return up.x ? 'x' : up.y ? 'y' : 'z'; }
export function axisSign(up) { return up.x || up.y || up.z; }

/** The two world axes the body is *wide* along, given which one it is tall
 *  along. Order is fixed so a frame is reproducible. */
export function crossKeys(up) {
  const k = axisKey(up);
  return k === 'x' ? ['y', 'z'] : k === 'y' ? ['x', 'z'] : ['x', 'y'];
}

/** Yaw's zero, per up. Any vector perpendicular to up would do — it only fixes
 *  where the angle is measured from — but it has to be the same one every time
 *  or a player's heading would jump about. For the ordinary up this is
 *  (0,0,-1), which is what the game has always measured yaw from. */
export function northFor(up) {
  return up.y !== 0 ? { x: 0, y: 0, z: -1 } : { x: 0, y: -1, z: 0 };
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
