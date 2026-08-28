import { clamp, lerp } from './util.js';
import { aabbOverlap } from './world.js';

const RADIUS = 0.17;      // matches the rendered body half-width in remote.js
const HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.15;
const EYE_RATIO = 0.9;          // eye sits at 90% of current height
const STEP_HEIGHT = 0.55;

const GRAVITY = 24;
const JUMP_SPEED = 8.2;
const WALK = 6.2;
const SPRINT = 9.0;
const CROUCH_SPEED = 3.0;
// Ground: direct control, Ultrakill style. The input IS the velocity, so a
// direction change is instant and letting go stops you dead — unless you are
// already going faster than a walk, in which case the speed is yours to keep and
// only bleeds off with friction.
//
// Air: Quake acceleration, which is what makes bunny hopping work. Only the
// component of your speed already along the direction you are pushing counts
// against the small AIR_CAP budget, so pressing forward while you are already
// moving forward gains nothing, but holding a strafe key and turning the view
// that way keeps the budget free and adds speed every frame.
// Exposed as an object so the numbers can be swept from a test harness without
// rebuilding; these are the two knobs that decide how bunny hopping feels.
// Swept with test/mechanics.mjs: `cap` is the dominant knob and `accel` saturates
// past about 55. These values make four seconds of strafing worth 11 m/s for a
// slow turn and 16 for a well-judged one, against 6.2 walking and 9 sprinting —
// so better technique is always worth more speed, and the 22 m/s safety cap is
// never reached by hand.
export const AIR = {
  accel: 55,                    // how hard the strafe pulls
  cap: 1.2                      // m/s of "wished" speed the air grants
};
const GROUND_FRICTION = 5;      // stopping friction, only when you stop asking to move
const GROUND_DRAG = 0.35;       // the slow bleed on carried speed while still running
const GROUND_STEER = 9;         // how fast carried momentum can be turned, magnitude kept
const SPEED_CAP = 22;           // sanity limit, well above anything reachable by hand
const MAX_STEP_DIST = 0.3;      // sub-step the movement so fast players cannot tunnel
const STEP_SMOOTH_RATE = 5;     // m/s the view catches up after a step, i.e. a linear climb
const STEP_SMOOTH_MAX = 1.0;
const MAX_PITCH = Math.PI / 2 - 0.01;
const CROUCH_TIME = 0.3;        // seconds to fully crouch or stand, so it cannot flicker

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = { x: 0, y: 2, z: 0 };     // feet position
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.height = HEIGHT;
    this.crouching = false;
    this.crouchT = 0;          // 0 standing, 1 crouched; animated, not snapped
    this.sprintLatch = false;
    this.onGround = false;
    this.hp = 100;
    this.alive = true;
    this.respawnAt = 0;
    this.kills = 0;
    this.deaths = 0;
    this.spawnSeq = 0;        // bumped on every spawn so peers can drop stale interpolation
    this.stepSmooth = 0;      // visual lag behind an instant step up, so stairs are a ramp
    this.bumped = false;      // hit something horizontally this frame
    this.bobPhase = 0;
    this.bob = 0;
    this.recoil = 0;             // extra pitch, decays
    this.recoilYaw = 0;
  }

  /** Collision moves the body up a whole step at once; the view is dragged along
   *  behind it at a constant rate so a staircase is climbed as a straight line
   *  rather than a series of jolts. Shots come from here too, so aim still
   *  matches exactly what is on screen. */
  get eyeY() { return this.pos.y + this.height * EYE_RATIO - this.stepSmooth; }

  aabb(pos = this.pos, height = this.height) {
    return {
      min: { x: pos.x - RADIUS, y: pos.y, z: pos.z - RADIUS },
      max: { x: pos.x + RADIUS, y: pos.y + height, z: pos.z + RADIUS }
    };
  }

  spawn(point) {
    this.spawnSeq++;
    this.pos = { x: point.x, y: point.y, z: point.z };
    this.height = HEIGHT;
    this.crouching = false;
    this.crouchT = 0;
    this.sprintLatch = false;
    this.stepSmooth = 0;
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
    // the view catches up to a step at a constant speed: linear, not easing
    this.stepSmooth = Math.max(0, this.stepSmooth - STEP_SMOOTH_RATE * dt);

    // recoil relaxes back toward zero and is folded into the view, not the state,
    // so remote players never see a jittering aim direction
    this.recoil *= Math.exp(-9 * dt);
    this.recoilYaw *= Math.exp(-9 * dt);

    if (!this.alive) {
      this.vel.x = this.vel.z = 0;
      return;
    }

    const wish = input.moveVector();
    this._crouch(dt, input.down('crouch'));

    // Sprint latches: tapping shift keeps you sprinting until you let go of
    // forward, rather than making you hold two keys down the whole way.
    if (input.down('sprint')) this.sprintLatch = true;
    if (wish.y < 0.1 || this.crouching) this.sprintLatch = false;
    const sprinting = this.sprintLatch && !this.crouching && wish.y > 0.1;

    // speed follows the crouch animation rather than stepping with it
    const upright = sprinting ? SPRINT : WALK;
    const maxSpeed = lerp(upright, CROUCH_SPEED, this.crouchT);

    // World-space wish direction. This basis MUST match the camera, which looks
    // along Ry(yaw) * (0,0,-1):
    //   forward = (-sin yaw, -cos yaw)
    //   right   = ( cos yaw, -sin yaw)
    // Getting the z sign wrong here mirrors the controls: W/S invert when facing
    // along z, A/D invert when facing along x, and both feel swapped in between.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = wish.x * cos - wish.y * sin;
    const wz = -(wish.x * sin + wish.y * cos);

    // Decide the jump now but apply it after the ground move, so a hop still
    // leaves the ground at full running speed. Holding space auto-hops, and a
    // frame that ends in a jump pays no friction at all — that is what lets a
    // chain of hops keep the speed it has built.
    const wantJump = input.down('jump') && this.onGround;

    const wishLen = Math.hypot(wish.x, wish.y);   // already clamped to <= 1
    const speed = Math.hypot(this.vel.x, this.vel.z);

    if (this.onGround) {
      if (speed <= maxSpeed + 0.05) {
        // direct control: you go exactly where you press, at once
        this.vel.x = wx * maxSpeed;
        this.vel.z = wz * maxSpeed;
      } else if (wishLen > 0.02 && !wantJump) {
        // Carrying more than a walk — off a hop chain, a heavy landing, a run
        // down some stairs. Touching the ground must not confiscate that, so the
        // magnitude is kept and only the direction is steered, bleeding at
        // GROUND_DRAG rather than stopping friction.
        //
        // A frame that ends in a jump skips this branch entirely: steering the
        // velocity toward the keys would undo the alignment a strafe jumper just
        // built, which is exactly what a hop chain is made of.
        const k = Math.min(1, GROUND_STEER * dt);
        const nx = this.vel.x + (wx * speed - this.vel.x) * k;
        const nz = this.vel.z + (wz * speed - this.vel.z) * k;
        const m = Math.hypot(nx, nz) || 1;
        this.vel.x = (nx / m) * speed;
        this.vel.z = (nz / m) * speed;
        const drop = Math.max(0, 1 - GROUND_DRAG * dt);
        this.vel.x *= drop;
        this.vel.z *= drop;
      } else if (!wantJump) {
        // you stopped asking to move, so stop
        const drop = Math.max(0, 1 - GROUND_FRICTION * dt);
        this.vel.x *= drop;
        this.vel.z *= drop;
      }
    } else if (Math.abs(wish.x) > 0.02) {
      // Air control, and the whole of bunny hopping.
      //
      // Only the strafe key steers in the air; forward is ignored. That is not a
      // simplification, it is the mechanic: acceleration is only granted up to
      // AIR_CAP of speed *along the direction pushed*, so the input has to stay
      // roughly perpendicular to where you are already going. Holding W would
      // put it 45 degrees off and the budget would already be spent. Hold a
      // strafe key, turn the view that way, and every frame pays out.
      const strafe = Math.sign(wish.x) * Math.min(1, Math.abs(wish.x));
      const dirX = cos * strafe;        // the camera's right vector
      const dirZ = -sin * strafe;
      const len = Math.hypot(dirX, dirZ);
      const nx = dirX / len, nz = dirZ / len;

      const wishSpeed = Math.min(Math.abs(strafe) * maxSpeed, AIR.cap);
      const current = this.vel.x * nx + this.vel.z * nz;
      const add = wishSpeed - current;
      if (add > 0) {
        const accel = Math.min(AIR.accel * wishSpeed * dt, add);
        const beforeMag = Math.hypot(this.vel.x, this.vel.z);
        this.vel.x += nx * accel;
        this.vel.z += nz * accel;

        // Air control redirects, it never brakes. Straight Quake would let the
        // budget go negative and scrub speed when you flip from A to D against
        // your own momentum; here the magnitude is restored, so swapping strafe
        // keys turns the momentum instead of throwing it away.
        const afterMag = Math.hypot(this.vel.x, this.vel.z);
        if (afterMag < beforeMag && afterMag > 1e-4) {
          this.vel.x *= beforeMag / afterMag;
          this.vel.z *= beforeMag / afterMag;
        }
      }
    }

    if (wantJump) {
      this.vel.y = JUMP_SPEED;
      this.onGround = false;
    }

    const after = Math.hypot(this.vel.x, this.vel.z);
    if (after > SPEED_CAP) {
      this.vel.x *= SPEED_CAP / after;
      this.vel.z *= SPEED_CAP / after;
    }

    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -60) this.vel.y = -60;

    this._move(dt);

    // Hitting something ends a hop chain: whatever you had built collapses back
    // to the speed you can run at. Landings and stairs do not trigger this —
    // only a horizontal surface that actually stopped you.
    if (this.bumped) {
      this.bumped = false;
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > maxSpeed && sp > 1e-4) {
        this.vel.x *= maxSpeed / sp;
        this.vel.z *= maxSpeed / sp;
      }
    }

    // view bob, purely cosmetic
    const groundSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && groundSpeed > 0.5) {
      this.bobPhase += dt * groundSpeed * 1.5;
      this.bob = Math.sin(this.bobPhase) * 0.035 * Math.min(1, groundSpeed / WALK);
    } else {
      this.bob *= Math.exp(-8 * dt);
    }
  }

  _crouch(dt, want) {
    const step = dt / CROUCH_TIME;
    if (want) {
      this.crouchT = Math.min(1, this.crouchT + step);
    } else if (this.crouchT > 0) {
      // rise only as far as there is headroom for, so standing under a ledge
      // stops smoothly instead of popping the player into it
      const next = Math.max(0, this.crouchT - step);
      if (!this._blockedAtHeight(lerp(HEIGHT, CROUCH_HEIGHT, next))) this.crouchT = next;
    }
    this.height = lerp(HEIGHT, CROUCH_HEIGHT, this.crouchT);
    this.crouching = this.crouchT > 0.5;
  }

  _blockedAtHeight(h) {
    const test = this.aabb(this.pos, h);
    for (const b of this.world.boxes) if (aabbOverlap(test, b)) return true;
    return false;
  }

  _move(dt) {
    // A cover wall is only 0.6 m thick; at bunny-hop speed a single 50 ms frame
    // would step further than that and pass straight through it.
    const far = Math.max(Math.abs(this.vel.x), Math.abs(this.vel.y), Math.abs(this.vel.z)) * dt;
    const steps = Math.min(8, Math.max(1, Math.ceil(far / MAX_STEP_DIST)));
    for (let i = 0; i < steps; i++) this._moveStep(dt / steps);
  }

  _moveStep(dt) {
    const boxes = this.world.boxes;
    const dx = this.vel.x * dt;
    const dz = this.vel.z * dt;
    const start = { ...this.pos };

    // horizontal move, resolved one axis at a time
    const blockedX = this._axis('x', dx, boxes);
    const blockedZ = this._axis('z', dz, boxes);
    const flat = { ...this.pos };

    // If something got in the way, retry the same move one step higher so stairs,
    // kerbs and crate edges are walked over instead of into. Not gated on being
    // grounded: a player mid-hop clips steps constantly, and refusing to step
    // there is what used to stop a run dead at the bottom of a staircase.
    if ((blockedX || blockedZ) && (this.onGround || this.vel.y <= 0)) {
      this.pos = { ...start, y: start.y + STEP_HEIGHT };
      if (this._overlaps(boxes)) {
        this.pos = flat;
      } else {
        this._axis('x', dx, boxes);
        this._axis('z', dz, boxes);
        this._axis('y', -STEP_HEIGHT, boxes);     // settle onto the step
        const stepped = Math.hypot(this.pos.x - start.x, this.pos.z - start.z);
        const slid = Math.hypot(flat.x - start.x, flat.z - start.z);
        if (stepped <= slid + 1e-4) {
          this.pos = flat;
        } else if (this.pos.y > start.y) {
          // took a step up: hold the view back by the height gained
          this.stepSmooth = Math.min(STEP_SMOOTH_MAX, this.stepSmooth + (this.pos.y - start.y));
        }
      }
    }

    // Anything still genuinely blocked loses its speed along that axis, and flags
    // the frame as a bump. Stairs do not count: the step-up moves you, so the
    // axis is not blocked.
    if (Math.abs(dx) > 1e-6 && Math.abs(this.pos.x - start.x) < Math.abs(dx) * 0.25) {
      this.vel.x = 0;
      this.bumped = true;
    }
    if (Math.abs(dz) > 1e-6 && Math.abs(this.pos.z - start.z) < Math.abs(dz) * 0.25) {
      this.vel.z = 0;
      this.bumped = true;
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
