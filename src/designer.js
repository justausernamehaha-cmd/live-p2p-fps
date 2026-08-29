import * as THREE from 'three';
import { Level, COLORS, COLOR_NAMES, GRID, MIN_W, MAX_W, MIN_H, MAX_H, MAX_BOXES } from './level.js';
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
    const speed = (input.down('sprint') ? FLY_FAST : FLY) * dt;
    this.pos.x += (fwd.x * m.y + right.x * m.x) * speed;
    this.pos.y += (fwd.y * m.y) * speed;
    this.pos.z += (fwd.z * m.y + right.z * m.x) * speed;
    if (input.down('jump')) this.pos.y += speed;
    if (input.down('crouch') && !this.mouseFree) this.pos.y -= speed;

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

    if (this.stage === 'idle') {
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
    const made = this.level.add(a, b, this.color);
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
    const made = this.level.add(this.cornerA, p, this.color);
    this.cornerA = null;
    if (!made) { this._say(`that is the ${MAX_BOXES}-box limit`); return; }
    this.selected = made;
    this._changed();
  }

  _select() {
    const hit = this.game.world.pick(this.ray.origin, this.ray.dir);
    this.selected = hit ? hit.box.src : null;
    if (this.selected) {
      this._say(this.selected.locked
        ? `selected the ${this.selected.kind} — colour it, but it cannot be deleted`
        : 'selected — 1–0 colours it, R deletes it');
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
    if (this.stage !== 'idle') { this.stage = 'idle'; this.surface = null; this._say('cancelled'); }
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
      if (this.stage === 'idle') this.hover = this.game.world.pick(this.ray.origin, this.ray.dir);
      if (e.altKey && e.ctrlKey) this._select();
      else this._click();
    }, true);

    addEventListener('keydown', e => {
      if (!this.active || e.repeat) return;
      if (isFormTarget(e)) return;

      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault();
        this._freeMouse(true);
        return;
      }
      if (e.code === 'Tab') { e.preventDefault(); this.togglePlay(); return; }
      if (!this.ghost) return;

      if (e.code === 'Escape') { this._cancel(); return; }
      if (e.code === 'KeyQ') { e.preventDefault(); this._corner('q'); return; }
      if (e.code === 'KeyE') { e.preventDefault(); this._corner('e'); return; }
      if (e.code === 'KeyR') { e.preventDefault(); this._delete(); return; }
      if (e.code === 'KeyG') {
        e.preventDefault();
        this.snap = !this.snap;
        this._say(this.snap ? `snapping to ${GRID} m` : 'free placement');
        return;
      }
      if (e.code === 'KeyH') { e.preventDefault(); $('dkeys').classList.toggle('hidden'); return; }
      const digit = /^Digit([0-9])$/.exec(e.code);
      if (digit) {
        e.preventDefault();
        this._setColor(digit[1] === '0' ? 9 : Number(digit[1]) - 1);
      }
    }, true);

    addEventListener('keyup', e => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') this._freeMouse(false);
    }, true);

    // holding Alt through a tab switch would otherwise leave the mouse free
    addEventListener('blur', () => this._freeMouse(false));
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
    if (this.selected) {
      const s = this.selected;
      place(this.selEdges, { x: s.x0, y: s.y0, z: s.z0 }, { x: s.x1, y: s.y1, z: s.z1 }, 0.03);
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

    const stage = !this.ghost ? 'Tab returns to building'
      : this.stage === 'rect' ? 'drag the rectangle · click to fix the base'
      : this.stage === 'height' ? `pull the height · ${fmt(this.pull)} m · click to finish`
      : this.cornerA ? 'first corner set · E at the opposite one'
      : 'click a surface to start a rectangle · Q for a floating box';
    $('dtool').textContent = stage;

    const sel = this.selected;
    $('dsel').textContent = sel
      ? (sel.locked ? sel.kind : `box ${fmt(sel.x1 - sel.x0)}×${fmt(sel.y1 - sel.y0)}×${fmt(sel.z1 - sel.z0)}`) +
        ' · ' + COLOR_NAMES[sel.c]
      : 'nothing selected';

    $('dstats').textContent =
      `${L.boxes.length}/${MAX_BOXES} boxes · ${fmt(L.w)}×${fmt(L.l)}×${fmt(L.h)} m · ` +
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

function solidBox(color, opacity) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
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
