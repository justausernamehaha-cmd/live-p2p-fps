// Everything in the world used to be an axis-aligned box, which made collision
// and hitscan trivial and identical on every peer. Slopes and free rotation
// break that, so anything that is not an AABB becomes a **convex solid**: a list
// of world-space vertices, the faces between them, and the outward planes that
// bound it.
//
// AABBs keep their own faster, exact path in world.js and player.js. This file
// only ever sees the shapes that could not stay one.

export const SHAPE_BOX = 0;
export const SHAPE_SLOPE = 1;

// Unit-cube corners, in the order the face lists below index them.
const BOX_VERTS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];
const BOX_FACES = [
  [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
  [3, 2, 6, 7], [1, 2, 6, 5], [0, 3, 7, 4]
];

// A wedge: full height at local +x, nothing at local -x, so it rises along +x.
// The designer aims it with the box's rotation rather than with a direction
// field, which keeps one shape and one transform instead of two of each.
const SLOPE_VERTS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1]
];
const SLOPE_FACES = [
  [0, 1, 4, 3],      // bottom
  [1, 2, 5, 4],      // the tall end
  [0, 1, 2],         // -z side
  [3, 4, 5],         // +z side
  [0, 2, 5, 3]       // the ramp itself
];

/** An axis-aligned box, expressed as a convex solid, so that the capsule
 *  push-out can be used against it. Only the tilted movement path needs this —
 *  an upright body is an AABB and collides with boxes exactly and much more
 *  cheaply — so the planes are made on demand and cached on the box itself.
 *  Movers translate their box in place, so the cached planes are re-derived when
 *  the bounds have moved. */
export function boxAsSolid(b) {
  const c = b._asSolid;
  if (c && c.min.x === b.min.x && c.min.y === b.min.y && c.min.z === b.min.z &&
      c.max.x === b.max.x && c.max.y === b.max.y && c.max.z === b.max.z) return c;
  const s = {
    min: b.min, max: b.max, mover: b.mover, src: b.src || b, box: b,
    planes: [
      { nx: 1, ny: 0, nz: 0, d: b.max.x }, { nx: -1, ny: 0, nz: 0, d: -b.min.x },
      { nx: 0, ny: 1, nz: 0, d: b.max.y }, { nx: 0, ny: -1, nz: 0, d: -b.min.y },
      { nx: 0, ny: 0, nz: 1, d: b.max.z }, { nx: 0, ny: 0, nz: -1, d: -b.min.z }
    ]
  };
  b._asSolid = s;
  return s;
}

/** True when a level box still fits the fast axis-aligned path. */
export function isAxisAligned(b) {
  return (b.shape || 0) === SHAPE_BOX && !b.rx && !b.ry && !b.rz;
}

/** Rotation matrix for the stored Euler angles, applied X then Y then Z.
 *  Rows, so that m[r][0..2] dotted with a point gives that component. */
export function eulerMatrix(rx, ry, rz) {
  const ca = Math.cos(rx), sa = Math.sin(rx);
  const cb = Math.cos(ry), sb = Math.sin(ry);
  const cc = Math.cos(rz), sc = Math.sin(rz);
  return [
    [cb * cc, sa * sb * cc - ca * sc, ca * sb * cc + sa * sc],
    [cb * sc, sa * sb * sc + ca * cc, ca * sb * sc - sa * cc],
    [-sb, sa * cb, ca * cb]
  ];
}

/** The inverse of eulerMatrix: the angles that would rebuild this rotation. */
export function eulerFromMatrix(m) {
  const sb = Math.min(1, Math.max(-1, -m[2][0]));
  const ry = Math.asin(sb);
  // Near straight up or straight down the X and Z rotations become the same
  // turn and cannot be told apart; pin X and put all of it into Z.
  if (Math.abs(m[2][0]) > 0.99999) {
    return [0, ry, Math.atan2(-m[0][1], m[1][1])];
  }
  return [Math.atan2(m[2][1], m[2][2]), ry, Math.atan2(m[1][0], m[0][0])];
}

export function matMul(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
    }
  }
  return out;
}

/** Rotation of `angle` about a world axis, as a matrix. */
export function axisMatrix(axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (axis === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === 1) return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

/** Turn a level box into a world-space convex solid. */
export function makeSolid(b) {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
  const hx = (b.x1 - b.x0) / 2, hy = (b.y1 - b.y0) / 2, hz = (b.z1 - b.z0) / 2;
  const m = eulerMatrix(b.rx || 0, b.ry || 0, b.rz || 0);
  const shape = b.shape || SHAPE_BOX;
  const local = shape === SHAPE_SLOPE ? SLOPE_VERTS : BOX_VERTS;
  const faceIdx = shape === SHAPE_SLOPE ? SLOPE_FACES : BOX_FACES;

  const verts = local.map(([lx, ly, lz]) => {
    const x = lx * hx, y = ly * hy, z = lz * hz;
    return [
      cx + m[0][0] * x + m[0][1] * y + m[0][2] * z,
      cy + m[1][0] * x + m[1][1] * y + m[1][2] * z,
      cz + m[2][0] * x + m[2][1] * y + m[2][2] * z
    ];
  });

  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const [x, y, z] of verts) {
    if (x < min.x) min.x = x; if (x > max.x) max.x = x;
    if (y < min.y) min.y = y; if (y > max.y) max.y = y;
    if (z < min.z) min.z = z; if (z > max.z) max.z = z;
  }

  const centre = { x: cx, y: cy, z: cz };     // the pivot: rotation turns about it
  // A wedge's bounding-box centre lies exactly ON its ramp plane, so it cannot
  // be used to decide which way that face points — the test comes out zero and
  // the normal is left pointing into the solid. The mean of the vertices is
  // strictly inside every convex shape, so it can.
  let ix = 0, iy = 0, iz = 0;
  for (const v of verts) { ix += v[0]; iy += v[1]; iz += v[2]; }
  ix /= verts.length; iy /= verts.length; iz /= verts.length;

  const faces = [];
  const planes = [];
  for (let idx of faceIdx) {
    const a = verts[idx[0]], p = verts[idx[1]], q = verts[idx[2]];
    let nx = (p[1] - a[1]) * (q[2] - a[2]) - (p[2] - a[2]) * (q[1] - a[1]);
    let ny = (p[2] - a[2]) * (q[0] - a[0]) - (p[0] - a[0]) * (q[2] - a[2]);
    let nz = (p[0] - a[0]) * (q[1] - a[1]) - (p[1] - a[1]) * (q[0] - a[0]);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    // Point every normal away from the middle rather than trusting the winding
    // of the tables above — a mirrored or degenerate box would flip one silently.
    if (nx * (a[0] - ix) + ny * (a[1] - iy) + nz * (a[2] - iz) < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      idx = idx.slice().reverse();
    }
    faces.push({ idx, n: [nx, ny, nz] });
    planes.push({ nx, ny, nz, d: nx * a[0] + ny * a[1] + nz * a[2] });
  }

  return { verts, faces, planes, min, max, centre, shape, color: b.color, src: b };
}

/** Distance along `dir` to where the ray enters the solid, and the face it came
 *  in through. Null if it misses, or if the solid is behind the origin. */
export function rayConvex(ro, rd, solid, maxDist = Infinity) {
  let tmin = 0, tmax = maxDist, face = -1;
  const o = [ro.x, ro.y, ro.z], d = [rd.x, rd.y, rd.z];
  for (let i = 0; i < solid.planes.length; i++) {
    const p = solid.planes[i];
    const denom = p.nx * d[0] + p.ny * d[1] + p.nz * d[2];
    const dist = p.d - (p.nx * o[0] + p.ny * o[1] + p.nz * o[2]);
    if (Math.abs(denom) < 1e-9) {
      if (dist < 0) return null;          // parallel to this face and outside it
      continue;
    }
    const t = dist / denom;
    if (denom < 0) {                       // entering through this face
      if (t > tmin) { tmin = t; face = i; }
    } else if (t < tmax) {                 // leaving through it
      tmax = t;
    }
    if (tmin > tmax) return null;
  }
  // face < 0 means the origin was already inside: there is no entry face
  return { t: tmin, face, n: face < 0 ? null : solid.planes[face], inside: face < 0 };
}

/** How deep a vertical capsule is inside the solid, and the way out.
 *
 *  Separating-axis over the face normals only. That is exact for a sphere and
 *  close enough for a capsule: the corners come out very slightly rounded, which
 *  nobody can feel and which no other part of the game depends on. */
export function capsulePush(ax, ay, az, bx, by, bz, radius, solid) {
  // Cheap reject first — most solids are nowhere near the player. Written from
  // the two endpoints rather than assuming the capsule stands up: gravity can
  // point along a 45-degree diagonal now, and a body lying along one of those is
  // as wide as it is tall.
  if (Math.max(ax, bx) + radius < solid.min.x || Math.min(ax, bx) - radius > solid.max.x ||
      Math.max(ay, by) + radius < solid.min.y || Math.min(ay, by) - radius > solid.max.y ||
      Math.max(az, bz) + radius < solid.min.z || Math.min(az, bz) - radius > solid.max.z) return null;

  let best = null;
  for (const p of solid.planes) {
    const da = p.nx * ax + p.ny * ay + p.nz * az;
    const db = p.nx * bx + p.ny * by + p.nz * bz;
    const depth = p.d + radius - Math.min(da, db);
    if (depth <= 0) return null;           // this face separates them
    if (!best || depth < best.depth) best = { depth, n: p };
  }
  return best;
}

/** Slide a built solid bodily through space. A moving platform is rebuilt every
 *  frame otherwise, and rebuilding is where all the cost is: the vertices, the
 *  bounds and the pivot simply shift, and a plane's normal is untouched while
 *  its offset moves by the component of the shift along it. */
export function translateSolid(s, dx, dy, dz) {
  for (const v of s.verts) { v[0] += dx; v[1] += dy; v[2] += dz; }
  for (const p of s.planes) p.d += p.nx * dx + p.ny * dy + p.nz * dz;
  s.min.x += dx; s.min.y += dy; s.min.z += dz;
  s.max.x += dx; s.max.y += dy; s.max.z += dz;
  s.centre.x += dx; s.centre.y += dy; s.centre.z += dz;
  return s;
}
