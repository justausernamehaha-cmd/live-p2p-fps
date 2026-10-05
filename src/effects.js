import * as THREE from 'three';
import { buildGun, paintGun } from './gunmodel.js';
import { WEAPONS } from './weapons.js';

const TRACERS = 192;     // a shotgun through a corridor of portals is a leg per pellet per trip
const IMPACTS = 32;

export class Effects {
  constructor(scene, camera, vmScene) {
    this.scene = scene;
    this.camera = camera;
    this.tracers = [];
    this.impacts = [];
    this.shake = 0;

    const tracerGeo = new THREE.BufferGeometry();
    tracerGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    for (let i = 0; i < TRACERS; i++) {
      const mat = new THREE.LineBasicMaterial({
        color: 0xffd08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
      });
      const line = new THREE.Line(tracerGeo.clone(), mat);
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.tracers.push({ line, life: 0 });
    }

    const impactGeo = new THREE.PlaneGeometry(0.35, 0.35);
    for (let i = 0; i < IMPACTS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
      });
      const m = new THREE.Mesh(impactGeo, mat);
      m.visible = false;
      scene.add(m);
      this.impacts.push({ mesh: m, life: 0 });
    }

    // one flash lights the world; the viewmodel scene needs its own
    this.flash = new THREE.PointLight(0xffc070, 0, 12);
    this.flash.position.set(0.28, -0.22, -0.9);
    camera.add(this.flash);
    this.vmFlash = new THREE.PointLight(0xffc070, 0, 4);
    this.vmFlash.position.set(0.3, -0.1, -1.1);
    vmScene.add(this.vmFlash);
    this.flashLife = 0;
  }

  tracer(from, to, color = 0xffd08a) {
    const slot = this.tracers.find(t => t.life <= 0) || this.tracers[0];
    const p = slot.line.geometry.attributes.position;
    p.setXYZ(0, from.x, from.y, from.z);
    p.setXYZ(1, to.x, to.y, to.z);
    p.needsUpdate = true;
    slot.line.material.color.setHex(color);
    slot.line.material.opacity = 0.9;
    slot.line.visible = true;
    slot.life = 0.09;
  }

  _splash(x, y, z, color, opacity, scale, life) {
    const slot = this.impacts.find(t => t.life <= 0) || this.impacts[0];
    slot.mesh.position.set(x, y, z);
    slot.mesh.lookAt(this.camera.position);
    slot.mesh.material.color.setHex(color);
    slot.mesh.material.opacity = opacity;
    slot.mesh.scale.setScalar(scale);
    slot.mesh.visible = true;
    slot.life = life;
  }

  impact(point, dir) {
    this._splash(point.x - dir.x * 0.02, point.y - dir.y * 0.02, point.z - dir.z * 0.02,
                 0xffe0b0, 0.85, 1, 0.22);
  }

  /** A portal shot with nowhere to go: bigger, and in the portal's colour. */
  burst(point, color = 0xffffff) {
    this._splash(point.x, point.y, point.z, color, 1, 2.4, 0.3);
  }

  muzzle(scale = 1) {
    this.flash.intensity = 9 * scale;
    this.vmFlash.intensity = 3.5 * scale;
    this.flashLife = 0.05;
    this.shake = Math.min(0.35, this.shake + 0.05 * scale);
  }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.09) * 0.9;
      if (t.life <= 0) t.line.visible = false;
    }
    for (const t of this.impacts) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const k = Math.max(0, t.life / 0.22);
      t.mesh.material.opacity = k * 0.85;
      t.mesh.scale.setScalar(1 + (1 - k) * 1.6);
      if (t.life <= 0) t.mesh.visible = false;
    }
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      if (this.flashLife <= 0) { this.flash.intensity = 0; this.vmFlash.intensity = 0; }
    }
    this.shake *= Math.exp(-11 * dt);
  }
}

/** The gun in view. It lives in its own scene, drawn after a depth clear, so it
 *  stays whole when pressed into a wall; that scene's camera sits at the origin,
 *  so its transform is camera-relative. */
export class ViewModel {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.position.set(0.25, -0.2, -0.78);
    this.group.scale.setScalar(0.96);
    parent.add(this.group);
    this.kick = 0;
    this.reloadT = 0;
    this.sway = { x: 0, y: 0 };

    // the same model the body carries (gunmodel.js), so you see what others see
    this.gun = new THREE.Group();
    this.group.add(this.gun);
    // tracers leave from here; as a child it inherits every scale and sway
    this.muzzleTip = new THREE.Object3D();
    this.group.add(this.muzzleTip);
    this.setWeapon(0);
  }

  /** The portal gun's accent wears your pair. */
  setAccents(left, right) { paintGun(this.gun, left, right); }

  setWeapon(index) {
    const { muzzle } = buildGun(this.gun, WEAPONS[index] || WEAPONS[0]);
    this.muzzleTip.position.copy(muzzle);
  }

  fire(scale = 1) { this.kick = Math.min(0.16, this.kick + 0.055 * scale); }

  /** Muzzle position in camera space. */
  muzzleOffset(target) {
    this.group.updateMatrixWorld(true);
    return this.muzzleTip.getWorldPosition(target);
  }

  update(dt, player, reloading, adsT = 0) {
    this.kick *= Math.exp(-13 * dt);
    const targetSwayX = -player.vel.x * 0.004;
    const targetSwayY = player.vel.y * 0.003;
    this.sway.x += (targetSwayX - this.sway.x) * Math.min(1, dt * 8);
    this.sway.y += (targetSwayY - this.sway.y) * Math.min(1, dt * 8);

    const steady = 1 - adsT;       // aiming holds the gun still
    this.group.position.set(
      0.25 + this.sway.x * steady,
      -0.2 + (player.bob * 0.6 + this.sway.y) * steady - this.kick * 0.12 * steady,
      -0.78 + this.kick * steady
    );
    this.reloadT += ((reloading ? 1 : 0) - this.reloadT) * Math.min(1, dt * 7);
    this.group.rotation.x = -this.kick * 1.4 * steady - this.reloadT * 0.55;
    this.group.rotation.z = this.reloadT * 0.3;
    this.group.visible = player.alive;
  }
}
