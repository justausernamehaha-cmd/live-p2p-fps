// Convex solids: ramps and anything rotated. Plain boxes keep the faster
// axis-aligned path in world.js and player.js.

export const SHAPE_BOX = 0;
export const SHAPE_SLOPE = 1;

const BOX_VERTS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];
const BOX_FACES = [
  [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
  [3, 2, 6, 7], [1, 2, 6, 5], [0, 3, 7, 4]
];

// A wedge, full height at local +x: it climbs along +x.
const SLOPE_VERTS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1]
];
const SLOPE_FACES = [
  [0, 1, 4, 3],      // bottom
  [1, 2, 5, 4],      // the tall end
  [0, 1, 2],         // -z side
  [3, 4, 5],         // +z side
  [0, 2, 5, 3]       // the ramp
];

/** An AABB as a convex solid, for the tilted capsule path. Cached on the box and
 *  rebuilt if a mover has shifted it. */
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

export function isAxisAligned(b) {
  return (b.shape || 0) === SHAPE_BOX && !b.rx && !b.ry && !b.rz;
}

/** Rotation matrix (rows) for Euler angles applied X, then Y, then Z. */
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

/** Inverse of eulerMatrix. Angles are not unique: compare footprints, not angles. */
export function eulerFromMatrix(m) {
  const sb = Math.min(1, Math.max(-1, -m[2][0]));
  const ry = Math.asin(sb);
  // gimbal lock: X and Z are the same turn, so put all of it into Z
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

export function axisMatrix(axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (axis === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === 1) return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

/** A level box as a world-space convex solid. */
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

  const centre = { x: cx, y: cy, z: cz };     // the pivot
  // Orient normals from the vertex mean: a wedge's bounding-box centre lies ON
  // its ramp plane and cannot decide which way that face points.
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
    if (nx * (a[0] - ix) + ny * (a[1] - iy) + nz * (a[2] - iz) < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      idx = idx.slice().reverse();
    }
    faces.push({ idx, n: [nx, ny, nz] });
    planes.push({ nx, ny, nz, d: nx * a[0] + ny * a[1] + nz * a[2] });
  }

  return { verts, faces, planes, min, max, centre, shape, color: b.color, src: b };
}

/** Where a ray enters the solid and through which face; null on a miss. */
export function rayConvex(ro, rd, solid, maxDist = Infinity) {
  let tmin = 0, tmax = maxDist, face = -1;
  const o = [ro.x, ro.y, ro.z], d = [rd.x, rd.y, rd.z];
  for (let i = 0; i < solid.planes.length; i++) {
    const p = solid.planes[i];
    const denom = p.nx * d[0] + p.ny * d[1] + p.nz * d[2];
    const dist = p.d - (p.nx * o[0] + p.ny * o[1] + p.nz * o[2]);
    if (Math.abs(denom) < 1e-9) {
      if (dist < 0) return null;          // parallel and outside
      continue;
    }
    const t = dist / denom;
    if (denom < 0) {                       // entering
      if (t > tmin) { tmin = t; face = i; }
    } else if (t < tmax) {                 // leaving
      tmax = t;
    }
    if (tmin > tmax) return null;
  }
  // face < 0: the origin was already inside
  return { t: tmin, face, n: face < 0 ? null : solid.planes[face], inside: face < 0 };
}

/** Depth and way out of a capsule inside the solid (separating axis over the
 *  face normals), or null. */
export function capsulePush(ax, ay, az, bx, by, bz, radius, solid) {
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

/** Move a built solid without rebuilding it (moving platforms). */
export function translateSolid(s, dx, dy, dz) {
  for (const v of s.verts) { v[0] += dx; v[1] += dy; v[2] += dz; }
  for (const p of s.planes) p.d += p.nx * dx + p.ny * dy + p.nz * dz;
  s.min.x += dx; s.min.y += dy; s.min.z += dz;
  s.max.x += dx; s.max.y += dy; s.max.z += dz;
  s.centre.x += dx; s.centre.y += dy; s.centre.z += dz;
  return s;
}
