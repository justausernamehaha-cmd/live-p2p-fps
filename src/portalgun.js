import * as THREE from 'three';
import {
  HALF_W, HALF_H, faceOf, fitPortal, overlapsMouth, assignHues, SOLO_PAIR, rayPortal
} from './portal.js';
import { eraseMaterial } from './erase.js';

// The visible half of portals (the arithmetic is in portal.js): the balls, the
// mouths, the views through them, and who owns which pair.

const BALL_SPEED = 156;
const BALL_RANGE = 220;
const BALL_R = 0.09;
const BALL_STEP = 1.2;        // metres per collision query along its flight
// The mouth mesh must never rotate: it is a circle scaled into an oval, so
// spinning it visibly changes the oval's shape.

// Seeing through a portal re-renders the scene, so it is rationed: on-screen
// mouths only, nearest first, at most MAX_VIEWS, at half resolution.
const MAX_VIEWS = 4;
const VIEW_SCALE = 0.5;
const VIEW_RANGE = 90;

// The virtual camera renders the same viewport and projection, so the disc
// samples its view in screen space and needs no UVs.
// The includes are the places eraseMaterial() patches, so White Out paints over
// a mouth like any other surface.
const VIEW_VERT = `
  #include <common>
  varying vec4 vClip;
  void main() {
    vec3 transformed = position;
    #include <project_vertex>
    vClip = gl_Position;
  }`;
const VIEW_FRAG = `
  #include <common>
  uniform sampler2D uView;
  uniform vec3 uFallback;
  uniform float uHasView;
  varying vec4 vClip;
  void main() {
    gl_FragColor = vec4(uFallback, 0.92);
    if (uHasView > 0.5) {
      vec2 uv = (vClip.xy / vClip.w) * 0.5 + 0.5;
      gl_FragColor = vec4(texture2D(uView, clamp(uv, 0.002, 0.998)).rgb, 1.0);
      // a raw ShaderMaterial gets no colour-space conversion; without this the view
      // comes out at a third of its brightness
      #include <colorspace_fragment>
    }
    #include <fog_fragment>
  }`;

export class PortalField {
  constructor(scene, effects, world = null) {
    this.scene = scene;
    this.effects = effects;
    this.world = world;          // for the White Out a mouth is painted with
    this.pairs = new Map();      // ownerId -> {a, b}
    this.colors = new Map();     // ownerId -> {a, b} as 0xrrggbb
    this.balls = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.selfId = 'me';          // until there is a network id
    this._links = [];            // rebuilt only when a portal changes
    // this page's contribution to everybody's colours, new on every refresh
    this.myRandom = Math.random();
    this.colors.set(this.selfId, { ...SOLO_PAIR });
    this.onPlaced = null;        // the game broadcasts from here
    this.selfView = null;        // drawn only into portal views: your own body
    this._vcam = new THREE.PerspectiveCamera();
    this._vcam.matrixAutoUpdate = false;
    this._plane = new THREE.Plane();
    this._m = new THREE.Matrix4();
    this._viewSize = { w: 0, h: 0 };
  }

  // ------------------------------------------------------------------ colours
  /** Every peer runs this over the same announcements and gets the same colours. */
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

  /** Adopt the network id, keeping whatever is already on the walls. */
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
  /** A portal ball. A `ghost` ball is a peer's, only for show: where their portal
   *  lands arrives as its own message, so two machines never both decide. */
  fire(owner, origin, dir, side, ghost = false, up = null) {
    const color = this.colorFor(owner, side);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 12, 8),
      new THREE.MeshBasicMaterial({ color })
    );
    mesh.position.set(origin.x, origin.y, origin.z);
    mesh.add(new THREE.PointLight(color, 3, 6));
    this.group.add(mesh);
    // leaves from the eye so it lands on the crosshair; hidden for its first stride
    mesh.visible = false;
    this.balls.push({
      owner, side, mesh, color, ghost,
      pos: { x: origin.x, y: origin.y, z: origin.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
      up: up ? { x: up.x, y: up.y, z: up.z } : null,   // the shooter's up orients the mouth
      travelled: 0
    });
  }

  /** Advance balls and settle what they hit. */
  update(dt, world) {
    this._rideMovers(world);

    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      let left = BALL_SPEED * dt;
      let done = false;
      while (left > 0 && !done) {
        const seg = Math.min(BALL_STEP, left);
        const hit = world.pick(b.pos, b.dir, seg, true);   // through White Out holes
        if (hit) {
          this._land(b, hit, world);
          done = true;
          break;
        }
        b.pos.x += b.dir.x * seg;
        b.pos.y += b.dir.y * seg;
        b.pos.z += b.dir.z * seg;
        b.travelled += seg;
        left -= seg;
        if (b.travelled > BALL_RANGE) { done = true; this.effects?.burst?.(b.pos, b.color); }
      }
      if (done) { this._dropBall(i); continue; }
      b.mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
      if (b.travelled > 0.7) b.mesh.visible = true;
    }
  }

  /** A portal on a moving platform rides with it by the platform's frame delta. */
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

  _land(ball, hit, world) {
    if (ball.ghost) { this.effects?.impact(hit.point, ball.dir); return; }
    const explode = () => this.effects?.burst?.(hit.point || ball.pos, ball.color);
    if (hit.erased) { explode(); return; }        // the curved inside of a hole
    const face = faceOf(hit);
    const fitted = face && fitPortal(face, hit.point, ball.dir, ball.up);
    const mover = hit.solid ? (hit.solid.mover ?? -1) : (hit.box?.mover ?? -1);
    // no mouth over any other (except the one this replaces), and none on White Out
    const replacing = this.pairs.get(ball.owner)?.[ball.side] || null;
    const clash = fitted && (this._all().some(q => q !== replacing && overlapsMouth(fitted, q)) ||
      world.eraseCoversOval({ ...fitted, mover }, HALF_W, HALF_H));
    if (!fitted || clash) { explode(); return; }
    const portal = this.place(ball.owner, ball.side, {
      c: fitted.c, n: fitted.n, u: fitted.u, v: fitted.v, mover
    });
    if (ball.owner === this.selfId) this.onPlaced?.(ball.side, portal);
  }

  _dropBall(i) {
    const b = this.balls[i];
    this.group.remove(b.mesh);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
    this.balls.splice(i, 1);
  }

  // ------------------------------------------------------------------ portals
  /** Place a portal, replacing that owner's previous one of the same side. */
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

  /** Every complete pair, both directions. Anyone's portals work for anyone.
   *  Cached: the player asks several times per frame. */
  links() { return this._links; }

  _relink() {
    this._links = [];
    for (const pair of this.pairs.values()) {
      if (!pair.a || !pair.b) continue;
      this._links.push({ from: pair.a, to: pair.b }, { from: pair.b, to: pair.a });
    }
  }

  /** The nearest mouth a ray enters before maxDist, and its partner. */
  rayHit(origin, dir, maxDist) {
    let best = null;
    for (const link of this._links) {
      const t = rayPortal(origin, dir, link.from, maxDist);
      if (t < 0) continue;
      if (!best || t < best.t) best = { t, from: link.from, to: link.to };
    }
    return best;
  }

  /** Take one mouth away (White Out erased it). */
  remove(owner, side) {
    const p = this.pairs.get(owner)?.[side];
    if (!p) return false;
    this.effects?.burst?.(p.c, p.color);
    this._dispose(p);
    this.pairs.get(owner)[side] = null;
    this._relink();
    return true;
  }

  /** Remove every mouth `gone(portal)` says is erased; returns [owner, side] for
   *  each, which is what the peers are told. */
  erase(gone) {
    const out = [];
    for (const p of this._all()) if (gone(p)) out.push([p.owner, p.side]);
    for (const [owner, side] of out) this.remove(owner, side);
    return out;
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
  /** Render what is behind every mouth worth drawing, from the player's camera
   *  moved through the portal. The near plane is bent onto the exit's plane, and
   *  the EXIT is hidden (the virtual camera stands right behind it). Mouths seen
   *  inside a view keep last frame's texture, which gives the corridor effect. */
  renderViews(renderer, scene, camera) {
    const all = this._all().filter(p => p.group);
    if (!all.length) return;
    this._sizeTargets(renderer);

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
      partner.group.visible = false;
      // Through the mouth you are standing in, the view is from your own eye
      // moved through: your body out of the far mouth is first person there, and
      // first person never draws itself (it was your own back and gun).
      if (this.selfView) this.selfView.visible = p !== this.selfMouth;
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
    // Mt * flip(u, n) * Mf^-1: the same transform portalMap() applies to the player
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
    p.disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.ShaderMaterial({
        uniforms: {
          uView: { value: null },
          uHasView: { value: 0 },
          uFallback: { value: new THREE.Color(0x0a0f18) }
        },
        vertexShader: VIEW_VERT, fragmentShader: VIEW_FRAG,
        side: THREE.DoubleSide, depthWrite: false, transparent: true
      })
    );
    // additive ring glows on its own; no light, which would spotlight the wall
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
    // The ring is always drawn after the disc. Left to the depth sort it went
    // first whenever the camera faced away from the wall with the mouth still at
    // the edge of the view (the ring, 8 mm out from the wall, is then the farther
    // of the two), and the disc painted over it.
    p.ring.renderOrder = 1;
    if (this.world) {
      const er = this.world.eraseOf(p);
      eraseMaterial(p.disc.material, er);
      eraseMaterial(p.ring.material, er);
    }
    p.group.add(p.disc);
    p.group.add(p.ring);
    p.group.renderOrder = 4;
    p.target = null;             // made on first use
    this.group.add(p.group);
    this._placeMesh(p);
  }

  /** Sit the mesh on the surface in the portal's own (u, v, n) frame. */
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

/** Bend a projection's near plane onto a camera-space plane (Lengyel). */
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
