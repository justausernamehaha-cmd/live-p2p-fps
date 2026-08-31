import { clamp, lerp } from './util.js';
import { aabbOverlap } from './world.js';
import { capsulePush } from './solid.js';
import { portalMap, atMouth, pierce, BODY_SAMPLES, HALF_W, HALF_H } from './portal.js';
import {
  UP_Y, snapAxis, axisKey, axisSign, crossKeys, basisFor, lookFrom, anglesIn
} from './frame.js';

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
// There is no speed limit. There was a 22 m/s sanity cap, and a raised one for
// the three seconds after a portal handed you a fall to spend — the second
// existed only to get out of the way of the first. Both are gone at the user's
// asking: what you build is yours to keep, and the ground rules below (friction,
// drag, the collapse on a bump) are the only things that take speed off you.
const MAX_STEP_DIST = 0.3;      // sub-step the movement so fast players cannot tunnel
const STEP_SMOOTH_RATE = 5;     // m/s the view catches up after a step, i.e. a linear climb
const STEP_SMOOTH_MAX = 1.0;
// Push out of a box to just *clear* of its face, never to exactly touching.
// Landing exactly on a face leaves floating point free to put the player a
// fraction inside it, and the next axis resolved then sees a real overlap and
// ejects them across the whole box: walk into a four-metre wall and you end up
// standing on top of it. A millimetre of clearance costs nothing and cannot.
const SKIN = 1e-3;
// Straight up and straight down, exactly — at the user's asking. It used to stop
// a hundredth of a radian short, because the camera was aimed with lookAt() and
// lookAt takes its roll from an up vector it cannot use once the look direction
// is parallel to it. The camera now builds its own basis from the player's yaw
// (see Game._camera), which is defined at every pitch, so the limit is the real
// one: past it you would be looking out of the back of your own head.
const MAX_PITCH = Math.PI / 2;
const CROUCH_TIME = 0.3;        // seconds to fully crouch or stand, so it cannot flicker
// A portal is a hole in a wall that the wall does not know about. It used to be
// a hole you were thrown through: the crossing was tested against a plane held a
// radius out in *front* of the surface, so you were handed over before the wall
// could refuse you and the far side pushed you clear of itself on arrival. Both
// of those were the teleport showing, and both are gone. The wall itself is
// taken out of collision while a body is in the mouth (see `_boxes`), so the
// body goes through the hole the way anything goes through a hole.
//
// Sample points down the body, as fractions of its height, shared with whatever
// draws the half of a body that is out of the far mouth. Any part of you in the
// mouth is you in the mouth. The feet and the head have to be in the list:
// falling into a portal on the floor is the feet going through it and nothing
// else, and the head is the eye, which is what decides the hand-over.
const PORTAL_SAMPLES = BODY_SAMPLES;
// The sample line is the middle of the player, but a player is a cylinder. The
// mouth is widened by the radius so that clipping the rim with a shoulder counts
// as going in — the edge of a portal is an entrance, not somewhere to scrape
// along.
const PORTAL_EDGE = RADIUS;
// How close a part of the body has to be to the surface to count as being in the
// mouth. A hole is a hole: if you are against the wall and the hole is where you
// are, the wall is not there for you, whichever way you happen to be walking.
const PORTAL_CONTACT = RADIUS + 0.03;
// Being crushed happens in two stages, so it can be seen coming. A platform
// closing on your head forces you down into a crouch first; only once it has
// pushed past that — half a head deeper — does it kill you.
const CRUSH_DEPTH = 0.17;           // half a head, the same 0.34 the model uses
// Seconds the camera takes to roll from one up to the next. The body turns at
// once — physics has no use for a half-turned frame — and only the view eases.
const UP_ROLL_TIME = 0.22;

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = { x: 0, y: 2, z: 0 };     // feet position
    this.vel = { x: 0, y: 0, z: 0 };
    // Which way is up for this player. Always one of the six world axes; a
    // portal can turn it over, and everything below that says "vertical" means
    // along this. See frame.js.
    this.up = UP_Y;
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
    this.straddling = null;   // the mouth the body is standing in, and its wall
    this._inMouth = null;     // ...and which mouth that is, so it is not re-entered
    this._wasAt = new Map();  // last step's position in each mouth's own frame
    this.portalCount = 0;     // bumped on every traversal, for tests and effects
    this.upFrom = null;       // the up we are rolling out of, for the camera only
    this.upBlend = 0;         // 1 -> 0 across the roll
    this.rideVel = null;      // the platform underfoot, if any, and how fast it goes
    this.squashed = false;    // a platform closed on us: the game turns this into a death
    this.beingCrushed = false;// ...and this is the warning before it, for the HUD
    this.escapes = 0;         // times the failsafe has had to fetch us back inside
  }

  /** Collision moves the body up a whole step at once; the view is dragged along
   *  behind it at a constant rate so a staircase is climbed as a straight line
   *  rather than a series of jolts. Shots come from here too, so aim still
   *  matches exactly what is on screen. */
  get eyeY() { return this.eye().y; }

  /** The eye, in the world. `extra` is the view bob, which travels with the
   *  head and so is measured along the player's own up like everything else. */
  eye(extra = 0) {
    const d = this.height * EYE_RATIO - this.stepSmooth + extra;
    return {
      x: this.pos.x + this.up.x * d,
      y: this.pos.y + this.up.y * d,
      z: this.pos.z + this.up.z * d
    };
  }

  /** Which world axis the body is tall along, and which way its head points. */
  get upK() { return axisKey(this.up); }
  get upS() { return axisSign(this.up); }
  /** The two axes it is wide along. */
  get flatK() { return crossKeys(this.up); }

  /** Speed along up — what used to be simply `vel.y`. */
  get vUp() { return this.vel[axisKey(this.up)] * axisSign(this.up); }
  set vUp(v) { this.vel[axisKey(this.up)] = v * axisSign(this.up); }

  /** Speed across the plane the player walks in. */
  flatSpeed() {
    const [a, b] = crossKeys(this.up);
    return Math.hypot(this.vel[a], this.vel[b]);
  }

  /** The body's box. Still axis-aligned whichever way up the player is, which
   *  is the entire reason an arbitrary up costs so little here: it is tall along
   *  one axis and RADIUS wide along the other two, and which is which is the
   *  only thing that changes. */
  aabb(pos = this.pos, height = this.height) {
    const k = axisKey(this.up), s = axisSign(this.up);
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
    // However a portal left you standing, you are born the right way up.
    this.up = UP_Y;
    this.upFrom = null;
    this.upBlend = 0;
    this.straddling = null;
    this._inMouth = null;
    this._wasAt = new Map();
    this.height = HEIGHT;
    this.crouching = false;
    this.crouchT = 0;
    this.sprintLatch = false;
    this.stepSmooth = 0;
    // lift out of anything the spawn point happens to clip
    for (let i = 0; i < 12 && this._overlaps(this.world.boxes); i++) this.pos.y += 0.5;   // up is (0,1,0) here
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
    // ...and to a change of up the same way, so turning over is a roll rather
    // than a frame in which the room is suddenly on its side
    if (this.upBlend > 0) this.upBlend = Math.max(0, this.upBlend - dt / UP_ROLL_TIME);

    // Which mouth we are standing in has to be known *before* the platforms are
    // resolved, not only inside the collision sub-steps: a lift coming down on
    // somebody who is in a mouth on its underside must go through them rather
    // than ride or crush them, and both of those happen up here.
    if (this.alive) this._updateStraddle(dt);
    if (this.alive) this._ride();

    // recoil relaxes back toward zero and is folded into the view, not the state,
    // so remote players never see a jittering aim direction
    this.recoil *= Math.exp(-9 * dt);
    this.recoilYaw *= Math.exp(-9 * dt);

    if (!this.alive) {
      const [da, db] = crossKeys(this.up);
      this.vel[da] = this.vel[db] = 0;
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

    // World-space wish direction. This basis MUST match the camera. At the
    // ordinary up it is the one it has always been — forward (-sin yaw, -cos yaw)
    // and right (cos yaw, -sin yaw) — and frame.js asserts exactly that; getting
    // a sign wrong mirrors the controls, W/S inverting when facing along z and
    // A/D when facing along x, which feels like a bug in the mouse.
    const [KA, KB] = crossKeys(this.up);
    const { f, r } = basisFor(this.up, this.yaw);
    const w = {
      x: r.x * wish.x + f.x * wish.y,
      y: r.y * wish.x + f.y * wish.y,
      z: r.z * wish.x + f.z * wish.y
    };

    // Decide the jump now but apply it after the ground move, so a hop still
    // leaves the ground at full running speed. Holding space auto-hops, and a
    // frame that ends in a jump pays no friction at all — that is what lets a
    // chain of hops keep the speed it has built.
    const wantJump = input.down('jump') && this.onGround;

    const wishLen = Math.hypot(wish.x, wish.y);   // already clamped to <= 1
    const speed = this.flatSpeed();

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
        this.vel[KA] = w[KA] * maxSpeed;
        this.vel[KB] = w[KB] * maxSpeed;
      } else if (wishLen > 0.02) {
        // Carrying more than a walk — off a hop chain, a heavy landing, a run
        // down some stairs. Touching the ground must not confiscate that, so the
        // magnitude is kept and only the direction is steered, bleeding at
        // GROUND_DRAG rather than stopping friction.
        //
        const k = Math.min(1, GROUND_STEER * dt);
        const na = this.vel[KA] + (w[KA] * speed - this.vel[KA]) * k;
        const nb = this.vel[KB] + (w[KB] * speed - this.vel[KB]) * k;
        const m = Math.hypot(na, nb) || 1;
        this.vel[KA] = (na / m) * speed;
        this.vel[KB] = (nb / m) * speed;
        const drop = Math.max(0, 1 - GROUND_DRAG * dt);
        this.vel[KA] *= drop;
        this.vel[KB] *= drop;
      } else {
        // you stopped asking to move, so stop
        const drop = Math.max(0, 1 - GROUND_FRICTION * dt);
        this.vel[KA] *= drop;
        this.vel[KB] *= drop;
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
      const sgn = Math.sign(strafe);
      const na = r[KA] * sgn, nb = r[KB] * sgn;   // the camera's right vector

      const wishSpeed = Math.min(Math.abs(strafe) * maxSpeed, AIR.cap);
      const current = this.vel[KA] * na + this.vel[KB] * nb;
      const add = wishSpeed - current;
      if (add > 0) {
        const accel = Math.min(AIR.accel * wishSpeed * dt, add);
        const beforeMag = this.flatSpeed();
        this.vel[KA] += na * accel;
        this.vel[KB] += nb * accel;

        // Air control redirects, it never brakes. Straight Quake would let the
        // budget go negative and scrub speed when you flip from A to D against
        // your own momentum; here the magnitude is restored, so swapping strafe
        // keys turns the momentum instead of throwing it away.
        const afterMag = this.flatSpeed();
        if (afterMag < beforeMag && afterMag > 1e-4) {
          this.vel[KA] *= beforeMag / afterMag;
          this.vel[KB] *= beforeMag / afterMag;
        }
      }
    }

    if (wantJump) {
      this.vUp = JUMP_SPEED;
      this.onGround = false;
      // Leave a moving platform and you leave it *going somewhere*. Riding one
      // only ever moved the body, so jumping off a shuttle left the shuttle to
      // carry on without you and you landed behind it, which is not what
      // standing on a moving thing feels like anywhere.
      if (this.rideVel) {
        this.vel[KA] += this.rideVel[KA];
        this.vel[KB] += this.rideVel[KB];
      }
    }

    // Gravity pulls the way the feet point, which after a portal need not be
    // down the world's y at all.
    const vu = this.vUp;
    this.vUp = Math.max(-80, vu - GRAVITY * (vu < 0 ? FALL_GRAVITY : 1) * dt);

    this.fellAt = 0;
    this._move(dt);

    // A landing off a real drop is paid out as ground speed, along the way you
    // are already going — or, from a standing drop, along the keys. Height is
    // worth momentum, which is the same bargain the hop chain makes.
    if (this.fellAt > FALL_MIN) {
      const gain = Math.min(FALL_SPEED_MAX, (this.fellAt - FALL_MIN) * FALL_TO_SPEED);
      const sp = this.flatSpeed();
      let da, db;
      if (sp > 0.5) { da = this.vel[KA] / sp; db = this.vel[KB] / sp; }
      else if (wishLen > 0.02) { da = w[KA]; db = w[KB]; }
      else { da = db = 0; }     // dropped straight down standing still: nothing
      this.vel[KA] += da * gain;
      this.vel[KB] += db * gain;
    }

    // Hitting something ends a hop chain: whatever you had built collapses back
    // to the speed you can run at. Landings and stairs do not trigger this —
    // only a horizontal surface that actually stopped you.
    if (this.bumped) {
      this.bumped = false;
      const sp = this.flatSpeed();
      if (sp > maxSpeed && sp > 1e-4) {
        this.vel[KA] *= maxSpeed / sp;
        this.vel[KB] *= maxSpeed / sp;
      }
    }

    // view bob, purely cosmetic
    const groundSpeed = this.flatSpeed();
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
    const k = this.upK, up = this.upS;
    const [KA, KB] = this.flatK;
    const through = this._carvedMover();
    for (const m of movers) {
      if (m === through) continue;          // we are in a hole in this one
      const s = m.shape;
      if (this.pos[KA] + RADIUS <= s.min[KA] || this.pos[KA] - RADIUS >= s.max[KA]) continue;
      if (this.pos[KB] + RADIUS <= s.min[KB] || this.pos[KB] - RADIUS >= s.max[KB]) continue;
      // the face you would be standing on is whichever of its two is nearer your head
      const top = up > 0 ? s.max[k] : s.min[k];
      const gap = (top - this.pos[k]) * up;
      // standing on it, or it has just come up under us by less than a step
      if (gap > STEP_HEIGHT || gap < -0.12) continue;
      if (gap > 0) {
        if (this.vUp > 0.1) continue;           // jumping off it, not riding it
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
   *  Only platforms crush — but a platform is as dangerous carrying you as it is
   *  bearing down on you. Ride a lift up into the ceiling and the gap closing on
   *  your head is exactly the gap a lift coming down would close, and it kills
   *  the same way. The level's own walls and ceilings never crush anybody on
   *  their own: a ceiling only counts while something is driving you into it. */
  _crush() {
    this.beingCrushed = false;
    if (!this.alive || !this.world.movers || !this.world.movers.length) return;

    // A platform closing on you is only a platform if it is solid to you. Shoot
    // a mouth at the underside of a lift and stand where it will land and you go
    // *through* it — which is the whole difference between a hole and a wall,
    // and is the one way out of being crushed.
    const through = this._carvedMover();

    // ---- something coming down on top of us, or us coming up into something
    const k = this.upK, up = this.upS;
    const [KA, KB] = this.flatK;
    // Are we being carried toward our own head? Then the ceiling is closing on
    // us just as surely as if it were the thing moving, and the level's own
    // roof counts along with every platform.
    const carriedUp = !!this.rideVel &&
      (this.rideVel[k] * up) > 0.05 && this.onGround;
    let lowest = Infinity;
    const over = shape => {
      if (this.pos[KA] + RADIUS <= shape.min[KA] || this.pos[KA] - RADIUS >= shape.max[KA]) return;
      if (this.pos[KB] + RADIUS <= shape.min[KB] || this.pos[KB] - RADIUS >= shape.max[KB]) return;
      // "above" is toward the head, which after a portal can be any direction
      const near = up > 0 ? shape.min[k] : shape.max[k];
      const gap = (near - this.pos[k]) * up;
      if (gap <= 0.05) return;                             // not above us
      if (gap < lowest) lowest = gap;
    };
    for (const m of this.world.movers) {
      if (m === through) continue;
      over(m.shape);
    }
    if (carriedUp) {
      // The lift is taking us somewhere, and what is over it is now our problem.
      // Its own box is skipped: it is under our feet, not over our head, and the
      // scan above already ignores anything not above us.
      for (const b of this._boxes()) if (b.mover === undefined) over(b);
      for (const q of (this._solids() || [])) over(q);
    }
    if (lowest < Infinity) {
      const headroom = lowest;
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
      if (m === through) continue;
      const s = m.shape;
      // Sideways only. A platform coming down is the case above, and letting
      // this one see it would push the player out along whichever axis is
      // shallowest — which, for something resting on your head, is upwards.
      if (Math.abs(m.vel[k]) > Math.abs(m.vel[KA]) + Math.abs(m.vel[KB])) continue;
      // Low enough to walk onto is low enough to walk onto. Shoving the player
      // away from a knee-high platform would make the arena's shuttles
      // impossible to board, which is the opposite of the point of them.
      if ((up > 0 ? s.max[k] - this.pos[k] : this.pos[k] - s.min[k]) <= STEP_HEIGHT + 0.05) continue;
      if (!s.min || !aabbOverlap(this.aabb(), s)) continue;

      // Shoved along the way it is going, not out by the shortest route. A
      // platform bearing down on you does not politely lift you over itself; it
      // pushes you ahead of it, and whether that is survivable is a question
      // about what is behind you.
      const j = Math.abs(m.vel[KA]) >= Math.abs(m.vel[KB]) ? KA : KB;
      const forward = m.vel[j] >= 0;
      const wasAt = { ...this.pos };
      this.pos[j] = forward ? s.max[j] + RADIUS + SKIN : s.min[j] - RADIUS - SKIN;
      this.beingCrushed = true;
      if (this._overlapsStatic()) {
        this.pos = wasAt;          // nowhere to be shoved to
        this.squashed = true;
      }
      return;
    }
  }

  /** Overlapping anything that is not itself a moving platform — ramps and
   *  turned boxes included. They were left out, and a corner fillet or a ramp is
   *  exactly as unyielding to somebody being shoved into it as a wall is. */
  _overlapsStatic() {
    const a = this.aabb();
    for (const b of this._boxes()) {
      if (b.mover !== undefined) continue;
      if (aabbOverlap(a, b)) return true;
    }
    const [ax, ay, az, bx, by, bz] = this._capsule();
    for (const s of (this._solids() || [])) {
      if (s.mover !== undefined) continue;
      if (!aabbOverlap(a, s)) continue;
      if (capsulePush(ax, ay, az, bx, by, bz, RADIUS, s)) return true;
    }
    return false;
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
    for (const b of this._boxes()) if (aabbOverlap(test, b)) return true;
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

    const boxes = this._boxes();
    const k = this.upK, up = this.upS;
    const [KA, KB] = this.flatK;
    const da = this.vel[KA] * dt;
    const db = this.vel[KB] * dt;
    const start = { ...this.pos };

    // horizontal move, resolved one axis at a time
    const blockedA = this._axis(KA, da, boxes);
    const blockedB = this._axis(KB, db, boxes);
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
        // A step up may never gain more than a step. _axis() resolves an overlap
        // by pushing clear of the whole box, so a horizontal push-out that lands
        // a float's width inside a tall wall lets the settle above lift the
        // player all the way to the top of it — walk into a four-metre wall and
        // you would end up standing on it.
        const climbed = (this.pos[k] - start[k]) * up;
        if (climbed > STEP_HEIGHT + 1e-4) {
          this.pos = flat;
        } else if (stepped <= slid + 1e-4) {
          this.pos = flat;
        } else if (climbed > 0) {
          // took a step up: hold the view back by the height gained
          this.stepSmooth = Math.min(STEP_SMOOTH_MAX, this.stepSmooth + climbed);
        }
      }
    }

    // Anything still genuinely blocked loses its speed along that axis, and flags
    // the frame as a bump. Stairs do not count: the step-up moves you, so the
    // axis is not blocked.
    if (Math.abs(da) > 1e-6 && Math.abs(this.pos[KA] - start[KA]) < Math.abs(da) * 0.25) {
      this.vel[KA] = 0;
      this.bumped = true;
    }
    if (Math.abs(db) > 1e-6 && Math.abs(this.pos[KB] - start[KB]) < Math.abs(db) * 0.25) {
      this.vel[KB] = 0;
      this.bumped = true;
    }

    // vertical
    this.onGround = false;
    if (this._axis(k, this.vel[k] * dt, boxes)) {
      if (this.vUp <= 0) {
        this.onGround = true;
        this.fellAt = Math.max(this.fellAt, -this.vUp);   // read before it is zeroed
      }
      this.vUp = 0;
    }

    // ramps and turned boxes last: they are resolved by pushing out, so they
    // have to see where the axis-aligned pass actually left the player
    this._resolveSolids();

    // Anything the body is still inside is an overlap it did not walk into —
    // _axis() gives a move back rather than ejecting across a box, and a portal
    // can hand you over into a wall. Out the short way, every step, so it can
    // never be carried into the next one and compound.
    if (this._overlaps(this._boxes())) this._unstick();

    this._failsafe(dt);
  }

  /** Never let a player leak out of the level.
   *
   *  This used to be `pos.y < -20`, which only catches falling down the world's
   *  own y. Gravity follows the body through a portal, so somebody standing on a
   *  wall who gets out of the room leaves *sideways* and falls forever with y
   *  barely changing — and nothing ever fetched them back.
   *
   *  Being high up is not a fault and is never caught here: the room has a lid,
   *  but a level need not, and gravity brings anyone above it home on its own.
   *  Being far outside it sideways, or far below it, is a fault — and only once
   *  it has lasted, so that nothing transient during a hand-over is mistaken for
   *  one. */
  _failsafe(dt = 0) {
    const b = this.world.bounds;
    if (!b) return;
    const M = 25;
    const lost = this.pos.x < b.min.x - M || this.pos.x > b.max.x + M ||
                 this.pos.z < b.min.z - M || this.pos.z > b.max.z + M ||
                 this.pos.y < b.min.y - M;
    if (!lost) { this._lostFor = 0; return; }
    this._lostFor = (this._lostFor || 0) + Math.max(dt, 1 / 120);
    if (this._lostFor < 1.5) return;
    this._lostFor = 0;
    const p = this.world.randomSpawn();
    this.pos = { x: p.x, y: p.y, z: p.z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.up = UP_Y;
    this.upFrom = null;
    this.upBlend = 0;
    this.straddling = null;
    this._wasAt = new Map();
    this.onGround = false;
    this.escapes++;
    this.spawnSeq++;      // peers must not interpolate across the recovery
  }

  /** The level, as collision sees it this instant.
   *
   *  Which is not quite the level: a portal is a hole the wall does not know
   *  about, and a body standing in one is inside that wall. So the wall carrying
   *  the mouth is replaced, for as long as the body is in the mouth, by the
   *  pieces of itself left around the hole — see pierce() in portal.js, which
   *  also lists the three ways out of the map that came from taking the whole
   *  wall away instead.
   *
   *  The opening is widened by PORTAL_CONTACT so it is never narrower than the
   *  reach that decides a body is in the mouth: a hole the body is judged to be
   *  in but cannot fit through would stop the traversal dead against its own
   *  rim. */
  _boxes() {
    const st = this.straddling;
    const carve = st && st.host;
    if (!carve) return this.world.boxes;
    if (!this.world.boxes.includes(carve)) return this.world.boxes;
    const p = st.link.from;
    // The mouth can be on a moving platform, and then both it and its host move
    // every frame; the stamp is what notices.
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

  /** The same, for the ramps and turned boxes: a mouth can be cut into one of
   *  those too.
   *
   *  A convex solid cannot be pierced the way a box can — what is left of a
   *  wedge around a hole is not convex — so this one is still taken away whole.
   *  It is gated instead: the solid only vanishes once the *middle* of the body
   *  is genuinely over the oval, rather than as soon as any part of it is near
   *  the rim. Standing on a ramp beside a mouth cut into it therefore stays
   *  standing on a ramp. A push-out cannot fling anyone the length of a wall the
   *  way _axis() could, so this is the whole of the fix that side needs. */
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

  /** Is the middle of the body actually over the hole, rather than merely near
   *  it? Widened by the body's radius, the same way the mouth itself is. */
  _overOval(p) {
    const l = this._localOf(p, this._middle());
    const su = l.u / (HALF_W + PORTAL_EDGE), sv = l.v / (HALF_H + PORTAL_EDGE);
    return su * su + sv * sv <= 1;
  }

  /** How fast the body is moving *relative to a mouth*. Only differs from its
   *  own velocity for a mouth stuck to a moving platform, which is the case
   *  where it matters: the mouth arrives at you rather than the other way round. */
  _relativeTo(p) {
    const m = p.mover >= 0 && this.world.movers ? this.world.movers[p.mover] : null;
    if (!m) return this.vel;
    return { x: this.vel.x - m.vel.x, y: this.vel.y - m.vel.y, z: this.vel.z - m.vel.z };
  }

  /** A point up the body, in the world. */
  _sample(frac) {
    const d = this.height * frac;
    return {
      x: this.pos.x + this.up.x * d,
      y: this.pos.y + this.up.y * d,
      z: this.pos.z + this.up.z * d
    };
  }

  /** The eye as the physics uses it: no `stepSmooth`, which is a visual lag
   *  behind a step and has no business deciding where a body actually is. This
   *  is what the hand-over is anchored *on* — it is the thing you are looking
   *  through, so it is the thing that must not move.
   *
   *  It is not what decides *when*, though. See `_middle`. */
  _eyePhys() { return this._sample(EYE_RATIO); }

  /** The middle of the body, which is what has to be through a mouth for the
   *  rest of you to follow.
   *
   *  It used to be the eye, and on a wall that is the same question — the plane
   *  is vertical, so the head and the middle stand at the same distance from it.
   *  On anything tilted they are not: a mouth lying on a 45-degree ramp is about
   *  a metre and a third off the floor, and asking the *eye* to get below its
   *  plane means sinking a whole eye-height into the hill, which the floor
   *  underneath stops you doing. You stood in the mouth and nothing happened.
   *  Half of you through is the rule. */
  _middle() { return this._sample(0.5); }

  /** Is any part of the body in this mouth?
   *
   *  Two-sided, which is the whole change. A portal used to be something you
   *  were thrown through before you ever reached the wall, so a body behind the
   *  surface was an impossible state and the test only looked in front of it.
   *  Now you walk into a mouth and stand in it, and half a body past the plane
   *  is the ordinary case. The depth bound is a whole body length: past that you
   *  have gone through and out the back of the world, which cannot happen while
   *  the crossing below hands you over as soon as your eye reaches the plane. */
  _atMouth(p, reach = PORTAL_CONTACT) {
    return atMouth(p, this.pos, this.up, this.height, reach, PORTAL_EDGE);
  }

  /** Recompute which mouth the body is in, outside the collision loop. */
  _updateStraddle(dt = 0) {
    this.straddling = null;
    if (!this.portals) return;
    const links = this.portals.links();
    if (links && links.length) this.straddling = this._findStraddle(links, dt);
  }

  /** The moving platform we are currently inside the mouth of, if any. It is a
   *  hole, so it must not carry us and must not crush us — it goes through. */
  _carvedMover() {
    const host = this.straddling && this.straddling.host;
    if (!host || host.mover === undefined || !this.world.movers) return null;
    return this.world.movers[host.mover] || null;
  }

  /** Which mouth the body is standing in, and the piece of world that mouth is
   *  cut into — which collision has to stop seeing while we are in it.
   *
   *  The reach grows by however far this sub-step will close on the surface, and
   *  it has to: a body arriving at a mouth faster than the reach is wide would
   *  otherwise be stopped by the wall on the step *before* the hole was opened,
   *  stand on it for a frame, and set off again from rest. That is exactly what
   *  a fall through a floor mouth did — it arrived at 18 m/s and left at 8. */
  _findStraddle(links, dt = 0) {
    let best = null, bestD = Infinity;
    const e = this._middle();
    for (const link of links) {
      const p = link.from;
      const v = this._relativeTo(p);
      const closing = Math.max(0, -(v.x * p.n.x + v.y * p.n.y + v.z * p.n.z));
      const reach = PORTAL_CONTACT + closing * dt;
      if (!this._atMouth(p, reach)) continue;
      // A portal is a hole in *one side* of a wall. Standing on the far side of
      // the wall, directly behind the mouth, must not open that wall up: that is
      // walking through a wall, not through a portal. So a mouth can only ever
      // be entered from in front of it — and once you are in it you stay in it,
      // because a body wholly behind the surface is the ordinary case one step
      // later, and losing the mouth there would shut the wall on you.
      if (this._inMouth !== p && !this._nearFront(p, reach)) continue;
      const d = Math.abs((e.x - p.c.x) * p.n.x + (e.y - p.c.y) * p.n.y + (e.z - p.c.z) * p.n.z);
      if (d < bestD) { bestD = d; best = link; }
    }
    this._inMouth = best ? best.from : null;
    return best ? { link: best, host: this.world.hostFor(best.from) } : null;
  }

  /** Is any part of the body at the front of this mouth — on the outside of the
   *  surface, or no more than a shoulder's depth into it? */
  _nearFront(p, reach) {
    for (const frac of PORTAL_SAMPLES) {
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

  /** Walk into one mouth and out of the other, without ever being teleported.
   *
   *  A portal is not a doorway that moves you when you touch it: it is a hole,
   *  and the body goes through it the way anything goes through a hole — a bit
   *  at a time. So there is no lead plane held out in front of the wall any
   *  more, and no clearance pushing you out of the far side. There is one event,
   *  and it is the eye reaching the surface. Everything either side of it is
   *  ordinary movement through a wall that collision has been told is not there.
   *
   *  The hand-over is *exactly* the portal's own transform applied to the whole
   *  body — position, velocity, view, and which way is up — so the instant it
   *  happens nothing on screen moves at all. That is what makes it possible to
   *  stand still with half of you out of one mouth and half out of the other:
   *  neither half is a special case, they are the same body seen from the two
   *  sides of one hole.
   *
   *  Returns true when a hand-over happened, in which case this sub-step is over.
   */
  _tryPortal(dt) {
    this.straddling = null;
    if (!this.alive || !this.portals) return false;
    const links = this.portals.links();
    if (!links || !links.length) return false;

    this.straddling = this._findStraddle(links, dt);

    // Where the middle of the body sits in each mouth's own frame, this step and
    // last. Comparing the two is what makes a crossing a crossing:
    //
    //  * it needs no guess at where the body is going, so nothing slips through
    //    between a predicted step and the real one;
    //  * and it works when the *mouth* is what moved. A lift coming down on
    //    somebody standing still crosses them; measuring only the player's own
    //    step sees no crossing at all, and the mouth's movement between frames
    //    jumps the sign without ever being caught inside one.
    // Two points down the body decide a crossing: the eye and the middle,
    // whichever reaches the far side of the surface first.
    //
    // The eye is there because it is what the player is: "everything should use
    // my camera as the thinking point, since that's what I see". A mouth on the
    // underside of a rising platform is the case that needs it — stand under one
    // and it is your head that goes in, and asking the *middle* of the body to
    // get past a ceiling means half of you is inside the platform before
    // anything happens, which from behind the eye looks like the portal simply
    // not working.
    //
    // The middle stays because it is what a mouth lying on a slope needs: the
    // eye getting below a tilted plane means sinking an eye-height into the
    // hill, and the ground underneath stops you at about half of that. Taking
    // whichever comes first can only ever hand you over earlier, never later.
    const at = { eye: this._eyePhys(), mid: this._middle() };
    const seen = new Map();
    let crossed = null;
    for (const link of links) {
      const p = link.from;
      const cur = { eye: this._localOf(p, at.eye), mid: this._localOf(p, at.mid) };
      seen.set(p, cur);
      // With no sample from last step — the first one after a mouth is created —
      // step backwards to make one. That frame is exactly the expensive frame,
      // because the mouth's render target is being built on it, and a player
      // walking through a portal the instant it appears would otherwise cross it
      // in a single unwatched step and come out the other side of nothing.
      const prev = this._wasAt.get(p);
      const was = prev || {
        eye: this._localOf(p, this._back(p, at.eye, dt)),
        mid: this._localOf(p, this._back(p, at.mid, dt))
      };
      if (crossed) continue;
      for (const which of ['eye', 'mid']) {
        const a = was[which], b = cur[which];
        // only going in. Coming back out of the surface is how you leave a mouth
        // you are standing in, and it must not send you anywhere.
        if (!a || a.d < 0 || b.d >= 0) continue;
        const t = a.d - b.d > 1e-12 ? a.d / (a.d - b.d) : 0;
        const su = (a.u + (b.u - a.u) * t) / HALF_W;
        const sv = (a.v + (b.v - a.v) * t) / HALF_H;
        // Crossed the wall, not the hole. The oval is taken at its own size
        // here, not widened by a body radius as it once was: the wall now has a
        // hole in it the shape of the mouth (see pierce()), so anything
        // collision let this far is inside the oval already, and anything else
        // has no business being handed over.
        if (su * su + sv * sv > 1) continue;
        crossed = link;
        break;
      }
    }
    this._wasAt = seen;
    if (!crossed) return false;
    this._through(crossed, dt);
    return true;
  }

  /** Where the body was a step ago, relative to this mouth. */
  _back(p, at, dt) {
    const v = this._relativeTo(p);
    return { x: at.x - v.x * dt, y: at.y - v.y * dt, z: at.z - v.z * dt };
  }

  /** A world point in a mouth's own frame: across it, up it, and out of it. */
  _localOf(p, pt) {
    const dx = pt.x - p.c.x, dy = pt.y - p.c.y, dz = pt.z - p.c.z;
    return {
      u: dx * p.u.x + dy * p.u.y + dz * p.u.z,
      v: dx * p.v.x + dy * p.v.y + dz * p.v.z,
      d: dx * p.n.x + dy * p.n.y + dz * p.n.z
    };
  }

  /** The hand-over itself. */
  _through(link, dt) {
    const from = link.from, to = link.to;
    const map = portalMap(from, to);

    // The body is already past the plane — that is what was just measured — and
    // the transform sends a point behind the entry to the same distance in front
    // of the exit, so it comes out on the right side by construction.
    const eyeWas = this._eyePhys();     // read before `up` is turned over

    const look = map.dir(lookFrom(this.up, this.yaw, this.pitch));
    // Gravity follows the body. Where your feet point is where you fall, so the
    // exit decides which way is down for you from here — a mouth on a wall
    // stands you on that wall. Rounded to an axis: see frame.js.
    const turned = snapAxis(map.dir(this.up));
    if (turned !== this.up) { this.upFrom = this.up; this.upBlend = 1; }
    this.up = turned;
    const ang = anglesIn(this.up, look);
    this.yaw = ang.yaw;
    this.pitch = clamp(ang.pitch, -MAX_PITCH, MAX_PITCH);

    // The *eye* is what is anchored, not the feet. Where a mouth lies on a ramp
    // its transform turns the body by something that is not a right angle, and
    // rounding the new up to an axis then moves whatever point was pinned by as
    // much as the rounding — 0.7 m at the head, for a mouth on the arena's own
    // stairs. Pin the eye and that error goes into where the feet hang instead,
    // which nobody is looking through.
    const eyeAt = map.point(eyeWas);
    const d = this.height * EYE_RATIO;
    this.pos = {
      x: eyeAt.x - this.up.x * d,
      y: eyeAt.y - this.up.y * d,
      z: eyeAt.z - this.up.z * d
    };
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

    this.onGround = false;
    this.bumped = false;
    this.stepSmooth = 0;
    this.fellAt = 0;
    this.portalCount++;
    // Peers interpolate between the snapshots they hold; dragging a body across
    // the map between two of them is a smear rather than a teleport. This is the
    // same sequence number a respawn bumps, and it means the same thing here.
    this.spawnSeq++;

    // A fresh baseline: the body is somewhere else entirely, and last step's
    // distances describe a journey it did not make.
    this._wasAt = new Map();
    // Which mouth we are in now, so collision stops seeing the *exit's* wall —
    // the body is half inside that one from this moment on.
    this.straddling = this._findStraddle(this.portals.links());
    // Anything else it landed in, though, is a real overlap: resolve it along
    // the shallowest axis rather than letting _axis() eject across a whole box.
    if (this._overlaps(this._boxes())) this._unstick(to.n);
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
    const boxes = this._boxes();
    for (let i = 0; i < passes; i++) {
      const a = this.aabb();
      const cands = [];
      for (const b of boxes) {
        if (!aabbOverlap(a, b)) continue;
        for (const k of ['x', 'y', 'z']) {
          const up = b.max[k] - a.min[k] + SKIN;    // move + to clear it
          const dn = a.max[k] - b.min[k] + SKIN;    // move - to clear it
          for (const amount of [up, -dn]) {
            let cost = Math.abs(amount);
            // a nudge in the direction the portal faces is worth a little more
            // than one across it, all else being close
            if (prefer && Math.abs(prefer[k]) > 0.5 &&
                (prefer[k] > 0) === (amount > 0)) cost *= 0.75;
            cands.push({ k, amount, cost });
          }
        }
      }
      if (!cands.length) return true;
      cands.sort((x, y) => x.cost - y.cost);
      // The shortest way out that actually *is* out. The rule used to be the
      // shallowest axis of whichever box, taken blind — and the shallowest way
      // out of one box is very often straight into the next one, which on the
      // following pass is shallowest back the way it came. A body lying across
      // the foot of a wall was shoved between the wall and the floor for as long
      // as it lived, going nowhere. Trying each candidate costs a few box tests
      // and only ever runs on a body that is already somewhere it should not be.
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
    for (const b of boxes) if (aabbOverlap(a, b)) return true;
    return this._inSolid();
  }

  /** The player as the capsule solid.js resolves against: a vertical segment
   *  inset by the radius at each end, so its lowest point is still the feet. */
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
      if (!aabbOverlap(a, s)) continue;
      if (capsulePush(ax, ay, az, bx, by, bz, RADIUS, s)) return true;
    }
    return false;
  }

  /** Push out of every ramp and turned box the player is inside.
   *
   *  Resolution is along the face normal, except where that face is walkable —
   *  there the push is straight up instead. Along-the-normal would work, but it
   *  also nudges you a little downhill every frame gravity presses you into a
   *  ramp, and standing still on a slope would slide. */
  _resolveSolids() {
    const solids = this._solids();
    if (!solids || !solids.length) return;
    // Broad phase first. A convex push-out is not expensive on its own, but it
    // runs against every solid, twice, on every one of up to eight collision
    // sub-steps — and the room's corner fillets doubled how many solids there
    // are, each of them as long as a wall. The box test rejects nearly all of
    // them for the price of six comparisons.
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const s of solids) {
        if (!aabbOverlap(this.aabb(), s)) continue;
        const [ax, ay, az, bx, by, bz] = this._capsule();
        const hit = capsulePush(ax, ay, az, bx, by, bz, RADIUS, s);
        if (!hit) continue;
        moved = true;
        const n = hit.n;
        const facing = n.nx * this.up.x + n.ny * this.up.y + n.nz * this.up.z;
        if (facing > 0.5) {
          // walkable: push straight up rather than along the face, or standing
          // still on a slope would creep downhill every frame gravity presses in
          const d = hit.depth / facing;
          this.pos.x += this.up.x * d;
          this.pos.y += this.up.y * d;
          this.pos.z += this.up.z * d;
          if (this.vUp <= 0) {
            this.onGround = true;
            this.fellAt = Math.max(this.fellAt, -this.vUp);
            this.vUp = 0;
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
            if (Math.abs(facing) < 0.7) this.bumped = true;
          }
        }
      }
      if (!moved) break;      // a second pass only matters where two solids meet
    }
  }

  // There was a rule here that let a 45-degree face hand you back to the
  // world's own up — walk a corner fillet and you were upright again. It is
  // gone at the user's asking: **only a portal ever changes which way you
  // fall**. Touching a slope is not consent to be turned over, and getting home
  // from a wall is meant to cost you a shot and a walk, not a brush against a
  // corner. The fillets stay: they are still the only walkable surface between
  // a wall and a floor, and a mouth goes on one perfectly well.

  /** Move along one axis and push out of anything hit; returns true if blocked.
   *
   *  A move of `amount` can only ever be corrected by `amount`. Anything deeper
   *  than that is an overlap the move did not cause — the body was already
   *  inside the box — and pushing clear of the *whole* box then throws it out
   *  the far side: the room's own walls are a hundred and twenty metres long,
   *  so one step inside one is one step from being outside the map. Give the
   *  move back instead and leave the overlap to _unstick(), which goes out the
   *  short way. Blocked either way, which is the truthful answer. */
  _axis(axis, amount, boxes) {
    if (amount === 0) return false;
    const before = this.pos[axis];
    const cap = Math.abs(amount) + SKIN * 4;
    this.pos[axis] += amount;
    let blocked = false;
    for (const b of boxes) {
      const a = this.aabb();
      if (!aabbOverlap(a, b)) continue;
      blocked = true;
      const push = amount > 0 ? -((a.max[axis] - b.min[axis]) + SKIN)
                              : (b.max[axis] - a.min[axis]) + SKIN;
      if (Math.abs(push) > cap) { this.pos[axis] = before; return true; }
      this.pos[axis] += push;
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
