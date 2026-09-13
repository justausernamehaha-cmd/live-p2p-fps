import * as THREE from 'three';
import { lerp, lerpAngle, PLAYER_COLORS, cssColor, hash, now, num } from './util.js';
import { rayAABB } from './world.js';
import { UP_Y, upFromIndex, basisFor } from './frame.js';
import { mouthAround, portalMap } from './portal.js';
import { WEAPONS } from './weapons.js';

// The same reach player.js collision uses: what is drawn is what physics thinks.
const GHOST_REACH = 0.2;      // RADIUS + 0.03
const GHOST_EDGE = 0.17;      // RADIUS

const INTERP_DELAY = 110;     // ms of buffered lag between peers
const BUFFER = 24;
const HEAD_H = 0.34;
const BODY_R = HEAD_H / 2;    // hit boxes use the same constants as the mesh
const WHITE = new THREE.Color(0xffffff);

/** Where the other half of a body standing in a mouth hangs out of the far one.
 *  Each half is behind the wall its mouth is cut into, so no clipping is needed. */
function ghostOf(links, pos, up, yaw, height) {
  if (!links || !links.length) return null;
  const link = mouthAround(links, pos, up, height, GHOST_REACH, GHOST_EDGE);
  if (!link) return null;
  const map = portalMap(link.from, link.to);
  const f = basisFor(up, yaw);
  return {
    pos: map.point(pos),
    right: map.dir(f.r),
    up: map.dir(up),
    back: map.dir({ x: -f.f.x, y: -f.f.y, z: -f.f.z })
  };
}

function makeBody(colorHex) {
  const color = new THREE.Color(colorHex);
  const group = new THREE.Group();
  // emissive so a player never blends into the level
  const mat = new THREE.MeshLambertMaterial({
    color, emissive: color.clone().multiplyScalar(0.35)
  });
  const headMat = new THREE.MeshLambertMaterial({
    color: color.clone().offsetHSL(0, 0, 0.12),
    emissive: color.clone().multiplyScalar(0.3)
  });
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(BODY_R, 1.8 - HEAD_H - BODY_R * 2, 4, 12), mat);
  body.position.y = 0.72;
  const head = new THREE.Mesh(new THREE.BoxGeometry(HEAD_H, HEAD_H, HEAD_H), headMat);
  head.position.y = 1.62;
  const gun = new THREE.Group();
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.45, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(body, head, gun, shadow);
  return { group, mat, headMat, body, head, gun, shadow, weapon: -1 };
}

/** The held gun as a few boxes, rebuilt only when the weapon changes. */
function buildGun(group, w) {
  for (const c of group.children.slice()) {
    group.remove(c);
    c.geometry.dispose();
    c.material.dispose();
  }
  const h = w.hold || { barrel: 0.42, bore: 0.05, body: 0.5, tint: 0x2f3644, accent: 0xd9743b };
  const mk = (bw, bh, bd, color, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd),
                             new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };
  mk(0.085, 0.1, h.body, h.tint, 0, 0, -h.body / 2);                      // receiver
  mk(h.bore, h.bore, h.barrel, 0x1d2230, 0, 0.02, -h.body - h.barrel / 2 + 0.04);
  mk(0.06, 0.14, 0.07, 0x232936, 0, -0.11, -h.body * 0.35);               // magazine
  mk(0.06, 0.08, 0.16, 0x232936, 0, -0.02, 0.06);                         // stock
  if (h.scope) mk(0.04, 0.05, 0.22, 0x11161f, 0, 0.08, -h.body * 0.55);
  if (h.prongs) {                                                         // portal gun
    mk(0.028, 0.028, 0.16, h.accent, -0.05, 0.03, -h.body - h.barrel + 0.1);
    mk(0.028, 0.028, 0.16, h.accent, 0.05, 0.03, -h.body - h.barrel + 0.1);
  } else {
    mk(0.03, 0.03, 0.12, h.accent, 0, 0.065, -h.body * 0.5);              // rail block
  }
  group.userData.reach = h.body + h.barrel;
}

/** Crouch comes from height, and the weapon from what is in their hands. */
function poseBody(b, height, pitch, weaponIndex) {
  const s = height / 1.8;
  b.body.scale.y = s;
  b.body.position.y = 0.72 * s;
  b.head.position.y = 1.62 * s;
  const w = WEAPONS[weaponIndex] || WEAPONS[0];
  if (b.weapon !== w.id) {
    b.weapon = w.id;
    buildGun(b.gun, w);
  }
  b.gun.position.set(0.22, 1.35 * s, -0.12);
  b.gun.rotation.x = -pitch;
}

function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,.85)';
  g.strokeText(text, 128, 34);
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // depth-tested: a name visible through walls is a wallhack
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}

/** A drawn body plus its other half out of a far mouth. Peers and your own body
 *  (seen through portals) share this, so you look the same to yourself as to
 *  everyone else. */
class Avatar {
  constructor(colorHex, name) {
    this.colorHex = colorHex;
    this.color = new THREE.Color(colorHex);
    this.name = name;
    this.parts = makeBody(colorHex);
    this.group = this.parts.group;
    this.gparts = makeBody(colorHex);
    this.ghost = this.gparts.group;
    this.gparts.shadow.visible = false;    // one shadow, on the real body
    this.ghost.visible = false;
    this.label = null;
    this._rebuildLabel();
    this._m = new THREE.Matrix4();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
  }

  setName(name) {
    if (!name || name === this.name) return;
    this.name = name;
    this._rebuildLabel();
  }

  setColor(hex) {
    if (hex === undefined || hex === this.colorHex) return;
    this.colorHex = hex;
    this.color.setHex(hex);
    for (const b of [this.parts, this.gparts]) {
      b.mat.color.copy(this.color);
      b.mat.emissive.copy(this.color).multiplyScalar(0.35);
      b.headMat.color.copy(this.color).offsetHSL(0, 0, 0.12);
      b.headMat.emissive.copy(this.color).multiplyScalar(0.3);
    }
    this._rebuildLabel();
  }

  _rebuildLabel() {
    if (this.label) {
      this.group.remove(this.label);
      this.label.material.map?.dispose();
      this.label.material.dispose();
    }
    this.label = makeLabel(this.name, cssColor(this.colorHex));
    this.label.position.y = 2.25;
    this.group.add(this.label);
  }

  /** Place and pose both halves; `links` null means no ghost. */
  _pose(pos, up, yaw, pitch, height, weapon, links) {
    this.group.position.set(pos.x, pos.y, pos.z);
    // modelled standing up +y and looking down -z
    const f = basisFor(up, yaw);
    this._orient(this.group, f.r, up, { x: -f.f.x, y: -f.f.y, z: -f.f.z });
    poseBody(this.parts, height, pitch, weapon);
    this.label.position.y = 2.25 * (height / 1.8) + 0.1;

    const g = links ? ghostOf(links, pos, up, yaw, height) : null;
    this.ghost.visible = !!g;
    if (!g) return;
    this.ghost.position.set(g.pos.x, g.pos.y, g.pos.z);
    this._orient(this.ghost, g.right, g.up, g.back);
    poseBody(this.gparts, height, pitch, weapon);
  }

  _orient(obj, right, up, back) {
    this._m.makeBasis(
      this._a.set(right.x, right.y, right.z),
      this._b.set(up.x, up.y, up.z),
      this._c.set(back.x, back.y, back.z)
    );
    obj.quaternion.setFromRotationMatrix(this._m);
  }
}

export class RemotePlayer extends Avatar {
  constructor(id, scene) {
    super(PLAYER_COLORS[hash(id) % PLAYER_COLORS.length], id.slice(0, 6));
    this.id = id;
    this.scene = scene;
    this.buffer = [];
    this.kills = 0;
    this.deaths = 0;
    this.hp = 100;
    this.alive = true;
    this.ping = 0;
    this.lastSeen = now();
    this.flash = 0;
    this.spawnSeq = -1;
    this.portalRandom = 0;  // their share of everybody's portal colours
    this.settling = true;   // hidden until there are snapshots at the current spawn
    this.shielded = false;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.height = 1.8;
    this.up = UP_Y;
    this.weapon = 0;
    this.portals = null;    // set by the game

    this.group.visible = false;
    scene.add(this.group);
    scene.add(this.ghost);
  }

  onState(s) {
    this.lastSeen = now();
    // a teleport (respawn, portal): drop old samples rather than interpolate across
    const seq = num(s.s, 0);
    if (seq !== this.spawnSeq) {
      this.spawnSeq = seq;
      this.buffer.length = 0;
      this.settling = true;
      this.group.visible = false;
    }
    this.shielded = num(s.sf, 0) === 1;

    this.buffer.push({
      t: this.lastSeen,
      x: num(s.x), y: num(s.y), z: num(s.z),
      yaw: num(s.a), pitch: num(s.b), h: num(s.h, 1.8), u: num(s.u, 2)
    });
    this.weapon = num(s.w, this.weapon);
    if (this.buffer.length > BUFFER) this.buffer.shift();
    if (this.settling && this.buffer.length >= 2) this.settling = false;
    this.hp = num(s.hp);
    this.alive = this.hp > 0;
    this.kills = num(s.k, this.kills);
    this.deaths = num(s.d, this.deaths);
  }

  hit() { this.flash = 0.12; }

  update(dt) {
    const target = now() - INTERP_DELAY;
    const buf = this.buffer;
    if (buf.length === 0) return;

    // extrapolate from the newest pair when past everything received
    let a = buf.length > 1 ? buf[buf.length - 2] : buf[0];
    let b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= target && buf[i + 1].t >= target) { a = buf[i]; b = buf[i + 1]; break; }
    }
    const span = b.t - a.t;
    const k = span > 0 ? Math.min(1.4, Math.max(0, (target - a.t) / span)) : 1;

    this.pos.set(lerp(a.x, b.x, k), lerp(a.y, b.y, k), lerp(a.z, b.z, k));
    this.yaw = lerpAngle(a.yaw, b.yaw, k);
    this.pitch = lerp(a.pitch, b.pitch, k);
    this.height = lerp(a.h, b.h, k);
    this.up = upFromIndex(b.u ?? 2);     // never interpolated: a change empties the buffer

    this.group.visible = this.alive && !this.settling;
    // hit boxes stay on the real body, never the ghost
    this._pose(this.pos, this.up, this.yaw, this.pitch, this.height, this.weapon,
               this.group.visible && this.portals ? this.portals.links() : null);

    if (this.flash > 0) {
      this.flash -= dt;
      const on = this.flash > 0;
      for (const p of [this.parts, this.gparts]) {
        p.mat.color.copy(on ? WHITE : this.color);
        p.headMat.color.copy(on ? WHITE : this.color.clone().offsetHSL(0, 0, 0.12));
      }
    }
  }

  /** Hit boxes matching what this screen draws. */
  boxes() {
    const p = this.pos, s = this.height / 1.8, u = this.up;
    const at = (d, r) => {
      const c = { x: p.x + u.x * d, y: p.y + u.y * d, z: p.z + u.z * d };
      return {
        min: { x: c.x - r.x, y: c.y - r.y, z: c.z - r.z },
        max: { x: c.x + r.x, y: c.y + r.y, z: c.z + r.z }
      };
    };
    const H = HEAD_H / 2;
    if (!u.x && !u.y && !u.z) return [];
    if (Math.abs(u.x) < 0.999 && Math.abs(u.y) < 0.999 && Math.abs(u.z) < 0.999) {
      // tilted: one box around the whole body
      const top = { x: p.x + u.x * 1.8 * s, y: p.y + u.y * 1.8 * s, z: p.z + u.z * 1.8 * s };
      const box = { min: {}, max: {} };
      for (const a of ['x', 'y', 'z']) {
        box.min[a] = Math.min(p[a], top[a]) - BODY_R;
        box.max[a] = Math.max(p[a], top[a]) + BODY_R;
      }
      return [{ head: false, ...box }];
    }
    const head = at(1.62 * s, { x: H, y: H, z: H });
    const bodyTop = 1.62 * s - H;
    const bodyR = {
      x: u.x ? bodyTop / 2 : BODY_R,
      y: u.y ? bodyTop / 2 : BODY_R,
      z: u.z ? bodyTop / 2 : BODY_R
    };
    const body = at(bodyTop / 2, bodyR);
    return [{ head: true, ...head }, { head: false, ...body }];
  }

  raycast(origin, dir, maxDist) {
    if (!this.alive) return null;
    let best = null;
    for (const b of this.boxes()) {
      const t = rayAABB(origin, dir, b.min, b.max);
      if (t < maxDist && (!best || t < best.dist)) best = { dist: t, head: b.head, player: this };
    }
    return best;
  }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.ghost);
    for (const root of [this.group, this.ghost]) {
      root.traverse(o => {
        o.geometry?.dispose?.();
        const m = o.material;
        if (!m) return;
        for (const one of Array.isArray(m) ? m : [m]) { one.map?.dispose?.(); one.dispose?.(); }
      });
    }
  }
}

/** Your own body, drawn only into portal views (PortalField shows `root` there). */
export class SelfAvatar extends Avatar {
  constructor(scene) {
    super(PLAYER_COLORS[0], '');
    this.root = new THREE.Group();
    this.root.add(this.group, this.ghost);
    this.root.visible = false;
    scene.add(this.root);
  }

  update(player, weaponIndex = 0) {
    this._pose(player.pos, player.up, player.yaw, player.pitch, player.height, weaponIndex,
               player.portals ? player.portals.links() : null);
  }
}
