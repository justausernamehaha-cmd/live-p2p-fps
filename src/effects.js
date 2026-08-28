import * as THREE from 'three';

const TRACERS = 48;
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
      const geo = tracerGeo.clone();
      const mat = new THREE.LineBasicMaterial({
        color: 0xffd08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
      });
      const line = new THREE.Line(geo, mat);
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

    // the world flash lights the level; the second one lives in the viewmodel
    // scene, which is rendered separately and cannot see the first
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

  impact(point, dir) {
    const slot = this.impacts.find(t => t.life <= 0) || this.impacts[0];
    slot.mesh.position.set(point.x - dir.x * 0.02, point.y - dir.y * 0.02, point.z - dir.z * 0.02);
    slot.mesh.lookAt(this.camera.position);
    slot.mesh.material.opacity = 0.85;
    slot.mesh.scale.setScalar(1);
    slot.mesh.visible = true;
    slot.life = 0.22;
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

/** Chunky low-poly gun held in view; purely cosmetic.
 *  Added to a dedicated scene rather than to the camera: main.js renders that
 *  scene in a second pass with the depth buffer cleared, so the gun always draws
 *  on top and stays whole even with the muzzle buried in a wall. Its transform is
 *  camera-relative, which is exactly what a camera sitting at the origin gives. */
export class ViewModel {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.position.set(0.25, -0.2, -0.78);
    this.group.scale.setScalar(0.8);
    parent.add(this.group);
    this.kick = 0;
    this.reloadT = 0;
    this.sway = { x: 0, y: 0 };

    const mk = (w, h, d, color, x, y, z) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshLambertMaterial({ color })
      );
      m.position.set(x, y, z);
      this.group.add(m);
      return m;
    };
    this.body = mk(0.09, 0.11, 0.5, 0x2f3644, 0, 0, -0.1);
    this.barrel = mk(0.05, 0.05, 0.42, 0x1d2230, 0, 0.02, -0.42);

    // An empty parented to the barrel, sitting on its front face. Because it is
    // a child it inherits every per-weapon scale and the whole sway/kick/ADS
    // transform, so a tracer drawn from here leaves the actual muzzle rather
    // than from a constant guessed near it.
    this.muzzleTip = new THREE.Object3D();
    this.muzzleTip.position.set(0, 0, -0.21);      // half the 0.42 barrel length
    this.barrel.add(this.muzzleTip);
    mk(0.07, 0.16, 0.09, 0x232936, 0, -0.12, 0.05);   // grip
    mk(0.07, 0.09, 0.2, 0x232936, 0, -0.03, 0.2);     // stock
    this.accent = mk(0.06, 0.03, 0.14, 0xd9743b, 0, 0.07, -0.12);
  }

  setWeapon(index) {
    // one mesh set, reshaped per weapon — cheaper than three models
    const shapes = [
      { barrel: [0.05, 0.05, 0.42, -0.42], accent: 0xd9743b },
      { barrel: [0.08, 0.08, 0.36, -0.38], accent: 0xe0a33a },
      { barrel: [0.04, 0.04, 0.62, -0.52], accent: 0x3aa89c }
    ];
    const s = shapes[index] || shapes[0];
    this.barrel.scale.set(s.barrel[0] / 0.05, s.barrel[1] / 0.05, s.barrel[2] / 0.42);
    this.barrel.position.z = s.barrel[3];
    this.accent.material.color.setHex(s.accent);
  }

  fire(scale = 1) { this.kick = Math.min(0.16, this.kick + 0.055 * scale); }

  /** Muzzle position in camera space. The viewmodel scene's camera sits at the
   *  origin looking down -Z, so a world position in that scene is already
   *  relative to the player's eye. */
  muzzleOffset(target) {
    this.group.updateMatrixWorld(true);
    return this.muzzleTip.getWorldPosition(target);
  }

  update(dt, player, reloading) {
    this.kick *= Math.exp(-13 * dt);
    const targetSwayX = -player.vel.x * 0.004;
    const targetSwayY = player.vel.y * 0.003;
    this.sway.x += (targetSwayX - this.sway.x) * Math.min(1, dt * 8);
    this.sway.y += (targetSwayY - this.sway.y) * Math.min(1, dt * 8);

    this.group.position.set(
      0.25 + this.sway.x,
      -0.2 + player.bob * 0.6 + this.sway.y - this.kick * 0.12,
      -0.78 + this.kick
    );
    this.reloadT += ((reloading ? 1 : 0) - this.reloadT) * Math.min(1, dt * 7);
    this.group.rotation.x = -this.kick * 1.4 - this.reloadT * 0.55;
    this.group.rotation.z = this.reloadT * 0.3;
    this.group.visible = player.alive;
  }
}
