import * as THREE from 'three';
import {
  HALF_W, HALF_H, faceOf, fitPortal, overlapsMouth, assignHues, SOLO_PAIR, rayPortal
} from './portal.js';

// Everything you can see about a portal, and the ball that puts one there.
// The arithmetic is all in portal.js, which is why that file can be tested
// without a browser; this one is the three.js half plus the bookkeeping of who
// owns which pair.

// Twice what it was, at the user's asking. It was fast enough to read as a shot
// rather than a lob; now it barely reads as a flight at all, which is the point
// — you look where you want a portal and it is there.
const BALL_SPEED = 156;
const BALL_RANGE = 220;       // beyond this it simply fizzles out
const BALL_R = 0.09;          // "a perfect small ball"
const BALL_STEP = 1.2;        // metres per collision query along its flight
// The ring does not turn, and must not. It is a circle scaled unevenly into an
// oval, so rotating the mesh sweeps that oval around instead of spinning a ring
// inside it: the mouth visibly changes shape, wider than tall and back again,
// once a second. A portal that is there stays exactly as it was put.

// Seeing through a portal means rendering the scene again from behind the other
// one, once per portal, per frame. That is the most expensive thing this game
// does, so it is rationed: only portals actually on screen are redrawn, at most
// this many of them, at half resolution.
const MAX_VIEWS = 4;
const VIEW_SCALE = 0.5;
const VIEW_RANGE = 90;        // metres past which a mouth is not worth redrawing

// The disc samples its view in screen space: the virtual camera rendered the
// same viewport with the same projection, so the pixel behind this fragment is
// the pixel at the same place in the target. No UV mapping is involved at all,
// which is what keeps it correct at every angle.
const VIEW_VERT = `
  varying vec4 vClip;
  void main() {
    vClip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = vClip;
  }`;
const VIEW_FRAG = `
  uniform sampler2D uView;
  uniform vec3 uFallback;
  uniform float uHasView;
  uniform vec3 uTint;
  varying vec4 vClip;
  void main() {
    if (uHasView < 0.5) { gl_FragColor = vec4(uFallback, 0.92); return; }
    vec2 uv = (vClip.xy / vClip.w) * 0.5 + 0.5;
    // Straight through, untouched — it used to be mixed 12% toward the portal's
    // own colour to say which mouth you were looking through, and that only made
    // the view look murky. The ring already says which is which.
    gl_FragColor = vec4(texture2D(uView, clamp(uv, 0.002, 0.998)).rgb, 1.0);
    // The target is written in sRGB and sampled back as linear, and a raw
    // ShaderMaterial gets none of the conversions three.js appends to its own
    // materials. Without this the mouth outputs linear values where sRGB is
    // expected and everything through it comes out at about a third of its
    // brightness — which is what "meshed black" was.
    #include <colorspace_fragment>
  }`;

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
    // Anything in here is drawn only into portal views, never into the player's
    // own camera: their own body, which they can see through a portal and must
    // not see hanging in front of their face.
    this.selfView = null;
    this._vcam = new THREE.PerspectiveCamera();
    this._vcam.matrixAutoUpdate = false;
    this._plane = new THREE.Plane();
    this._m = new THREE.Matrix4();
    this._viewSize = { w: 0, h: 0 };
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
  fire(owner, origin, dir, side, ghost = false, up = null) {
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
      // which way was up for whoever fired it, so the mouth stands the way they
      // were standing rather than the way the world is
      up: up ? { x: up.x, y: up.y, z: up.z } : null,
      travelled: 0
    });
  }

  /** Advance every ball and settle what it hits. Called once a frame with the
   *  world, because a ball is the only thing here that has to ask about level
   *  geometry. */
  update(dt, world) {
    this._rideMovers(world);

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
    const fitted = face && fitPortal(face, hit.point, ball.dir, ball.up);
    // No mouth may be laid over any other, whoever it belongs to — not the
    // shooter's own partner, and not somebody else's. The one it is replacing
    // does not count: that piece of wall is about to be free again.
    const replacing = this.pairs.get(ball.owner)?.[ball.side] || null;
    const clash = fitted && this._all().some(q => q !== replacing && overlapsMouth(fitted, q));
    if (!fitted || clash) {
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
      owner, side, color,
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

  /** The nearest mouth a ray goes through before `maxDist`, and where it comes
   *  out. A shot through a portal is the same shot, somewhere else. */
  rayHit(origin, dir, maxDist) {
    let best = null;
    for (const link of this._links) {
      const t = rayPortal(origin, dir, link.from, maxDist);
      if (t < 0) continue;
      if (!best || t < best.t) best = { t, from: link.from, to: link.to };
    }
    return best;
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

  // ------------------------------------------------------------------- views
  /** Draw what is on the other side of every portal worth drawing.
   *
   *  Looking through a portal is the scene rendered again from a camera that has
   *  been put through the portal — the player's own camera, moved by exactly the
   *  transform that moves the player. The result is sampled in screen space, so
   *  the window is correct at every angle without a UV in sight.
   *
   *  Two things make it work rather than nearly work:
   *
   *  The near plane is bent onto the exit portal's own plane. The virtual camera
   *  sits *behind* the exit — that is what looking out of it means — so without
   *  this the first thing it draws is the back of the wall the exit is on, and
   *  every portal is a picture of the inside of a wall.
   *
   *  Portals drawn inside a portal view keep the texture they had last frame.
   *  That costs one render per portal per frame instead of one per portal per
   *  level of recursion, and it is what makes a mouth facing its own partner show
   *  a corridor going away from you rather than a flat disc. It is a frame stale,
   *  which at sixty frames a second nobody has ever been able to see.
   */
  renderViews(renderer, scene, camera) {
    const all = this._all().filter(p => p.group);
    if (!all.length) return;
    this._sizeTargets(renderer);

    // only what is on screen, nearest first, and never more than the ration
    camera.updateMatrixWorld();
    this._frustum = this._frustum || new THREE.Frustum();
    this._frustum.setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const wanted = [];
    for (const p of all) {
      const partner = this._partnerOf(p);
      if (!partner) continue;
      const c = new THREE.Vector3(p.c.x, p.c.y, p.c.z);
      const d = c.distanceTo(eye);
      if (d > VIEW_RANGE) continue;
      // a sphere, so a mouth half off the edge of the screen still counts
      if (!this._frustum.intersectsSphere(new THREE.Sphere(c, HALF_H + 0.2))) continue;
      wanted.push({ p, partner, d });
    }
    if (!wanted.length) return;
    wanted.sort((a, b) => a.d - b.d);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    if (this.selfView) this.selfView.visible = true;

    for (const { p, partner } of wanted.slice(0, MAX_VIEWS)) {
      if (!p.target) p.target = this._makeTarget();
      this._aimVirtualCamera(camera, p, partner);
      // The *exit* is what has to go, not the mouth being looked through. The
      // virtual camera stands behind the far mouth looking out of it, so that
      // mouth is right against the lens: leave it in and every portal is a
      // picture of the back of its own partner. The near mouth stays, and shows
      // the texture it had last frame, which is what turns two facing portals
      // into a corridor going away from you instead of a flat disc.
      partner.group.visible = false;
      renderer.setRenderTarget(p.target);
      renderer.render(scene, this._vcam);
      partner.group.visible = true;
      p.disc.material.uniforms.uView.value = p.target.texture;
      p.disc.material.uniforms.uHasView.value = 1;
    }

    if (this.selfView) this.selfView.visible = false;
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  _partnerOf(p) {
    const pair = this.pairs.get(p.owner);
    if (!pair) return null;
    return p.side === 'a' ? pair.b : pair.a;
  }

  /** Put the camera through the portal, and bend its near plane onto the far
   *  mouth's surface so nothing between the two is drawn. */
  _aimVirtualCamera(camera, from, to) {
    const basis = (q, flip) => {
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(q.u.x, q.u.y, q.u.z).multiplyScalar(flip ? -1 : 1),
        new THREE.Vector3(q.v.x, q.v.y, q.v.z),
        new THREE.Vector3(q.n.x, q.n.y, q.n.z).multiplyScalar(flip ? -1 : 1)
      );
      m.setPosition(q.c.x, q.c.y, q.c.z);
      return m;
    };
    // Mt * flip(u, n) * Mf^-1 — the same half turn about the exit's up axis that
    // portalMap() applies to the player, written as one matrix.
    this._m.copy(basis(to, true)).multiply(basis(from, false).invert());

    const v = this._vcam;
    v.matrixWorld.multiplyMatrices(this._m, camera.matrixWorld);
    v.matrixWorldInverse.copy(v.matrixWorld).invert();
    v.projectionMatrix.copy(camera.projectionMatrix);
    v.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    v.matrixWorldNeedsUpdate = false;

    this._plane.setFromNormalAndCoplanarPoint(
      new THREE.Vector3(to.n.x, to.n.y, to.n.z),
      new THREE.Vector3(to.c.x, to.c.y, to.c.z));
    this._plane.applyMatrix4(v.matrixWorldInverse);
    obliqueNear(v.projectionMatrix, this._plane);
  }

  _makeTarget() {
    const t = new THREE.WebGLRenderTarget(
      Math.max(2, this._viewSize.w), Math.max(2, this._viewSize.h),
      { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true }
    );
    t.texture.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Keep the targets matched to the window. Resizing is rare and reallocating
   *  every frame would be absurd, so it only happens when the size really moved. */
  _sizeTargets(renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(2, Math.round(size.x * VIEW_SCALE));
    const h = Math.max(2, Math.round(size.y * VIEW_SCALE));
    if (w === this._viewSize.w && h === this._viewSize.h) return;
    this._viewSize = { w, h };
    for (const p of this._all()) if (p.target) p.target.setSize(w, h);
  }

  // ------------------------------------------------------------------ meshes
  _build(p) {
    p.group = new THREE.Group();
    // the mouth: dark, so it reads as a hole rather than as a sticker
    p.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.ShaderMaterial({
        uniforms: {
          uView: { value: null },
          uHasView: { value: 0 },
          uFallback: { value: new THREE.Color(0x0a0f18) },
          uTint: { value: new THREE.Color(p.color) }   // kept for the ring's sake
        },
        vertexShader: VIEW_VERT, fragmentShader: VIEW_FRAG,
        side: THREE.DoubleSide, depthWrite: false, transparent: true
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
    // No lamp. A mouth used to carry a coloured point light, which lit whatever
    // it was near: put one on the floor beside a wall and the wall — and you
    // standing at it — turned into a spotlight. The ring is additively blended
    // and glows on its own, so the portal still reads in a dark corner without
    // throwing light onto anything solid.
    p.group.renderOrder = 4;
    p.target = null;             // its view of the far side, made on first use
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
    p.disc?.material.uniforms.uTint.value.setHex(color);
  }

  _dispose(p) {
    if (!p.group) return;
    this.group.remove(p.group);
    p.disc.geometry.dispose(); p.disc.material.dispose();
    p.ring.geometry.dispose(); p.ring.material.dispose();
    p.target?.dispose();
    p.target = null;
    p.group = null;
  }
}

/** Bend a projection matrix's near plane onto an arbitrary plane, given in the
 *  camera's own space. Lengyel's construction: replace the third row so that the
 *  near plane and the clip plane coincide, which costs nothing at draw time and
 *  clips exactly, unlike a user clipping plane. */
function obliqueNear(projection, plane) {
  const e = projection.elements;
  const c = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  if (Math.abs(c.w) < 1e-6 && c.lengthSq() < 1e-12) return;
  const q = new THREE.Vector4(
    (Math.sign(c.x) + e[8]) / e[0],
    (Math.sign(c.y) + e[9]) / e[5],
    -1,
    (1 + e[10]) / e[14]
  );
  const denom = c.dot(q);
  if (Math.abs(denom) < 1e-9) return;      // the plane runs through the eye
  c.multiplyScalar(2 / denom);
  e[2] = c.x;
  e[6] = c.y;
  e[10] = c.z + 1;
  e[14] = c.w;
}
