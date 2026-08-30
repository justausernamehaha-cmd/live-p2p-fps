import * as THREE from 'three';
import { makeSolid, rayConvex, isAxisAligned, translateSolid, SHAPE_BOX, SHAPE_SLOPE } from './solid.js';

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
// The room is closed, so this is its height and not merely how tall the walls
// are. Twelve rather than nine: a player standing on the centre block has their
// feet at 5.9, and a nine-metre lid put the ceiling within a jump of their head.
const WALL_H = 12;
const PALETTE = {
  floor: 0x3d4757,
  wall: 0x4c586f,
  block: 0x616e8b,
  accent: 0xd9743b,
  accent2: 0x3aa89c,
  plate: 0x76849f,
  ceil: 0x333c4d,     // darker than the walls, so up still reads as up
  fillet: 0x5a6884
};

// How far a corner fillet reaches along each of the two surfaces it joins. Big
// enough to stand on with room to turn round; small enough that it takes nothing
// worth having off the floor.
const FILLET = 1.6;

export class World {
  /** With no level, the hand-written arena below. With one, its data instead. */
  constructor(scene, level = null) {
    this.parts = [];       // every piece, before it is sorted into the two below
    this.boxes = [];       // {min:{x,y,z}, max:{x,y,z}} — the axis-aligned ones
    this.solids = [];      // convex solids — ramps, and anything turned
    this.movers = [];      // the subset of both that travels; see updateMovers()
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
    this.movers = [];
    for (const p of this.parts) {
      let shape;
      if (isAxisAligned(p)) {
        shape = {
          min: { x: p.x0, y: p.y0, z: p.z0 },
          max: { x: p.x1, y: p.y1, z: p.z1 },
          color: p.color, src: p.src || p
        };
        this.boxes.push(shape);
      } else {
        shape = makeSolid(p);
        shape.src = p.src || p;
        this.solids.push(shape);
      }
      // The order of this list is the order of `parts`, which every peer builds
      // from the same seed — so a platform's index is a name for it that needs
      // no negotiation. A portal stuck to one travels by quoting that index.
      const mv = p.mv || (p.src && p.src.mv);
      if (mv && mv.sp > 0) {
        const p0 = centreOf(shape);
        const dist = Math.hypot(mv.x - p0.x, mv.y - p0.y, mv.z - p0.z);
        if (dist > 1e-4) {
          shape.mover = this.movers.length;
          this.movers.push({
            index: this.movers.length, shape, src: p.src || p,
            p0, p1: { x: mv.x, y: mv.y, z: mv.z },
            sp: mv.sp, dist, at: 0, dir: 1,
            delta: { x: 0, y: 0, z: 0 },     // how far it moved this frame
            vel: { x: 0, y: 0, z: 0 },       // ...and how fast, which a portal on
            mesh: null                        // it hands to whatever comes out
          });
        }
      }
    }
  }

  /** Walk every platform along its run and drag its collision shape with it.
   *
   *  A moving platform is the first thing in this game that breaks the standing
   *  assumption that world geometry never changes, so it is deliberately the
   *  smallest possible break: the shape is *translated*, never rebuilt, and
   *  `delta` records what it moved this frame so a player standing on top and a
   *  portal stuck to its face can both be carried by exactly the same amount. */
  updateMovers(dt) {
    if (!this.movers.length) return;
    for (const m of this.movers) {
      m.at += (m.sp / m.dist) * m.dir * dt;
      // ping-pong: reflect off each end rather than wrapping, so it comes back
      while (m.at > 1 || m.at < 0) {
        if (m.at > 1) { m.at = 2 - m.at; m.dir = -1; }
        if (m.at < 0) { m.at = -m.at; m.dir = 1; }
      }
      const want = {
        x: m.p0.x + (m.p1.x - m.p0.x) * m.at,
        y: m.p0.y + (m.p1.y - m.p0.y) * m.at,
        z: m.p0.z + (m.p1.z - m.p0.z) * m.at
      };
      const at = centreOf(m.shape);
      const dx = want.x - at.x, dy = want.y - at.y, dz = want.z - at.z;
      m.delta.x = dx; m.delta.y = dy; m.delta.z = dz;
      if (dt > 1e-6) { m.vel.x = dx / dt; m.vel.y = dy / dt; m.vel.z = dz / dt; }
      if (m.shape.planes) translateSolid(m.shape, dx, dy, dz);
      else {
        m.shape.min.x += dx; m.shape.min.y += dy; m.shape.min.z += dz;
        m.shape.max.x += dx; m.shape.max.y += dy; m.shape.max.z += dz;
      }
      if (m.mesh) {
        m.mesh.position.set(want.x - m.bake.x, want.y - m.bake.y, want.z - m.bake.z);
      }
    }
  }

  /** The platform a player is standing on, if any. Their feet have to be within
   *  a hand's breadth of its top and inside its footprint — the same test for a
   *  ramp uses its bounding box, which is close enough to carry someone. */
  moverUnder(pos, radius = 0.17) {
    for (const m of this.movers) {
      const s = m.shape;
      const min = s.min, max = s.max;
      if (pos.x + radius < min.x || pos.x - radius > max.x) continue;
      if (pos.z + radius < min.z || pos.z - radius > max.z) continue;
      if (pos.y > max.y + 0.12 || pos.y < max.y - 0.4) continue;
      return m;
    }
    return null;
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

  /** The piece of world a portal's mouth is lying on.
   *
   *  Collision has to be able to take exactly that piece away while somebody is
   *  standing in the mouth — a portal is a hole, and a body half through one is
   *  inside the wall. Nothing records which box a portal was shot at (a peer's
   *  portal arrives as four vectors and nothing else), so it is found from the
   *  geometry: the surface whose face the centre is lying on, facing the way the
   *  mouth faces. Cached on the portal, and a portal is rebuilt whenever it
   *  moves, so the cache cannot go stale. */
  hostFor(portal) {
    if (portal._host !== undefined) return portal._host;
    portal._host = this._findHost(portal.c, portal.n) || null;
    return portal._host;
  }

  _findHost(c, n) {
    const EPS = 3e-3;
    // axis-aligned mouths are the common case, and are exact
    const k = Math.abs(n.x) > 0.999 ? 'x' : Math.abs(n.y) > 0.999 ? 'y'
            : Math.abs(n.z) > 0.999 ? 'z' : null;
    if (k) {
      const sign = n[k] > 0 ? 1 : -1;
      const others = ['x', 'y', 'z'].filter(a => a !== k);
      for (const b of this.boxes) {
        const face = sign > 0 ? b.max[k] : b.min[k];
        if (Math.abs(face - c[k]) > EPS) continue;
        if (others.some(a => c[a] < b.min[a] - EPS || c[a] > b.max[a] + EPS)) continue;
        return b;
      }
    }
    for (const s of this.solids) {
      for (const pl of s.planes) {
        if (pl.nx * n.x + pl.ny * n.y + pl.nz * n.z < 0.999) continue;
        if (Math.abs(pl.nx * c.x + pl.ny * c.y + pl.nz * c.z - pl.d) > EPS) continue;
        return s;
      }
    }
    return null;
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
   *
   *  Every slope in this map is 45 degrees — run equals rise, with no exceptions
   *  — because a slope is now the thing that decides which way is up for whoever
   *  is standing on it, and 45 is the one pitch that belongs equally to the two
   *  surfaces it joins. (It began as a flight of half-metre steps, then a gentler
   *  ramp at the same pitch as those steps.)
   *
   *  `y` is the bottom, and `flip` turns the wedge over so the sloped face is
   *  underneath it — which is what a fillet under a ceiling is.
   *
   *  The wedge in solid.js always climbs along its own +x, so the run is stored
   *  along local x and a turn about Y aims it; the extents are in the wedge's own
   *  frame, not the world's. */
  slope(cx, cz, width, height, axis, dir, color, y = 0, flip = false) {
    const run = height;                           // 45 degrees, always
    const wx = axis === 'x' ? cx + (run / 2) * dir : cx;
    const wz = axis === 'z' ? cz + (run / 2) * dir : cz;
    const ry = axis === 'x' ? (dir > 0 ? Math.PI : 0)
                            : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    return this.add(wx, y, wz, run, height, width, color, SHAPE_SLOPE,
                    [0, ry, flip ? Math.PI : 0]);
  }

  /** Fillet every inside corner of the room, floor and ceiling alike.
   *
   *  Not decoration. Gravity follows a player through a portal, so somebody can
   *  be standing on a wall — and for them a right-angled corner is a dead end,
   *  because there is no surface between the wall and the floor that either of
   *  them can walk on. A 45-degree face belongs to both, and standing on one is
   *  what turns you back the right way up: see Player._groundUp. */
  _fillets(inner, color) {
    const F = FILLET, top = WALL_H - FILLET;
    const runs = [
      [-inner, 0, ARENA, 'x', 1], [inner, 0, ARENA, 'x', -1],
      [0, -inner, ARENA, 'z', 1], [0, inner, ARENA, 'z', -1]
    ];
    for (const [cx, cz, width, axis, dir] of runs) {
      this.slope(cx, cz, width, F, axis, dir, color);
      this.slope(cx, cz, width, F, axis, dir, color, top, true);
    }
  }

  _build() {
    const H = ARENA / 2;

    // ground, outer walls, and a roof over the lot
    this.add(0, -1, 0, ARENA, 1, ARENA, PALETTE.floor);
    this.add(0, 0, -H, ARENA, WALL_H, 1, PALETTE.wall);
    this.add(0, 0, H, ARENA, WALL_H, 1, PALETTE.wall);
    this.add(-H, 0, 0, 1, WALL_H, ARENA, PALETTE.wall);
    this.add(H, 0, 0, 1, WALL_H, ARENA, PALETTE.wall);
    // The room is closed now. It is a surface to put a portal on more than it is
    // a lid: twelve metres is far above anything that can be jumped to, so
    // nothing that could be reached before has become unreachable.
    this.add(0, WALL_H, 0, ARENA, 1, ARENA, PALETTE.ceil);
    this._fillets(H - 0.5, PALETTE.fillet);

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

    // ---- moving platforms ----
    // Placed where they are worth riding rather than where they are easiest to
    // put: two lifts that reach somewhere you otherwise have to walk round to,
    // and two shuttles high enough to cross the map on. Each starts flush with
    // whatever is under it, so nothing here is a 0.5 m crawlspace that
    // test/map.mjs would rightly call a trap.
    const lift = this.add(36, 0, 47, 4, 0.5, 4, PALETTE.accent);
    lift.mv = { x: 36, y: 3.75, z: 47, sp: 2.2 };         // up to the bunker roof

    const tower = this.add(0, 0, -50, 5, 0.5, 5, PALETTE.accent);
    tower.mv = { x: 0, y: 5.75, z: -50, sp: 2.6 };        // a long way up, and back

    // The two shuttles run along the floor rather than overhead. Up at four
    // metres there was no way onto them — a jump is worth 1.4 m — and anything
    // low enough to climb onto is also low enough to trap someone underneath.
    // On the ground there is nothing to be under, and you board one by walking.
    // Routes chosen by sweeping each one along its whole run against every
    // static box in the arena, not by eye: at head height these two flew over
    // the cover, and on the floor they drove straight through it.
    const shuttle = this.add(-30, 0, 56, 8, 0.5, 4, PALETTE.accent2);
    shuttle.mv = { x: 30, y: 0.25, z: 56, sp: 5 };        // along the north edge

    const crossing = this.add(56, 0, -30, 4, 0.5, 8, PALETTE.accent2);
    crossing.mv = { x: 56, y: 0.25, z: 30, sp: 4.5 };     // and up the east one

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
    // A platform cannot be merged in with everything else its colour: the merge
    // is what makes the level one draw call, and one draw call cannot have a
    // piece of itself walk off. Each gets its own mesh and its own transform,
    // which is a handful of extra calls for a handful of platforms.
    for (const b of this.boxes) if (b.mover === undefined) bucket(b.color).boxes.push(b);
    for (const s of this.solids) if (s.mover === undefined) bucket(s.color).solids.push(s);
    for (const m of this.movers) m.mesh = this._moverMesh(m);

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

  /** One platform, drawn at its own starting place and moved by its transform.
   *  The geometry is baked in world coordinates exactly like the merged mesh, so
   *  `position` is the offset from where it began rather than where it is. */
  _moverMesh(m) {
    const positions = [], normals = [], uvs = [];
    const s = m.shape;
    if (s.planes) pushSolid(positions, normals, uvs, s);
    else {
      const sx = s.max.x - s.min.x, sy = s.max.y - s.min.y, sz = s.max.z - s.min.z;
      pushBox(positions, normals, uvs,
        s.min.x + sx / 2, s.min.y + sy / 2, s.min.z + sz / 2, sx, sy, sz);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: s.color }));
    // the geometry was baked wherever the shape currently is, which after a
    // reload is not necessarily the start of its run
    m.bake = centreOf(s);
    mesh.position.set(0, 0, 0);
    this.group.add(mesh);
    return mesh;
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
        // `face` is what a portal needs: the plane alone says which way the
        // surface points, not where its edges are.
        best = { box: s, solid: s, t: h.t, axis: -1, sign: 1, plane: h.n, face: h.face };
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

/** The middle of either kind of shape. A solid keeps its own pivot; a box is
 *  halfway between its corners. Both agree with Level.centreOf(), which is what
 *  makes a platform's run mean the same thing in the designer and in the world. */
export function centreOf(shape) {
  if (shape.centre) return { x: shape.centre.x, y: shape.centre.y, z: shape.centre.z };
  return {
    x: (shape.min.x + shape.max.x) / 2,
    y: (shape.min.y + shape.max.y) / 2,
    z: (shape.min.z + shape.max.z) / 2
  };
}

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
