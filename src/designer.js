import * as THREE from 'three';
import { Level, COLORS, COLOR_NAMES, GRID, MIN_W, MAX_W, MIN_H, MAX_H, MAX_BOXES } from './level.js';
import { SHAPE_BOX, SHAPE_SLOPE, eulerMatrix, eulerFromMatrix, matMul, axisMatrix } from './solid.js';
import { clamp, cssColor, now } from './util.js';

// The level designer. It runs instead of a match: no peers, no signalling, no
// damage. The room code `level design` is the only way in.
//
// Two modes share the room. In GHOST you fly and build; Tab drops you into
// PLAYTEST, which is the ordinary player against the same boxes, and Tab again
// brings the ghost back where the player was standing.

const AXES = ['x', 'y', 'z'];
const FLY = 16, FLY_FAST = 42;
const REACH = 3;              // metres ahead of the eye for the Q/E corner point
const MARGIN = 0.3;           // how close the ghost may drift to the shell
const SAVE_KEY = 'pa.level';
const AXIS_NAMES = ['X', 'Y', 'Z'];
const AXIS_COLORS = [0xff5566, 0x66dd55, 0x5599ff];
const GIZMO_MIN = 1.1;        // the rings never shrink below this, however small the box
const GIZMO_PAD = 0.55;       // how far outside the box the smallest ring sits
const RING_TOL = 0.22;        // how close the cursor must come to a ring to grab it
const STEP_TURN = Math.PI / 2;      // one press of rotate
const FINE_TURN = Math.PI / 12;     // ...with shift held
const SNAP_TURN = Math.PI / 12;     // the grid, while dragging a ring
const SAVE_EVERY = 1500;      // ms between autosaves while something has changed

const $ = id => document.getElementById(id);

export class Designer {
  constructor(game) {
    this.game = game;
    this.level = null;
    this.active = false;
    this.ghost = true;
    this.mouseFree = false;       // Alt is down: the pointer is released
    this.snap = true;
    this.color = 0;
    this.shape = SHAPE_BOX;       // what the next box drawn will be
    this.axis = 1;                // which way `rotate` turns things: Y by default
    this.drag = null;             // a gizmo ring being pulled round
    this.held = new Set();        // designer actions currently down
    this.selected = null;
    this.stage = 'idle';          // idle -> rect -> height -> idle
    this.surface = null;
    this.a = null; this.b = null; this.pull = 0;
    this.cornerA = null;
    this.pos = { x: 0, y: 2, z: 0 };
    this.ndc = { x: 0, y: 0 };
    this.ray = null;
    this.reachPoint = { x: 0, y: 0, z: 0 };
    this.hover = null;
    this.message = '';
    this.messageUntil = 0;
    this._dirty = false;
    this._savedAt = 0;
    this._bound = false;
  }

  // ------------------------------------------------------------------ enter
  start(level) {
    this.level = level;
    this.active = true;
    this.ghost = true;
    this.stage = 'idle';
    this.selected = null;
    this.cornerA = null;
    this.drag = null;
    this.held.clear();
    this.pos = { x: 0, y: Math.min(6, level.h - 1), z: level.l * 0.35 };
    this.game.player.yaw = Math.PI;
    this.game.player.pitch = -0.12;
    this.game.world.setLevel(level);
    if (!this._bound) { this._bind(); this._buildOverlay(); this._bindPanel(); this._bound = true; }
    this.overlay.visible = true;
    this._paintSwatches();
    $('designhud').classList.remove('hidden');
    document.body.classList.add('designing');
    this._setBodyMode();
    this._say('room ' + fmt(level.w) + ' × ' + fmt(level.l) + ' × ' + fmt(level.h) + ' — H toggles the key list', 4000);
  }

  stop() {
    this.active = false;
    if (this.overlay) this.overlay.visible = false;
    $('designhud').classList.add('hidden');
    document.body.classList.remove('designing', 'design-ghost', 'design-play');
    this.game.input.suspendLock = false;
    this.save();
  }

  // ------------------------------------------------------------------ frame
  /** Returns true when the designer owns the frame, i.e. the ghost is flying. */
  frame(t, dt) {
    if (!this.active) return false;
    this.overlay.visible = this.ghost;
    if (!this.ghost) { this._hud(); return false; }

    const input = this.game.input;
    const look = input.consumeLook(dt);
    if (!this.mouseFree) this.game.player.look(look.dx, look.dy);

    this._fly(dt, input);
    this._camera();
    this._tools();
    this._hud();

    if (this._dirty && now() - this._savedAt > SAVE_EVERY) this.save();
    return true;
  }

  _fly(dt, input) {
    const p = this.game.player;
    const m = input.moveVector();
    // movement follows the look direction, pitch included: nose up and press
    // forward and you climb
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const fwd = { x: -Math.sin(p.yaw) * cp, y: sp, z: -Math.cos(p.yaw) * cp };
    const right = { x: Math.cos(p.yaw), y: 0, z: -Math.sin(p.yaw) };
    const speed = (this.held.has('fast') ? FLY_FAST : FLY) * dt;
    this.pos.x += (fwd.x * m.y + right.x * m.x) * speed;
    this.pos.y += (fwd.y * m.y) * speed;
    this.pos.z += (fwd.z * m.y + right.z * m.x) * speed;
    if (this.held.has('up')) this.pos.y += speed;
    if (this.held.has('down')) this.pos.y -= speed;

    // the shell is solid even for a ghost: you cannot leave the room
    const L = this.level;
    this.pos.x = clamp(this.pos.x, -L.w / 2 + MARGIN, L.w / 2 - MARGIN);
    this.pos.z = clamp(this.pos.z, -L.l / 2 + MARGIN, L.l / 2 - MARGIN);
    this.pos.y = clamp(this.pos.y, MARGIN, L.h - MARGIN);
  }

  _camera() {
    const cam = this.game.camera, p = this.game.player;
    if (Math.abs(cam.fov - this.game.baseFov) > 0.01) {
      cam.fov = this.game.baseFov;
      cam.updateProjectionMatrix();
    }
    cam.position.set(this.pos.x, this.pos.y, this.pos.z);
    cam.rotation.set(0, 0, 0);
    cam.rotateY(p.yaw);
    cam.rotateX(p.pitch);
    cam.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------- rays
  _ray() {
    const cam = this.game.camera;
    const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    let dir;
    if (this.mouseFree) {
      // Alt released the pointer, so aim through wherever the cursor sits
      dir = new THREE.Vector3(this.ndc.x, this.ndc.y, 0.5).unproject(cam).sub(origin).normalize();
    } else {
      dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    }
    return { origin, dir };
  }

  _tools() {
    const { origin, dir } = this._ray();
    this.ray = { origin, dir };

    // the Q/E corner is a fixed reach in front of the eye, whatever the mouse
    // is doing, because it is a position and not a pick
    const cam = this.game.camera;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.reachPoint = this._snapPoint({
      x: origin.x + f.x * REACH, y: origin.y + f.y * REACH, z: origin.z + f.z * REACH
    });

    if (this.drag) {
      this._dragRing();
    } else if (this.stage === 'idle') {
      this.hover = this.game.world.pick(origin, dir);
    } else if (this.stage === 'rect') {
      const p = this._onSurface();
      if (p) this.b = p;
    } else if (this.stage === 'height') {
      this._updatePull();
    }
    this._drawPreview();
  }

  /** Project the ray onto the plane of the surface the rectangle started on,
   *  then hold it inside that face — leaving the face must not make the point
   *  jump onto whatever is behind it. */
  _onSurface() {
    const s = this.surface;
    const k = AXES[s.axis];
    const { origin, dir } = this.ray;
    const d = dir[k];
    if (Math.abs(d) < 1e-6) return null;
    const t = (s.plane - origin[k]) / d;
    if (!(t > 0.02) || t > 800) return null;
    const p = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
    p[k] = s.plane;
    for (const j of [0, 1, 2]) {
      if (j === s.axis) continue;
      p[AXES[j]] = clamp(p[AXES[j]], s.lo[j], s.hi[j]);
    }
    const snapped = this._snapPoint(p);
    snapped[k] = s.plane;                              // the plane is never snapped away
    for (const j of [0, 1, 2]) {
      if (j === s.axis) continue;
      snapped[AXES[j]] = clamp(snapped[AXES[j]], s.lo[j], s.hi[j]);
    }
    return snapped;
  }

  /** How far the mouse has pulled the box out along the surface normal. Signed:
   *  negative sinks the box back into the surface it was drawn on. */
  _updatePull() {
    const s = this.surface;
    const n = [0, 0, 0];
    n[s.axis] = s.sign;
    const c = this._baseCentre();
    const { origin, dir } = this.ray;
    const w0 = [c.x - origin.x, c.y - origin.y, c.z - origin.z];
    const d = [dir.x, dir.y, dir.z];
    const b = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    const dd = n[0] * w0[0] + n[1] * w0[1] + n[2] * w0[2];
    const e = d[0] * w0[0] + d[1] * w0[1] + d[2] * w0[2];
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-4) return;      // looking straight down the normal
    let pull = (b * e - dd) / denom;
    if (!Number.isFinite(pull)) return;
    this.pull = clamp(this._snapN(pull), -(this.level.h + 4), this.level.h + 4);
  }

  _baseCentre() {
    const c = { x: 0, y: 0, z: 0 };
    for (const k of AXES) c[k] = (this.a[k] + this.b[k]) / 2;
    return c;
  }

  _snapN(v) { return this.snap ? Math.round(v / GRID) * GRID : Math.round(v * 100) / 100; }
  _snapPoint(p) { return { x: this._snapN(p.x), y: this._snapN(p.y), z: this._snapN(p.z) }; }

  // ------------------------------------------------------------------ tools
  _click() {
    if (this.stage === 'idle') {
      const hit = this.hover;
      if (!hit) { this._say('point at a surface first'); return; }
      const b = hit.box, k = AXES[hit.axis];
      const lo = [b.min.x, b.min.y, b.min.z], hi = [b.max.x, b.max.y, b.max.z];
      this.surface = {
        axis: hit.axis, sign: hit.sign,
        plane: hit.sign > 0 ? b.max[k] : b.min[k],
        lo, hi
      };
      const p = this._onSurface();
      if (!p) { this._say('that surface is edge-on from here'); return; }
      this.a = p;
      this.b = { ...p };
      this.stage = 'rect';
    } else if (this.stage === 'rect') {
      this.stage = 'height';
      this.pull = 0;
    } else {
      this._commitRect();
    }
  }

  _commitRect() {
    const s = this.surface, k = AXES[s.axis];
    let pull = this.pull;
    if (Math.abs(pull) < GRID * 0.5) pull = GRID;      // a flat plate still needs a thickness
    const a = { ...this.a };
    const b = { ...this.b };
    a[k] = s.plane;
    b[k] = s.plane + pull * s.sign;
    const made = this._addShape(a, b, s);
    this.stage = 'idle';
    this.surface = null;
    if (!made) { this._say(`that is the ${MAX_BOXES}-box limit`); return; }
    this.selected = made;
    this._changed();
  }

  _corner(which) {
    const p = { ...this.reachPoint };
    if (which === 'q') {
      this.cornerA = p;
      this._say('corner set — fly to the opposite one and press E');
      return;
    }
    if (!this.cornerA) { this._say('press Q at the first corner first'); return; }
    const made = this._addShape(this.cornerA, p, null);
    this.cornerA = null;
    if (!made) { this._say(`that is the ${MAX_BOXES}-box limit`); return; }
    this.selected = made;
    this._changed();
  }

  /** Add whatever shape is currently selected between two corners.
   *
   *  A box is the corners as they are. A ramp is not: the wedge in solid.js
   *  reads its extents along its *own* axes, and it is then turned into place —
   *  so the run the player dragged has to be handed over as the wedge's local x,
   *  the pull as its local y, and the width as its local z. Storing the world
   *  extents and turning them afterwards makes a nine-metre run come out half a
   *  metre long and nine metres wide.
   */
  _addShape(a, b, surface) {
    if (this.shape !== SHAPE_SLOPE) return this.level.add(a, b, this.color);

    const rot = this._slopeRot(a, b, surface);
    const m = eulerMatrix(rot[0], rot[1], rot[2]);
    const world = [Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)];
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };

    // each local axis lands on one world axis; take that world extent for it
    const local = [0, 1, 2].map(col => {
      let axis = 0, best = -1;
      for (let row = 0; row < 3; row++) {
        const v = Math.abs(m[row][col]);
        if (v > best) { best = v; axis = row; }
      }
      return world[axis];
    });

    return this.level.add(
      { x: centre.x - local[0] / 2, y: centre.y - local[1] / 2, z: centre.z - local[2] / 2 },
      { x: centre.x + local[0] / 2, y: centre.y + local[1] / 2, z: centre.z + local[2] / 2 },
      this.color, SHAPE_SLOPE, rot);
  }

  /** A ramp climbs along its own +x with its own +y as "up", so placing one is
   *  a matter of naming those two directions and reading off the turn that gets
   *  them there. Up is the surface it was drawn on; the climb runs along
   *  whichever free axis the drag covered more of, toward the second point. */
  _slopeRot(a, b, surface) {
    const up = [0, 0, 0];
    if (surface) up[surface.axis] = surface.sign;
    else up[1] = 1;                                   // a floating ramp stands upright

    const span = [Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)];
    let rise = 0, bestSpan = -1;
    for (let i = 0; i < 3; i++) {
      if (up[i]) continue;                            // never climb along "up"
      if (span[i] > bestSpan) { bestSpan = span[i]; rise = i; }
    }
    const dir = [0, 0, 0];
    const to = [b.x - a.x, b.y - a.y, b.z - a.z][rise];
    dir[rise] = to < 0 ? -1 : 1;

    // a right-handed frame: local x is the climb, local y is up, local z follows
    const side = [
      dir[1] * up[2] - dir[2] * up[1],
      dir[2] * up[0] - dir[0] * up[2],
      dir[0] * up[1] - dir[1] * up[0]
    ];
    return eulerFromMatrix([
      [dir[0], up[0], side[0]],
      [dir[1], up[1], side[1]],
      [dir[2], up[2], side[2]]
    ]);
  }

  /** Turn the selection about a world axis, through its own centre. */
  _turn(axis, angle) {
    const b = this.selected;
    if (!b || b.locked) { this._say('select something first'); return; }
    const m = matMul(axisMatrix(axis, angle), eulerMatrix(b.rx || 0, b.ry || 0, b.rz || 0));
    const [rx, ry, rz] = eulerFromMatrix(m);
    b.rx = rx; b.ry = ry; b.rz = rz;
    this._changed();
  }

  _cycleShape() {
    this.shape = this.shape === SHAPE_BOX ? SHAPE_SLOPE : SHAPE_BOX;
    this._say(this.shape === SHAPE_SLOPE ? 'drawing ramps' : 'drawing boxes');
  }

  _cycleAxis() {
    this.axis = (this.axis + 1) % 3;
    this._say('rotating about ' + AXIS_NAMES[this.axis]);
  }

  // ------------------------------------------------------------- the gizmo
  /** Radius of the rings drawn around the selection. */
  _gizmoRadius(b) {
    const half = Math.max(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0) / 2;
    return Math.max(GIZMO_MIN, half + GIZMO_PAD);
  }

  _gizmoCentre(b) {
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 };
  }

  /** Which ring, if any, the ray is pointing at — and where on it. */
  _ringUnderRay() {
    const b = this.selected;
    if (!b || b.locked) return null;
    const c = this._gizmoCentre(b);
    const r = this._gizmoRadius(b);
    const { origin, dir } = this.ray;
    let best = null;
    for (let axis = 0; axis < 3; axis++) {
      const k = AXES[axis];
      const denom = dir[k];
      if (Math.abs(denom) < 1e-6) continue;
      const t = (c[k] - origin[k]) / denom;
      if (t <= 0.05) continue;
      const p = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
      if (Math.abs(d - r) > RING_TOL + r * 0.06) continue;
      if (!best || t < best.t) best = { axis, t, point: p, centre: c };
    }
    return best;
  }

  /** The angle of a point around a ring, measured in that ring's own plane. */
  _ringAngle(axis, c, p) {
    const [u, v] = axis === 0 ? ['z', 'y'] : axis === 1 ? ['x', 'z'] : ['x', 'y'];
    return Math.atan2(p[v] - c[v], p[u] - c[u]);
  }

  _startRingDrag(hit) {
    this.axis = hit.axis;
    this.drag = {
      axis: hit.axis,
      centre: hit.centre,
      from: this._ringAngle(hit.axis, hit.centre, hit.point),
      applied: 0
    };
    this._say('rotating about ' + AXIS_NAMES[hit.axis] + ' — let go to stop');
  }

  _dragRing() {
    const d = this.drag;
    const k = AXES[d.axis];
    const { origin, dir } = this.ray;
    const denom = dir[k];
    if (Math.abs(denom) < 1e-6) return;
    const t = (d.centre[k] - origin[k]) / denom;
    if (t <= 0.05) return;
    const p = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
    let turned = this._ringAngle(d.axis, d.centre, p) - d.from;
    // unwrap, so a drag past the far side keeps going instead of snapping back
    while (turned > Math.PI) turned -= Math.PI * 2;
    while (turned < -Math.PI) turned += Math.PI * 2;
    // the ring's sign flips depending on which side of the plane you are on
    const target = this.snap ? Math.round(turned / SNAP_TURN) * SNAP_TURN : turned;
    if (Math.abs(target - d.applied) < 1e-6) return;
    this._turn(d.axis, target - d.applied);
    d.applied = target;
  }

  _endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.save();
  }

  _select() {
    const hit = this.game.world.pick(this.ray.origin, this.ray.dir);
    this.selected = hit ? hit.box.src : null;
    if (this.selected) {
      this._say(this.selected.locked
        ? `selected the ${this.selected.kind} — colour it, but it cannot be deleted`
        : 'selected — 1–0 colours it, T deletes it, R turns it');
    }
  }

  _setColor(i) {
    this.color = i;
    this._paintSwatches();
    if (this.selected) {
      this.selected.c = i;
      this._changed();
      this._say(`${this.selected.locked ? this.selected.kind : 'box'} → ${COLOR_NAMES[i]}`);
    } else {
      this._say(`new boxes are ${COLOR_NAMES[i]}`);
    }
  }

  _delete() {
    if (!this.selected) { this._say('nothing selected — Alt+Ctrl+click an object first'); return; }
    if (this.selected.locked) { this._say('the floor, walls and ceiling cannot be deleted'); return; }
    this.level.remove(this.selected);
    this.selected = null;
    this._changed();
  }

  _cancel() {
    if (this.drag) { this._endDrag(); this._say('stopped turning'); }
    else if (this.stage !== 'idle') { this.stage = 'idle'; this.surface = null; this._say('cancelled'); }
    else if (this.cornerA) { this.cornerA = null; this._say('corner cleared'); }
    else if (this.selected) this.selected = null;
  }

  _changed() {
    this.game.world.syncLevel();
    this._dirty = true;
  }

  // -------------------------------------------------------------- playtest
  togglePlay() {
    const p = this.game.player;
    if (this.ghost) {
      const yaw = p.yaw, pitch = p.pitch;
      p.spawn({ x: this.pos.x, y: Math.max(0.05, this.pos.y - 1.7), z: this.pos.z });
      p.yaw = yaw; p.pitch = pitch;             // spawn() turns you to face the middle
      this.game.loadout.refill();
      this.ghost = false;
      this._say('playtest — Tab returns to building', 3000);
    } else {
      this.pos = { x: p.pos.x, y: p.eyeY, z: p.pos.z };
      const L = this.level;
      this.pos.x = clamp(this.pos.x, -L.w / 2 + MARGIN, L.w / 2 - MARGIN);
      this.pos.z = clamp(this.pos.z, -L.l / 2 + MARGIN, L.l / 2 - MARGIN);
      this.pos.y = clamp(this.pos.y, MARGIN, L.h - MARGIN);
      this.ghost = true;
      this.stage = 'idle';
      this._say('building', 2000);
    }
    this._setBodyMode();
  }

  _setBodyMode() {
    document.body.classList.toggle('design-ghost', this.ghost);
    document.body.classList.toggle('design-play', !this.ghost);
  }

  // ------------------------------------------------------------------ saving
  save() {
    this._savedAt = now();
    this._dirty = false;
    try { localStorage.setItem(SAVE_KEY, this.level.encode()); } catch { /* private mode */ }
  }

  static savedSeed() {
    try { return localStorage.getItem(SAVE_KEY) || ''; } catch { return ''; }
  }

  // ------------------------------------------------------------------ input
  _bind() {
    const canvas = this.game.canvas;

    addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      this.ndc.x = (e.clientX / innerWidth) * 2 - 1;
      this.ndc.y = -(e.clientY / innerHeight) * 2 + 1;
    });

    canvas.addEventListener('pointerdown', e => {
      if (!this.active || !this.ghost || e.pointerType === 'touch') return;
      if (this.game.menuOpen || this.game.editing) return;
      if (e.button === 2) { e.preventDefault(); this._cancel(); return; }
      if (e.button !== 0) return;
      // The click that grabs the pointer is not a building click. Without this,
      // clicking into the window to start aiming also started a rectangle.
      if (!this.mouseFree && document.pointerLockElement !== canvas) return;
      // the ray is a frame behind while the pointer is free, so refresh it first
      this.ray = this._ray();
      // a ring of the gizmo is grabbed before anything else: it is sitting in
      // front of the object precisely so it can be taken hold of
      const ring = this._ringUnderRay();
      if (ring && !(e.altKey && e.ctrlKey)) { this._startRingDrag(ring); return; }
      if (this.stage === 'idle') this.hover = this.game.world.pick(this.ray.origin, this.ray.dir);
      if (e.altKey && e.ctrlKey) this._select();
      else this._click();
    }, true);

    addEventListener('pointerup', e => {
      if (e.pointerType !== 'touch') this._endDrag();
    }, true);

    addEventListener('keydown', e => {
      if (!this.active || e.repeat || isFormTarget(e)) return;
      const a = this.game.input.designAction(e.code);

      if (a === 'freemouse') { e.preventDefault(); this._freeMouse(true); return; }
      if (a === 'playtest') { e.preventDefault(); this.togglePlay(); return; }
      if (a && a !== 'playtest') this.held.add(a);
      if (!this.ghost) return;

      if (e.code === 'Escape') { this._cancel(); return; }
      switch (a) {
        case 'corner1': e.preventDefault(); this._corner('q'); return;
        case 'corner2': e.preventDefault(); this._corner('e'); return;
        case 'ddelete': e.preventDefault(); this._delete(); return;
        case 'shape': e.preventDefault(); this._cycleShape(); return;
        case 'axis': e.preventDefault(); this._cycleAxis(); return;
        case 'rotate':
          e.preventDefault();
          this._turn(this.axis, (e.shiftKey ? FINE_TURN : STEP_TURN));
          return;
        case 'snap':
          e.preventDefault();
          this.snap = !this.snap;
          this._say(this.snap ? `snapping to ${GRID} m` : 'free placement');
          return;
        case 'keylist':
          e.preventDefault();
          $('dkeys').classList.toggle('hidden');
          return;
      }
      // The ten colours stay on the number row. They are a palette, not a
      // command, and thirteen more rows in the panel would bury the rest.
      const digit = /^Digit([0-9])$/.exec(e.code);
      if (digit) {
        e.preventDefault();
        this._setColor(digit[1] === '0' ? 9 : Number(digit[1]) - 1);
      }
    }, true);

    addEventListener('keyup', e => {
      const a = this.game.input.designAction(e.code);
      if (!a) return;
      this.held.delete(a);
      if (a === 'freemouse') this._freeMouse(false);
    }, true);

    // holding a key through a tab switch would otherwise leave it stuck down
    addEventListener('blur', () => { this.held.clear(); this._freeMouse(false); this._endDrag(); });
  }

  _freeMouse(on) {
    if (!this.active || this.mouseFree === on) return;
    this.mouseFree = on;
    // stop input.js grabbing the pointer back on the very next click
    this.game.input.suspendLock = on;
    if (on) document.exitPointerLock?.();
    else if (this.ghost) this.game.input.requestLock();
  }

  // ------------------------------------------------------------------ overlay
  _buildOverlay() {
    this.overlay = new THREE.Group();
    this.overlay.renderOrder = 5;
    this.game.scene.add(this.overlay);

    this.ghostBox = solidBox(0xffb066, 0.22);
    this.ghostEdges = edgeBox(0xffd0a0);
    this.selEdges = edgeBox(0x42d2c4);
    this.reachMark = edgeBox(0xffffff);
    this.cornerMark = edgeBox(0x8bf03a);
    this.hoverMark = edgeBox(0x7f8ea8);
    for (const o of [this.ghostBox, this.ghostEdges, this.selEdges,
                     this.reachMark, this.cornerMark, this.hoverMark]) {
      o.visible = false;
      this.overlay.add(o);
    }

    // Three rings, one per axis, drawn through everything so a ring behind the
    // object can still be taken hold of. Grabbing one both picks the axis and
    // starts the turn.
    this.rings = AXIS_COLORS.map((color, axis) => {
      const ring = new THREE.LineLoop(ringGeometry(axis), new THREE.LineBasicMaterial({
        color, depthTest: false, transparent: true, opacity: 0.85
      }));
      ring.renderOrder = 7;
      ring.visible = false;
      this.overlay.add(ring);
      return ring;
    });
  }

  _drawPreview() {
    const showPreview = this.stage !== 'idle';
    this.ghostBox.visible = this.ghostEdges.visible = showPreview;
    if (showPreview) {
      const s = this.surface, k = AXES[s.axis];
      const a = { ...this.a }, b = { ...this.b };
      a[k] = s.plane;
      b[k] = s.plane + (this.stage === 'height' ? this.pull * s.sign : 0);
      place(this.ghostBox, a, b, 0.02);
      place(this.ghostEdges, a, b, 0.02);
    }

    // the point a Q or E press would use, always visible so the corner is not a guess
    this.reachMark.visible = true;
    place(this.reachMark, sub(this.reachPoint, 0.12), add(this.reachPoint, 0.12));

    this.cornerMark.visible = !!this.cornerA;
    if (this.cornerA) place(this.cornerMark, sub(this.cornerA, 0.22), add(this.cornerA, 0.22));

    this.selEdges.visible = !!this.selected;
    if (this.selected) placeOriented(this.selEdges, this.selected, 0.03);

    // the gizmo: only on something that can actually be turned
    const gizmo = this.selected && !this.selected.locked;
    const over = gizmo && !this.drag ? this._ringUnderRay() : null;
    for (let axis = 0; axis < 3; axis++) {
      const ring = this.rings[axis];
      ring.visible = !!gizmo;
      if (!gizmo) continue;
      const c = this._gizmoCentre(this.selected);
      const r = this._gizmoRadius(this.selected);
      ring.position.set(c.x, c.y, c.z);
      ring.scale.set(r, r, r);
      const live = (this.drag && this.drag.axis === axis) || (over && over.axis === axis);
      ring.material.opacity = live ? 1 : (this.axis === axis ? 0.85 : 0.4);
    }

    const showHover = this.stage === 'idle' && this.hover && !this.mouseFree;
    this.hoverMark.visible = !!showHover;
    if (showHover) {
      const p = this._snapPoint(this.hover.point);
      place(this.hoverMark, sub(p, 0.12), add(p, 0.12));
    }
  }

  // ---------------------------------------------------------------- the panel
  _bindPanel() {
    $('dexport').addEventListener('click', () => {
      const seed = this.level.encode();
      $('dseed').value = seed;
      this.save();
      navigator.clipboard?.writeText(seed)
        .then(() => this._say('seed copied — paste it into ROOM SEED to play it', 4000))
        .catch(() => this._say('seed is in the box below — copy it by hand', 4000));
    });

    $('dload').addEventListener('click', () => {
      const text = $('dseed').value;
      try {
        const level = Level.decode(text);
        this.level = level;
        this.selected = null;
        this.cornerA = null;
        this.stage = 'idle';
        this.game.world.setLevel(level);
        this.pos.y = Math.min(this.pos.y, level.h - MARGIN);
        this._changed();
        this._say('loaded ' + level.boxes.length + ' boxes', 4000);
      } catch (err) {
        this._say(err.message, 6000);
      }
    });

    $('dnew').addEventListener('click', () => this.game.openDesignSetup());
    $('dquit').addEventListener('click', () => this.game.leaveDesign());
  }

  _paintSwatches() {
    const wrap = $('dswatches');
    if (!wrap.children.length) {
      for (let i = 0; i < COLORS.length; i++) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'dsw';
        el.style.background = cssColor(COLORS[i]);
        el.textContent = i === 9 ? '0' : String(i + 1);
        el.title = COLOR_NAMES[i];
        el.addEventListener('click', () => this._setColor(i));
        wrap.appendChild(el);
      }
    }
    [...wrap.children].forEach((el, i) => el.classList.toggle('on', i === this.color));
  }

  _say(text, ms = 2500) {
    this.message = text;
    this.messageUntil = now() + ms;
  }

  _hud() {
    const L = this.level;
    $('dmode').textContent = this.ghost ? 'BUILDING' : 'PLAYTEST';
    $('dmode').classList.toggle('play', !this.ghost);

    const noun = this.shape === SHAPE_SLOPE ? 'ramp' : 'box';
    const stage = !this.ghost ? 'Tab returns to building'
      : this.drag ? `turning about ${AXIS_NAMES[this.drag.axis]} · let go to stop`
      : this.stage === 'rect' ? `drag the ${noun}'s base · click to fix it`
      : this.stage === 'height' ? `pull the height · ${fmt(this.pull)} m · click to finish`
      : this.cornerA ? 'first corner set · E at the opposite one'
      : `click a surface to start a ${noun} · Q for a floating one`;
    $('dtool').textContent = stage;

    const sel = this.selected;
    $('dsel').textContent = sel
      ? (sel.locked ? sel.kind
          : `${sel.shape === SHAPE_SLOPE ? 'ramp' : 'box'} ` +
            `${fmt(sel.x1 - sel.x0)}×${fmt(sel.y1 - sel.y0)}×${fmt(sel.z1 - sel.z0)}`) +
        ' · ' + COLOR_NAMES[sel.c]
      : 'nothing selected';

    $('dstats').textContent =
      `${L.boxes.length}/${MAX_BOXES} · ${fmt(L.w)}×${fmt(L.l)}×${fmt(L.h)} m · ` +
      (this.shape === SHAPE_SLOPE ? 'ramp' : 'box') + ' · ' + AXIS_NAMES[this.axis] + ' · ' +
      (this.snap ? `grid ${GRID}` : 'free') + (this.mouseFree ? ' · mouse free' : '');

    $('dmsg').textContent = now() < this.messageUntil ? this.message : '';
  }
}

// ------------------------------------------------------------------ helpers
function fmt(v) { return (Math.round(v * 100) / 100).toString(); }
const sub = (p, r) => ({ x: p.x - r, y: p.y - r, z: p.z - r });
const add = (p, r) => ({ x: p.x + r, y: p.y + r, z: p.z + r });

/** Size and centre a unit cube on the box between two corners. `grow` keeps an
 *  outline just clear of the surface it hugs, so it does not z-fight. */
function place(obj, a, b, grow = 0) {
  const sx = Math.abs(b.x - a.x) + grow * 2 || 0.02;
  const sy = Math.abs(b.y - a.y) + grow * 2 || 0.02;
  const sz = Math.abs(b.z - a.z) + grow * 2 || 0.02;
  obj.scale.set(sx, sy, sz);
  obj.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/** Size, turn and place an outline onto a level box, rotation included. The
 *  matrix is built from solid.js's own Euler convention rather than from
 *  three.js's, so the outline cannot drift away from the collision shape. */
function placeOriented(obj, box, grow = 0) {
  const m = eulerMatrix(box.rx || 0, box.ry || 0, box.rz || 0);
  const sx = (box.x1 - box.x0) + grow * 2;
  const sy = (box.y1 - box.y0) + grow * 2;
  const sz = (box.z1 - box.z0) + grow * 2;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, cz = (box.z0 + box.z1) / 2;
  obj.matrixAutoUpdate = false;
  obj.matrix.set(
    m[0][0] * sx, m[0][1] * sy, m[0][2] * sz, cx,
    m[1][0] * sx, m[1][1] * sy, m[1][2] * sz, cy,
    m[2][0] * sx, m[2][1] * sy, m[2][2] * sz, cz,
    0, 0, 0, 1
  );
}

function solidBox(color, opacity) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
}

/** A unit circle in the plane that `axis` is normal to. */
function ringGeometry(axis, segments = 64) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    if (axis === 0) pts.push(0, s, c);
    else if (axis === 1) pts.push(c, 0, s);
    else pts.push(c, s, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function edgeBox(color) {
  const line = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    // drawn through the world: an outline you cannot see is no use
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
  );
  line.renderOrder = 6;
  return line;
}

/** A key typed into the seed box or a dimension field is not a designer command. */
function isFormTarget(e) {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
