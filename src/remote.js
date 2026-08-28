import * as THREE from 'three';
import { lerp, lerpAngle, colorFor, hueFor, now, num } from './util.js';
import { rayAABB } from './world.js';

const INTERP_DELAY = 110;    // ms of buffered lag; smooths jitter between peers
const BUFFER = 24;
const BODY_R = 0.4;
const HEAD_H = 0.34;

export class RemotePlayer {
  constructor(id, scene) {
    this.id = id;
    this.name = id.slice(0, 6);
    this.color = new THREE.Color().setHSL(hueFor(id) / 360, 0.75, 0.58);
    this.buffer = [];
    this.kills = 0;
    this.deaths = 0;
    this.hp = 100;
    this.alive = true;
    this.ping = 0;
    this.lastSeen = now();
    this.flash = 0;

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.height = 1.8;

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

    this.label = makeLabel(this.name, colorFor(id));
    this.label.position.y = 2.25;
    this.group.add(this.label);

    this.group.visible = false;   // nothing to draw until a snapshot arrives
    scene.add(this.group);
    this.scene = scene;
  }

  setName(name) {
    if (!name || name === this.name) return;
    this.name = name;
    this.group.remove(this.label);
    this.label.material.map.dispose();
    this.label.material.dispose();
    this.label = makeLabel(name, '#' + this.color.getHexString());
    this.label.position.y = 2.25;
    this.group.add(this.label);
  }

  onState(s) {
    this.lastSeen = now();
    this.buffer.push({
      t: this.lastSeen,
      x: num(s.x), y: num(s.y), z: num(s.z),
      yaw: num(s.a), pitch: num(s.b), h: num(s.h, 1.8)
    });
    if (this.buffer.length > BUFFER) this.buffer.shift();
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

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    const scaleY = this.height / 1.8;
    this.body.scale.y = scaleY;
    this.body.position.y = 0.72 * scaleY;
    this.head.position.y = 1.62 * scaleY;
    this.gun.position.y = 1.35 * scaleY;
    this.gun.rotation.x = -this.pitch;
    this.label.position.y = 2.25 * scaleY + 0.1;
    this.group.visible = this.alive;

    if (this.flash > 0) {
      this.flash -= dt;
      const on = this.flash > 0;
      this.mat.color.copy(on ? WHITE : this.color);
      this.head.material.color.copy(on ? WHITE : this.color.clone().offsetHSL(0, 0, 0.12));
    }
  }

  /** hit boxes match what is drawn on this screen, so what you see is what you shoot */
  boxes() {
    const p = this.pos, s = this.height / 1.8;
    return [
      {
        head: true,
        min: { x: p.x - HEAD_H / 2, y: p.y + 1.62 * s - HEAD_H / 2, z: p.z - HEAD_H / 2 },
        max: { x: p.x + HEAD_H / 2, y: p.y + 1.62 * s + HEAD_H / 2, z: p.z + HEAD_H / 2 }
      },
      {
        head: false,
        min: { x: p.x - BODY_R, y: p.y, z: p.z - BODY_R },
        max: { x: p.x + BODY_R, y: p.y + 1.62 * s - HEAD_H / 2, z: p.z + BODY_R }
      }
    ];
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
