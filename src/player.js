import { clamp, lerp } from './util.js';
import { aabbOverlap } from './world.js';
import { capsulePush, boxAsSolid } from './solid.js';
import { portalMap, atMouth, pierce, BODY_SAMPLES, HALF_W, HALF_H } from './portal.js';
import {
  UP_Y, snapUp, axisKey, axisSign, crossKeys, flatBasis, basisFor, lookFrom,
  anglesIn, dot3
} from './frame.js';

const RADIUS = 0.17;      // matches the drawn body in remote.js
const HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.15;
const EYE_RATIO = 0.9;
const STEP_HEIGHT = 0.55;

const GRAVITY = 24;
const JUMP_SPEED = 8.2;
const WALK = 6.2;
const SPRINT = 9.0;
const CROUCH_SPEED = 3.0;
// Air control is Quake-style: only speed along the pushed direction counts
// against `cap`, so strafing while turning gains speed (bunny hopping). Exposed
// so test/mechanics.mjs can sweep it.
export const AIR = {
  accel: 55,
  cap: 1.2
};
const FALL_GRAVITY = 1.4;       // falling is heavier than rising
// a landing faster than FALL_MIN pays out ground speed
const FALL_MIN = 12;
const FALL_TO_SPEED = 0.35;
const FALL_SPEED_MAX = 8;
const GROUND_FRICTION = 5;      // when you stop asking to move
const GROUND_DRAG = 0.35;       // bleed on carried speed while still running
const GROUND_STEER = 9;         // how fast carried momentum turns
// There is no speed limit, deliberately.
const MAX_STEP_DIST = 0.3;      // sub-step so fast bodies cannot tunnel
const STEP_SMOOTH_RATE = 5;     // m/s the view catches up after a step
const STEP_SMOOTH_MAX = 1.0;
// Push out to just clear of a face, never exactly touching: exactly touching
// leaves a float's width of overlap that the next axis ejects across the whole
// box, which is how walls became climbable.
const SKIN = 1e-3;
const MAX_PITCH = Math.PI / 2;  // the camera builds its own basis, so no lookAt limit
const CROUCH_TIME = 0.3;
// A mouth is widened by the body radius, so the rim is an entrance.
const PORTAL_EDGE = RADIUS;
// How close to the surface a part of the body must be to count as in the mouth.
const PORTAL_CONTACT = RADIUS + 0.03;
const CRUSH_DEPTH = 0.17;       // past a full crouch by this much, a platform kills
const UP_ROLL_TIME = 0.22;      // the camera rolls to a new up; the body turns at once

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = { x: 0, y: 2, z: 0 };     // feet
    this.vel = { x: 0, y: 0, z: 0 };
    this.up = UP_Y;                      // one of frame.js's eighteen
    this.yaw = 0;
    this.pitch = 0;
    this.height = HEIGHT;
    this.crouching = false;
    this.crouchT = 0;          // 0 standing, 1 crouched
    this.sprintLatch = false;
    this.onGround = false;
    this.fellAt = 0;           // impact speed of this frame's landing
    this.hp = 100;
    this.alive = true;
    this.kills = 0;
    this.deaths = 0;
    this.spawnSeq = 0;        // bumped on every teleport so peers drop interpolation
    this.stepSmooth = 0;      // visual lag behind an instant step up
    this.bumped = false;      // hit something flat-on this frame
    this.bobPhase = 0;
    this.bob = 0;
    this.recoil = 0;
    this.recoilYaw = 0;
    this.portals = null;      // set by the game: something with .links()
    this.straddling = null;   // {link, host}: the mouth the body is in, and its wall
    this._inMouth = null;
    this._wasAt = new Map();  // last step's position in each mouth's frame
    this.portalCount = 0;
    this.upFrom = null;       // the up the camera is rolling out of
    this.upBlend = 0;         // 1 -> 0 across the roll
    this.rideVel = null;      // velocity of the platform underfoot
    this.squashed = false;    // a platform closed on us; the game kills
    this.beingCrushed = false;
    this.escapes = 0;         // times the body left the level
    this.outOfBounds = false; // left the level: the game turns this into a death
  }

  get eyeY() { return this.eye().y; }

  /** The eye in the world, with the step lag; `extra` is the view bob. */
  eye(extra = 0) {
    const d = this.height * EYE_RATIO - this.stepSmooth + extra;
    return {
      x: this.pos.x + this.up.x * d,
      y: this.pos.y + this.up.y * d,
      z: this.pos.z + this.up.z * d
    };
  }

  get upK() { return axisKey(this.up); }
  get upS() { return axisSign(this.up); }
  get flatK() { return crossKeys(this.up); }
  /** Standing at 45 degrees? The axis-only code paths ask this first. */
  get tilted() { return axisKey(this.up) === null; }

  /** Speed along up. */
  get vUp() {
    const k = axisKey(this.up);
    return k ? this.vel[k] * axisSign(this.up) : dot3(this.vel, this.up);
  }
  set vUp(v) {
    const k = axisKey(this.up);
    if (k) { this.vel[k] = v * axisSign(this.up); return; }
    const now = dot3(this.vel, this.up), d = v - now;
    this.vel.x += this.up.x * d;
    this.vel.y += this.up.y * d;
    this.vel.z += this.up.z * d;
  }

  flatSpeed() {
    const f = this.flatK;
    if (f) return Math.hypot(this.vel[f[0]], this.vel[f[1]]);
    const u = dot3(this.vel, this.up);
    return Math.hypot(this.vel.x - this.up.x * u,
                      this.vel.y - this.up.y * u,
                      this.vel.z - this.up.z * u);
  }

  /** The body's box: axis-aligned for any axis up. When tilted, the box around
   *  the capsule (broad phase only; the tilted path collides the capsule). */
  aabb(pos = this.pos, height = this.height) {
    const k = axisKey(this.up);
    if (!k) {
      const u = this.up;
      const min = {}, max = {};
      for (const a of ['x', 'y', 'z']) {
        const lo = Math.min(pos[a], pos[a] + u[a] * height);
        const hi = Math.max(pos[a], pos[a] + u[a] * height);
        min[a] = lo - RADIUS; max[a] = hi + RADIUS;
      }
      return { min, max };
    }
    const s = axisSign(this.up);
    const [a, b] = crossKeys(this.up);
    const min = {}, max = {};
    min[a] = pos[a] - RADIUS; max[a] = pos[a] + RADIUS;
    min[b] = pos[b] - RADIUS; max[b] = pos[b] + RADIUS;
    min[k] = s > 0 ? pos[k] : pos[k] - height;
    max[k] = s > 0 ? pos[k] + height : pos[k];
    return { min, max };
  }

  spawn(point) {
    this.spawnSeq++;
    this.pos = { x: point.x, y: point.y, z: point.z };
    this.up = UP_Y;
    this.upFrom = null;
    this.upBlend = 0;
    this.straddling = null;
    this._inMouth = null;
    this._wasAt = new Map();
    this._wasInside = false;
    this.outOfBounds = false;
    this.height = HEIGHT;
    this.crouching = false;
    this.crouchT = 0;
    this.sprintLatch = false;
    this.stepSmooth = 0;
    for (let i = 0; i < 12 && this._overlaps(this.world.boxes); i++) this.pos.y += 0.5;
    this.vel = { x: 0, y: 0, z: 0 };
    this.hp = 100;
    this.alive = true;
    this.yaw = Math.atan2(point.x, point.z);   // face the middle
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
    this.stepSmooth = Math.max(0, this.stepSmooth - STEP_SMOOTH_RATE * dt);
    if (this.upBlend > 0) this.upBlend = Math.max(0, this.upBlend - dt / UP_ROLL_TIME);

    // Which mouth we are in must be known before platforms ride or crush us:
    // a platform whose mouth we are in goes through us instead.
    if (this.alive) this._updateStraddle(dt);
    if (this.alive) this._ride();

    this.recoil *= Math.exp(-9 * dt);
    this.recoilYaw *= Math.exp(-9 * dt);

    if (!this.alive) {
      const u = this.vUp;             // the dead still fall, but go nowhere flat
      this.vel.x = this.up.x * u;
      this.vel.y = this.up.y * u;
      this.vel.z = this.up.z * u;
      return;
    }

    const wish = input.moveVector();
    this._crouch(dt, input.down('crouch'));
    this._crush();                    // before moving, or _axis() stands us on the platform

    // tap sprint and it holds until you stop going forward
    if (input.down('sprint')) this.sprintLatch = true;
    if (wish.y < 0.1 || this.crouching) this.sprintLatch = false;
    const sprinting = this.sprintLatch && !this.crouching && wish.y > 0.1;

    const upright = sprinting ? SPRINT : WALK;
    const maxSpeed = lerp(upright, CROUCH_SPEED, this.crouchT);

    // Movement is written against two flat directions; for an axis up they are
    // exactly two world axes, so tilted and upright share the same arithmetic.
    const [E1, E2] = flatBasis(this.up);
    const dotV = e => this.vel.x * e.x + this.vel.y * e.y + this.vel.z * e.z;
    const setFlat = (a, b) => {
      const u = this.vUp;
      this.vel.x = this.up.x * u + E1.x * a + E2.x * b;
      this.vel.y = this.up.y * u + E1.y * a + E2.y * b;
      this.vel.z = this.up.z * u + E1.z * a + E2.z * b;
    };
    // must match the camera's basis, or the controls come out mirrored
    const { f, r } = basisFor(this.up, this.yaw);
    const w = {
      x: r.x * wish.x + f.x * wish.y,
      y: r.y * wish.x + f.y * wish.y,
      z: r.z * wish.x + f.z * wish.y
    };

    const wantJump = input.down('jump') && this.onGround;   // holding space auto-hops
    const wishLen = Math.hypot(wish.x, wish.y);
    const speed = this.flatSpeed();
    // A frame ending in a jump keeps its velocity: that is what lets a hop chain
    // keep the speed it built instead of snapping back to the keys on landing.
    const keepMomentum = wantJump && speed > maxSpeed * 0.5;

    let va = dotV(E1), vb = dotV(E2);
    const wa = w.x * E1.x + w.y * E1.y + w.z * E1.z;
    const wb = w.x * E2.x + w.y * E2.y + w.z * E2.z;

    if (this.onGround && !keepMomentum) {
      if (speed <= maxSpeed + 0.05) {
        // direct control
        va = wa * maxSpeed;
        vb = wb * maxSpeed;
      } else if (wishLen > 0.02) {
        // faster than a run: keep the magnitude, steer the direction, bleed slowly
        const k = Math.min(1, GROUND_STEER * dt);
        const na = va + (wa * speed - va) * k;
        const nb = vb + (wb * speed - vb) * k;
        const m = Math.hypot(na, nb) || 1;
        va = (na / m) * speed;
        vb = (nb / m) * speed;
        const drop = Math.max(0, 1 - GROUND_DRAG * dt);
        va *= drop;
        vb *= drop;
      } else {
        const drop = Math.max(0, 1 - GROUND_FRICTION * dt);
        va *= drop;
        vb *= drop;
      }
    } else if (Math.abs(wish.x) > 0.02) {
      // Air: only the strafe key steers.
      const strafe = Math.sign(wish.x) * Math.min(1, Math.abs(wish.x));
      const sgn = Math.sign(strafe);
      const na = (r.x * E1.x + r.y * E1.y + r.z * E1.z) * sgn;
      const nb = (r.x * E2.x + r.y * E2.y + r.z * E2.z) * sgn;

      const wishSpeed = Math.min(Math.abs(strafe) * maxSpeed, AIR.cap);
      const current = va * na + vb * nb;
      const add = wishSpeed - current;
      if (add > 0) {
        const accel = Math.min(AIR.accel * wishSpeed * dt, add);
        const beforeMag = Math.hypot(va, vb);
        va += na * accel;
        vb += nb * accel;
        // air control redirects, never brakes
        const afterMag = Math.hypot(va, vb);
        if (afterMag < beforeMag && afterMag > 1e-4) {
          va *= beforeMag / afterMag;
          vb *= beforeMag / afterMag;
        }
      }
    }
    setFlat(va, vb);

    if (wantJump) {
      this.vUp = JUMP_SPEED;
      this.onGround = false;
      // jumping off a moving platform keeps its flat velocity
      if (this.rideVel) {
        const ru = dot3(this.rideVel, this.up);
        this.vel.x += this.rideVel.x - this.up.x * ru;
        this.vel.y += this.rideVel.y - this.up.y * ru;
        this.vel.z += this.rideVel.z - this.up.z * ru;
      }
    }

    const vu = this.vUp;
    this.vUp = Math.max(-80, vu - GRAVITY * (vu < 0 ? FALL_GRAVITY : 1) * dt);

    this.fellAt = 0;
    this._move(dt);

    // a real drop is paid out as ground speed, along the way you are going
    if (this.fellAt > FALL_MIN) {
      const gain = Math.min(FALL_SPEED_MAX, (this.fellAt - FALL_MIN) * FALL_TO_SPEED);
      const sp = this.flatSpeed();
      let da, db;
      if (sp > 0.5) { da = dotV(E1) / sp; db = dotV(E2) / sp; }
      else if (wishLen > 0.02) { da = wa; db = wb; }
      else { da = db = 0; }
      setFlat(dotV(E1) + da * gain, dotV(E2) + db * gain);
    }

    // hitting a wall collapses built speed back to a run
    if (this.bumped) {
      this.bumped = false;
      const sp = this.flatSpeed();
      if (sp > maxSpeed && sp > 1e-4) {
        const k = maxSpeed / sp;
        setFlat(dotV(E1) * k, dotV(E2) * k);
      }
    }

    const groundSpeed = this.flatSpeed();
    if (this.onGround && groundSpeed > 0.5) {
      this.bobPhase += dt * groundSpeed * 1.5;
      this.bob = Math.sin(this.bobPhase) * 0.035 * Math.min(1, groundSpeed / WALK);
    } else {
      this.bob *= Math.exp(-8 * dt);
    }
  }

  /** Is the shape's footprint across the body's two flat axes under/over us? */
  _overFootprint(s, KA, KB) {
    return !(this.pos[KA] + RADIUS <= s.min[KA] || this.pos[KA] - RADIUS >= s.max[KA] ||
             this.pos[KB] + RADIUS <= s.min[KB] || this.pos[KB] - RADIUS >= s.max[KB]);
  }

  /** Ride the platform underfoot: carry the body by the platform's delta, and
   *  lift a body it has risen into (or the overlap would be ejected across the
   *  whole box). Remembers the platform's velocity for a jump. */
  _ride() {
    this.rideVel = null;
    if (this.tilted) return;          // tilted bodies are not carried
    const movers = this.world.movers;
    if (!movers || !movers.length) return;
    const k = this.upK, up = this.upS;
    const [KA, KB] = this.flatK;
    const through = this._carvedMover();
    for (const m of movers) {
      if (m === through) continue;          // we are in a hole in this one
      const s = m.shape;
      if (!this._overFootprint(s, KA, KB)) continue;
      const top = up > 0 ? s.max[k] : s.min[k];
      const gap = (top - this.pos[k]) * up;
      if (this._faceErased(s, k, top)) continue;
      if (gap > STEP_HEIGHT || gap < -0.12) continue;
      if (gap > 0) {
        if (this.vUp > 0.1) continue;           // jumping off it
        this.pos[k] = top;
        this.onGround = true;
        if (this.vUp < 0) this.vUp = 0;
      } else {
        this.pos.x += m.delta.x;
        this.pos.y += m.delta.y;
        this.pos.z += m.delta.z;
      }
      this.rideVel = { x: m.vel.x, y: m.vel.y, z: m.vel.z };
      return;
    }
  }

  /** What a platform does to somebody in its way. Coming down on the head (or
   *  carrying you up into anything) forces a crouch, then kills past a crouch by
   *  CRUSH_DEPTH. Closing from the side shoves you along its path, and kills if
   *  there is something solid behind you. */
  _crush() {
    this.beingCrushed = false;
    if (this.tilted) return;
    if (!this.alive || !this.world.movers || !this.world.movers.length) return;

    const through = this._carvedMover();   // a mouth in it: we go through instead

    const k = this.upK, up = this.upS;
    const [KA, KB] = this.flatK;
    const carriedUp = !!this.rideVel &&
      (this.rideVel[k] * up) > 0.05 && this.onGround;
    let lowest = Infinity;
    const over = shape => {
      if (!this._overFootprint(shape, KA, KB)) return;
      const near = up > 0 ? shape.min[k] : shape.max[k];
      const gap = (near - this.pos[k]) * up;
      if (gap <= 0.05) return;                             // not above us
      if (this._faceErased(shape, k, near)) return;
      if (gap < lowest) lowest = gap;
    };
    for (const m of this.world.movers) {
      if (m === through) continue;
      over(m.shape);
    }
    if (carriedUp) {
      // being lifted: the level's own ceilings close on us too
      for (const b of this._boxes()) if (b.mover === undefined) over(b);
      for (const q of (this._solids() || [])) over(q);
    }
    if (lowest < Infinity) {
      const headroom = lowest;
      if (headroom < CROUCH_HEIGHT - CRUSH_DEPTH) { this.squashed = true; return; }
      if (headroom < HEIGHT) {
        // keep compressing past a full crouch, or _axis() would push us on top
        const t = clamp((HEIGHT - headroom) / (HEIGHT - CROUCH_HEIGHT), 0, 1);
        if (t > this.crouchT) this.crouchT = t;
        this.height = Math.min(this.height, Math.max(headroom - 0.01, 0.3));
        this.crouching = this.crouchT > 0.5;
        this.beingCrushed = true;
      }
    }

    for (const m of this.world.movers) {
      if (m === through) continue;
      const s = m.shape;
      // sideways movers only; a descending one is handled above
      if (Math.abs(m.vel[k]) > Math.abs(m.vel[KA]) + Math.abs(m.vel[KB])) continue;
      // low enough to step onto: never shove (the shuttles must be boardable)
      if ((up > 0 ? s.max[k] - this.pos[k] : this.pos[k] - s.min[k]) <= STEP_HEIGHT + 0.05) continue;
      if (!s.min || !this._touches(this.aabb(), s)) continue;

      // Only when being run down: on the side it is coming from, and its path the
      // shorter way out. A brush along its length is left to ordinary collision.
      const j = Math.abs(m.vel[KA]) >= Math.abs(m.vel[KB]) ? KA : KB;
      const o = j === KA ? KB : KA;
      const box = this.aabb();
      const depthJ = Math.min(box.max[j] - s.min[j], s.max[j] - box.min[j]);
      const depthO = Math.min(box.max[o] - s.min[o], s.max[o] - box.min[o]);
      const mid = (s.min[j] + s.max[j]) / 2;
      const mySide = this.pos[j] >= mid ? 1 : -1;
      if (m.vel[j] * mySide <= 0 || depthJ > depthO) continue;
      const wasAt = { ...this.pos };
      this.pos[j] = mySide > 0 ? s.max[j] + RADIUS + SKIN : s.min[j] - RADIUS - SKIN;
      this.beingCrushed = true;
      if (this._overlapsStatic()) {
        this.pos = wasAt;          // nowhere to be shoved to
        this.squashed = true;
      }
      return;
    }
  }

  /** Overlapping anything that is not a moving platform, ramps included. */
  _overlapsStatic() {
    const a = this.aabb();
    for (const b of this._boxes()) {
      if (b.mover !== undefined) continue;
      if (this._touches(a, b)) return true;
    }
    const [ax, ay, az, bx, by, bz] = this._capsule();
    for (const s of (this._solids() || [])) {
      if (s.mover !== undefined) continue;
      if (!this._touches(a, s)) continue;
      if (capsulePush(ax, ay, az, bx, by, bz, RADIUS, s)) return true;
    }
    return false;
  }

  _crouch(dt, want) {
    const step = dt / CROUCH_TIME;
    if (want) {
      this.crouchT = Math.min(1, this.crouchT + step);
    } else if (this.crouchT > 0) {
      // rise only as far as there is headroom
      const next = Math.max(0, this.crouchT - step);
      if (!this._blockedAtHeight(lerp(HEIGHT, CROUCH_HEIGHT, next))) this.crouchT = next;
    }
    this.height = lerp(HEIGHT, CROUCH_HEIGHT, this.crouchT);
    this.crouching = this.crouchT > 0.5;
  }

  _blockedAtHeight(h) {
    const test = this.aabb(this.pos, h);
    for (const b of this._boxes()) if (this._touches(test, b)) return true;
    return false;
  }

  _move(dt) {
    const far = Math.max(Math.abs(this.vel.x), Math.abs(this.vel.y), Math.abs(this.vel.z)) * dt;
    const steps = Math.min(8, Math.max(1, Math.ceil(far / MAX_STEP_DIST)));
    // Ground contact is a property of the whole frame, not the last sub-step:
    // a later sub-step with zero vertical move would otherwise clear a landing.
    let grounded = false;
    for (let i = 0; i < steps; i++) {
      this._moveStep(dt / steps);
      grounded = grounded || this.onGround;
    }
    this.onGround = grounded;
  }

  _moveStep(dt) {
    if (this.tilted) return this._moveTilted(dt);

    // Did this step take us through a portal? Asked before the walls are.
    if (this._tryPortal(dt)) return;

    const boxes = this._boxes();
    const k = this.upK, up = this.upS;
    const [KA, KB] = this.flatK;
    const da = this.vel[KA] * dt;
    const db = this.vel[KB] * dt;
    const start = { ...this.pos };

    const blockedA = this._axis(KA, da, boxes);
    const blockedB = this._axis(KB, db, boxes);
    const flat = { ...this.pos };

    // Blocked: retry the move a step higher. Deliberately not gated on being
    // grounded or on falling; rising gating put a wall at the top of every ramp.
    if (blockedA || blockedB) {
      this.pos = { ...start };
      this.pos[k] = start[k] + STEP_HEIGHT * up;
      if (this._overlaps(boxes)) {
        this.pos = flat;
      } else {
        this._axis(KA, da, boxes);
        this._axis(KB, db, boxes);
        this._axis(k, -STEP_HEIGHT * up, boxes);     // settle onto the step
        const stepped = Math.hypot(this.pos[KA] - start[KA], this.pos[KB] - start[KB]);
        const slid = Math.hypot(flat[KA] - start[KA], flat[KB] - start[KB]);
        const climbed = (this.pos[k] - start[k]) * up;
        if (climbed > STEP_HEIGHT + 1e-4) {
          this.pos = flat;                           // never gain more than a step
        } else if (stepped <= slid + 1e-4) {
          this.pos = flat;
        } else if (climbed > 0) {
          this.stepSmooth = Math.min(STEP_SMOOTH_MAX, this.stepSmooth + climbed);
        }
      }
    }

    // still blocked: lose the speed on that axis and flag a bump
    if (Math.abs(da) > 1e-6 && Math.abs(this.pos[KA] - start[KA]) < Math.abs(da) * 0.25) {
      this.vel[KA] = 0;
      this.bumped = true;
    }
    if (Math.abs(db) > 1e-6 && Math.abs(this.pos[KB] - start[KB]) < Math.abs(db) * 0.25) {
      this.vel[KB] = 0;
      this.bumped = true;
    }

    this.onGround = false;
    if (this._axis(k, this.vel[k] * dt, boxes)) {
      if (this.vUp <= 0) {
        this.onGround = true;
        this.fellAt = Math.max(this.fellAt, -this.vUp);
      }
      this.vUp = 0;
    }

    // ramps last: they push out from wherever the box pass left us
    this._resolveSolids();

    // an overlap we did not walk into: out the short way, every step
    if (this._overlaps(this._boxes())) this._unstick();

    // Ask about the crossing again now the step is done, or the frame is drawn
    // from behind the mouth (the one-frame flash going through a portal).
    if (this._tryPortal(0)) return;

    this._failsafe(dt);
  }

  /** Out of bounds is death, instantly: a body more than a metre outside the
   *  level on any axis. Only a body that was inside counts, so a test or a spawn
   *  that places one elsewhere is left alone. */
  _failsafe() {
    const b = this.world.bounds;
    if (!b) return;
    const M = 1;
    const inside = this.pos.x > b.min.x - M && this.pos.x < b.max.x + M &&
                   this.pos.y > b.min.y - M && this.pos.y < b.max.y + M &&
                   this.pos.z > b.min.z - M && this.pos.z < b.max.z + M;
    if (inside) { this._wasInside = true; return; }
    if (!this._wasInside || this.outOfBounds) return;
    this.outOfBounds = true;
    this.escapes++;
    this._oob('left the level');
  }

  /** Why the last out-of-bounds death happened, for the console and the tests. */
  _oob(why) {
    const r = v => v && { x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2) };
    this.oobWhy = { why, pos: r(this.pos), vel: r(this.vel), up: r(this.up),
                    crouch: +this.crouchT.toFixed(2), portals: this.portalCount,
                    inMouth: !!this.straddling, bounds: this.world.bounds &&
                      { min: r(this.world.bounds.min), max: r(this.world.bounds.max) } };
  }

  /** A movement step at 45 degrees: the body is a capsule against everything
   *  (boxes as convex solids). No step-up and no platform riding when tilted. */
  _moveTilted(dt) {
    if (this._tryPortal(dt)) return;

    const start = { ...this.pos };
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    this.onGround = false;
    const before = this.vUp;
    this._pushOutOfEverything();

    // blocked flat: the move went almost nowhere
    const [ux, uy, uz] = [this.up.x, this.up.y, this.up.z];
    const wantU = (this.vel.x * ux + this.vel.y * uy + this.vel.z * uz) * dt;
    const gotX = this.pos.x - start.x, gotY = this.pos.y - start.y, gotZ = this.pos.z - start.z;
    const gotU = gotX * ux + gotY * uy + gotZ * uz;
    const wantFlat = Math.hypot(this.vel.x * dt - ux * wantU,
                                this.vel.y * dt - uy * wantU,
                                this.vel.z * dt - uz * wantU);
    const gotFlat = Math.hypot(gotX - ux * gotU, gotY - uy * gotU, gotZ - uz * gotU);
    if (wantFlat > 1e-6 && gotFlat < wantFlat * 0.25) this.bumped = true;

    if (this.onGround && before <= 0) this.fellAt = Math.max(this.fellAt, -before);

    this._failsafe(dt);
  }

  /** Push out along a capsule hit. A walkable face (agreeing with up) pushes
   *  straight up, so standing on a slope does not creep downhill; anything
   *  steeper pushes along its normal and takes the speed that went into it.
   *  True if the face was walkable. */
  _pushOut(hit) {
    const n = hit.n;
    const facing = n.nx * this.up.x + n.ny * this.up.y + n.nz * this.up.z;
    if (facing > 0.5) {
      const d = hit.depth / facing;
      this.pos.x += this.up.x * d;
      this.pos.y += this.up.y * d;
      this.pos.z += this.up.z * d;
      return true;
    }
    this.pos.x += n.nx * hit.depth;
    this.pos.y += n.ny * hit.depth;
    this.pos.z += n.nz * hit.depth;
    const into = this.vel.x * n.nx + this.vel.y * n.ny + this.vel.z * n.nz;
    if (into < 0) {
      this.vel.x -= n.nx * into;
      this.vel.y -= n.ny * into;
      this.vel.z -= n.nz * into;
      if (Math.abs(facing) < 0.7) this.bumped = true;
    }
    return false;
  }

  /** The tilted body's collision: the capsule out of boxes and solids alike. */
  _pushOutOfEverything() {
    const boxes = this._boxes();
    const solids = this._solids() || [];
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      const a = this.aabb();
      const [ax, ay, az, bx, by, bz] = this._capsule();
      for (const list of [boxes, solids]) {
        for (const raw of list) {
          if (!this._touches(a, raw)) continue;
          const shape = raw.planes ? raw : boxAsSolid(raw);
          const hit = capsulePush(ax, ay, az, bx, by, bz, RADIUS, shape);
          if (!hit) continue;
          moved = true;
          if (this._pushOut(hit)) {
            this.onGround = true;
            if (this.vUp < 0) this.vUp = 0;
          }
          break;                 // one at a time; the next pass catches the rest
        }
        if (moved) break;
      }
      if (!moved) break;
    }
  }

  /** The level's boxes as collision sees them now. While the body is in a
   *  mouth, the wall carrying it is replaced by the pieces left around the hole
   *  (pierce), widened by PORTAL_CONTACT so the hole is never narrower than the
   *  reach that decided we were in it. Cached until mouth or host moves. */
  _boxes() {
    const st = this.straddling;
    const carve = st && st.host;
    if (!carve) return this.world.boxes;
    if (!this.world.boxes.includes(carve)) return this.world.boxes;
    const p = st.link.from;
    const stamp = p.c.x + p.c.y * 3 + p.c.z * 7 +
                  carve.min.x + carve.min.y * 3 + carve.min.z * 7;
    if (this._carvedBoxes && this._carvedFor === carve && this._carvedPortal === p &&
        this._carvedStamp === stamp) return this._carvedBoxes;
    this._carvedFor = carve;
    this._carvedPortal = p;
    this._carvedStamp = stamp;
    this._carvedBoxes = this.world.boxes.filter(b => b !== carve);
    for (const piece of pierce(carve, p, PORTAL_CONTACT)) this._carvedBoxes.push(piece);
    return this._carvedBoxes;
  }

  /** The same for ramps. A convex solid cannot be pierced, so it is removed
   *  whole, but only once the middle of the body is over the oval. */
  _solids() {
    const st = this.straddling;
    const carve = st && st.host;
    const solids = this.world.solids;
    if (!carve || !solids || !solids.length) return solids;
    if (!solids.includes(carve)) return solids;
    if (!this._overOval(st.link.from)) return solids;
    if (this._carvedSolids && this._carvedSolidFor === carve) return this._carvedSolids;
    this._carvedSolidFor = carve;
    this._carvedSolids = solids.filter(x => x !== carve);
    return this._carvedSolids;
  }

  _overOval(p) {
    const l = this._localOf(p, this._middle());
    const su = l.u / (HALF_W + PORTAL_EDGE), sv = l.v / (HALF_H + PORTAL_EDGE);
    return su * su + sv * sv <= 1;
  }

  /** Our velocity relative to a mouth (differs for a mouth on a platform). */
  _relativeTo(p) {
    const m = p.mover >= 0 && this.world.movers ? this.world.movers[p.mover] : null;
    if (!m) return this.vel;
    return { x: this.vel.x - m.vel.x, y: this.vel.y - m.vel.y, z: this.vel.z - m.vel.z };
  }

  /** A point `frac` of the way up the body. */
  _sample(frac) {
    const d = this.height * frac;
    return {
      x: this.pos.x + this.up.x * d,
      y: this.pos.y + this.up.y * d,
      z: this.pos.z + this.up.z * d
    };
  }

  /** The eye without the step lag: the hand-over is anchored on this. */
  _eyePhys() { return this._sample(EYE_RATIO); }

  /** The middle of the body: what has to be through a mouth on a slope. */
  _middle() { return this._sample(0.5); }

  _updateStraddle(dt = 0) {
    this.straddling = null;
    if (!this.portals) return;
    const links = this.portals.links();
    if (links && links.length) this.straddling = this._findStraddle(links, dt);
  }

  /** The moving platform whose mouth we are in, if any. */
  _carvedMover() {
    const host = this.straddling && this.straddling.host;
    if (!host || host.mover === undefined || !this.world.movers) return null;
    return this.world.movers[host.mover] || null;
  }

  /** Which mouth the body is in, and the world piece it is cut into.
   *
   *  The reach grows by how far this sub-step closes on the surface, or a fast
   *  body is stopped by the wall the step before the hole opens. A mouth is only
   *  entered from in front (standing behind a wall must not open it), but once
   *  in, you stay in. */
  _findStraddle(links, dt = 0) {
    let best = null, bestD = Infinity;
    const e = this._middle();
    for (const link of links) {
      const p = link.from;
      const v = this._relativeTo(p);
      const closing = Math.max(0, -(v.x * p.n.x + v.y * p.n.y + v.z * p.n.z));
      const reach = PORTAL_CONTACT + closing * dt;
      if (!atMouth(p, this.pos, this.up, this.height, reach, PORTAL_EDGE)) continue;
      if (this._inMouth !== p && !this._nearFront(p, reach)) continue;
      const d = Math.abs((e.x - p.c.x) * p.n.x + (e.y - p.c.y) * p.n.y + (e.z - p.c.z) * p.n.z);
      if (d < bestD) { bestD = d; best = link; }
    }
    this._inMouth = best ? best.from : null;
    return best ? { link: best, host: this.world.hostFor(best.from) } : null;
  }

  /** Is any part of the body in front of this mouth, or no deeper than a
   *  shoulder into it? */
  _nearFront(p, reach) {
    for (const frac of BODY_SAMPLES) {
      const h = this.height * frac;
      const dx = this.pos.x + this.up.x * h - p.c.x;
      const dy = this.pos.y + this.up.y * h - p.c.y;
      const dz = this.pos.z + this.up.z * h - p.c.z;
      const d = dx * p.n.x + dy * p.n.y + dz * p.n.z;
      if (d > reach || d < -RADIUS) continue;
      const su = (dx * p.u.x + dy * p.u.y + dz * p.u.z) / (HALF_W + PORTAL_EDGE);
      const sv = (dx * p.v.x + dy * p.v.y + dz * p.v.z) / (HALF_H + PORTAL_EDGE);
      if (su * su + sv * sv <= 1) return true;
    }
    return false;
  }

  /** Walk into one mouth and out of the other, without a teleport.
   *
   *  Collision has a hole cut for the mouth we are in, so the body moves through
   *  it normally. The only event is the eye or the middle of the body (whichever
   *  first) crossing the surface inside the oval, measured in the mouth's own
   *  frame from last step to this one, so a mouth moving onto a still body
   *  counts too. Then the portal's transform is applied to the whole body.
   *  Returns true when a hand-over happened (the sub-step is over). */
  _tryPortal(dt) {
    this.straddling = null;
    if (!this.alive || !this.portals) return false;
    const links = this.portals.links();
    if (!links || !links.length) return false;

    this.straddling = this._findStraddle(links, dt);

    const at = { eye: this._eyePhys(), mid: this._middle() };
    const seen = new Map();
    let crossed = null;
    for (const link of links) {
      const p = link.from;
      const cur = { eye: this._localOf(p, at.eye), mid: this._localOf(p, at.mid) };
      seen.set(p, cur);
      // no sample yet (a brand new mouth): step backwards to make one
      const prev = this._wasAt.get(p);
      const was = prev || {
        eye: this._localOf(p, this._back(p, at.eye, dt)),
        mid: this._localOf(p, this._back(p, at.mid, dt))
      };
      if (crossed) continue;
      // A body standing in this mouth can only be in its hole, and the hole is
      // cut wider than the oval (PORTAL_CONTACT) so a body can brush the rim — a
      // centre can sit 3 cm outside the oval. Crossing there is still going
      // through; asking the oval dropped a body drifting in the hole out of the map.
      const inIt = this.straddling && this.straddling.link.from === p;
      for (const which of ['eye', 'mid']) {
        const a = was[which], b = cur[which];
        if (!a || a.d < 0 || b.d >= 0) continue;     // only going in
        const t = a.d - b.d > 1e-12 ? a.d / (a.d - b.d) : 0;
        const su = (a.u + (b.u - a.u) * t) / HALF_W;
        const sv = (a.v + (b.v - a.v) * t) / HALF_H;
        if (!inIt && su * su + sv * sv > 1) continue; // crossed the wall, not the hole
        crossed = link;
        break;
      }
    }
    this._wasAt = seen;
    if (!crossed) return false;
    this._through(crossed, dt);
    return true;
  }

  /** Where a point was a step ago, relative to this mouth. */
  _back(p, at, dt) {
    const v = this._relativeTo(p);
    return { x: at.x - v.x * dt, y: at.y - v.y * dt, z: at.z - v.z * dt };
  }

  /** A world point in a mouth's frame: across (u), up (v), out (d). */
  _localOf(p, pt) {
    const dx = pt.x - p.c.x, dy = pt.y - p.c.y, dz = pt.z - p.c.z;
    return {
      u: dx * p.u.x + dy * p.u.y + dz * p.u.z,
      v: dx * p.v.x + dy * p.v.y + dz * p.v.z,
      d: dx * p.n.x + dy * p.n.y + dz * p.n.z
    };
  }

  /** The hand-over: position, velocity, view and up through the transform. */
  _through(link, dt) {
    const from = link.from, to = link.to;
    const map = portalMap(from, to);

    const eyeWas = this._eyePhys();     // before `up` changes

    const look = map.dir(lookFrom(this.up, this.yaw, this.pitch));
    // gravity follows the body, rounded to one of the eighteen ups
    const turned = snapUp(map.dir(this.up));
    if (turned !== this.up) { this.upFrom = this.up; this.upBlend = 1; }
    this.up = turned;
    const ang = anglesIn(this.up, look);
    this.yaw = ang.yaw;
    this.pitch = clamp(ang.pitch, -MAX_PITCH, MAX_PITCH);

    // Pin the eye, not the feet: rounding a non-right-angle turn moves whatever
    // is pinned, and the eye is what the player looks through.
    const eyeAt = map.point(eyeWas);
    const d = this.height * EYE_RATIO;
    this.pos = {
      x: eyeAt.x - this.up.x * d,
      y: eyeAt.y - this.up.y * d,
      z: eyeAt.z - this.up.z * d
    };
    const v = map.dir(this.vel);
    this.vel = { x: v.x, y: v.y, z: v.z };

    // an exit on a moving platform adds the platform's motion
    const mover = to.mover >= 0 && this.world.movers ? this.world.movers[to.mover] : null;
    if (mover) {
      this.vel.x += mover.vel.x;
      this.vel.y += mover.vel.y;
      this.vel.z += mover.vel.z;
    }

    this.onGround = false;
    this.bumped = false;
    this.stepSmooth = 0;
    this.fellAt = 0;
    this.portalCount++;
    this.spawnSeq++;              // peers must not smear the body across the map

    this._wasAt = new Map();
    // We are in the exit's mouth now, so its wall gets the hole. Said outright:
    // the "entered from in front" test has gaps between its body samples, and a
    // body that fell in one was not in the mouth and was thrown out of the floor.
    this._inMouth = to;
    this.straddling = this._findStraddle(this.portals.links());
    // Something in front of the exit (a crate) is a real overlap: out the short
    // way, then along the exit normal, and failing that the body is out of bounds.
    if (this._overlaps(this._boxes()) && !this._unstick(to.n, 12)) {
      const from = { ...this.pos };
      let clear = false;
      for (let i = 1; i <= 30 && !clear; i++) {
        this.pos.x = from.x + to.n.x * i * 0.1;
        this.pos.y = from.y + to.n.y * i * 0.1;
        this.pos.z = from.z + to.n.z * i * 0.1;
        clear = !this._overlaps(this._boxes());
      }
      if (!clear) {
        this.pos = from;
        this.outOfBounds = true;
        this.escapes++;
        this._oob('portal exit blocked');
      }
    }
  }

  /** Shortest way out of everything the body is inside, along single axes,
   *  taking the cheapest candidate that actually ends clear (the shallowest way
   *  out of one box is often straight into the next). `prefer` favours the way
   *  out of a portal. */
  _unstick(prefer = null, passes = 8) {
    if (this.tilted) { this._pushOutOfEverything(); return !this._overlaps(this._boxes()); }
    const boxes = this._boxes();
    for (let i = 0; i < passes; i++) {
      const a = this.aabb();
      const cands = [];
      for (const b of boxes) {
        if (!this._touches(a, b)) continue;
        for (const k of ['x', 'y', 'z']) {
          const up = b.max[k] - a.min[k] + SKIN;    // move + to clear it
          const dn = a.max[k] - b.min[k] + SKIN;    // move - to clear it
          for (const amount of [up, -dn]) {
            let cost = Math.abs(amount);
            if (prefer && Math.abs(prefer[k]) > 0.5 &&
                (prefer[k] > 0) === (amount > 0)) cost *= 0.75;
            cands.push({ k, amount, cost });
          }
        }
      }
      if (!cands.length) return true;
      // Never out of the level while any other way exists. With nothing clear the
      // cheapest move is taken anyway, and a body under the centre block (ramps
      // all round, the block above) was walked down through the floor and out of
      // the map — which is death now.
      const lim = this.world.bounds;
      const staysIn = c => !lim ||
        (this.pos[c.k] + c.amount >= lim.min[c.k] && this.pos[c.k] + c.amount <= lim.max[c.k]);
      const inside = cands.filter(staysIn);
      const pool = inside.length ? inside : cands;
      pool.sort((x, y) => x.cost - y.cost);
      cands.length = 0;
      cands.push(...pool);
      let chosen = cands[0];
      for (const c of cands) {
        const was = this.pos[c.k];
        this.pos[c.k] += c.amount;
        const clear = !this._overlaps(boxes);
        this.pos[c.k] = was;
        if (clear) { chosen = c; break; }
      }
      this.pos[chosen.k] += chosen.amount;
      if (!this._overlaps(boxes)) return true;
    }
    return !this._overlaps(boxes);
  }

  _overlaps(boxes) {
    const a = this.aabb();
    // tilted, the box is far bigger than the capsule, so ask the capsule
    const cap = this.tilted ? this._capsule() : null;
    for (const b of boxes) {
      if (!this._touches(a, b)) continue;
      if (!cap || capsulePush(cap[0], cap[1], cap[2], cap[3], cap[4], cap[5], RADIUS, boxAsSolid(b))) return true;
    }
    return this._inSolid();
  }

  /** The capsule: a segment inset by the radius at each end. */
  _capsule(height = this.height) {
    const lo = RADIUS, hi = Math.max(height - RADIUS, RADIUS);
    const u = this.up;
    return [this.pos.x + u.x * lo, this.pos.y + u.y * lo, this.pos.z + u.z * lo,
            this.pos.x + u.x * hi, this.pos.y + u.y * hi, this.pos.z + u.z * hi];
  }

  _inSolid() {
    const solids = this._solids();
    if (!solids || !solids.length) return false;
    const [ax, ay, az, bx, by, bz] = this._capsule();
    const a = this.aabb();
    for (const s of solids) {
      if (!this._touches(a, s)) continue;
      if (capsulePush(ax, ay, az, bx, by, bz, RADIUS, s)) return true;
    }
    return false;
  }

  /** Push out of every ramp and turned box (upright path). */
  _resolveSolids() {
    const solids = this._solids();
    if (!solids || !solids.length) return;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const s of solids) {
        if (!this._touches(this.aabb(), s)) continue;     // broad phase
        const [ax, ay, az, bx, by, bz] = this._capsule();
        const hit = capsulePush(ax, ay, az, bx, by, bz, RADIUS, s);
        if (!hit) continue;
        moved = true;
        if (this._pushOut(hit) && this.vUp <= 0) {
          this.onGround = true;
          this.fellAt = Math.max(this.fellAt, -this.vUp);
          this.vUp = 0;
        }
      }
      if (!moved) break;
    }
  }

  // Only a portal ever changes which way you fall; slopes never do.

  /** Move along one axis and push out of anything hit; true if blocked.
   *  A correction deeper than the move itself is an overlap the move did not
   *  cause, so the move is given back and _unstick() handles it. */
  _axis(axis, amount, boxes) {
    if (amount === 0) return false;
    const before = this.pos[axis];
    const cap = Math.abs(amount) + SKIN * 4;
    this.pos[axis] += amount;
    let blocked = false;
    for (const b of boxes) {
      const a = this.aabb();
      if (!this._touches(a, b)) continue;
      blocked = true;
      const push = amount > 0 ? -((a.max[axis] - b.min[axis]) + SKIN)
                              : (b.max[axis] - a.min[axis]) + SKIN;
      if (Math.abs(push) > cap) { this.pos[axis] = before; return true; }
      this.pos[axis] += push;
    }
    return blocked;
  }

  /** Every collision test goes through here: a shape is only solid where its
   *  overlap with the body has not been erased by White Out. Ramps are asked by
   *  bounding box, which errs toward solid near a hole. */
  _touches(a, b) {
    if (!aabbOverlap(a, b)) return false;
    if (!this.tilted) return !this.world.erasedOverlap(a, b);
    // Tilted, the box around the capsule is far bigger than the body and no
    // hole ever covered it: ask a radius-sized box at each stretch of the body.
    const [ax, ay, az, bx, by, bz] = this._capsule();
    const n = Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / RADIUS);
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f, z = az + (bz - az) * f;
      const part = {
        min: { x: Math.max(x - RADIUS, a.min.x), y: Math.max(y - RADIUS, a.min.y), z: Math.max(z - RADIUS, a.min.z) },
        max: { x: Math.min(x + RADIUS, a.max.x), y: Math.min(y + RADIUS, a.max.y), z: Math.min(z + RADIUS, a.max.z) }
      };
      if (aabbOverlap(part, b) && !this.world.erasedOverlap(part, b)) return true;
    }
    return false;
  }

  /** Has the patch of this face over the body's footprint been erased? */
  _faceErased(s, k, face) {
    if (!s.min) return false;
    const [KA, KB] = this.flatK;
    const min = {}, max = {};
    min[KA] = Math.max(this.pos[KA] - RADIUS, s.min[KA]); max[KA] = Math.min(this.pos[KA] + RADIUS, s.max[KA]);
    min[KB] = Math.max(this.pos[KB] - RADIUS, s.min[KB]); max[KB] = Math.min(this.pos[KB] + RADIUS, s.max[KB]);
    min[k] = face - 0.005; max[k] = face + 0.005;
    return this.world.erasedBox(min, max, s);
  }

  damage(amount) {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.deaths++;
      return true;
    }
    return false;
  }
}
