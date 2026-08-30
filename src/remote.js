import * as THREE from 'three';
import { lerp, lerpAngle, PLAYER_COLORS, cssColor, hash, now, num } from './util.js';
import { rayAABB } from './world.js';
import { UP_Y, upFromIndex, basisFor } from './frame.js';
import { mouthAround, portalMap } from './portal.js';

// How near a mouth a body has to be for the other half of it to be drawn out of
// the far one. The same numbers the player's own collision uses, and they have
// to be: what is drawn is what the physics thinks is happening.
const GHOST_REACH = 0.2;      // RADIUS + 0.03 in player.js
const GHOST_EDGE = 0.17;      // RADIUS

/** The other half of a body: where it hangs out of the far mouth, as a position
 *  and a turn.
 *
 *  A body standing in a portal is in two places at once, and both of them are
 *  real — the half inside the wall is hidden by that wall's own geometry, and
 *  the half out of the other mouth is this. There is no clipping to do: the
 *  walls do it, because each half is behind the surface its mouth is cut into.
 *
 *  Rigid, unlike the body it copies. A player is always upright in their own
 *  frame, but their reflection through a mouth is whatever the portal's
 *  transform makes of them, so the two halves meet exactly at the surface even
 *  where the pair is not square to itself. */
export function ghostOf(links, pos, up, yaw, height) {
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

const INTERP_DELAY = 110;    // ms of buffered lag; smooths jitter between peers
const BUFFER = 24;
const HEAD_H = 0.34;
// The body is exactly as wide as the head is long, so the silhouette reads as one
// consistent shape. The hit boxes below are built from the same constants, which
// keeps the "what you see is what you shoot" promise intact.
const BODY_R = HEAD_H / 2;

export class RemotePlayer {
  constructor(id, scene) {
    this.id = id;
    this.name = id.slice(0, 6);
    this.colorHex = PLAYER_COLORS[hash(id) % PLAYER_COLORS.length];
    this.color = new THREE.Color(this.colorHex);
    this.buffer = [];
    this.kills = 0;
    this.deaths = 0;
    this.hp = 100;
    this.alive = true;
    this.ping = 0;
    this.lastSeen = now();
    this.flash = 0;
    this.spawnSeq = -1;
    this.portalRandom = 0;  // their contribution to everybody's portal colours
    this.settling = true;   // hide until we have real snapshots at the current spawn
    this.shielded = false;

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.height = 1.8;
    this.up = UP_Y;          // a peer standing on a wall is standing on a wall
    this._basis = new THREE.Matrix4();
    this._vr = new THREE.Vector3();
    this._vu = new THREE.Vector3();
    this._vb = new THREE.Vector3();

    this.group = new THREE.Group();
    // emissive so an enemy never blends into the grey-blue level
    const mat = new THREE.MeshLambertMaterial({
      color: this.color,
      emissive: this.color.clone().multiplyScalar(0.35)
    });
    this.mat = mat;

    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(BODY_R, 1.8 - HEAD_H - BODY_R * 2, 4, 12), mat);
    this.body.position.y = 0.72;
    this.group.add(this.body);

    this.head = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_H, HEAD_H, HEAD_H),
      new THREE.MeshLambertMaterial({
        color: this.color.clone().offsetHSL(0, 0, 0.12),
        emissive: this.color.clone().multiplyScalar(0.3)
      })
    );
    this.head.position.y = 1.62;
    this.group.add(this.head);

    // gun stub so you can read which way they are aiming
    this.gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.6),
      new THREE.MeshLambertMaterial({ color: 0x232936 })
    );
    this.gun.position.set(0.22, 1.35, -0.4);
    this.group.add(this.gun);

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.group.add(this.shadow);

    this.label = makeLabel(this.name, cssColor(this.colorHex));
    this.label.position.y = 2.25;
    this.group.add(this.label);

    this.group.visible = false;   // nothing to draw until a snapshot arrives
    scene.add(this.group);
    this.scene = scene;

    // the half of them that is out of the other mouth, when they are standing
    // in a portal: the same three meshes, the same materials, somewhere else
    this.ghost = new THREE.Group();
    this.gBody = new THREE.Mesh(this.body.geometry, mat);
    this.gHead = new THREE.Mesh(this.head.geometry, this.head.material);
    this.gGun = new THREE.Mesh(this.gun.geometry, this.gun.material);
    this.ghost.add(this.gBody, this.gHead, this.gGun);
    this.ghost.visible = false;
    scene.add(this.ghost);
    this.portals = null;          // set by the game
    this._gm = new THREE.Matrix4();
    this._g1 = new THREE.Vector3();
    this._g2 = new THREE.Vector3();
    this._g3 = new THREE.Vector3();
  }

  setName(name) {
    if (!name || name === this.name) return;
    this.name = name;
    this._rebuildLabel();
  }

  /** Room membership decides colours, so this changes as people come and go. */
  setColor(hex) {
    if (hex === this.colorHex) return;
    this.colorHex = hex;
    this.color.setHex(hex);
    this.mat.color.copy(this.color);
    this.mat.emissive.copy(this.color).multiplyScalar(0.35);
    this.head.material.color.copy(this.color).offsetHSL(0, 0, 0.12);
    this.head.material.emissive.copy(this.color).multiplyScalar(0.3);
    this._rebuildLabel();
  }

  _rebuildLabel() {
    this.group.remove(this.label);
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.label = makeLabel(this.name, cssColor(this.colorHex));
    this.label.position.y = 2.25;
    this.group.add(this.label);
  }

  onState(s) {
    this.lastSeen = now();

    // A respawn teleports them. Interpolating across that would drag the body
    // through the level, so throw the old samples away and stay hidden until
    // there are enough new ones to interpolate between at the new position.
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

    // default to the newest pair (i.e. extrapolate) when the target time is
    // past everything we have received
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

    // Up never interpolates: it changes only by going through a portal, which
    // bumps the sequence number and empties this buffer anyway, so the newer
    // sample is the answer and a half-turned body is never drawn.
    this.up = upFromIndex(b.u ?? 2);
    this.group.position.copy(this.pos);
    // The body is modelled standing up its own local +y and looking down its
    // own -z; put that frame where the player's actually is.
    const f = basisFor(this.up, this.yaw);
    this._basis.makeBasis(
      this._vr.set(f.r.x, f.r.y, f.r.z),
      this._vu.set(this.up.x, this.up.y, this.up.z),
      this._vb.set(-f.f.x, -f.f.y, -f.f.z)
    );
    this.group.quaternion.setFromRotationMatrix(this._basis);
    const scaleY = this.height / 1.8;
    this.body.scale.y = scaleY;
    this.body.position.y = 0.72 * scaleY;
    this.head.position.y = 1.62 * scaleY;
    this.gun.position.y = 1.35 * scaleY;
    this.gun.rotation.x = -this.pitch;
    this.label.position.y = 2.25 * scaleY + 0.1;
    this.group.visible = this.alive && !this.settling;
    this._ghost(scaleY);

    if (this.flash > 0) {
      this.flash -= dt;
      const on = this.flash > 0;
      this.mat.color.copy(on ? WHITE : this.color);
      this.head.material.color.copy(on ? WHITE : this.color.clone().offsetHSL(0, 0, 0.12));
    }
  }

  /** Draw the half of them that is out of the far mouth, if they are standing
   *  in one. Hit boxes deliberately stay on the real body: shooting a reflection
   *  would be shooting somebody who is not there, and a bullet has its own way
   *  through a portal already. */
  _ghost(scaleY) {
    const g = this.group.visible && this.portals
      ? ghostOf(this.portals.links(), this.pos, this.up, this.yaw, this.height)
      : null;
    this.ghost.visible = !!g;
    if (!g) return;
    this.ghost.position.set(g.pos.x, g.pos.y, g.pos.z);
    this._gm.makeBasis(
      this._g1.set(g.right.x, g.right.y, g.right.z),
      this._g2.set(g.up.x, g.up.y, g.up.z),
      this._g3.set(g.back.x, g.back.y, g.back.z)
    );
    this.ghost.quaternion.setFromRotationMatrix(this._gm);
    this.gBody.scale.y = scaleY;
    this.gBody.position.y = 0.72 * scaleY;
    this.gHead.position.y = 1.62 * scaleY;
    this.gGun.position.set(0.22, 1.35 * scaleY, -0.4);
    this.gGun.rotation.x = -this.pitch;
  }

  /** hit boxes match what is drawn on this screen, so what you see is what you shoot */
  boxes() {
    const p = this.pos, s = this.height / 1.8, u = this.up;
    // Boxes along whichever axis they are standing up. Up is always a world
    // axis, so these stay axis-aligned however the body is turned, and what you
    // see is still exactly what you shoot.
    const at = (d, r) => {
      const c = { x: p.x + u.x * d, y: p.y + u.y * d, z: p.z + u.z * d };
      return {
        min: { x: c.x - r.x, y: c.y - r.y, z: c.z - r.z },
        max: { x: c.x + r.x, y: c.y + r.y, z: c.z + r.z }
      };
    };
    const H = HEAD_H / 2;
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
    this.body.geometry.dispose();
    this.head.geometry.dispose();
    this.gun.geometry.dispose();
    this.shadow.geometry.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.mat.dispose();
  }
}

const WHITE = new THREE.Color(0xffffff);

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
  // depth-tested on purpose: a name tag visible through a wall is a wallhack
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}

/** The local player's own body.
 *
 *  There has never been one: this is a first-person game and the only thing on
 *  screen was the gun. Seeing yourself through a portal needs something to see,
 *  so this follows the player around and is drawn *only* into portal views —
 *  PortalField hides it for the player's own camera, where it would be a torso
 *  hanging in front of their face.
 *
 *  It is deliberately the same silhouette as a RemotePlayer, so what you see of
 *  yourself is what everyone else sees of you. */
export class SelfAvatar {
  constructor(scene) {
    this.group = new THREE.Group();
    this._m = new THREE.Matrix4();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this.color = new THREE.Color(PLAYER_COLORS[0]);
    const mat = new THREE.MeshLambertMaterial({
      color: this.color, emissive: this.color.clone().multiplyScalar(0.35)
    });
    this.mat = mat;
    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(BODY_R, 1.8 - HEAD_H - BODY_R * 2, 4, 12), mat);
    this.body.position.y = 0.72;
    this.head = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_H, HEAD_H, HEAD_H),
      new THREE.MeshLambertMaterial({
        color: this.color.clone().offsetHSL(0, 0, 0.12),
        emissive: this.color.clone().multiplyScalar(0.3)
      })
    );
    this.head.position.y = 1.62;
    this.gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.6),
      new THREE.MeshLambertMaterial({ color: 0x232936 })
    );
    this.gun.position.set(0.22, 1.35, -0.4);
    this.group.add(this.body, this.head, this.gun);

    // your own other half, for when you are standing in a mouth and looking at
    // the one you are hanging out of
    this.ghost = new THREE.Group();
    this.gBody = new THREE.Mesh(this.body.geometry, mat);
    this.gHead = new THREE.Mesh(this.head.geometry, this.head.material);
    this.gGun = new THREE.Mesh(this.gun.geometry, this.gun.material);
    this.gBody.position.y = 0.72;
    this.gHead.position.y = 1.62;
    this.gGun.position.set(0.22, 1.35, -0.4);
    this.ghost.add(this.gBody, this.gHead, this.gGun);

    // One root for both halves, because what the portal views turn on and off is
    // "the player's own body", and that is two pieces now.
    this.root = new THREE.Group();
    this.root.add(this.group, this.ghost);
    this.root.visible = false;       // portal views only
    scene.add(this.root);
  }

  setColor(hex) {
    if (hex === undefined || hex === this.colorHex) return;
    this.colorHex = hex;
    this.color.setHex(hex);
    this.mat.color.copy(this.color);
    this.mat.emissive.copy(this.color).multiplyScalar(0.35);
    this.head.material.color.copy(this.color).offsetHSL(0, 0, 0.12);
    this.head.material.emissive.copy(this.color).multiplyScalar(0.3);
  }

  update(player) {
    const s = player.height / 1.8;
    this.group.position.set(player.pos.x, player.pos.y, player.pos.z);
    const f = basisFor(player.up, player.yaw);
    this._m.makeBasis(
      this._a.set(f.r.x, f.r.y, f.r.z),
      this._b.set(player.up.x, player.up.y, player.up.z),
      this._c.set(-f.f.x, -f.f.y, -f.f.z)
    );
    this.group.quaternion.setFromRotationMatrix(this._m);
    this.body.scale.y = s;
    this.body.position.y = 0.72 * s;
    this.head.position.y = 1.62 * s;
    this.gun.position.y = 1.35 * s;
    this.gun.rotation.x = -player.pitch;

    const g = player.portals
      ? ghostOf(player.portals.links(), player.pos, player.up, player.yaw, player.height)
      : null;
    this.ghost.visible = !!g;
    if (!g) return;
    this.ghost.position.set(g.pos.x, g.pos.y, g.pos.z);
    this._m.makeBasis(
      this._a.set(g.right.x, g.right.y, g.right.z),
      this._b.set(g.up.x, g.up.y, g.up.z),
      this._c.set(g.back.x, g.back.y, g.back.z)
    );
    this.ghost.quaternion.setFromRotationMatrix(this._m);
    this.gBody.scale.y = s;
    this.gBody.position.y = 0.72 * s;
    this.gHead.position.y = 1.62 * s;
    this.gGun.position.y = 1.35 * s;
    this.gGun.rotation.x = -player.pitch;
  }
}
