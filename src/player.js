import { clamp } from './util.js';
import { aabbOverlap } from './world.js';

const RADIUS = 0.4;
const HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.15;
const EYE_RATIO = 0.9;          // eye sits at 90% of current height
const STEP_HEIGHT = 0.55;

const GRAVITY = 24;
const JUMP_SPEED = 8.2;
const WALK = 6.2;
const SPRINT = 9.0;
const CROUCH_SPEED = 3.0;
const ACCEL = 70;               // ground acceleration
const AIR_ACCEL = 14;
const FRICTION = 11;
const MAX_PITCH = Math.PI / 2 - 0.01;

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = { x: 0, y: 2, z: 0 };     // feet position
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.height = HEIGHT;
    this.crouching = false;
    this.onGround = false;
    this.hp = 100;
    this.alive = true;
    this.respawnAt = 0;
    this.kills = 0;
    this.deaths = 0;
    this.bobPhase = 0;
    this.bob = 0;
    this.recoil = 0;             // extra pitch, decays
    this.recoilYaw = 0;
  }

  get eyeY() { return this.pos.y + this.height * EYE_RATIO; }

  aabb(pos = this.pos, height = this.height) {
    return {
      min: { x: pos.x - RADIUS, y: pos.y, z: pos.z - RADIUS },
      max: { x: pos.x + RADIUS, y: pos.y + height, z: pos.z + RADIUS }
    };
  }

  spawn(point) {
    this.pos = { x: point.x, y: point.y, z: point.z };
    this.height = HEIGHT;
    this.crouching = false;
    // lift out of anything the spawn point happens to clip
    for (let i = 0; i < 12 && this._overlaps(this.world.boxes); i++) this.pos.y += 0.5;
    this.vel = { x: 0, y: 0, z: 0 };
    this.hp = 100;
    this.alive = true;
    this.yaw = Math.atan2(point.x, point.z);   // face the middle of the arena
    this.pitch = 0;
  }

  look(dx, dy) {
    if (!this.alive) return;
    this.yaw -= dx;
    this.pitch = clamp(this.pitch - dy, -MAX_PITCH, MAX_PITCH);
  }

  addRecoil(pitchKick, yawKick) {
    this.recoil += pitchKick;
    this.recoilYaw += yawKick;
  }

  update(dt, input) {
    // recoil relaxes back toward zero and is folded into the view, not the state,
    // so remote players never see a jittering aim direction
    this.recoil *= Math.exp(-9 * dt);
    this.recoilYaw *= Math.exp(-9 * dt);

    if (!this.alive) {
      this.vel.x = this.vel.z = 0;
      return;
    }

    const wish = input.moveVector();
    const wantCrouch = input.down('crouch');
    this._setCrouch(wantCrouch);

    const sprinting = input.down('sprint') && !this.crouching && wish.y > 0.1;
    const maxSpeed = this.crouching ? CROUCH_SPEED : sprinting ? SPRINT : WALK;

    // world-space wish direction from yaw
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = wish.x * cos - wish.y * sin;
    const wz = wish.x * sin + wish.y * cos;

    const accel = this.onGround ? ACCEL : AIR_ACCEL;
    this.vel.x += wx * accel * dt;
    this.vel.z += wz * accel * dt;

    // friction only when no input, so strafing keeps its momentum
    if (this.onGround && Math.hypot(wish.x, wish.y) < 0.05) {
      const drop = Math.max(0, 1 - FRICTION * dt);
      this.vel.x *= drop;
      this.vel.z *= drop;
    }

    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > maxSpeed) {
      this.vel.x *= maxSpeed / speed;
      this.vel.z *= maxSpeed / speed;
    }

    if (input.down('jump') && this.onGround) {
      this.vel.y = JUMP_SPEED;
      this.onGround = false;
    }

    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -60) this.vel.y = -60;

    this._move(dt);

    // view bob, purely cosmetic
    const groundSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && groundSpeed > 0.5) {
      this.bobPhase += dt * groundSpeed * 1.5;
      this.bob = Math.sin(this.bobPhase) * 0.035 * Math.min(1, groundSpeed / WALK);
    } else {
      this.bob *= Math.exp(-8 * dt);
    }
  }

  _setCrouch(want) {
    if (want === this.crouching) return;
    if (want) {
      this.crouching = true;
      this.height = CROUCH_HEIGHT;
    } else {
      // refuse to stand up inside geometry
      const test = this.aabb(this.pos, HEIGHT);
      for (const b of this.world.boxes) if (aabbOverlap(test, b)) return;
      this.crouching = false;
      this.height = HEIGHT;
    }
  }

  _move(dt) {
    const boxes = this.world.boxes;
    const dx = this.vel.x * dt;
    const dz = this.vel.z * dt;
    const start = { ...this.pos };

    // horizontal move, resolved one axis at a time
    const blockedX = this._axis('x', dx, boxes);
    const blockedZ = this._axis('z', dz, boxes);
    const flat = { ...this.pos };

    // if something got in the way, retry the same move one step higher so
    // stairs, kerbs and crate edges are walked over instead of into
    if ((blockedX || blockedZ) && this.onGround) {
      this.pos = { ...start, y: start.y + STEP_HEIGHT };
      if (this._overlaps(boxes)) {
        this.pos = flat;
      } else {
        this._axis('x', dx, boxes);
        this._axis('z', dz, boxes);
        this._axis('y', -STEP_HEIGHT, boxes);     // settle onto the step
        const stepped = Math.hypot(this.pos.x - start.x, this.pos.z - start.z);
        const slid = Math.hypot(flat.x - start.x, flat.z - start.z);
        if (stepped <= slid + 1e-4) this.pos = flat;
      }
    }

    // vertical
    this.onGround = false;
    if (this._axis('y', this.vel.y * dt, boxes)) {
      if (this.vel.y <= 0) this.onGround = true;
      this.vel.y = 0;
    }

    // failsafe: never let a player leak out of the arena
    if (this.pos.y < -20) { this.pos.y = 10; this.vel.y = 0; }
  }

  _overlaps(boxes) {
    const a = this.aabb();
    for (const b of boxes) if (aabbOverlap(a, b)) return true;
    return false;
  }

  /** move along one axis and push out of anything hit; returns true if blocked */
  _axis(axis, amount, boxes) {
    if (amount === 0) return false;
    this.pos[axis] += amount;
    let blocked = false;
    for (const b of boxes) {
      const a = this.aabb();
      if (!aabbOverlap(a, b)) continue;
      blocked = true;
      if (amount > 0) this.pos[axis] -= a.max[axis] - b.min[axis];
      else this.pos[axis] += b.max[axis] - a.min[axis];
    }
    return blocked;
  }

  damage(amount) {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.deaths++;
      return true;      // died
    }
    return false;
  }
}

export { RADIUS, HEIGHT, CROUCH_HEIGHT, EYE_RATIO };
