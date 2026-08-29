import * as THREE from 'three';
import {
  HALF_W, HALF_H, faceOf, fitPortal, overlapsPartner, assignHues, SOLO_PAIR
} from './portal.js';

// Everything you can see about a portal, and the ball that puts one there.
// The arithmetic is all in portal.js, which is why that file can be tested
// without a browser; this one is the three.js half plus the bookkeeping of who
// owns which pair.

const BALL_SPEED = 78;        // fast enough to read as a shot, not a lob
const BALL_RANGE = 220;       // beyond this it simply fizzles out
const BALL_R = 0.09;          // "a perfect small ball"
const BALL_STEP = 1.2;        // metres per collision query along its flight
const SPIN = 1.7;             // radians a second the ring turns, so it reads as live

export class PortalField {
  constructor(scene, effects) {
    this.scene = scene;
    this.effects = effects;
    this.pairs = new Map();      // ownerId -> {a, b}
    this.colors = new Map();     // ownerId -> {a, b} as 0xrrggbb
    this.balls = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.selfId = 'me';
    this._links = [];            // rebuilt only when a portal changes, see links()
    // one random number, announced once, never re-rolled: it is this page's
    // contribution to everybody's colours and it changes on every refresh
    this.myRandom = Math.random();
    this.colors.set(this.selfId, { ...SOLO_PAIR });
    this.onPlaced = null;        // the game hooks this to broadcast
  }

  // ------------------------------------------------------------------ colours
  /** Recompute everyone's colours from the announcements in hand. Every peer
   *  runs this over the same set and reaches the same answer, so nobody has to
   *  be in charge of handing colours out. */
  recolour(entries) {
    const hues = assignHues(entries);
    this.colors = new Map();
    for (const [id, pair] of hues) this.colors.set(id, pair);
    if (!this.colors.has(this.selfId)) this.colors.set(this.selfId, { ...SOLO_PAIR });
    for (const [owner, pair] of this.pairs) {
      for (const side of ['a', 'b']) {
        if (pair[side]) this._paint(pair[side], this.colorFor(owner, side));
      }
    }
  }

  /** Adopt the real network id once there is one, keeping whatever is already
   *  on the walls. Before connecting the local player is simply called 'me'. */
  setSelfId(id) {
    const next = id || 'me';
    if (next === this.selfId) return;
    const pair = this.pairs.get(this.selfId);
    const color = this.colors.get(this.selfId);
    this.pairs.delete(this.selfId);
    this.colors.delete(this.selfId);
    if (pair) {
      this.pairs.set(next, pair);
      for (const side of ['a', 'b']) if (pair[side]) pair[side].owner = next;
    }
    if (color) this.colors.set(next, color);
    this.selfId = next;
  }

  colorFor(owner, side) {
    const c = this.colors.get(owner) || SOLO_PAIR;
    return side === 'b' ? c.b : c.a;
  }

  myColors() { return this.colors.get(this.selfId) || SOLO_PAIR; }

  // -------------------------------------------------------------------- shots
  /** A portal shot: a small ball, no gravity, perfect aim.
   *
   *  `ghost` is a peer's ball, which is there to be watched and nothing else —
   *  where their portal ended up is their machine's business and arrives as its
   *  own message. Letting two machines both decide would let them disagree. */
  fire(owner, origin, dir, side, ghost = false) {
    const color = this.colorFor(owner, side);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 12, 8),
      new THREE.MeshBasicMaterial({ color })
    );
    mesh.position.set(origin.x, origin.y, origin.z);
    const glow = new THREE.PointLight(color, 3, 6);
    mesh.add(glow);
    this.group.add(mesh);
    // it leaves along the aim line from the eye, so it lands exactly on the
    // crosshair; hidden for the first stride so it looks like it left the gun
    // rather than the player's face
    mesh.visible = false;
    this.balls.push({
      owner, side, mesh, color, ghost,
      pos: { x: origin.x, y: origin.y, z: origin.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
      travelled: 0
    });
  }

  /** Advance every ball and settle what it hits. Called once a frame with the
   *  world, because a ball is the only thing here that has to ask about level
   *  geometry. */
  update(dt, world) {
    this._rideMovers(world);
    for (const p of this._all()) {
      p.spin += SPIN * dt;
      if (p.ring) p.ring.rotation.z = p.spin;
    }

    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      let left = BALL_SPEED * dt;
      let done = false;
      while (left > 0 && !done) {
        const seg = Math.min(BALL_STEP, left);
        const hit = world.pick(b.pos, b.dir, seg);
        if (hit) {
          this._land(b, hit);
          done = true;
          break;
        }
        b.pos.x += b.dir.x * seg;
        b.pos.y += b.dir.y * seg;
        b.pos.z += b.dir.z * seg;
        b.travelled += seg;
        left -= seg;
        if (b.travelled > BALL_RANGE) { done = true; this._fizzle(b); }
      }
      if (done) { this._dropBall(i); continue; }
      b.mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
      if (b.travelled > 0.7) b.mesh.visible = true;
    }
  }

  /** A portal placed on a moving platform rides with it — mouth, mesh and all.
   *  The platform's own frame delta is the whole of it, which is why world.js
   *  bothers to record one. */
  _rideMovers(world) {
    if (!world.movers || !world.movers.length) return;
    for (const p of this._all()) {
      if (p.mover === undefined || p.mover < 0) continue;
      const m = world.movers[p.mover];
      if (!m) continue;
      p.c.x += m.delta.x; p.c.y += m.delta.y; p.c.z += m.delta.z;
      this._placeMesh(p);
    }
  }

  _land(ball, hit) {
    if (ball.ghost) { this.effects?.impact(hit.point, ball.dir); return; }
    const face = faceOf(hit);
    const fitted = face && fitPortal(face, hit.point, ball.dir);
    const mine = this.pairs.get(ball.owner);
    const partner = mine && mine[ball.side === 'a' ? 'b' : 'a'];
    if (!fitted || (partner && overlapsPartner(fitted, partner))) {
      this._explode(hit.point || ball.pos, ball.color);
      return;
    }
    const mover = hit.solid ? (hit.solid.mover ?? -1) : (hit.box?.mover ?? -1);
    const portal = this.place(ball.owner, ball.side, {
      c: fitted.c, n: fitted.n, u: fitted.u, v: fitted.v, mover
    });
    if (ball.owner === this.selfId) this.onPlaced?.(ball.side, portal);
  }

  _fizzle(ball) { this._explode(ball.pos, ball.color); }

  /** "It should just explode and disappear." A flash and a bang, no portal. */
  _explode(point, color) {
    this.effects?.burst?.(point, color);
  }

  _dropBall(i) {
    const b = this.balls[i];
    this.group.remove(b.mesh);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
    this.balls.splice(i, 1);
  }

  // ------------------------------------------------------------------ portals
  /** Put a portal down, replacing that owner's previous one of the same colour.
   *  One pair per person is the whole rule, and it lives here. */
  place(owner, side, spec) {
    let pair = this.pairs.get(owner);
    if (!pair) { pair = { a: null, b: null }; this.pairs.set(owner, pair); }
    if (pair[side]) this._dispose(pair[side]);

    const color = this.colorFor(owner, side);
    const portal = {
      owner, side, color, spin: 0,
      c: { ...spec.c }, n: { ...spec.n }, u: { ...spec.u }, v: { ...spec.v },
      mover: spec.mover ?? -1
    };
    this._build(portal);
    pair[side] = portal;
    this._relink();
    return portal;
  }

  /** Every complete pair, in both directions. This is what the player walks
   *  into: anyone's portals work for anyone, which is what makes the colours
   *  worth telling apart in the first place.
   *
   *  Cached, because the caller is _moveStep(): at hop speed that is eight
   *  sub-steps a frame, and rebuilding the list each time allocated some five
   *  hundred throwaway arrays a second to answer a question whose answer only
   *  changes when somebody fires. */
  links() { return this._links; }

  _relink() {
    this._links = [];
    for (const pair of this.pairs.values()) {
      if (!pair.a || !pair.b) continue;
      this._links.push({ from: pair.a, to: pair.b }, { from: pair.b, to: pair.a });
    }
  }

  forget(owner) {
    const pair = this.pairs.get(owner);
    if (!pair) return;
    for (const side of ['a', 'b']) if (pair[side]) this._dispose(pair[side]);
    this.pairs.delete(owner);
    this._relink();
  }

  clear() {
    for (const owner of [...this.pairs.keys()]) this.forget(owner);
    for (let i = this.balls.length - 1; i >= 0; i--) this._dropBall(i);
  }

  _all() {
    const out = [];
    for (const pair of this.pairs.values()) {
      if (pair.a) out.push(pair.a);
      if (pair.b) out.push(pair.b);
    }
    return out;
  }

  // ------------------------------------------------------------------ meshes
  _build(p) {
    p.group = new THREE.Group();
    // the mouth: dark, so it reads as a hole rather than as a sticker
    p.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({
        color: 0x0a0f18, transparent: true, opacity: 0.82,
        side: THREE.DoubleSide, depthWrite: false
      })
    );
    p.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 48),
      new THREE.MeshBasicMaterial({
        color: p.color, transparent: true, opacity: 0.95,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
      })
    );
    p.disc.scale.set(HALF_W, HALF_H, 1);
    p.ring.scale.set(HALF_W, HALF_H, 1);
    p.disc.position.z = 0.004;
    p.ring.position.z = 0.012;
    p.group.add(p.disc);
    p.group.add(p.ring);
    p.light = new THREE.PointLight(p.color, 2.4, 7);
    p.light.position.set(0, 0, 0.4);
    p.group.add(p.light);
    p.group.renderOrder = 4;
    this.group.add(p.group);
    this._placeMesh(p);
  }

  /** Sit the mesh on the surface, turned into the portal's own frame. The basis
   *  is (u, v, n) exactly as the geometry uses it, so what is drawn and what is
   *  walked through can never drift apart. */
  _placeMesh(p) {
    if (!p.group) return;
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(p.u.x, p.u.y, p.u.z),
      new THREE.Vector3(p.v.x, p.v.y, p.v.z),
      new THREE.Vector3(p.n.x, p.n.y, p.n.z)
    );
    m.setPosition(p.c.x + p.n.x * 0.02, p.c.y + p.n.y * 0.02, p.c.z + p.n.z * 0.02);
    p.group.matrixAutoUpdate = false;
    p.group.matrix.copy(m);
    p.group.matrixWorldNeedsUpdate = true;
  }

  _paint(p, color) {
    p.color = color;
    p.ring?.material.color.setHex(color);
    if (p.light) p.light.color.setHex(color);
  }

  _dispose(p) {
    if (!p.group) return;
    this.group.remove(p.group);
    p.disc.geometry.dispose(); p.disc.material.dispose();
    p.ring.geometry.dispose(); p.ring.material.dispose();
    p.group = null;
  }
}
