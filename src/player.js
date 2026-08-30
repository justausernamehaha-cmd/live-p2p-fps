import { clamp, lerp } from './util.js';
import { aabbOverlap } from './world.js';
import { capsulePush } from './solid.js';
import { crossing, portalMap, lookAngles, EXIT_CLEAR, HALF_W, HALF_H } from './portal.js';

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
// Falling is heavier than rising. Gravity is one number for the jump arc, which
// makes a hop feel floaty at the top and mushy on the way down; multiplying it
// while descending keeps the take-off and adds weight to the drop.
const FALL_GRAVITY = 1.4;
// A long fall is worth speed. Below this impact nothing is paid out, which keeps
// ordinary hops (they land at about 9 m/s) and stair descents out of it.
const FALL_MIN = 12;
const FALL_TO_SPEED = 0.35;     // of the impact above FALL_MIN
const FALL_SPEED_MAX = 8;       // m/s one landing may ever add
const GROUND_FRICTION = 5;      // stopping friction, only when you stop asking to move
const GROUND_DRAG = 0.35;       // the slow bleed on carried speed while still running
const GROUND_STEER = 9;         // how fast carried momentum can be turned, magnitude kept
const SPEED_CAP = 22;           // sanity limit, well above anything reachable by hand
const MAX_STEP_DIST = 0.3;      // sub-step the movement so fast players cannot tunnel
const STEP_SMOOTH_RATE = 5;     // m/s the view catches up after a step, i.e. a linear climb
const STEP_SMOOTH_MAX = 1.0;
// Push out of a box to just *clear* of its face, never to exactly touching.
// Landing exactly on a face leaves floating point free to put the player a
// fraction inside it, and the next axis resolved then sees a real overlap and
// ejects them across the whole box: walk into a four-metre wall and you end up
// standing on top of it. A millimetre of clearance costs nothing and cannot.
const SKIN = 1e-3;
const MAX_PITCH = Math.PI / 2 - 0.01;
const CROUCH_TIME = 0.3;        // seconds to fully crouch or stand, so it cannot flicker
// A portal is a hole in a wall that the wall does not know about: collision is
// still solid right across the mouth. Rather than cut the hole — which would
// mean unpicking the merged geometry that makes this game cheap — the crossing
// test is run against a plane held this far out in front of the real surface, so
// it fires on the sub-step *before* the wall would have stopped you. That figure
// is the player's own radius plus a little, i.e. exactly where their leading
// edge is when the wall is about to refuse them.
const PORTAL_LEAD = RADIUS + 0.06;
// Sample points down the body, as fractions of its height. Any part of you
// through the mouth is you through the mouth, which is what "step in easily"
// means in arithmetic. The feet and the head have to be in the list: falling
// into a portal on the floor is the feet going through it and nothing else, and
// with the lowest sample at a quarter height that could never happen — the floor
// stopped the body while the sample was still a foot above the mouth.
const PORTAL_SAMPLES = [0.02, 0.25, 0.5, 0.75, 0.98];
// The sample line is the middle of the player, but a player is a cylinder. The
// mouth is widened by the radius so that clipping the rim with a shoulder counts
// as going in — the edge of a portal is an entrance, not somewhere to scrape
// along.
const PORTAL_EDGE = RADIUS;
const PORTAL_COOLDOWN = 0.14;   // stops a pair sitting close together strobing
// How close the body has to be to a surface to count as touching it. A portal is
// a hole: if you are against the wall and the hole is where you are, the wall is
// not there for you, whichever way you happen to be walking.
const PORTAL_CONTACT = RADIUS + 0.03;
// Being crushed happens in two stages, so it can be seen coming. A platform
// closing on your head forces you down into a crouch first; only once it has
// pushed past that — half a head deeper — does it kill you.
const CRUSH_DEPTH = 0.17;           // half a head, the same 0.34 the model uses

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
    this.fellAt = 0;           // impact speed of the landing that just happened
    this.hp = 100;
    this.alive = true;
    this.kills = 0;
    this.deaths = 0;
    this.spawnSeq = 0;        // bumped on every spawn so peers can drop stale interpolation
    this.stepSmooth = 0;      // visual lag behind an instant step up, so stairs are a ramp
    this.bumped = false;      // hit something horizontally this frame
    this.bobPhase = 0;
    this.bob = 0;
    this.recoil = 0;             // extra pitch, decays
    this.recoilYaw = 0;
    this.portals = null;      // set by the game: something with .links()
    this.portalCooldown = 0;
    this.portalCount = 0;     // bumped on every traversal, for tests and effects
    this.rideVel = null;      // the platform underfoot, if any, and how fast it goes
    this.squashed = false;    // a platform closed on us: the game turns this into a death
    this.beingCrushed = false;// ...and this is the warning before it, for the HUD
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
    this.portalCooldown = Math.max(0, this.portalCooldown - dt);

    if (this.alive) this._ride();

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
    // Before anything moves. A platform overlapping the head is resolved by
    // _axis() as though it were ground — it pushes up out of the *whole* box —
    // so a lift coming down would stand the player on top of itself instead of
    // squashing them. Ducking first means the overlap never happens.
    this._crush();

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

    // A frame that ends in a jump keeps the velocity it arrived with, and pays no
    // friction at all. That is the whole of a hop chain: the alignment a strafe
    // jumper builds in the air must survive the instant of ground contact, and
    // snapping the velocity back to the keys at walk speed would erase it every
    // single hop. Below half a walk there is nothing worth preserving, so direct
    // control still gets you moving from a standstill.
    //
    // This used to happen by accident. Ground contact was decided by the last
    // collision sub-step, so at speed the landing frame reported onGround false
    // and the whole block below was skipped — the chain worked *because* of a
    // bug, and fixing that bug on its own capped hopping at walking pace.
    const keepMomentum = wantJump && speed > maxSpeed * 0.5;

    if (this.onGround && !keepMomentum) {
      if (speed <= maxSpeed + 0.05) {
        // direct control: you go exactly where you press, at once
        this.vel.x = wx * maxSpeed;
        this.vel.z = wz * maxSpeed;
      } else if (wishLen > 0.02) {
        // Carrying more than a walk — off a hop chain, a heavy landing, a run
        // down some stairs. Touching the ground must not confiscate that, so the
        // magnitude is kept and only the direction is steered, bleeding at
        // GROUND_DRAG rather than stopping friction.
        //
        const k = Math.min(1, GROUND_STEER * dt);
        const nx = this.vel.x + (wx * speed - this.vel.x) * k;
        const nz = this.vel.z + (wz * speed - this.vel.z) * k;
        const m = Math.hypot(nx, nz) || 1;
        this.vel.x = (nx / m) * speed;
        this.vel.z = (nz / m) * speed;
        const drop = Math.max(0, 1 - GROUND_DRAG * dt);
        this.vel.x *= drop;
        this.vel.z *= drop;
      } else {
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
      // Leave a moving platform and you leave it *going somewhere*. Riding one
      // only ever moved the body, so jumping off a shuttle left the shuttle to
      // carry on without you and you landed behind it, which is not what
      // standing on a moving thing feels like anywhere.
      if (this.rideVel) {
        this.vel.x += this.rideVel.x;
        this.vel.z += this.rideVel.z;
      }
    }

    this._capSpeed();

    this.vel.y -= GRAVITY * (this.vel.y < 0 ? FALL_GRAVITY : 1) * dt;
    if (this.vel.y < -80) this.vel.y = -80;

    this.fellAt = 0;
    this._move(dt);

    // A landing off a real drop is paid out as ground speed, along the way you
    // are already going — or, from a standing drop, along the keys. Height is
    // worth momentum, which is the same bargain the hop chain makes.
    if (this.fellAt > FALL_MIN) {
      const gain = Math.min(FALL_SPEED_MAX, (this.fellAt - FALL_MIN) * FALL_TO_SPEED);
      const sp = Math.hypot(this.vel.x, this.vel.z);
      let dx, dz;
      if (sp > 0.5) { dx = this.vel.x / sp; dz = this.vel.z / sp; }
      else if (wishLen > 0.02) { dx = wx; dz = wz; }
      else { dx = dz = 0; }     // dropped straight down standing still: nothing
      this.vel.x += dx * gain;
      this.vel.z += dz * gain;
    }

    this._capSpeed();

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

  /** Ride whatever platform is underfoot.
   *
   *  Two jobs. It carries the body by exactly what the platform moved, so
   *  standing on one holds still relative to it. And it *lifts* a body a rising
   *  platform has come up into, which is the whole point: without that the feet
   *  end up inside the platform, and the next horizontal move resolves that
   *  overlap the only way _axis() knows how — by ejecting the player clear of the
   *  whole box. Stand on the edge of a lift, take one step, and you were flung to
   *  one edge of it or the other.
   *
   *  It also remembers the platform's own velocity, which is what a jump takes
   *  with it. */
  _ride() {
    this.rideVel = null;
    const movers = this.world.movers;
    if (!movers || !movers.length) return;
    for (const m of movers) {
      const s = m.shape;
      if (this.pos.x + RADIUS <= s.min.x || this.pos.x - RADIUS >= s.max.x) continue;
      if (this.pos.z + RADIUS <= s.min.z || this.pos.z - RADIUS >= s.max.z) continue;
      const top = s.max.y;
      const gap = top - this.pos.y;
      // standing on it, or it has just come up under us by less than a step
      if (gap > STEP_HEIGHT || gap < -0.12) continue;
      if (gap > 0) {
        if (this.vel.y > 0.1) continue;         // jumping off it, not riding it
        this.pos.y = top;
        this.onGround = true;
        if (this.vel.y < 0) this.vel.y = 0;
      } else {
        this.pos.x += m.delta.x;
        this.pos.z += m.delta.z;
        this.pos.y += m.delta.y;
      }
      this.rideVel = { x: m.vel.x, z: m.vel.z };
      return;
    }
  }

  /** What a moving platform does to somebody in its way.
   *
   *  Two stages, deliberately. A platform coming down on your head pushes you
   *  into a crouch — that is a warning you can act on, and most of the time
   *  ducking and walking out is the whole story. Only once it has come further
   *  than a crouch allows, by half a head, are you dead. A platform closing on
   *  you sideways is the same bargain with no crouch to buy you anything: if it
   *  presses you into something solid and there is nowhere left to be pushed,
   *  that is the end of it.
   *
   *  Only platforms crush. The level's own walls and ceilings have always been
   *  there and have never killed anybody, and they are not going to start. */
  _crush() {
    this.beingCrushed = false;
    if (!this.alive || !this.world.movers || !this.world.movers.length) return;

    // ---- something coming down on top of us
    let lowest = Infinity;
    for (const m of this.world.movers) {
      const s = m.shape;
      if (this.pos.x + RADIUS <= s.min.x || this.pos.x - RADIUS >= s.max.x) continue;
      if (this.pos.z + RADIUS <= s.min.z || this.pos.z - RADIUS >= s.max.z) continue;
      if (s.min.y <= this.pos.y + 0.05) continue;          // not above us
      if (s.min.y < lowest) lowest = s.min.y;
    }
    if (lowest < Infinity) {
      const headroom = lowest - this.pos.y;
      if (headroom < CROUCH_HEIGHT - CRUSH_DEPTH) { this.squashed = true; return; }
      if (headroom < HEIGHT) {
        // Forced down as far as it takes to fit, and held there. Past a full
        // crouch the body keeps compressing rather than stopping: it has to, or
        // the overlap would be resolved by _axis() pushing the player up out of
        // the whole platform and standing them on top of it, and the last half a
        // head — the part that kills you — could never happen at all.
        const t = clamp((HEIGHT - headroom) / (HEIGHT - CROUCH_HEIGHT), 0, 1);
        if (t > this.crouchT) this.crouchT = t;
        this.height = Math.min(this.height, Math.max(headroom - 0.01, 0.3));
        this.crouching = this.crouchT > 0.5;
        this.beingCrushed = true;
      }
    }

    // ---- or closing on us sideways, with a wall on the other side
    for (const m of this.world.movers) {
      const s = m.shape;
      // Sideways only. A platform coming down is the case above, and letting
      // this one see it would push the player out along whichever axis is
      // shallowest — which, for something resting on your head, is upwards.
      if (Math.abs(m.vel.y) > Math.abs(m.vel.x) + Math.abs(m.vel.z)) continue;
      // Low enough to walk onto is low enough to walk onto. Shoving the player
      // away from a knee-high platform would make the arena's shuttles
      // impossible to board, which is the opposite of the point of them.
      if (s.max.y - this.pos.y <= STEP_HEIGHT + 0.05) continue;
      if (!s.min || !aabbOverlap(this.aabb(), s)) continue;

      // Shoved along the way it is going, not out by the shortest route. A
      // platform bearing down on you does not politely lift you over itself; it
      // pushes you ahead of it, and whether that is survivable is a question
      // about what is behind you.
      const k = Math.abs(m.vel.x) >= Math.abs(m.vel.z) ? 'x' : 'z';
      const forward = m.vel[k] >= 0;
      const wasAt = { ...this.pos };
      this.pos[k] = forward ? s.max[k] + RADIUS + SKIN : s.min[k] - RADIUS - SKIN;
      this.beingCrushed = true;
      if (this._overlapsStatic()) {
        this.pos = wasAt;          // nowhere to be shoved to
        this.squashed = true;
      }
      return;
    }
  }

  /** Overlapping anything that is not itself a moving platform. */
  _overlapsStatic() {
    const a = this.aabb();
    for (const b of this.world.boxes) {
      if (b.mover !== undefined) continue;
      if (aabbOverlap(a, b)) return true;
    }
    return false;
  }

  _capSpeed() {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > SPEED_CAP) {
      this.vel.x *= SPEED_CAP / sp;
      this.vel.z *= SPEED_CAP / sp;
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

    // Ground contact is a property of the frame, not of the last sub-step.
    //
    // This is the bug that made a hop chain drop jumps at speed. Landing in an
    // early sub-step set onGround, and the next sub-step cleared it again: with
    // vel.y already zeroed, its vertical move was zero, and _axis() reports a
    // zero move as "not blocked". So the faster you went the more sub-steps ran
    // and the more landings were thrown away — you were standing on the floor
    // with onGround false, which loses the jump *and* skips ground friction
    // entirely, so nothing ever slowed you down either.
    let grounded = false;
    for (let i = 0; i < steps; i++) {
      this._moveStep(dt / steps);
      grounded = grounded || this.onGround;
    }
    this.onGround = grounded;
  }

  _moveStep(dt) {
    // Before anything is resolved against the level: did this step take the
    // player through a portal? It has to be asked first, because the answer is
    // "the wall in front of you is not there for you", and every line below
    // this one assumes it is.
    if (this._tryPortal(dt)) return;

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
    //
    // Nor is it gated on rising any more, which is what used to put a wall at the
    // top of every ramp. Run up one and the hop that takes you off the top is
    // still going up when your feet meet the few centimetres of lip where the
    // ramp meets the plate. Rising meant no step, so a lip you would have walked
    // over stopped eighteen metres a second dead — and only sometimes, because it
    // depended on where in the arc you arrived.
    //
    // Letting a rising player step reaches nowhere new: STEP_HEIGHT is 0.55 m and
    // they are already mid-jump with more than a metre of climb in hand, so this
    // only ever mounts a ledge they were going over anyway instead of scraping up
    // its face. There is no ratchet either — you cannot jump again in mid-air.
    if (blockedX || blockedZ) {
      this.pos = { ...start, y: start.y + STEP_HEIGHT };
      if (this._overlaps(boxes)) {
        this.pos = flat;
      } else {
        this._axis('x', dx, boxes);
        this._axis('z', dz, boxes);
        this._axis('y', -STEP_HEIGHT, boxes);     // settle onto the step
        const stepped = Math.hypot(this.pos.x - start.x, this.pos.z - start.z);
        const slid = Math.hypot(flat.x - start.x, flat.z - start.z);
        // A step up may never gain more than a step. _axis() resolves an overlap
        // by pushing clear of the whole box, so a horizontal push-out that lands
        // a float's width inside a tall wall lets the settle above lift the
        // player all the way to the top of it — walk into a four-metre wall and
        // you would end up standing on it.
        if (this.pos.y > start.y + STEP_HEIGHT + 1e-4) {
          this.pos = flat;
        } else if (stepped <= slid + 1e-4) {
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
      if (this.vel.y <= 0) {
        this.onGround = true;
        this.fellAt = Math.max(this.fellAt, -this.vel.y);   // read before it is zeroed
      }
      this.vel.y = 0;
    }

    // ramps and turned boxes last: they are resolved by pushing out, so they
    // have to see where the axis-aligned pass actually left the player
    this._resolveSolids();

    // failsafe: never let a player leak out of the arena
    if (this.pos.y < -20) { this.pos.y = 10; this.vel.y = 0; }
  }

  /** Is the body up against this mouth's surface, and inside the mouth?
   *
   *  Standing still counts. A hole in a wall you are already standing in is a
   *  hole you fall through, and waiting for the player to be moving meant you
   *  could press yourself into a mouth and simply stay there.
   *
   *  Distance is measured to the portal's own plane, so "touching" means what it
   *  means for collision: a radius clear of the face. Standing anywhere in open
   *  space — between two mouths, say — is far outside that band and never counts,
   *  and EXIT_CLEAR is set wide enough that leaving a portal does not land you
   *  back inside its partner's. */
  _inMouth(p) {
    for (const frac of PORTAL_SAMPLES) {
      const y = this.pos.y + this.height * frac;
      const dx = this.pos.x - p.c.x, dy = y - p.c.y, dz = this.pos.z - p.c.z;
      const d = dx * p.n.x + dy * p.n.y + dz * p.n.z;
      if (d < 0 || d > PORTAL_CONTACT) continue;          // behind it, or not touching
      const su = (dx * p.u.x + dy * p.u.y + dz * p.u.z) / (HALF_W + PORTAL_EDGE);
      const sv = (dx * p.v.x + dy * p.v.y + dz * p.v.z) / (HALF_H + PORTAL_EDGE);
      if (su * su + sv * sv <= 1) return true;
    }
    return false;
  }

  /** Walk into one mouth, come out of the other, keeping everything you had.
   *
   *  The transform is applied to the *crossing point* rather than to the
   *  player's feet. Mapping the feet is the obvious thing and it is wrong: a
   *  portal at head height on a wall would put your feet a metre and a half
   *  behind the exit's plane, which for a portal on the floor is a metre and a
   *  half underground. The point where you actually went through is by
   *  construction inside the mouth, so its image is inside the other one.
   *
   *  Returns true when a traversal happened, in which case this sub-step is over.
   */
  _tryPortal(dt) {
    if (!this.alive || this.portalCooldown > 0 || !this.portals) return false;
    const links = this.portals.links();
    if (!links || !links.length) return false;

    const sx = this.vel.x * dt, sy = this.vel.y * dt, sz = this.vel.z * dt;
    if (Math.abs(sx) + Math.abs(sy) + Math.abs(sz) < 1e-7) return false;

    let best = null;
    for (const link of links) {
      const from = link.from;
      // Already up against the surface, inside the mouth? Then go through it.
      //
      // The crossing test below cannot see this case and never could: it asks
      // whether the body passed through the plane, and a player pressed against
      // a wall is held a radius away from it by collision — which is *behind*
      // the plane the test uses, so the test reads them as having come out the
      // back and refuses. Walk along a wall into a portal on that same wall and
      // you would slide straight past the mouth. Nothing here fires unless the
      // body is genuinely touching the surface, so standing in the gap between
      // two mouths is untouched by it.
      if (this._inMouth(from)) { best = { k: 0, link, hy: this.height * 0.5, at: null }; break; }
      // the mouth, held a player's radius out in front of the surface
      const lead = {
        c: {
          x: from.c.x + from.n.x * PORTAL_LEAD,
          y: from.c.y + from.n.y * PORTAL_LEAD,
          z: from.c.z + from.n.z * PORTAL_LEAD
        },
        n: from.n, u: from.u, v: from.v
      };
      for (const frac of PORTAL_SAMPLES) {
        const hy = this.height * frac;
        const p0 = { x: this.pos.x, y: this.pos.y + hy, z: this.pos.z };
        const p1 = { x: p0.x + sx, y: p0.y + sy, z: p0.z + sz };
        const k = crossing(p0, p1, lead, PORTAL_EDGE);
        if (k < 0) continue;
        if (!best || k < best.k) best = { k, link, hy, p0, p1 };
      }
    }
    if (!best) return false;

    const { link, hy, p0, p1, k } = best;
    const from = link.from, to = link.to;
    // where the body went through: the crossing point, or — for a body already
    // standing in the mouth — itself, dropped onto the portal's own plane
    let at;
    if (best.at === null) {
      const mid = { x: this.pos.x, y: this.pos.y + hy, z: this.pos.z };
      const d = (mid.x - from.c.x) * from.n.x + (mid.y - from.c.y) * from.n.y +
                (mid.z - from.c.z) * from.n.z;
      at = { x: mid.x - from.n.x * d, y: mid.y - from.n.y * d, z: mid.z - from.n.z * d };
    } else {
      at = {
        x: p0.x + (p1.x - p0.x) * k,
        y: p0.y + (p1.y - p0.y) * k,
        z: p0.z + (p1.z - p0.z) * k
      };
    }
    const map = portalMap(from, to);
    const out = map.point(at);
    const anchor = {
      x: out.x + to.n.x * EXIT_CLEAR,
      y: out.y + to.n.y * EXIT_CLEAR,
      z: out.z + to.n.z * EXIT_CLEAR
    };

    // The exit's own orientation decides where the body hangs off the mouth.
    // Out of a wall you keep the height you went in at; out of the floor you
    // stand on it, and out of the ceiling you hang below it. Anything else puts
    // you inside the surface you just came through.
    let feetY;
    if (to.n.y > 0.7) feetY = anchor.y;
    else if (to.n.y < -0.7) feetY = anchor.y - this.height;
    else feetY = anchor.y - hy;

    this.pos = { x: anchor.x, y: feetY, z: anchor.z };

    // momentum is turned, never scrubbed: this is the whole point of the thing
    const v = map.dir(this.vel);
    this.vel = { x: v.x, y: v.y, z: v.z };

    // A mouth on a moving platform hands over the platform's own motion as well.
    // Coming out of a portal on the underside of a lift should throw you the way
    // the lift is going — the surface you are leaving through is itself moving,
    // and a portal that ignored that would swallow the ride.
    const mover = to.mover >= 0 && this.world.movers ? this.world.movers[to.mover] : null;
    if (mover) {
      this.vel.x += mover.vel.x;
      this.vel.y += mover.vel.y;
      this.vel.z += mover.vel.z;
    }

    // and the view comes with it, so a portal on a wall does not leave you
    // facing the wall you just left through
    const cp = Math.cos(this.pitch);
    const look = map.dir({
      x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp
    });
    const ang = lookAngles(look);
    this.yaw = ang.yaw;
    this.pitch = clamp(ang.pitch, -MAX_PITCH, MAX_PITCH);

    // Leave the exit genuinely clear of everything, not merely clear of the wall
    // it is on. Pushing only along the exit's normal cannot fix a body four
    // millimetres into the *floor*, and _axis() resolves an overlap it did not
    // cause by ejecting across the whole box — which for the arena floor is a
    // hundred and twenty metres sideways and then a fall out of the world.
    this._unstick(to.n);

    this.onGround = false;
    this.bumped = false;
    this.stepSmooth = 0;
    this.fellAt = 0;
    this.portalCooldown = PORTAL_COOLDOWN;
    this.portalCount++;
    // Peers interpolate between the snapshots they hold; dragging a body across
    // the map between two of them is a smear rather than a teleport. This is the
    // same sequence number a respawn bumps, and it means the same thing here.
    this.spawnSeq++;
    return true;
  }

  /** Shortest way out of everything the player is currently inside.
   *
   *  Each overlap is resolved along whichever of the three axes it is shallowest
   *  on, which is the least the body can be moved to be somewhere legal. That
   *  matters wherever the player did not walk into the overlap — a portal exit,
   *  and a moving platform arriving underneath someone — because the direction
   *  of travel says nothing useful about how they got there. `prefer` breaks a
   *  tie toward the way out of a portal, so a mouth flush with a wall lets you
   *  out in front of it rather than behind. */
  _unstick(prefer = null, passes = 8) {
    for (let i = 0; i < passes; i++) {
      const a = this.aabb();
      let best = null;
      for (const b of this.world.boxes) {
        if (!aabbOverlap(a, b)) continue;
        for (const k of ['x', 'y', 'z']) {
          const up = b.max[k] - a.min[k];        // move + to clear it
          const dn = a.max[k] - b.min[k];        // move - to clear it
          const positive = up < dn;
          let depth = positive ? up : dn;
          // a nudge in the direction the portal faces is worth a little more
          // than one across it, all else being close
          if (prefer && Math.abs(prefer[k]) > 0.5 &&
              (prefer[k] > 0) === positive) depth *= 0.75;
          if (!best || depth < best.depth) {
            best = { k, depth, amount: positive ? up + SKIN : -(dn + SKIN) };
          }
        }
      }
      if (!best) return true;
      this.pos[best.k] += best.amount;
    }
    return !this._overlaps(this.world.boxes);
  }

  _overlaps(boxes) {
    const a = this.aabb();
    for (const b of boxes) if (aabbOverlap(a, b)) return true;
    return this._inSolid();
  }

  /** The player as the capsule solid.js resolves against: a vertical segment
   *  inset by the radius at each end, so its lowest point is still the feet. */
  _capsule(height = this.height) {
    return [this.pos.x, this.pos.y + RADIUS, this.pos.z,
            this.pos.x, this.pos.y + Math.max(height - RADIUS, RADIUS), this.pos.z];
  }

  _inSolid() {
    const solids = this.world.solids;
    if (!solids || !solids.length) return false;
    const [ax, ay, az, bx, by, bz] = this._capsule();
    for (const s of solids) if (capsulePush(ax, ay, az, bx, by, bz, RADIUS, s)) return true;
    return false;
  }

  /** Push out of every ramp and turned box the player is inside.
   *
   *  Resolution is along the face normal, except where that face is walkable —
   *  there the push is straight up instead. Along-the-normal would work, but it
   *  also nudges you a little downhill every frame gravity presses you into a
   *  ramp, and standing still on a slope would slide. */
  _resolveSolids() {
    const solids = this.world.solids;
    if (!solids || !solids.length) return;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const s of solids) {
        const [ax, ay, az, bx, by, bz] = this._capsule();
        const hit = capsulePush(ax, ay, az, bx, by, bz, RADIUS, s);
        if (!hit) continue;
        moved = true;
        const n = hit.n;
        if (n.ny > 0.5) {
          this.pos.y += hit.depth / n.ny;
          if (this.vel.y <= 0) {
            this.onGround = true;
            this.fellAt = Math.max(this.fellAt, -this.vel.y);
            this.vel.y = 0;
          }
        } else {
          this.pos.x += n.nx * hit.depth;
          this.pos.y += n.ny * hit.depth;
          this.pos.z += n.nz * hit.depth;
          const into = this.vel.x * n.nx + this.vel.y * n.ny + this.vel.z * n.nz;
          if (into < 0) {
            this.vel.x -= n.nx * into;
            this.vel.y -= n.ny * into;
            this.vel.z -= n.nz * into;
            if (Math.abs(n.ny) < 0.7) this.bumped = true;
          }
        }
      }
      if (!moved) break;      // a second pass only matters where two solids meet
    }
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
      if (amount > 0) this.pos[axis] -= (a.max[axis] - b.min[axis]) + SKIN;
      else this.pos[axis] += (b.max[axis] - a.min[axis]) + SKIN;
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
