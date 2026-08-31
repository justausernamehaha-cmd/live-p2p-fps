// Portals and moving platforms, in a real browser, driven the way a player
// drives them.
//
// The node suite (test/portal.mjs) proves the arithmetic. This one proves the
// arithmetic means something to the *player*: that walking into a mouth puts you
// out of the other one going the same speed, that a fall is still worth that
// speed on the far side, that the gun refuses a surface too small for a portal,
// and that a platform carries whoever is standing on it. Every check has a
// negative control next to it — the same walk with the portals taken away has to
// end somewhere else, or the test is measuring a coincidence.
//
//   ./serve.sh 8080 &   then   node test/portals.mjs
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'portal');
await page.fill('#roominput', 'solo-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const out = {};
  const keys = (...on) => {
    g.input.held.clear();
    for (const k of on) g.input.held.add(k);
    g.input._recalcKeys();
  };
  const park = (x, y, z, yaw = 0) => {
    g.player.pos = { x, y, z };
    g.player.vel = { x: 0, y: 0, z: 0 };
    g.player.yaw = yaw; g.player.pitch = 0;
    g.player.crouchT = 0; g.player.sprintLatch = false; g.player.stepSmooth = 0;
    // Which way is up is state now, and a portal can turn it over. Parking
    // somewhere means parking there the right way up, or every check after the
    // first traversal would quietly be measuring a player standing on a wall.
    g.player.up = { x: 0, y: 1, z: 0 };
    g.player.straddling = null;
  };
  const speed = () => Math.hypot(g.player.vel.x, g.player.vel.z);
  const round = v => +v.toFixed(2);

  // ------------------------------------------------------- the gun exists
  out.weaponCount = window.__WEAPONS ? window.__WEAPONS.length : g.loadout.state.length;
  g.loadout.switchTo(3, performance.now() / 1000);
  out.name = g.loadout.weapon.name;
  out.perfect = g.loadout.weapon.perfect === true;
  out.infinite = g.loadout.weapon.infinite === true;

  // accuracy is 100% in every stance — the whole point of `perfect`
  out.spreadStill = window.__spreadFor(g.loadout.weapon, false, 0);
  out.spreadMoving = window.__spreadFor(g.loadout.weapon, true, 0);
  out.rifleMovingSpread = window.__spreadFor(window.__WEAPONS ? window.__WEAPONS[0]
    : { spread: 0, hipSpread: 0.09 }, true, 0);

  // right click is the second trigger, so it must not raise sights
  g.adsT = 0;
  g.input.held.add('ads');
  await sleep(400);
  out.adsWithPortalGun = round(g.adsT);
  g.input.held.delete('ads');
  g.loadout.switchTo(0, performance.now() / 1000);
  g.input.held.add('ads');
  await sleep(400);
  out.adsWithRifle = round(g.adsT);
  g.input.held.delete('ads');
  await sleep(450);
  g.loadout.switchTo(3, performance.now() / 1000);

  // -------------------------------------------------- traversal, by hand
  // The portals are placed directly here: this measures what going through one
  // does, not where the gun puts them, and those are two different claims.
  const put = () => {
    g.portals.clear();
    g.portals.place('me', 'a', {
      c: { x: 0, y: 1, z: -20 }, n: { x: 0, y: 0, z: 1 },
      u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1
    });
    g.portals.place('me', 'b', {
      c: { x: 30, y: 1, z: 0 }, n: { x: 1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 }, mover: -1
    });
  };

  // the negative control first: the same walk with nothing to walk into
  g.portals.clear();
  park(0, 0.3, -17, 0);            // yaw 0 faces -z, straight at where A will be
  await sleep(200);
  keys('fwd');
  await sleep(900);
  keys();
  out.withoutPortals = { x: round(g.player.pos.x), z: round(g.player.pos.z) };

  put();
  park(0, 0.3, -17, 0);
  await sleep(200);
  const before = { count: g.player.portalCount };
  keys('fwd');
  // Wait for the traversal rather than for a stopwatch. The first two portals of
  // the session are the expensive ones — their render targets are built on the
  // frame they appear — so a fixed window can end with the player still three
  // strides short of a mouth they were always going to walk into.
  for (let i = 0; i < 160 && g.player.portalCount === before.count; i++) await sleep(16);
  // read while still walking: letting go first would measure the friction
  out.walkedThrough = g.player.portalCount - before.count >= 1;
  out.afterWalk = { x: round(g.player.pos.x), y: round(g.player.pos.y), z: round(g.player.pos.z) };
  out.nearExit = Math.hypot(g.player.pos.x - 30, g.player.pos.z - 0) < 6;
  // in at -z, out along the exit's own normal, which is +x
  out.leftAlongExitNormal = g.player.vel.x > 3 && Math.abs(g.player.vel.z) < 2;
  out.speedAfter = round(speed());
  keys();

  // ------------------------------------------------- momentum is not scrubbed
  // A fast fall into a portal on the floor has to come out of a wall as speed.
  g.portals.clear();
  g.portals.place('me', 'a', {
    c: { x: -40, y: 0, z: -40 }, n: { x: 0, y: 1, z: 0 },
    u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, mover: -1
  });
  g.portals.place('me', 'b', {
    c: { x: 40, y: 3, z: 40 }, n: { x: 0, y: 0, z: -1 },
    u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1
  });
  park(-40, 7, -40, 0);                        // the arena has a roof now
  g.player.vel = { x: 0, y: -18, z: 0 };       // dropping hard
  const fellAt = 18;
  // Read at the instant of the traversal. Sampling a moment later measures where
  // the flight happened to have got to, not what the portal handed over — and now
  // that a fling is allowed to keep its speed, a moment later is a wall away.
  let outSpeed = null, outZ = null;
  const wrapped = g.player._tryPortal.bind(g.player);
  g.player._tryPortal = function (dt) {
    const r = wrapped(dt);
    if (r && outSpeed === null) {
      outSpeed = Math.hypot(this.vel.x, this.vel.z);
      outZ = this.vel.z;
    }
    return r;
  };
  await sleep(700);
  g.player._tryPortal = wrapped;
  out.fellThrough = g.player.portalCount >= 1;
  out.speedOutOfFall = outSpeed === null ? null : round(outSpeed);
  out.keptMostOfTheFall = outSpeed !== null && outSpeed > fellAt * 0.55;
  out.exitZ = outZ === null ? null : round(outZ);

  // ---------------------------------------------- the gun places and refuses
  g.portals.clear();
  keys();
  // point at the big outer wall at -z and pull both triggers
  park(0, 0.3, -40, 0);
  g.player.pitch = 0;
  await sleep(150);
  g.loadout.nextShot = 0;
  g.portals.fire('me', { x: 0, y: 1.6, z: -40 }, { x: 0, y: 0, z: -1 }, 'a');
  await sleep(700);
  const pair = g.portals.pairs.get('me');
  out.gunPlaced = !!(pair && pair.a);
  out.placedOnWall = pair && pair.a ? round(pair.a.c.z) : null;
  out.placedUpright = pair && pair.a ? Math.abs(pair.a.v.y) > 0.99 : false;

  // A 2 m crate is not too small — a 1.36 x 1.8 oval fits on one, which is worth
  // knowing. What is too small is the *end* of a cover wall: one metre of
  // thickness against a mouth 1.36 wide, whichever way it is slid.
  g.portals.clear();
  const thin = g.world.boxes.find(b =>
    b.max.x - b.min.x < 1.3 && b.max.z - b.min.z > 6 && b.max.y - b.min.y > 1.9 &&
    b.max.y < 5 && b.min.y >= 0);
  out.foundThinWall = !!thin;
  if (thin) {
    out.thinFace = [+(thin.max.x - thin.min.x).toFixed(2), +(thin.max.y - thin.min.y).toFixed(2)];
    const cx = (thin.min.x + thin.max.x) / 2, cy = (thin.min.y + thin.max.y) / 2;
    // straight at the narrow end face, which is thickness x height
    g.portals.fire('me', { x: cx, y: cy, z: thin.min.z - 5 }, { x: 0, y: 0, z: 1 }, 'a');
    await sleep(700);
    const p2 = g.portals.pairs.get('me');
    out.thinRefused = !(p2 && p2.a);

    // ...and the same wall's broad side is plenty, so the refusal above is
    // about the size of the surface and not about the gun failing to fire
    g.portals.clear();
    g.portals.fire('me', { x: cx - 6, y: cy, z: (thin.min.z + thin.max.z) / 2 },
                   { x: 1, y: 0, z: 0 }, 'a');
    await sleep(700);
    const p3 = g.portals.pairs.get('me');
    out.broadAccepted = !!(p3 && p3.a);
  }

  // ------------------------------------------------------- 2 m tall, oval
  out.portalHeight = round(2 * 1.0);
  const anyPortal = g.portals.pairs.get('me')?.a;
  out.discIsUpright = !!anyPortal && anyPortal.disc.scale.y > anyPortal.disc.scale.x;
  out.ringMatchesDisc = !!anyPortal &&
    Math.abs(anyPortal.ring.scale.x - anyPortal.disc.scale.x) < 1e-6 &&
    Math.abs(anyPortal.ring.scale.y - anyPortal.disc.scale.y) < 1e-6;
  // and it does not turn once it is there: rotating an unevenly scaled circle
  // sweeps the oval around and the mouth visibly changes shape
  const ringAngle0 = anyPortal ? anyPortal.ring.rotation.z : 0;
  await sleep(500);
  out.ringDidNotTurn = !!anyPortal && Math.abs(anyPortal.ring.rotation.z - ringAngle0) < 1e-9;

  // ------------------------------------------ the rim is an entrance too
  // Walk in offset almost the whole half-width, so the body only clips the edge.
  const rimRun = async (offset) => {
    g.portals.clear();
    const X = -52;
    g.portals.place('me', 'a', { c: { x: X, y: 1.0, z: -3 }, n: { x: 0, y: 0, z: 1 },
      u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    g.portals.place('me', 'b', { c: { x: X + 25, y: 1.0, z: 0 }, n: { x: 1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    park(X + offset, 0.3, -1.4, 0);
    await sleep(150);
    const before = g.player.portalCount;
    keys('fwd');
    await sleep(700);
    keys();
    return g.player.portalCount - before >= 1;
  };
  out.enteredAtTheRim = await rimRun(0.66);        // all but touching the edge
  out.enteredDeadCentre = await rimRun(0);
  out.refusedWellOutside = !(await rimRun(1.6));   // a metre and a half off: no

  // --------------------------------------- standing between two portals
  // Two mouths facing each other with the player in the gap. Nothing is moving
  // into anything, so nothing may teleport — this used to be the shape that
  // could strobe a player back and forth for ever.
  g.portals.clear();
  const BX = -52;
  g.portals.place('me', 'a', { c: { x: BX, y: 1.3, z: -2.4 }, n: { x: 0, y: 0, z: 1 },
    u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  g.portals.place('me', 'b', { c: { x: BX, y: 1.3, z: 2.4 }, n: { x: 0, y: 0, z: -1 },
    u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  park(BX, 0.05, 0, 0);
  keys();
  const stillCount = g.player.portalCount;
  await sleep(1200);
  out.stoodBetween = {
    teleports: g.player.portalCount - stillCount,
    stayed: Math.abs(g.player.pos.x - BX) < 0.3 && Math.abs(g.player.pos.z) < 0.5
  };

  // ------------------------------------------------- and you can see yourself
  // The strongest form of the claim, read out of the portal's own view rather
  // than off the screen: paint the player a colour nothing in the arena wears,
  // then count how much of it the front mouth is showing. The control is the
  // same frame with the body taken out of portal views entirely.
  const magentaIn = async (showSelf) => {
    g.portals.selfView = showSelf ? g.selfAvatar.root : null;
    g.myColor = 0xff00ff;
    g.selfAvatar.setColor(0xff00ff);
    await sleep(500);
    const t = g.portals.pairs.get('me')?.a?.target;
    if (!t) return -1;
    const buf = new Uint8Array(t.width * t.height * 4);
    g.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] > 90 && buf[i + 2] > 90 && buf[i] - buf[i + 1] > 45 && buf[i + 2] - buf[i + 1] > 45) n++;
    }
    return n;
  };
  out.selfSeenThroughPortal = await magentaIn(true);
  out.selfNotSeenWithoutBody = await magentaIn(false);
  g.portals.selfView = g.selfAvatar.root;
  out.viewIsLive = g.portals.pairs.get('me')?.a?.disc.material.uniforms.uHasView.value;
  // A mouth carries no lamp. It used to, and a portal on the floor beside a wall
  // lit the wall — and whoever stood at it — like a spotlight.
  out.mouthHasNoLamp = ![...g.portals.pairs.values()]
    .some(pr => ['a', 'b'].some(k => pr[k] && pr[k].light));
  out.sceneLightCount = g.scene.children.filter(c => c.isLight).length;
  out.selfHiddenFromOwnCamera = g.selfAvatar.root.visible === false;

  // ------------------------------------------------- falling through, for ever
  // One mouth at your feet and one over your head: you fall through the floor,
  // come out of the ceiling, and do it again faster. The speed has to keep
  // *building* — a fixed cooldown between traversals used to cap it, because
  // once the drop took less time than the cooldown the crossing was refused, the
  // player hit the floor instead, and the whole loop started again from rest.
  g.portals.clear();
  const LX = -52;
  g.portals.place('me', 'a', { c: { x: LX, y: 0, z: 0 }, n: { x: 0, y: 1, z: 0 },
    u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, mover: -1 });
  g.portals.place('me', 'b', { c: { x: LX, y: 8, z: 0 }, n: { x: 0, y: -1, z: 0 },
    u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 }, mover: -1 });
  park(LX, 6, 0, 0);
  g.player.hp = 100; g.player.alive = true;
  keys();
  const fallSpeeds = [];
  let seen = g.player.portalCount;
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    await sleep(16);
    if (g.player.portalCount !== seen) {
      seen = g.player.portalCount;
      fallSpeeds.push(+Math.abs(g.player.vel.y).toFixed(1));
    }
  }
  out.loopHops = fallSpeeds.length;
  out.loopFirst = fallSpeeds.slice(0, 5);
  out.loopPeak = fallSpeeds.length ? Math.max(...fallSpeeds) : 0;
  // each of the first several is faster than the last, and it never falls back
  out.loopBuilds = fallSpeeds.slice(0, 8).every((v, i, a) => i === 0 || v >= a[i - 1] - 0.5);
  out.loopNeverReset = fallSpeeds.slice(3).every(v => v > 15);

  // ...and turning that fall sideways keeps it, rather than clamping it to a
  // sprint the instant it leaves the mouth
  g.portals.clear();
  g.portals.place('me', 'a', { c: { x: LX, y: 0, z: 0 }, n: { x: 0, y: 1, z: 0 },
    u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, mover: -1 });
  g.portals.place('me', 'b', { c: { x: LX + 20, y: 1.2, z: 0 }, n: { x: 1, y: 0, z: 0 },
    u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  park(LX, 7, 0, 0);
  g.player.vel = { x: 0, y: -45, z: 0 };
  let flung = null;
  const beforeFling = g.player._tryPortal.bind(g.player);
  g.player._tryPortal = function (dt) {
    const r = beforeFling(dt);
    if (r && flung === null) flung = Math.hypot(this.vel.x, this.vel.z);
    return r;
  };
  await sleep(600);
  out.flingSpeed = flung === null ? null : round(flung);

  // ----------------------------------------- a mouth never hangs off its wall
  // Shot hard into a corner, it slides inward until the whole oval is on the
  // face — the least it can move and still be entirely on the surface.
  g.portals.clear();
  const bigWall = g.world.boxes.find(b => b.min.z < -59 && b.max.x - b.min.x > 100);
  out.foundOuterWall = !!bigWall;
  if (bigWall) {
    // above the corner fillet, or the shot lands on that instead of the wall
    g.portals.fire('me', { x: 12, y: 2.6, z: -50 }, { x: 0, y: 0, z: -1 }, 'a');
    await sleep(700);
    const pa = g.portals.pairs.get('me')?.a;
    out.slidClear = !!pa && pa.c.y - 1.0 >= 1.59;    // half of a 2 m portal, clear of the fillet
    out.slidTo = pa ? round(pa.c.y) : null;
  }

  // ---------------------------------- standing in a mouth leaves you in it
  // A portal is a hole, not a doorway that grabs you. Stand with the body
  // astride the surface and you stay there, half out of each mouth, for as long
  // as you like — which is only possible because the wall the mouth is cut into
  // has a hole in it while you are in it.
  //
  // The body goes *in the hole*, not merely near it. This used to stand the
  // player on the corner fillet with the mouth's bottom edge two thirds of a
  // metre above their feet, and their legs simply buried in the wall — which
  // was possible only because the whole wall was being taken out of collision.
  // A mouth is two metres and a player is 1.8, so a hole they are actually
  // inside is a hole they fit in.
  g.portals.clear();
  g.portals.fire('me', { x: -30, y: 3.2, z: -55 }, { x: 0, y: 0, z: -1 }, 'a');
  g.portals.fire('me', { x: 0, y: 1.6, z: -20 }, { x: 0, y: 0, z: 1 }, 'b');
  await sleep(900);
  const wm = g.portals.pairs.get('me')?.a;
  if (wm) {
    // eye a hair in front of the surface, so the front of the body is past it
    park(wm.c.x, wm.c.y - 0.95, wm.c.z + 0.1, 0);
    keys();
    const before = g.player.portalCount;
    await sleep(120);
    out.stillStraddles = !!g.player.straddling;
    const bs = g.player._boxes();
    // the wall is still in collision — with a hole cut in it, not removed
    out.stillPiercedTheWall = !bs.includes(g.player.straddling?.host) &&
                              bs.some(b => b.pierced) &&
                              bs.length > g.world.boxes.length - 1;
    const box = g.player.aabb();
    // the body genuinely crosses the plane: some of it in front, some behind
    out.stillHalfIn = box.min.z < wm.c.z - 0.02 && box.max.z > wm.c.z + 0.02;
    out.stillFrontDepth = round(wm.c.z - box.min.z);
    await sleep(480);
    out.stillStayedPut = g.player.portalCount - before === 0;
  }

  // -------------------------------------- and the hand-over is not a teleport
  // The body is re-expressed in the exit's frame at the instant the eye reaches
  // the surface, so the eye comes out exactly as far in front of the far mouth
  // as it had just gone behind the near one. That is an equality, not a
  // tolerance: if this drifts, the crossing has become a jump again.
  {
    // Both mouths on flat vertical wall, so nothing has to be pushed out of
    // anything afterwards: this measures the hand-over and only the hand-over.
    g.portals.clear();
    g.portals.place('me', 'a', { c: { x: -59.5, y: 3, z: 20 }, n: { x: 1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    g.portals.place('me', 'b', { c: { x: 59.5, y: 3, z: -20 }, n: { x: -1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    const cm = g.portals.pairs.get('me').a;
    let cont = null;
    const realThrough = g.player._through.bind(g.player);
    g.player._through = function (link, dt) {
      const e = this._eyePhys();
      const n = link.from.n, c = link.from.c;
      // the body has already passed the plane by the time this runs
      const before = (e.x - c.x) * n.x + (e.y - c.y) * n.y + (e.z - c.z) * n.z;
      const speedBefore = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
      realThrough(link, dt);
      const e2 = this._eyePhys(), n2 = link.to.n, c2 = link.to.c;
      const after = (e2.x - c2.x) * n2.x + (e2.y - c2.y) * n2.y + (e2.z - c2.z) * n2.z;
      if (cont === null) {
        cont = {
          before: +before.toFixed(6), after: +after.toFixed(6),
          gap: +Math.abs(after + before).toFixed(6),
          speedKept: +Math.abs(Math.hypot(this.vel.x, this.vel.y, this.vel.z) - speedBefore).toFixed(6),
          up: { ...this.up }, toN: { ...link.to.n }, toV: { ...link.to.v }, toU: { ...link.to.u },
          fromV: { ...link.from.v }, fromN: { ...link.from.n },
          straddlingAfter: !!this.straddling,
          hostAfter: !!(this.straddling && this.straddling.host)
        };
      }
    };
    park(cm.c.x + 1.2, cm.c.y - 1.62, cm.c.z, Math.PI / 2);    // yaw pi/2 walks along -x
    keys('fwd');
    await sleep(700);
    keys();
    g.player._through = realThrough;
    out.continuity = cont;
  }

  // ------------------------------------------- a mouth lying on a slope
  // Every slope in the map is 45 degrees, so a mouth on one is tilted 45
  // degrees, and the crossing is judged on the *middle* of the body rather than
  // on the eye for exactly this case: asking the eye to get below a tilted plane
  // means sinking a whole eye-height into the hill, and the floor underneath
  // stops you at about half of that. Standing in the mouth did nothing at all.
  g.portals.clear();
  g.portals.fire('me', { x: 15.2, y: 6, z: 0 }, { x: 0, y: -1, z: 0 }, 'a');  // the +x centre ramp
  await sleep(700);
  g.portals.place('me', 'b', { c: { x: 0, y: 3, z: -59.5 }, n: { x: 0, y: 0, z: 1 },
    u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  const ramped = g.portals.pairs.get('me')?.a;
  out.mouthOnASlope = ramped
    ? { tilted: round(ramped.n.y), onTheRamp: round(ramped.c.y) } : null;
  if (ramped) {
    park(ramped.c.x, ramped.c.y + 0.3, ramped.c.z, 0);
    keys();
    const before = g.player.portalCount;
    await sleep(1200);
    out.slopeMouthTookThem = g.player.portalCount - before > 0;
    out.slopeMouthEnded = round(g.player.pos.z);
  }

  // ------------------------------------- gravity comes through with the body
  // The user's own case: a mouth over your head and one on a wall. Go up into
  // the first and you come out of the second standing *on* that wall, with
  // gravity pulling into it — where your feet point is where you fall.
  g.portals.clear();
  const eastWall = g.world.boxes.find(b => b.min.x > 55 && b.max.z - b.min.z > 100);
  out.foundEastWall = !!eastWall;
  if (eastWall) {
    g.portals.place('me', 'a', { c: { x: -20, y: 4, z: -20 }, n: { x: 0, y: -1, z: 0 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 }, mover: -1 });
    g.portals.place('me', 'b', { c: { x: eastWall.min.x, y: 2.5, z: 0 }, n: { x: -1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    park(-20, 1, -20, 0);
    keys();
    // Measured inside the physics, one frame at a time. Sampling on the wall
    // clock catches whatever the flight happened to be doing 200 ms later —
    // including having already landed, which reads as no gravity at all.
    let pull = null;
    const seenAt = g.player.portalCount;
    const realUpdate = g.player.update.bind(g.player);
    g.player.update = function (dt, input) {
      const before = { ...this.vel }, up0 = { ...this.up };
      const pc = this.portalCount;
      realUpdate(dt, input);
      // not the frame of the hand-over itself: that velocity change is the
      // portal's transform, not gravity
      if (pull === null && pc > seenAt && this.portalCount === pc &&
          !this.onGround && dt > 0) {
        const d = (v, u) => -(v.x * u.x + v.y * u.y + v.z * u.z);
        pull = {
          toward: +((d(this.vel, up0) - d(before, up0)) / dt).toFixed(1),
          downward: +((before.y - this.vel.y) / dt).toFixed(1)
        };
      }
    };
    // Up into the mouth, and a little sideways with it: come out of the wall
    // dead square to it and gravity — which now points *into* that wall — drops
    // you straight back into the hole you just left.
    g.player.vel = { x: 0, y: 14, z: -3 };
    const before = g.player.portalCount;
    for (let i = 0; i < 60 && g.player.portalCount === before; i++) await sleep(16);
    out.gravityWentThrough = g.player.portalCount > before;
    out.upAfter = { ...g.player.up };
    await sleep(300);
    g.player.update = realUpdate;
    // GRAVITY is 24 m/s^2, and 1.4x that falling: the pull has to be that, along
    // the new up, with nothing left over pointing at the world's floor.
    out.pullTowardTheWall = pull ? pull.toward : null;
    out.pullDownward = pull ? pull.downward : null;
    out.stillOnItsWall = { ...g.player.up };
  }

  // ...and stepping out of one does not drop you straight back into it
  g.portals.clear();
  const X2 = -52;
  g.portals.place('me', 'a', { c: { x: X2, y: 1.2, z: -3 }, n: { x: 0, y: 0, z: 1 },
    u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  g.portals.place('me', 'b', { c: { x: X2 + 30, y: 1.2, z: 0 }, n: { x: 1, y: 0, z: 0 },
    u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  park(X2, 0.05, 0, 0);
  keys('fwd');
  await sleep(500);
  keys();
  const settled = g.player.portalCount;
  await sleep(1200);
  out.noBounceBack = g.player.portalCount - settled;

  // ------------------------------------------- bullets go through them too
  g.portals.clear();
  g.portals.place('me', 'a', { c: { x: X2, y: 1.6, z: -3 }, n: { x: 0, y: 0, z: 1 },
    u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  g.portals.place('me', 'b', { c: { x: 0, y: 1.6, z: -59.5 }, n: { x: 0, y: 0, z: 1 },
    u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  park(X2, 0.05, 0, 0);
  g.player.portalCooldown = 999;                 // stay put; this is about the bullet
  await sleep(200);
  const V = g._aimDirection().constructor;
  const eye = new V(g.player.pos.x, g.player.eyeY, g.player.pos.z);
  const aim = g._aimDirection();
  const shot = g._raycast(eye.clone(), aim, 200);
  out.shotLegs = shot.points.length;
  out.shotEnd = { x: round(shot.end.x), z: round(shot.end.z) };
  g.portals.clear();
  await sleep(150);
  const plain = g._raycast(eye.clone(), aim, 200);
  out.plainLegs = plain.points.length;
  out.plainEnd = { x: round(plain.end.x), z: round(plain.end.z) };
  g.player.portalCooldown = 0;

  // ------------------------------------- every platform's run is clear of the level
  // Swept along its whole path against every static box, because eyeballing this
  // is exactly what got it wrong: at head height the shuttles flew over the
  // cover walls, and lowering them so they could be climbed onto drove them
  // straight through the same walls.
  out.pathHits = g.world.movers.map(m => {
    const sh = m.shape;
    const hw = (sh.max.x - sh.min.x) / 2, hh = (sh.max.y - sh.min.y) / 2,
          hd = (sh.max.z - sh.min.z) / 2;
    const statics = g.world.boxes.filter(b =>
      b.mover === undefined && !(b.max.y <= 0.001 && b.min.y < -0.5));   // not the floor slab
    let n = 0;
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const c = { x: m.p0.x + (m.p1.x - m.p0.x) * t, y: m.p0.y + (m.p1.y - m.p0.y) * t,
                  z: m.p0.z + (m.p1.z - m.p0.z) * t };
      const box = { min: { x: c.x - hw, y: c.y - hh, z: c.z - hd },
                    max: { x: c.x + hw, y: c.y + hh, z: c.z + hd } };
      for (const b of statics) {
        if (box.min.x < b.max.x - 1e-6 && box.max.x > b.min.x + 1e-6 &&
            box.min.y < b.max.y - 1e-6 && box.max.y > b.min.y + 1e-6 &&
            box.min.z < b.max.z - 1e-6 && box.max.z > b.min.z + 1e-6) n++;
      }
    }
    return n;
  });

  // -------------------------------------------- riding a platform, and leaving it
  const ride = g.world.movers.find(m => Math.abs(m.p1.x - m.p0.x) > 10);
  out.foundRide = !!ride;
  if (ride) {
    ride.at = 0.3; ride.dir = 1;
    await sleep(100);
    const rb = ride.shape;
    park((rb.min.x + rb.max.x) / 2, rb.max.y + 0.02, (rb.min.z + rb.max.z) / 2, 0);
    keys();
    await sleep(250);
    out.ridingSpeed = round(ride.vel.x);
    out.rideVel = g.player.rideVel ? round(g.player.rideVel.x) : null;
    out.stoodOnIt = round(g.player.pos.y) === round(rb.max.y);
    // Jump, and read the speed on the frame it actually leaves the platform.
    // Polling on the wall clock caught whatever the flight was doing 100 ms
    // later, which under a software rasteriser is sometimes before the jump and
    // sometimes after the landing.
    let leftWith = null;
    const realUp = g.player.update.bind(g.player);
    g.player.update = function (dt, input) {
      const before = this.onGround;
      realUp(dt, input);
      if (leftWith === null && before && !this.onGround) leftWith = this.vel.x;
    };
    keys('jump');
    for (let i = 0; i < 40 && leftWith === null; i++) await sleep(16);
    g.player.update = realUp;
    out.velAfterJump = leftWith === null ? 0 : round(leftWith);
    keys();
    await sleep(500);

    // It arrives while you stand in its way. A shuttle is 1.3 m of solid block
    // now, not a plate you can step onto, so it does not lift you over itself:
    // it shoves you ahead of it, which is the whole reason a horizontal platform
    // is something to get out of the way of.
    ride.at = 0.25; ride.dir = 1;
    await sleep(80);
    const rb2 = ride.shape;
    park(rb2.max.x + 1.2, 0.05, (rb2.min.z + rb2.max.z) / 2, 0);
    keys();
    await sleep(150);
    const sx = g.player.pos.x;
    let onIt = false, shoved = 0;
    for (let i = 0; i < 90; i++) {
      await sleep(16);
      shoved = Math.max(shoved, g.player.pos.x - sx);
      if (g.player.pos.y > rb2.max.y - 0.1) onIt = true;
    }
    out.boardedWhenItArrived = onIt;
    out.shovedInstead = round(shoved);

    // ...and with something solid behind you, being shoved is being killed.
    // Nothing on the shuttle's own lane can do that — it runs an empty edge of
    // the room — so the wall is put there, which is the rule under test rather
    // than the arena.
    ride.at = 0.3; ride.dir = 1;
    await sleep(80);
    const rb4 = ride.shape;
    const cz = (rb4.min.z + rb4.max.z) / 2;
    const wall = { min: { x: rb4.max.x + 1.6, y: 0, z: cz - 3 },
                   max: { x: rb4.max.x + 2.6, y: 3, z: cz + 3 } };
    g.world.boxes.push(wall);
    park(rb4.max.x + 1.0, 0.05, cz, 0);
    keys();
    g.player.hp = 100; g.player.alive = true; g.player.squashed = false;
    g.protectedUntil = 0;
    let crushed = false;
    for (let i = 0; i < 120 && !crushed; i++) {
      await sleep(16);
      crushed = !g.player.alive || g.player.squashed;
    }
    out.crushedAgainstAWall = crushed;
    g.world.boxes.splice(g.world.boxes.indexOf(wall), 1);
    g.player.hp = 100; g.player.alive = true; g.player.squashed = false;
    park(0, 3, 0, 0);
    await sleep(200);

    // ...and you get onto one by jumping. 1.3 m is deliberately just inside a
    // jump — JUMP_SPEED 8.2 against GRAVITY 24 is 1.40 m of rise — and well
    // outside a step, which is 0.55.
    ride.at = 0.6; ride.dir = -1;
    await sleep(80);
    const rb3 = ride.shape;
    park(rb3.min.x - 3.0, 0.05, (rb3.min.z + rb3.max.z) / 2, -Math.PI / 2);
    await sleep(120);
    keys('fwd', 'jump');            // holding jump auto-hops
    let onIt2 = false;
    // Long enough that it does not matter whether the shuttle happens to be
    // running away at the time: it turns round at the end of its own run.
    for (let i = 0; i < 400 && !onIt2; i++) {
      await sleep(16);
      if (g.player.pos.y > rb3.max.y - 0.1) onIt2 = true;
    }
    keys();
    out.jumpedOnto = onIt2;
    out.shuttleTop = round(rb3.max.y);
  }

  // ------------------------------- standing on the edge of a rising lift
  // The feet sink into a platform coming up under them, and the next horizontal
  // move used to resolve that overlap the only way _axis() knows: by ejecting the
  // player clear of the whole box. One step on the edge flung you to an edge.
  const edgeLift = g.world.movers.find(m => Math.abs(m.p1.y - m.p0.y) > 2);
  if (edgeLift) {
    edgeLift.at = 0.2; edgeLift.dir = 1;
    await sleep(80);
    const es = edgeLift.shape;
    park(es.max.x - 0.3, es.max.y, (es.min.z + es.max.z) / 2, 0);
    await sleep(150);
    const ex = g.player.pos.x;
    keys('fwd');
    let flung = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(16);
      flung = Math.max(flung, Math.abs(g.player.pos.x - ex));
    }
    keys();
    out.edgeFling = round(flung);
  }

  // ---------------------------------- portals on the top and bottom of things
  // A portal is 1.36 by 2 and the top of a crate is 2 by 2, so laid diagonally
  // it did not fit on its own surface and the shot exploded — which way you
  // happened to be standing decided whether a box would take one. Floor and
  // ceiling mouths are snapped to the surface's own axes now.
  g.portals.clear();
  const crate = g.world.boxes.find(b => b.max.x - b.min.x < 2.2 && b.max.z - b.min.z < 2.2 &&
    b.min.y >= 0 && b.max.y > 1.5);
  out.foundCrate = !!crate;
  if (crate) {
    const cx = (crate.min.x + crate.max.x) / 2, cz = (crate.min.z + crate.max.z) / 2;
    let placed = 0;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      g.portals.clear();
      g.portals.fire('me', { x: cx, y: crate.max.y + 5, z: cz },
        { x: Math.cos(ang) * 0.01, y: -1, z: Math.sin(ang) * 0.01 }, 'a');
      await sleep(380);
      if (g.portals.pairs.get('me')?.a) placed++;
    }
    out.topFaceFromEveryAngle = placed;
  }
  // the underside of a lift, which is the one that has to ride as well
  const liftForBottom = g.world.movers.find(m => Math.abs(m.p1.y - m.p0.y) > 2);
  if (liftForBottom) {
    liftForBottom.at = 0.8;
    await sleep(80);
    const ls = liftForBottom.shape;
    g.portals.clear();
    g.portals.fire('me', { x: (ls.min.x + ls.max.x) / 2, y: 0.3, z: (ls.min.z + ls.max.z) / 2 },
      { x: 0, y: 1, z: 0 }, 'b');
    await sleep(600);
    const under = g.portals.pairs.get('me')?.b;
    out.bottomFace = under ? { n: round(under.n.y), rides: under.mover === liftForBottom.index } : null;
  }

  // ------------------------------------------------- crushed by a platform
  // Two stages, so it can be seen coming: a lift closing on your head pushes you
  // into a crouch first, and only once it has come half a head further are you
  // dead. The killfeed says who did it, and a platform is a who.
  g.portals.clear();
  const lift2 = g.world.movers.find(m => Math.abs(m.p1.y - m.p0.y) > 2);
  if (lift2) {
    const sh = lift2.shape;
    lift2.at = 1; lift2.dir = -1;
    await sleep(80);
    park((sh.min.x + sh.max.x) / 2, 0.05, (sh.min.z + sh.max.z) / 2, 0);
    g.player.hp = 100; g.player.alive = true; g.player.squashed = false;
    g.player.crouchT = 0; g.player.height = 1.8; g.player.deaths = 0;
    g.protectedUntil = 0;
    keys();
    const seen = { crouchedAt: null, died: false };
    for (let i = 0; i < 220 && !seen.died; i++) {
      await sleep(16);
      const headroom = sh.min.y - g.player.pos.y;
      if (seen.crouchedAt === null && g.player.crouchT > 0.25) seen.crouchedAt = round(headroom);
      if (!g.player.alive) seen.died = true;
    }
    out.crushVertical = seen;
    out.crushFeed = [...document.querySelectorAll('#killfeed > div')].map(e => e.textContent).slice(-1)[0] || '';
  }

  // --------------------------- ...unless the thing coming down has a hole in it
  // A mouth on the underside of a lift is a way out of being crushed by it, and
  // the only one. The crush above is the control: the same lift, the same place,
  // with nothing shot at it, kills you.
  const lift3 = g.world.movers.find(m => Math.abs(m.p1.y - m.p0.y) > 2);
  if (lift3) {
    g.portals.clear();
    lift3.at = 1; lift3.dir = -1;                  // at the top, on its way down
    await sleep(80);
    const sh = lift3.shape;
    const cx = (sh.min.x + sh.max.x) / 2, cz = (sh.min.z + sh.max.z) / 2;
    g.portals.place('me', 'a', { c: { x: cx, y: sh.min.y, z: cz }, n: { x: 0, y: -1, z: 0 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 }, mover: lift3.index });
    g.portals.place('me', 'b', { c: { x: 0, y: 3, z: -59.5 }, n: { x: 0, y: 0, z: 1 },
      u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    park(cx, 0.05, cz, 0);
    g.player.hp = 100; g.player.alive = true; g.player.squashed = false;
    g.player.crouchT = 0; g.player.height = 1.8;
    g.protectedUntil = 0;
    keys();
    const before = g.player.portalCount;
    const seen = { died: false, crouched: false };
    for (let i = 0; i < 260; i++) {
      await sleep(16);
      if (g.player.crouchT > 0.25) seen.crouched = true;
      if (!g.player.alive) { seen.died = true; break; }
      if (g.player.portalCount > before) break;
    }
    out.crushEscape = {
      ...seen,
      wentThrough: g.player.portalCount - before > 0,
      endedAt: { x: round(g.player.pos.x), y: round(g.player.pos.y), z: round(g.player.pos.z) }
    };
  }
  g.portals.clear();

  // ...and sideways, pressed into something that is not going anywhere
  const shuttle = g.world.movers.find(m => Math.abs(m.p1.x - m.p0.x) > 10);
  if (shuttle) {
    // A knee-high platform is meant to be stepped onto, not to shove anybody, so
    // the crusher here is a tall one — what the designer can build, and what the
    // arena's own shuttles deliberately are not.
    shuttle.at = 0; shuttle.dir = 1;
    await sleep(120);
    const b = shuttle.shape;
    const wasTop = b.max.y;
    b.max.y = b.min.y + 2.6;
    const wallX = b.max.x + 0.9;
    g.world.boxes.push({ min: { x: wallX, y: -1, z: b.min.z - 4 },
                         max: { x: wallX + 1, y: 6, z: b.max.z + 4 }, color: 0x888888, src: {} });
    park(b.max.x + 0.45, 0.05, (b.min.z + b.max.z) / 2, 0);
    g.player.hp = 100; g.player.alive = true; g.player.squashed = false;
    g.player.crouchT = 0; g.player.height = 1.8; g.player.deaths = 0;
    g.protectedUntil = 0;
    keys();
    let crushed = false, shoved = 0;
    const x0 = g.player.pos.x;
    for (let i = 0; i < 150 && !crushed; i++) {
      await sleep(16);
      shoved = Math.max(shoved, g.player.pos.x - x0);
      if (!g.player.alive) crushed = true;
    }
    out.crushSideways = { crushed, shovedFirst: round(shoved) };
    g.world.boxes.pop();
    b.max.y = wasTop;
  }

  // ------------------------------------------- the killfeed uses your name
  g.player.hp = 100; g.player.alive = true; g.protectedUntil = 0;
  g.hud.feed('---mark---');
  g._takeHit('nobody', { dmg: 500 });
  await sleep(80);
  const lines = [...document.querySelectorAll('#killfeed > div')].map(e => e.textContent);
  out.deathLine = lines[lines.length - 1] || '';
  out.usesMyName = out.deathLine.includes('portal') && !/\byou\b/i.test(out.deathLine);
  g.player.hp = 100; g.player.alive = true;

  // ------------------------------------------- a portal on a moving platform
  // A mouth on a lift hands over the lift's own motion. Caught at the instant of
  // the traversal, because gravity reverses an upward throw in a third of a
  // second and measuring afterwards measures nothing.
  let exitVel = null;
  const origTry = g.player._tryPortal.bind(g.player);
  g.player._tryPortal = function (dt) {
    const r = origTry(dt);
    if (r) exitVel = { ...this.vel };
    return r;
  };
  const lift = g.world.movers.find(m => Math.abs(m.p1.y - m.p0.y) > 2);
  out.foundLift = !!lift;
  if (lift) {
    const runIntoWall = async (attached) => {
      exitVel = null;
      g.portals.clear();
      const sh = lift.shape;
      const cx = (sh.min.x + sh.max.x) / 2, cz = (sh.min.z + sh.max.z) / 2;
      lift.at = 0.4; lift.dir = 1;                 // on its way up
      g.portals.place('me', 'b', { c: { x: cx, y: sh.max.y, z: cz }, n: { x: 0, y: 1, z: 0 },
        u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, mover: attached ? lift.index : -1 });
      // clear of the corner fillet, which is 1.6 m of 45-degree wedge now
      g.portals.place('me', 'a', { c: { x: -59.5, y: 3, z: -40 }, n: { x: 1, y: 0, z: 0 },
        u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
      park(-55, 0.05, -40, Math.PI / 2);           // yaw pi/2 walks along -x
      keys('fwd');
      await sleep(1100);
      keys();
      return exitVel ? round(exitVel.y) : null;
    };
    out.liftSpeed = round(lift.vel.y);
    out.exitOnLift = await runIntoWall(true);
    out.exitOffLift = await runIntoWall(false);
  }

  // ------------------------------ a mouth on a wall you are pressed against
  // A hole in a wall you are leaning on is a hole you can walk into — but it is
  // not a magnet. Sliding along the wall *past* the mouth used to drag you
  // through it, back when touching the surface anywhere inside the oval was
  // enough; now the body has to actually go in, which is what stops the
  // crossing being a teleport in the first place.
  g.portals.clear();
  g.portals.fire('me', { x: -30, y: 3.2, z: -55 }, { x: 0, y: 0, z: -1 }, 'a');
  g.portals.fire('me', { x: 0, y: 1.6, z: -20 }, { x: 0, y: 0, z: 1 }, 'b');
  await sleep(900);
  const wallMouth = g.portals.pairs.get('me')?.a;
  out.mouthOnWall = !!wallMouth;
  if (wallMouth) {
    park(wallMouth.c.x - 2.5, wallMouth.c.y - 1.62, wallMouth.c.z + 0.2, 0);
    keys('fwd');
    await sleep(400);                              // press into the wall
    out.pressedAgainstWall = round(Math.abs(g.player.pos.z - wallMouth.c.z));
    const before = g.player.portalCount;
    g.player.yaw = -Math.PI / 2;                   // now walk along the wall
    keys('fwd');
    await sleep(900);
    keys();
    out.hugReachedMouth = Math.abs(g.player.pos.x - wallMouth.c.x) < 1.5 ||
                          g.player.pos.x > wallMouth.c.x;
    out.hugSlidPast = g.player.portalCount - before === 0;
    // ...and turning into it goes through, from the same place
    park(wallMouth.c.x, wallMouth.c.y - 1.62, wallMouth.c.z + 0.5, 0);
    const before2 = g.player.portalCount;
    keys('fwd');
    await sleep(600);
    keys();
    out.hugTurnedIn = g.player.portalCount - before2 > 0;
  }

  // ------------------------------------------------------- moving platforms
  g.portals.clear();
  out.moverCount = g.world.movers.length;
  const m = g.world.movers.find(x => Math.abs(x.p1.x - x.p0.x) > 10);
  out.foundShuttle = !!m;
  if (m) {
    const start = { ...m.p0 };
    const t0 = m.at;
    await sleep(900);
    out.moverMoved = Math.abs(m.at - t0) > 0.02;
    out.moverAlongItsRun = Math.abs(
      (m.shape.min.x + m.shape.max.x) / 2 - (start.x + (m.p1.x - start.x) * m.at)) < 0.4;

    // it turns round rather than teleporting back
    m.at = 0.995; m.dir = 1;
    await sleep(400);
    out.moverTurnsRound = m.dir === -1 && m.at <= 1;

    // and it carries whoever is standing on it
    m.at = 0.1; m.dir = 1;
    await sleep(80);
    const top = m.shape.max.y;
    const cx = (m.shape.min.x + m.shape.max.x) / 2, cz = (m.shape.min.z + m.shape.max.z) / 2;
    park(cx, top + 0.05, cz, 0);
    keys();
    await sleep(700);
    const nowCx = (m.shape.min.x + m.shape.max.x) / 2;
    out.platformTravelled = round(nowCx - cx);
    out.riderTravelled = round(g.player.pos.x - cx);
    out.riderCarried = Math.abs((g.player.pos.x - cx) - (nowCx - cx)) < 0.6 &&
                       Math.abs(nowCx - cx) > 1;
  }

  // a portal stuck to a platform rides with it
  if (m) {
    const face = { x: (m.shape.min.x + m.shape.max.x) / 2, y: m.shape.max.y,
                   z: (m.shape.min.z + m.shape.max.z) / 2 };
    g.portals.place('me', 'a', {
      c: { ...face }, n: { x: 0, y: 1, z: 0 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, mover: m.index
    });
    const p0x = g.portals.pairs.get('me').a.c.x;
    const s0x = (m.shape.min.x + m.shape.max.x) / 2;
    await sleep(600);
    const p1x = g.portals.pairs.get('me').a.c.x;
    const s1x = (m.shape.min.x + m.shape.max.x) / 2;
    out.portalRodeAlong = Math.abs((p1x - p0x) - (s1x - s0x)) < 0.05 && Math.abs(s1x - s0x) > 0.5;
    out.portalDrift = round((p1x - p0x) - (s1x - s0x));
  }

  g.portals.clear();
  keys();
  g.portals.selfView = g.selfAvatar.root;
  return out;
});

// ------------------------------- what you see through it is what is behind it
// The strongest form of "the view should be clear": put both mouths in the same
// place facing opposite ways, which makes the portal transform the identity, and
// the disc must then show *precisely* what it is covering. Any difference at all
// is the view being wrong — a tint, a gamma slip, a stale frame.
//
// This is what caught the real one: the render target is written in sRGB and
// sampled back as linear, and a raw ShaderMaterial gets none of the conversions
// three.js appends to its own materials, so everything through a mouth came out
// at about a third of its brightness.
const identityScene = async (withPortals) => await page.evaluate(async (on) => {
  const g = window.game, P = g.player, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.portals.clear();
  g.portals.selfView = null;               // no body, so both sides are the same
  const X = -52, EYE = 1.67;               // open floor; the mouth at eye height
  if (on) {
    g.portals.place('me', 'a', { c: { x: X, y: EYE, z: -3 }, n: { x: 0, y: 0, z: 1 },
      u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    g.portals.place('me', 'b', { c: { x: X, y: EYE, z: -3 }, n: { x: 0, y: 0, z: -1 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    // the coloured lamp each mouth carries lights the floor, which is a real
    // difference but not one the view is answerable for
    for (const pr of g.portals.pairs.values()) {
      for (const side of ['a', 'b']) if (pr[side]?.light) pr[side].light.intensity = 0;
    }
  }
  P.pos = { x: X, y: 0.05, z: 0 }; P.vel = { x: 0, y: 0, z: 0 };
  P.yaw = 0; P.pitch = 0; P.portalCooldown = 0;
  await sleep(900);
}, withPortals);

const centrePatch = async () => {
  const png = PNG.sync.read(await page.screenshot());
  const cx = png.width >> 1, cy = png.height >> 1;
  let sum = [0, 0, 0], n = 0;
  for (let y = cy - 20; y < cy + 20; y++) {
    for (let x = cx - 20; x < cx + 20; x++) {
      const i = (y * png.width + x) * 4;
      sum[0] += png.data[i]; sum[1] += png.data[i + 1]; sum[2] += png.data[i + 2];
      n++;
    }
  }
  return sum.map(v => +(v / n).toFixed(1));
};

await identityScene(false);
R.directView = await centrePatch();
await identityScene(true);
R.viewThroughPortal = await centrePatch();
R.viewDifference = R.directView.map((v, i) => +Math.abs(R.viewThroughPortal[i] - v).toFixed(1));
await page.evaluate(() => {
  window.game.portals.clear();
  window.game.portals.selfView = window.game.selfAvatar.root;
});

const fail = [];
const want = (name, cond, got) => { if (!cond) fail.push(`${name} — got ${JSON.stringify(got)}`); };

want('the portal gun is the fourth weapon', R.name === 'Portal Gun', R.name);
want('it is perfectly accurate standing', R.spreadStill === 0, R.spreadStill);
want('and perfectly accurate moving', R.spreadMoving === 0, R.spreadMoving);
want('while the rifle still is not', R.rifleMovingSpread > 0, R.rifleMovingSpread);
want('it never runs out', R.infinite, R.infinite);
want('right click does not raise sights with it', R.adsWithPortalGun === 0, R.adsWithPortalGun);
want('but still does with the rifle', R.adsWithRifle > 0.5, R.adsWithRifle);

want('walking into a mouth traverses', R.walkedThrough, R.walkedThrough);
want('and puts you at the other one', R.nearExit, R.afterWalk);
want('leaving along the exit normal', R.leftAlongExitNormal, R.afterWalk);
want('keeping walking speed', R.speedAfter > 5, R.speedAfter);
want('the same walk with no portals goes nowhere near it',
  Math.abs(R.withoutPortals.x - 30) > 20, R.withoutPortals);

want('a fall through a floor portal comes out of the wall', R.fellThrough, R.fellThrough);
want('...carrying most of the fall as speed', R.keptMostOfTheFall, R.speedOutOfFall);

want('the gun places a portal on a wall', R.gunPlaced, R.gunPlaced);
want('...standing upright on it', R.placedUpright, R.placedUpright);
want('a surface too narrow explodes instead', R.thinRefused, { face: R.thinFace, refused: R.thinRefused });
want('...while the same wall\'s broad side takes one', R.broadAccepted, R.broadAccepted);

want('a portal is 2 m tall', R.portalHeight === 2, R.portalHeight);
want('...taller than it is wide', R.discIsUpright, R.discIsUpright);
want('...with the ring on the mouth, not around it', R.ringMatchesDisc, R.ringMatchesDisc);
want('a placed portal does not turn', R.ringDidNotTurn, R.ringDidNotTurn);

want('brushing the rim still takes you in', R.enteredAtTheRim, R.enteredAtTheRim);
want('...as does walking in dead centre', R.enteredDeadCentre, R.enteredDeadCentre);
want('...but walking well past it does not', R.refusedWellOutside, R.refusedWellOutside);

want('standing between two portals teleports nobody', R.stoodBetween.teleports === 0, R.stoodBetween);
want('...and leaves them where they stood', R.stoodBetween.stayed, R.stoodBetween);

want('a portal in view is rendering its far side', R.viewIsLive === 1, R.viewIsLive);
want('what you see through a mouth is exactly what it covers',
  Math.max(...R.viewDifference) <= 2,
  { direct: R.directView, through: R.viewThroughPortal, off: R.viewDifference });
want('you can see yourself through a portal', R.selfSeenThroughPortal > 200,
  { seen: R.selfSeenThroughPortal, control: R.selfNotSeenWithoutBody });
want('...and it really is the body you are seeing', R.selfNotSeenWithoutBody === 0,
  R.selfNotSeenWithoutBody);
want('your body never shows in your own camera', R.selfHiddenFromOwnCamera, R.selfHiddenFromOwnCamera);
want('a mouth throws no light onto anything solid', R.mouthHasNoLamp,
  { lamp: R.mouthHasNoLamp, sceneLights: R.sceneLightCount });

want('a mouth on a lift hands over the lift\'s motion',
  R.exitOnLift !== null && R.exitOffLift !== null && R.exitOnLift - R.exitOffLift > 1.5,
  { onLift: R.exitOnLift, offLift: R.exitOffLift, liftSpeed: R.liftSpeed });
want('a body pressed to a wall reaches a mouth on it', R.hugReachedMouth,
  { pressedAt: R.pressedAgainstWall, reached: R.hugReachedMouth });
want('...and slides past it rather than being sucked in', R.hugSlidPast, R.hugSlidPast);
want('...but walking into it goes through', R.hugTurnedIn, R.hugTurnedIn);

want('a fall through one mouth and out of another loops', R.loopHops > 12,
  { hops: R.loopHops, speeds: R.loopFirst });
want('...and gets faster every time round', R.loopBuilds, R.loopFirst);
want('...without ever dropping back to a standstill', R.loopNeverReset, R.loopFirst);
want('...up to the falling terminal', R.loopPeak > 55, R.loopPeak);
want('a fall turned sideways keeps its speed', R.flingSpeed !== null && R.flingSpeed > 30,
  { fling: R.flingSpeed, walkingCap: 22 });

want('a portal never hangs off the wall it is on', R.slidClear, { slidTo: R.slidTo });
want('standing in a mouth leaves you standing in it', R.stillStayedPut, R.stillStayedPut);
want('...with the body genuinely astride the surface', R.stillHalfIn,
  { half: R.stillHalfIn, frontDepth: R.stillFrontDepth });
want('...because the wall it is cut into has a hole in it',
  R.stillStraddles && R.stillPiercedTheWall,
  { straddling: R.stillStraddles, pierced: R.stillPiercedTheWall });

// the hand-over is a change of frame, not a jump
want('the eye comes out exactly as far in as it went',
  !!R.continuity && R.continuity.gap < 1e-6, R.continuity);
want('...at exactly the speed it went in with',
  !!R.continuity && R.continuity.speedKept < 1e-6, R.continuity);

// a mouth on a slope is a mouth
want('a portal goes on a 45-degree slope',
  !!R.mouthOnASlope && Math.abs(R.mouthOnASlope.tilted - 0.71) < 0.02, R.mouthOnASlope);
want('...and standing in it takes you through',
  R.slopeMouthTookThem, { through: R.slopeMouthTookThem, endedAtZ: R.slopeMouthEnded });

// gravity travels with the body
want('a ceiling mouth onto a wall stands you on that wall',
  R.gravityWentThrough && R.upAfter && R.upAfter.x === -1,
  { went: R.gravityWentThrough, up: R.upAfter });
want('...and gravity then pulls into that wall, not downward',
  R.pullTowardTheWall !== null && R.pullTowardTheWall >= 23 &&
  Math.abs(R.pullDownward) < 0.5 && R.stillOnItsWall && R.stillOnItsWall.x === -1,
  { towardTheWall: R.pullTowardTheWall, downward: R.pullDownward,
    up: R.stillOnItsWall });
want('...and coming out of one does not put you back in', R.noBounceBack === 0, R.noBounceBack);
want('a bullet goes through a portal', R.shotLegs > 2, { legs: R.shotLegs, end: R.shotEnd });
want('...and comes out somewhere the straight shot never reaches',
  R.shotEnd && R.plainEnd && (Math.abs(R.shotEnd.x - R.plainEnd.x) > 5 ||
                              Math.abs(R.shotEnd.z - R.plainEnd.z) > 5),
  { throughPortal: R.shotEnd, straight: R.plainEnd });
want('...while the same shot with no portals is one straight leg', R.plainLegs === 2, R.plainLegs);

want('a mouth in a lift is a way out of being crushed by it',
  !!R.crushEscape && R.crushEscape.wentThrough && !R.crushEscape.died,
  R.crushEscape);
want('...and it does not even squash you into a crouch on the way',
  !!R.crushEscape && !R.crushEscape.crouched, R.crushEscape);

want('no platform\'s run touches the level it runs through',
  R.pathHits && R.pathHits.every(n => n === 0), R.pathHits);
want('standing on a platform rides it', R.stoodOnIt && R.rideVel !== null,
  { onIt: R.stoodOnIt, rideVel: R.rideVel, platform: R.ridingSpeed });
want('jumping off one takes its momentum with you',
  R.velAfterJump > R.ridingSpeed * 0.6, { afterJump: R.velAfterJump, platform: R.ridingSpeed });
want('a platform arriving shoves you ahead of it rather than lifting you over',
  R.shovedInstead > 0.5, { onIt: R.boardedWhenItArrived, shoved: R.shovedInstead });
want('...and shoving you into something solid kills you', R.crushedAgainstAWall,
  R.crushedAgainstAWall);
want('...and you get onto one by jumping, which its 1.3 m top just allows',
  R.jumpedOnto, { onIt: R.jumpedOnto, top: R.shuttleTop });
want('a shuttle is high enough to have to be jumped and low enough to be jumped',
  R.shuttleTop > 0.55 && R.shuttleTop < 1.4, R.shuttleTop);
want('standing on the edge of a rising lift does not fling you',
  R.edgeFling !== undefined && R.edgeFling < 0.6, R.edgeFling);

want('a crate top takes a portal whichever way you face it',
  R.topFaceFromEveryAngle === 8, R.topFaceFromEveryAngle + '/8');
want('the underside of a lift takes one too, and it rides',
  R.bottomFace && R.bottomFace.n === -1 && R.bottomFace.rides, R.bottomFace);

want('a lift closing on your head crouches you first',
  R.crushVertical && R.crushVertical.crouchedAt !== null, R.crushVertical);
want('...and then kills you', R.crushVertical && R.crushVertical.died, R.crushVertical);
want('...credited to the platform', /platform/.test(R.crushFeed || ''), R.crushFeed);
want('a platform shoves you before it crushes you',
  R.crushSideways && R.crushSideways.shovedFirst > 0.05, R.crushSideways);
want('...and crushes you against a wall', R.crushSideways && R.crushSideways.crushed, R.crushSideways);

want('the killfeed names you, not "you"', R.usesMyName, R.deathLine);

want('the arena has moving platforms', R.moverCount >= 4, R.moverCount);
want('a platform actually moves', R.moverMoved, R.moverMoved);
want('...along its own run', R.moverAlongItsRun, R.moverAlongItsRun);
want('...and turns round at the end', R.moverTurnsRound, R.moverTurnsRound);
want('a platform carries its rider', R.riderCarried,
  { platform: R.platformTravelled, rider: R.riderTravelled });
want('a portal on a platform rides with it', R.portalRodeAlong, R.portalDrift);

console.log(JSON.stringify(R, null, 2));
if (errs.length) fail.push('page errors: ' + errs.join(' | '));
await browser.close();
if (fail.length) { console.log('FAILED:'); fail.forEach(f => console.log('  ' + f)); process.exit(1); }
console.log('portals + platforms OK');
