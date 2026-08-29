import * as THREE from 'three';

// Everything in the arena is an axis-aligned box, which keeps collision and
// hitscan trivial and identical on every peer (the layout is hard-coded, so
// there is nothing to synchronise).

// Everything is laid out at S times the original distances. Heights and
// player-scale props (crates, stair rises, wall thickness) deliberately do not
// scale: a 4m crate would be unclimbable and a 1m step unwalkable. So the map
// gets twice as big to cross without any of it becoming twice as tall.
const S = 2;
const ARENA = 60 * S;  // floor is ARENA x ARENA, centred on the origin
const WALL_H = 9;
const STEP = 0.5;      // stair rise — must stay <= Player.stepHeight

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
    this.boxes = [];       // {min:{x,y,z}, max:{x,y,z}}
    this.spawns = [];
    this.level = null;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.setLevel(level);
  }

  setLevel(level) {
    this.level = level || null;
    this.boxes = [];
    this.spawns = [];
    if (this.level) {
      this.boxes = this.level.worldBoxes();
      this.spawns = this.level.spawnPoints(this.boxes);
    } else {
      this._build();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        this.spawns.push({ x: Math.cos(a) * 24 * S, y: 0.05, z: Math.sin(a) * 24 * S });
      }
    }
    this.refresh();
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
    this.boxes = this.level.worldBoxes();
    this.spawns = this.level.spawnPoints(this.boxes);
    this.refresh();
  }

  /** cx/cz = centre, y = bottom */
  add(cx, y, cz, w, h, d, color) {
    const b = {
      min: { x: cx - w / 2, y, z: cz - d / 2 },
      max: { x: cx + w / 2, y: y + h, z: cz + d / 2 },
      color
    };
    this.boxes.push(b);
    return b;
  }

  // a flight of stairs from ground up to `height`, facing +dir along an axis
  stairs(cx, cz, width, height, axis, dir, color) {
    const n = Math.round(height / STEP);
    for (let i = 0; i < n; i++) {
      const off = (i + 0.5) * STEP * 2 * dir;
      const x = axis === 'x' ? cx + off : cx;
      const z = axis === 'z' ? cz + off : cz;
      const w = axis === 'x' ? STEP * 2 : width;
      const d = axis === 'z' ? STEP * 2 : width;
      this.add(x, 0, z, w, (n - i) * STEP, d, color);
    }
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
    this.stairs(7 * S, 0, 6 * S, 2.5, 'x', 1, PALETTE.block);
    this.stairs(-7 * S, 0, 6 * S, 2.5, 'x', -1, PALETTE.block);
    this.stairs(0, 7 * S, 6 * S, 2.5, 'z', 1, PALETTE.block);
    this.stairs(0, -7 * S, 6 * S, 2.5, 'z', -1, PALETTE.block);

    // ---- four corner bunkers, open on the inward diagonal ----
    // The perch occupies x,z in [42,52] (mirrored per corner); the stair flight
    // and the crate are deliberately kept out of that footprint so nobody ever
    // ends up walking into a low gap under the roof.
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = sx * 20 * S, cz = sz * 20 * S;
      this.add(cx, 0, cz - sz * 5 * S, 12 * S, 3.2, 1, PALETTE.block);   // inner wall
      this.add(cx - sx * 5 * S, 0, cz, 1, 3.2, 12 * S, PALETTE.block);   // inner wall
      this.add(cx + sx * 3.5 * S, 3.0, cz + sz * 3.5 * S, 5 * S, 0.4, 5 * S, PALETTE.plate);
      this.stairs(cx - sx * 1 * S, cz + sz * 5 * S, 3, 3.0, 'z', -sz, PALETTE.block);
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
    for (const b of this.boxes) {
      if (!byColor.has(b.color)) byColor.set(b.color, []);
      byColor.get(b.color).push(b);
    }
    // one merged BufferGeometry per colour keeps the draw-call count in single digits
    for (const [color, list] of byColor) {
      const positions = [];
      const normals = [];
      const uvs = [];
      for (const b of list) {
        const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
        pushBox(positions, normals, uvs,
          b.min.x + sx / 2, b.min.y + sy / 2, b.min.z + sz / 2, sx, sy, sz);
      }
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
