import * as THREE from 'three';
import { makeSolid, rayConvex, isAxisAligned, SHAPE_BOX, SHAPE_SLOPE } from './solid.js';

// Almost everything here is an axis-aligned box, which keeps collision and
// hitscan trivial and identical on every peer. The exceptions — ramps, and
// anything the level designer has turned — go through solid.js as convex solids
// instead. Both lists are hard-coded or seeded, so there is still nothing to
// synchronise at runtime.

// Everything is laid out at S times the original distances. Heights and
// player-scale props (crates, stair rises, wall thickness) deliberately do not
// scale: a 4m crate would be unclimbable and a 1m step unwalkable. So the map
// gets twice as big to cross without any of it becoming twice as tall.
const S = 2;
const ARENA = 60 * S;  // floor is ARENA x ARENA, centred on the origin
const WALL_H = 9;
// Ramps replaced the stairs, but the pitch is still expressed as a rise per
// half-metre of run, so the climb is the same as the steps it grew out of.
const STEP = 0.5;

const PALETTE = {
  floor: 0x3d4757,
  wall: 0x4c586f,
  block: 0x616e8b,
  accent: 0xd9743b,
  accent2: 0x3aa89c,
  plate: 0x76849f
};

export class World {
  /** With no level, the hand-written arena below. With one, its data instead. */
  constructor(scene, level = null) {
    this.parts = [];       // every piece, before it is sorted into the two below
    this.boxes = [];       // {min:{x,y,z}, max:{x,y,z}} — the axis-aligned ones
    this.solids = [];      // convex solids — ramps, and anything turned
    this.spawns = [];
    this.level = null;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.setLevel(level);
  }

  setLevel(level) {
    this.level = level || null;
    this.parts = [];
    if (this.level) this.parts = this.level.worldBoxes();
    else this._build();
    this._split();
    this.spawns = [];
    if (this.level) {
      this.spawns = this.level.spawnPoints(this.boxes);
    } else {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        this.spawns.push({ x: Math.cos(a) * 24 * S, y: 0.05, z: Math.sin(a) * 24 * S });
      }
    }
    this.refresh();
  }

  /** Upright boxes keep the exact, cheap axis-aligned path; ramps and anything
   *  turned become convex solids. Nothing is in both lists. */
  _split() {
    this.boxes = [];
    this.solids = [];
    for (const p of this.parts) {
      if (isAxisAligned(p)) {
        this.boxes.push({
          min: { x: p.x0, y: p.y0, z: p.z0 },
          max: { x: p.x1, y: p.y1, z: p.z1 },
          color: p.color, src: p.src || p
        });
      } else {
        const s = makeSolid(p);
        s.src = p.src || p;
        this.solids.push(s);
      }
    }
  }

  /** Re-derive the meshes from `boxes`. Cheap enough to call on every edit. */
  refresh() {
    for (const child of this.group.children.slice()) {
      this.group.remove(child);
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
    this._mesh();
  }

  /** Pull the box list back out of the level after the designer changed it. */
  syncLevel() {
    if (!this.level) return;
    this.parts = this.level.worldBoxes();
    this._split();
    this.spawns = this.level.spawnPoints(this.boxes);
    this.refresh();
  }

  /** cx/cz = centre, y = bottom. w and d are along the part's *own* axes, which
   *  only differ from the world's once `rot` turns it. */
  add(cx, y, cz, w, h, d, color, shape = SHAPE_BOX, rot = null) {
    const b = {
      x0: cx - w / 2, y0: y, z0: cz - d / 2,
      x1: cx + w / 2, y1: y + h, z1: cz + d / 2,
      color, shape,
      rx: rot ? rot[0] : 0, ry: rot ? rot[1] : 0, rz: rot ? rot[2] : 0
    };
    this.parts.push(b);
    return b;
  }

  /** A ramp up to `height`, tall against (cx,cz) and falling away along `dir`.
   *  This was a flight of half-metre steps; the pitch is the same, so anything
   *  that could be walked up before still can, but a run up it no longer stutters
   *  and a hop chain no longer catches on the nose of every step.
   *
   *  The wedge in solid.js always climbs along its own +x, so the run is stored
   *  along local x and a turn about Y aims it. */
  slope(cx, cz, width, height, axis, dir, color) {
    const run = height * 2;                       // the old staircase's pitch
    const wx = axis === 'x' ? cx + (run / 2) * dir : cx;
    const wz = axis === 'z' ? cz + (run / 2) * dir : cz;
    const ry = axis === 'x' ? (dir > 0 ? Math.PI : 0)
                            : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    return this.add(wx, 0, wz, run, height, width, color, SHAPE_SLOPE, [0, ry, 0]);
  }

  _build() {
    const H = ARENA / 2;

    // ground + outer walls
    this.add(0, -1, 0, ARENA, 1, ARENA, PALETTE.floor);
    this.add(0, 0, -H, ARENA, WALL_H, 1, PALETTE.wall);
    this.add(0, 0, H, ARENA, WALL_H, 1, PALETTE.wall);
    this.add(-H, 0, 0, 1, WALL_H, ARENA, PALETTE.wall);
    this.add(H, 0, 0, 1, WALL_H, ARENA, PALETTE.wall);

    // ---- centre: raised platform with a stair on each side ----
    this.add(0, 0, 0, 14 * S, 2.5, 14 * S, PALETTE.plate);
    this.add(0, 2.5, 0, 3, 3.4, 3, PALETTE.accent);          // sightline breaker
    this.slope(7 * S, 0, 6 * S, 2.5, 'x', 1, PALETTE.block);
    this.slope(-7 * S, 0, 6 * S, 2.5, 'x', -1, PALETTE.block);
    this.slope(0, 7 * S, 6 * S, 2.5, 'z', 1, PALETTE.block);
    this.slope(0, -7 * S, 6 * S, 2.5, 'z', -1, PALETTE.block);

    // ---- four corner bunkers, open on the inward diagonal ----
    // The perch occupies x,z in [42,52] (mirrored per corner); the stair flight
    // and the crate are deliberately kept out of that footprint so nobody ever
    // ends up walking into a low gap under the roof.
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = sx * 20 * S, cz = sz * 20 * S;
      this.add(cx, 0, cz - sz * 5 * S, 12 * S, 3.2, 1, PALETTE.block);   // inner wall
      this.add(cx - sx * 5 * S, 0, cz, 1, 3.2, 12 * S, PALETTE.block);   // inner wall
      this.add(cx + sx * 3.5 * S, 3.0, cz + sz * 3.5 * S, 5 * S, 0.4, 5 * S, PALETTE.plate);
      this.slope(cx - sx * 1 * S, cz + sz * 5 * S, 3, 3.0, 'z', -sz, PALETTE.block);
      this.add(cx + sx * 1 * S, 0, cz - sz * 3 * S, 2, 2, 2, PALETTE.accent2);
    }

    // ---- mid-field cover: positions and lengths scale, height does not ----
    const covers = [
      [0, 22, 12, 2.4, 1], [0, -22, 12, 2.4, 1],
      [22, 0, 1, 2.4, 12], [-22, 0, 1, 2.4, 12],
      [12, 12, 6, 1.6, 1], [-12, -12, 6, 1.6, 1],
      [12, -12, 1, 1.6, 6], [-12, 12, 1, 1.6, 6]
    ];
    for (const [x, z, w, h, d] of covers) {
      this.add(x * S, 0, z * S, w > 1 ? w * S : w, h, d > 1 ? d * S : d, PALETTE.wall);
    }

    // ---- extra cover, because twice the floor needs more than twice the gaps
    // filled: long walls out in the quarters that were empty at the old size ----
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      this.add(sx * 30, 0, sz * 14, 1, 2.4, 14, PALETTE.wall);
      this.add(sx * 14, 0, sz * 30, 14, 2.4, 1, PALETTE.wall);
      this.add(sx * 34, 0, sz * 34, 2, 2, 2, PALETTE.block);
      this.add(sx * 36, 0, sz * 32, 2, 2, 2, PALETTE.block);
      this.add(sx * 35, 2, sz * 33, 2, 2, 2, PALETTE.block);
    }

    // ---- scattered crates: repositioned, but still crate-sized ----
    const crates = [
      [8, 18], [10, 20], [8.6, 19.2, 2], [-8, -18], [-10, -20], [-8.6, -19.2, 2],
      [18, -8], [20, -10], [-18, 8], [-20, 10],
      [16, 16], [-16, -16], [27, 27], [-27, -27], [27, -27], [-27, 27]
    ];
    for (const [x, z, y = 0] of crates) this.add(x * S, y, z * S, 2, 2, 2, PALETTE.block);
  }

  _mesh() {
    const byColor = new Map();
    const bucket = c => {
      if (!byColor.has(c)) byColor.set(c, { boxes: [], solids: [] });
      return byColor.get(c);
    };
    for (const b of this.boxes) bucket(b.color).boxes.push(b);
    for (const s of this.solids) bucket(s.color).solids.push(s);

    // one merged BufferGeometry per colour keeps the draw-call count in single digits
    for (const [color, list] of byColor) {
      const positions = [];
      const normals = [];
      const uvs = [];
      for (const b of list.boxes) {
        const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
        pushBox(positions, normals, uvs,
          b.min.x + sx / 2, b.min.y + sy / 2, b.min.z + sz / 2, sx, sy, sz);
      }
      for (const s of list.solids) pushSolid(positions, normals, uvs, s);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      const mat = new THREE.MeshLambertMaterial({ color });
      this.group.add(new THREE.Mesh(geo, mat));
    }

    // grid overlay on the floor so movement reads clearly
    const span = this.level ? Math.max(this.level.w, this.level.l) : ARENA;
    const grid = new THREE.GridHelper(span, Math.max(4, Math.round(span / 2)), 0x64748b, 0x3c4658);
    grid.position.y = 0.01;
    grid.material.transparent = true;
    grid.material.opacity = 0.25;
    this.group.add(grid);
  }

  randomSpawn() {
    return { ...this.spawns[(Math.random() * this.spawns.length) | 0] };
  }

  /** Distance along `dir` to the nearest box, or Infinity. */
  raycast(origin, dir, maxDist = 200) {
    let best = maxDist;
    for (const b of this.boxes) {
      const t = rayAABB(origin, dir, b.min, b.max);
      if (t < best) best = t;
    }
    for (const s of this.solids) {
      const h = rayConvex(origin, dir, s, best);
      if (h && h.t < best) best = h.t;
    }
    return best;
  }

  /** The nearest box the ray enters, and which of its faces it came in through.
   *  The level designer needs the face, not just the distance. */
  pick(origin, dir, maxDist = 400) {
    let best = null;
    for (const b of this.boxes) {
      const h = rayBoxFace(origin, dir, b.min, b.max);
      if (!h || h.t > maxDist) continue;
      if (!best || h.t < best.t) best = { box: b, t: h.t, axis: h.axis, sign: h.sign };
    }
    // A turned box or a ramp has no axis-aligned face to name, so the designer
    // gets the plane it hit instead and draws on that.
    for (const s of this.solids) {
      const h = rayConvex(origin, dir, s, maxDist);
      if (!h || h.inside || h.t > maxDist) continue;
      if (!best || h.t < best.t) {
        best = { box: s, solid: s, t: h.t, axis: -1, sign: 1, plane: h.n };
      }
    }
    if (best) {
      best.point = {
        x: origin.x + dir.x * best.t,
        y: origin.y + dir.y * best.t,
        z: origin.z + dir.z * best.t
      };
    }
    return best;
  }
}

const AXES = ['x', 'y', 'z'];

/** Slab intersection that also reports the entry face: `axis` is 0/1/2 and
 *  `sign` is -1 for the low face and +1 for the high one. Null if it misses,
 *  or if the entry point is behind the origin. */
export function rayBoxFace(ro, rd, min, max) {
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = -1;
  for (let i = 0; i < 3; i++) {
    const k = AXES[i];
    const inv = 1 / (rd[k] || 1e-9);
    let t1 = (min[k] - ro[k]) * inv;
    let t2 = (max[k] - ro[k]) * inv;
    let s = -1;                         // entering through the low face
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmax < tmin) return null;
  }
  if (tmin < 0 || tmax < 0) return null;
  return { t: tmin, axis, sign };
}

export function rayAABB(ro, rd, min, max) {
  const ix = 1 / (rd.x || 1e-9), iy = 1 / (rd.y || 1e-9), iz = 1 / (rd.z || 1e-9);
  let t1 = (min.x - ro.x) * ix, t2 = (max.x - ro.x) * ix;
  let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
  t1 = (min.y - ro.y) * iy; t2 = (max.y - ro.y) * iy;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  t1 = (min.z - ro.z) * iz; t2 = (max.z - ro.z) * iz;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  if (tmax < Math.max(tmin, 0)) return Infinity;
  return tmin >= 0 ? tmin : 0;   // 0 = ray starts inside the box
}

export function aabbOverlap(a, b) {
  return a.min.x < b.max.x && a.max.x > b.min.x &&
         a.min.y < b.max.y && a.max.y > b.min.y &&
         a.min.z < b.max.z && a.max.z > b.min.z;
}

/** Triangulate a convex solid's faces as fans, flat-shaded from the face normal. */
function pushSolid(pos, nor, uv, solid) {
  for (const f of solid.faces) {
    const [nx, ny, nz] = f.n;
    const a = solid.verts[f.idx[0]];
    for (let i = 1; i + 1 < f.idx.length; i++) {
      const b = solid.verts[f.idx[i]], c = solid.verts[f.idx[i + 1]];
      for (const v of [a, b, c]) {
        pos.push(v[0], v[1], v[2]);
        nor.push(nx, ny, nz);
      }
      // uv is only used to keep box proportions readable; a solid gets a flat one
      uv.push(0, 0, 1, 0, 1, 1);
    }
  }
}

function pushBox(pos, nor, uv, cx, cy, cz, sx, sy, sz) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  // 6 faces, each 2 triangles; uv scaled by face size so the texture-free
  // lambert shading still shows box proportions if a map is added later
  const faces = [
    [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], sz, sy],
    [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], sz, sy],
    [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], sx, sz],
    [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], sx, sz],
    [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], sx, sy],
    [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], sx, sy]
  ];
  for (const [n, quad, uw, uh] of faces) {
    const [a, b, c, d] = quad;
    for (const [p, u, v] of [[a, 0, 0], [b, uw, 0], [c, uw, uh], [a, 0, 0], [c, uw, uh], [d, 0, uh]]) {
      pos.push(cx + p[0], cy + p[1], cz + p[2]);
      nor.push(n[0], n[1], n[2]);
      uv.push(u, v);
    }
  }
}
