import * as THREE from 'three';
import {
  HALF_W, HALF_H, faceOf, fitPortal, overlapsMouth, huePair, SOLO_HUE, SOLO_PAIR, rayPortal
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
// A mouth seen in a view (itself again, or anyone's) is drawn from one more trip
// through, and so on in: at most MAX_DEPTH trips and MAX_RENDERS views a frame
// in all. Each trip in is drawn DEPTH_SCALE coarser than the one before, and
// only the part of it the mouth it is seen through leaves on screen. A mouth
// with under MIN_SEEN of the screen showing, or with level in the way of every
// line to it, is not drawn at all.
const MAX_DEPTH = 6;
const MAX_RENDERS = 10;
const DEPTH_SCALE = 0.84;
const MIN_SEEN = 0.02;        // of the screen's width or height
const FULL = { x0: -1, y0: -1, x1: 1, y1: 1 };
// where on a mouth a line of sight is tried: the middle and eight round the rim
const SIGHT = [[0, 0], ...Array.from({ length: 8 }, (_, i) =>
  [0.85 * Math.cos(i * Math.PI / 4), 0.85 * Math.sin(i * Math.PI / 4)])];
const VIEW_SCALE = 0.5;
const VIEW_RANGE = 90;
const SEAT = 0.02;            // the mesh sits this far proud of its wall
const DISC_Z = 0.004, RING_Z = 0.012;
const NEAR_ZONE = 0.1;        // an eye closer to the wall than this would clip the picture
const NEAR_BACK = 0.06;       // so it is drawn this far behind the wall instead

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
    this.myHue = SOLO_HUE;       // this player's own pair; only they ever change it
    this.joinedAt = 0;           // when they started playing: later comers give way
    this.colors.set(this.selfId, { ...SOLO_PAIR });
    this.onPlaced = null;        // the game broadcasts from here
    this.selfView = null;        // your own body: both halves in portal views,
    this.selfBody = null;        // only the half out of a far mouth in your own
    this.selfGhost = null;
    this._vcam = new THREE.PerspectiveCamera();
    this._vcam.matrixAutoUpdate = false;
    this._plane = new THREE.Plane();
    this._viewSize = { w: 0, h: 0 };
  }

  // ------------------------------------------------------------------ colours
  /** Everyone wears the hue they announced; `entries` is [{id, hue}]. */
  recolour(entries) {
    this.colors = new Map();
    for (const e of entries) if (Number.isFinite(e.hue)) this.colors.set(e.id, huePair(e.hue));
    this.colors.set(this.selfId, huePair(this.myHue));
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
   *  inside a view are drawn from further through again (_view). */
  renderViews(renderer, scene, camera) {
    this._fitNear(null);       // views are drawn with every mouth on its wall
    // Your own camera is inside the body, so it draws only the other half, out
    // of the far mouth — the one you can see from where you stand.
    const self = this.selfView && this.selfBody && this.selfGhost ? this.selfView : null;
    const ghost = !!self && this.selfGhost.visible;
    this._views(renderer, scene, camera, self, ghost);
    this._fitNear(camera);
    if (!self) return;
    this.selfGhost.visible = ghost;
    this.selfBody.visible = false;
    self.visible = ghost;
  }

  /** A mouth's picture stands 2.4 cm proud of its wall, so an eye in the last
   *  4 cm before the surface has it inside the near plane and sees bare wall
   *  until the hand-over. For a mouth the eye is that close to, the picture is
   *  drawn from behind the wall instead, without a depth test, and grown about
   *  the eye so its outline on screen is still the oval's. Null puts all back. */
  _fitNear(camera) {
    const eye = camera ? camera.getWorldPosition(this._eye = this._eye || new THREE.Vector3()) : null;
    for (const p of this._all()) {
      if (!p.group) continue;
      let k = 1, lu = 0, lv = 0;
      if (eye) {
        const dx = eye.x - p.c.x, dy = eye.y - p.c.y, dz = eye.z - p.c.z;
        const d = dx * p.n.x + dy * p.n.y + dz * p.n.z;
        lu = dx * p.u.x + dy * p.u.y + dz * p.u.z;
        lv = dx * p.v.x + dy * p.v.y + dz * p.v.z;
        const su = lu / (HALF_W + 0.3), sv = lv / (HALF_H + 0.3);
        if (d > 0 && d < NEAR_ZONE && su * su + sv * sv <= 1) k = (Math.max(d, 1e-4) + NEAR_BACK) / Math.max(d, 1e-4);
      }
      const near = k !== 1;
      if (!near && !p._near) continue;
      p._near = near;
      for (const [mesh, z] of [[p.disc, DISC_Z], [p.ring, RING_Z]]) {
        mesh.position.set(near ? lu * (1 - k) : 0, near ? lv * (1 - k) : 0, near ? -(SEAT + NEAR_BACK) : z);
        mesh.scale.set(HALF_W * k, HALF_H * k, 1);
        mesh.material.depthTest = !near;
      }
    }
  }

  _views(renderer, scene, camera, self, ghost) {
    const linked = this._all().filter(p => p.group && this._partnerOf(p));
    if (!linked.length) return;
    this._sizeTargets(renderer);

    camera.updateMatrixWorld();
    const top = this._seen(linked, camera.matrixWorld, camera, null, FULL).slice(0, MAX_VIEWS);
    if (!top.length) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;        // each view clears itself, then draws its part
    if (self) self.visible = this.selfBody.visible = true;

    // every mouth on screen is owed one view; what is left goes to views in views
    this._spare = MAX_RENDERS - top.length;
    this._pooled = [];
    this.renders = 0;
    const draw = { renderer, scene, camera, linked, self, ghost };
    for (const { p, rect } of top) {
      if (!p.target) p.target = this._makeTarget();
      this._view(draw, p, camera.matrixWorld, 1, p.target, rect);
    }
    // on screen each mouth shows its own picture; one not drawn this frame
    // (too many on screen) keeps the last it had
    for (const p of linked) {
      const u = p.disc.material.uniforms;
      u.uView.value = p.target ? p.target.texture : null;
      u.uHasView.value = p.target ? 1 : 0;
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  /** Draw what is through `p` for a camera at `world` into `into`. Every mouth
   *  that can be seen in that picture — this one again, its owner's or anyone
   *  else's — is first drawn from the camera carried on through it, while there
   *  is depth and budget left; one that is not shows dark. An old picture there
   *  would feed itself for ever, and whatever was once in the middle of it would
   *  never leave. */
  _view(draw, p, world, depth, into, rect) {
    const { renderer, scene, camera, linked, self, ghost } = draw;
    const partner = this._partnerOf(p);
    const mine = new THREE.Matrix4().multiplyMatrices(this._through(p, partner), world);
    const inner = new Map();
    if (depth < MAX_DEPTH) {
      for (const { p: q, rect: part } of this._seen(linked, mine, camera, partner, rect)) {
        if (this._spare <= 0) break;
        this._spare--;
        inner.set(q, this._view(draw, q, mine, depth + 1, this._pooledTarget(depth + 1), part));
      }
    }
    for (const q of linked) {
      const t = inner.get(q), u = q.disc.material.uniforms;
      u.uView.value = t ? t.texture : null;
      u.uHasView.value = t ? 1 : 0;
    }
    this._aimVirtualCamera(camera, mine, partner);
    // Through the mouth you are standing in, the first view is from your own eye
    // moved through: the half of you out of the far mouth is first person there,
    // and first person never draws itself (it was your own back and gun). The
    // half still on this side is far from that eye and is drawn, and so is
    // everything of you from one trip further in.
    if (self) this.selfGhost.visible = ghost && !(depth === 1 && p === this.selfMouth);
    partner.group.visible = false;      // the camera stands right behind the exit
    // cleared whole, then drawn only where `p` shows on the screen it is seen on
    into.scissorTest = false;
    renderer.setRenderTarget(into);
    renderer.clear();
    const x0 = Math.floor((rect.x0 + 1) / 2 * into.width), x1 = Math.ceil((rect.x1 + 1) / 2 * into.width);
    const y0 = Math.floor((rect.y0 + 1) / 2 * into.height), y1 = Math.ceil((rect.y1 + 1) / 2 * into.height);
    into.scissor.set(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    into.scissorTest = true;
    renderer.setRenderTarget(into);
    renderer.render(scene, this._vcam);
    partner.group.visible = true;
    this.renders++;
    return into;
  }

  /** The mouths a camera at `world` can see, nearest first, each with the part
   *  of the screen (`clip` or less) it shows in. Looking out of `exit` (a view
   *  in a view) they must also be in front of that mouth and seen from their
   *  own front. */
  _seen(linked, world, camera, exit, clip) {
    const eye = new THREE.Vector3().setFromMatrixPosition(world);
    const viewProj = new THREE.Matrix4().copy(world).invert().premultiply(camera.projectionMatrix);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(viewProj);
    const c = new THREE.Vector3(), ball = new THREE.Sphere(c, HALF_H + 0.2);
    const out = [];
    for (const p of linked) {
      if (p === exit) continue;
      c.set(p.c.x, p.c.y, p.c.z);
      const d = c.distanceTo(eye);
      if (d > VIEW_RANGE || !frustum.intersectsSphere(ball)) continue;
      const front = (eye.x - c.x) * p.n.x + (eye.y - c.y) * p.n.y + (eye.z - c.z) * p.n.z;
      if (exit) {
        const past = (c.x - exit.c.x) * exit.n.x + (c.y - exit.c.y) * exit.n.y + (c.z - exit.c.z) * exit.n.z;
        if (front < 0.01 || past < -HALF_H) continue;
      }
      const rect = this._rect(p, viewProj, clip);
      if (!rect) continue;
      if (exit && (rect.x1 - rect.x0 < MIN_SEEN * 2 || rect.y1 - rect.y0 < MIN_SEEN * 2)) continue;
      // an eye at the mouth itself (standing in it) is never asked about walls
      if ((exit || front > 0.5) && !this._inSight(p, eye, exit)) continue;
      out.push({ p, d, rect });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** The box round a mouth on screen, in -1..1, cut to `clip`; null if nothing
   *  of it is left. Any of it behind the lens and the whole of `clip` is kept. */
  _rect(p, viewProj, clip) {
    const v = new THREE.Vector4();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8, su = Math.cos(a) * HALF_W * 1.05, sv = Math.sin(a) * HALF_H * 1.05;
      v.set(p.c.x + p.u.x * su + p.v.x * sv, p.c.y + p.u.y * su + p.v.y * sv,
            p.c.z + p.u.z * su + p.v.z * sv, 1).applyMatrix4(viewProj);
      if (v.w < 0.05) return { ...clip };
      x0 = Math.min(x0, v.x / v.w); x1 = Math.max(x1, v.x / v.w);
      y0 = Math.min(y0, v.y / v.w); y1 = Math.max(y1, v.y / v.w);
    }
    const r = { x0: Math.max(clip.x0, x0 - 0.01), y0: Math.max(clip.y0, y0 - 0.01),
                x1: Math.min(clip.x1, x1 + 0.01), y1: Math.min(clip.y1, y1 + 0.01) };
    return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
  }

  /** Is there a clear line from the eye to any of nine points on the mouth?
   *  Looking out of `exit` the line starts where it leaves that mouth's wall. */
  _inSight(p, eye, exit) {
    if (!this.world || !this.world.raycast) return true;
    for (const [a, b] of SIGHT) {
      const su = a * HALF_W, sv = b * HALF_H;
      const from = {
        x: p.c.x + p.u.x * su + p.v.x * sv + p.n.x * 0.05,
        y: p.c.y + p.u.y * su + p.v.y * sv + p.n.y * 0.05,
        z: p.c.z + p.u.z * su + p.v.z * sv + p.n.z * 0.05
      };
      const dir = { x: eye.x - from.x, y: eye.y - from.y, z: eye.z - from.z };
      let len = Math.hypot(dir.x, dir.y, dir.z);
      if (len < 1e-6) return true;
      dir.x /= len; dir.y /= len; dir.z /= len;
      if (exit) {
        // stop at the exit's surface: the eye stands behind it, inside its wall
        const along = dir.x * exit.n.x + dir.y * exit.n.y + dir.z * exit.n.z;
        const off = (from.x - exit.c.x) * exit.n.x + (from.y - exit.c.y) * exit.n.y + (from.z - exit.c.z) * exit.n.z;
        if (along < -1e-6 && off > 0) len = Math.min(len, off / -along);
      }
      len -= 0.05;
      if (len <= 0 || this.world.raycast(from, dir, len) >= len) return true;
    }
    return false;
  }

  /** A target for a view `depth` trips in: each trip a little coarser. */
  _pooledTarget(depth) {
    this._pool = this._pool || [];
    const mine = this._pool[depth] = this._pool[depth] || [];
    const used = this._pooled[depth] = (this._pooled[depth] || 0) + 1;
    if (!mine[used - 1]) mine[used - 1] = this._makeTarget(DEPTH_SCALE ** (depth - 1));
    return mine[used - 1];
  }

  _partnerOf(p) {
    const pair = this.pairs.get(p.owner);
    if (!pair) return null;
    return p.side === 'a' ? pair.b : pair.a;
  }

  /** Mt * flip(u, n) * Mf^-1: the same transform portalMap() applies to the player. */
  _through(from, to) {
    const basis = (q, flip) => {
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(q.u.x, q.u.y, q.u.z).multiplyScalar(flip ? -1 : 1),
        new THREE.Vector3(q.v.x, q.v.y, q.v.z),
        new THREE.Vector3(q.n.x, q.n.y, q.n.z).multiplyScalar(flip ? -1 : 1)
      );
      m.setPosition(q.c.x, q.c.y, q.c.z);
      return m;
    };
    return basis(to, true).multiply(basis(from, false).invert());
  }

  /** Stand the virtual camera at `world`, its near plane bent onto `to`. */
  _aimVirtualCamera(camera, world, to) {
    const v = this._vcam;
    v.matrixWorld.copy(world);
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

  _makeTarget(scale = 1) {
    const t = new THREE.WebGLRenderTarget(
      Math.max(2, Math.round(this._viewSize.w * scale)), Math.max(2, Math.round(this._viewSize.h * scale)),
      { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true }
    );
    t.texture.colorSpace = THREE.SRGBColorSpace;
    t.scale = scale;
    return t;
  }

  _sizeTargets(renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(2, Math.round(size.x * VIEW_SCALE));
    const h = Math.max(2, Math.round(size.y * VIEW_SCALE));
    if (w === this._viewSize.w && h === this._viewSize.h) return;
    this._viewSize = { w, h };
    for (const p of this._all()) if (p.target) p.target.setSize(w, h);
    for (const t of (this._pool || []).flat()) {
      t.setSize(Math.max(2, Math.round(w * t.scale)), Math.max(2, Math.round(h * t.scale)));
    }
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
    // A flat border in the mouth's own colour: no glow and no light. Additive,
    // it took its brightness from whatever was behind it, so the same border was
    // a different colour on a wall, in a view, and in a view of that.
    p.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 48),
      new THREE.MeshBasicMaterial({
        color: p.color, transparent: true, side: THREE.DoubleSide, depthWrite: false
      })
    );
    p.disc.scale.set(HALF_W, HALF_H, 1);
    p.ring.scale.set(HALF_W, HALF_H, 1);
    p.disc.position.z = DISC_Z;
    p.ring.position.z = RING_Z;
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
    m.setPosition(p.c.x + p.n.x * SEAT, p.c.y + p.n.y * SEAT, p.c.z + p.n.z * SEAT);
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
