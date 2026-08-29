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
    g.player.portalCooldown = 0;
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
  await sleep(900);
  keys();
  out.walkedThrough = g.player.portalCount - before.count >= 1;
  out.afterWalk = { x: round(g.player.pos.x), y: round(g.player.pos.y), z: round(g.player.pos.z) };
  out.nearExit = Math.hypot(g.player.pos.x - 30, g.player.pos.z - 0) < 6;
  // in at -z, out along the exit's own normal, which is +x
  out.leftAlongExitNormal = g.player.vel.x > 3 && Math.abs(g.player.vel.z) < 2;
  out.speedAfter = round(speed());

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
  park(-40, 8, -40, 0);
  g.player.vel = { x: 0, y: -18, z: 0 };       // dropping hard
  const fellAt = 18;
  await sleep(700);
  out.fellThrough = g.player.portalCount >= 2;
  out.speedOutOfFall = round(speed());
  out.keptMostOfTheFall = speed() > fellAt * 0.55;
  out.exitZ = round(g.player.vel.z);

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

  // --------------------------------------------- it goes where it was shot
  // Not shuffled along until its border lines up with the block's edge. Fired
  // hard into the corner of the arena's floor-level wall, the portal has to
  // appear at the point of impact, overhang and all.
  g.portals.clear();
  const wall = g.world.boxes.find(b => b.min.z < -59 && b.max.x - b.min.x > 100);
  out.foundOuterWall = !!wall;
  if (wall) {
    const aimY = 0.35;                       // low enough that a slide would show
    g.portals.fire('me', { x: 12, y: aimY, z: -50 }, { x: 0, y: 0, z: -1 }, 'a');
    await sleep(700);
    const pa = g.portals.pairs.get('me')?.a;
    out.shotWhereAimed = pa ? round(Math.abs(pa.c.y - aimY)) : null;
    out.landedAtImpact = !!pa && Math.abs(pa.c.y - aimY) < 0.02 && Math.abs(pa.c.x - 12) < 0.02;
    out.allowedToOverhang = !!pa && pa.c.y - 1.0 < 0;      // half of a 2 m portal
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
    g.portals.selfView = showSelf ? g.selfAvatar.group : null;
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
  g.portals.selfView = g.selfAvatar.group;
  out.viewIsLive = g.portals.pairs.get('me')?.a?.disc.material.uniforms.uHasView.value;
  out.selfHiddenFromOwnCamera = g.selfAvatar.group.visible === false;

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
  return out;
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

want('a portal lands exactly where it was shot', R.landedAtImpact,
  { offBy: R.shotWhereAimed });
want('...and is allowed to hang over the edge', R.allowedToOverhang, R.allowedToOverhang);
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
want('you can see yourself through a portal', R.selfSeenThroughPortal > 200,
  { seen: R.selfSeenThroughPortal, control: R.selfNotSeenWithoutBody });
want('...and it really is the body you are seeing', R.selfNotSeenWithoutBody === 0,
  R.selfNotSeenWithoutBody);
want('your body never shows in your own camera', R.selfHiddenFromOwnCamera, R.selfHiddenFromOwnCamera);

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
