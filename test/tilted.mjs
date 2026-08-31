// Gravity that can rotate 45 degrees.
//
// Up used to be one of the six world axes, full stop, because that is what keeps
// the body's box axis-aligned and lets collision resolve one world axis at a
// time. A mouth on a 45-degree face therefore rounded your new up to whichever
// axis was nearer, and coming out of one stood you bolt upright on a slope.
//
// There are eighteen ups now: the six, and the twelve that sit at 45 degrees
// between two of them. A tilted body is not an AABB in any world frame, so it is
// collided as the capsule it has always been to the ramps — see Player._moveTilted.
//
// What this guards is that a tilted player is a *player*: they stand on the
// ground, they walk where they are looking, they fall the way their feet point,
// and they never leave the map.
//
//   ./serve.sh 8080 &   then   node test/tilted.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'tilt');
await page.fill('#roominput', 'tilt-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(600);

const R = await page.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const round = v => +v.toFixed(2);
  const out = {};
  const keys = (...on) => {
    g.input.held.clear();
    for (const k of on) g.input.held.add(k);
    g.input._recalcKeys();
  };
  const inRoom = () => {
    const p = g.player.pos;
    return Math.abs(p.x) < 60.4 && Math.abs(p.z) < 60.4 && p.y > -1.4 && p.y < 13;
  };

  // ------------------------------------------------- the frame knows eighteen
  const R2 = Math.SQRT1_2;
  out.upsCount = window.__frame.UPS ? window.__frame.UPS.length : null;

  // ---------------------------------- a body standing at 45 degrees stands up
  // The +x centre ramp climbs from x=16.5 to x=14 over 2.5 m, so its walkable
  // face points up and along -x: (-1,1,0)/root two. Stand on it with that as up
  // and the body should settle onto the face rather than sinking through it or
  // being thrown off it.
  const up = { x: -R2, y: R2, z: 0 };
  g.player.spawn({ x: 15.2, y: 4, z: 0 });
  g.player.up = up;
  g.player.upFrom = null; g.player.upBlend = 0;
  g.player.pos = { x: 15.2, y: 2.2, z: 0 };
  g.player.vel = { x: 0, y: 0, z: 0 };
  g.player.yaw = 0; g.player.pitch = 0;
  g.player.escapes = 0;
  keys();
  await sleep(900);
  out.tilted = g.player.tilted;
  out.upKept = round(g.player.up.x) === round(up.x) && round(g.player.up.y) === round(up.y);
  out.landed = g.player.onGround;
  out.restedAt = { x: round(g.player.pos.x), y: round(g.player.pos.y), z: round(g.player.pos.z) };
  out.stillInRoom = inRoom();
  // Slid downhill in its *own* frame and stopped on something. Down for this
  // body is (+x, -y) together, so it leaves the ramp toward +x and settles on
  // the floor at the ramp's foot — a face whose normal its up still agrees with,
  // which is what "ground" means for a tilted body.
  out.slidItsOwnWay = g.player.pos.x > 15.2 + 0.5 && g.player.pos.y < 2.2 - 0.5;

  // ------------------------------------------------ ...and can walk about on it
  // Forward for a tilted body is still whatever the camera is looking along,
  // flattened into their own ground — which is the ramp. Asserted against the
  // camera's own forward vector, not against "it moved".
  const before = { ...g.player.pos };
  const fwd = window.__frame.basisFor(g.player.up, g.player.yaw).f;
  keys('fwd');
  await sleep(900);
  keys();
  await sleep(150);
  const moved = { x: g.player.pos.x - before.x, y: g.player.pos.y - before.y, z: g.player.pos.z - before.z };
  const dist = Math.hypot(moved.x, moved.y, moved.z);
  out.walkedDistance = round(dist);
  out.walkedAlongTheCamera = dist > 0.4 &&
    round((moved.x * fwd.x + moved.y * fwd.y + moved.z * fwd.z) / dist) > 0.7;
  out.walkedStayedInRoom = inRoom();
  out.walkEscapes = g.player.escapes;

  // --------------------------------------------- ...and falls the way it points
  // Off the end of the ramp, gravity is along -up: the body accelerates toward
  // +x and -y together, not straight down the world's y.
  g.player.pos = { x: 15.2, y: 6, z: 0 };
  g.player.vel = { x: 0, y: 0, z: 0 };
  g.player.up = up;
  await sleep(220);
  const v = g.player.vel;
  const speed = Math.hypot(v.x, v.y, v.z) || 1;
  out.fallDir = { x: round(v.x / speed), y: round(v.y / speed), z: round(v.z / speed) };
  out.fallsAlongItsOwnDown =
    round(-(v.x * up.x + v.y * up.y + v.z * up.z) / speed) > 0.99;

  // --------------------------------- a mouth on a 45-degree face turns you 45
  // The image of an up through a mouth on a ramp is a 45-degree direction, and
  // it is kept as one instead of being rounded to whichever axis is nearer.
  g.portals.clear();
  g.portals.fire('me', { x: 15.2, y: 6, z: 0 }, { x: 0, y: -1, z: 0 }, 'a');
  await sleep(700);
  const ramped = g.portals.pairs.get('me')?.a;
  out.mouthOnASlope = ramped ? { n: { x: round(ramped.n.x), y: round(ramped.n.y), z: round(ramped.n.z) } } : null;
  if (ramped) {
    const cover = g.world.boxes.find(b => b.mover === undefined && b.min.y === 0 &&
      Math.abs(b.max.y - 2.4) < 1e-6 && b.max.x - b.min.x > 20 && b.max.z - b.min.z < 1.5 && b.min.z > 40);
    g.portals.place('me', 'b', { c: { x: 0, y: 1.0, z: cover.min.z }, n: { x: 0, y: 0, z: -1 },
      u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    await sleep(300);
    g.player.spawn({ x: 0, y: 0.05, z: cover.min.z - 4 });
    g.player.yaw = Math.PI;              // walks along +z, at the mouth's front
    g.player.escapes = 0;
    await sleep(200);
    const crossings = g.player.portalCount;
    let sawTilted = false, everLeft = 0;
    keys('fwd');
    for (let i = 0; i < 110; i++) {
      await sleep(16);
      if (g.player.tilted) sawTilted = true;
      if (!inRoom()) everLeft++;
    }
    keys();
    out.slopeCrossed = g.player.portalCount - crossings > 0;
    out.slopeGaveATiltedUp = sawTilted;
    out.slopeUp = { x: round(g.player.up.x), y: round(g.player.up.y), z: round(g.player.up.z) };
    out.slopeLeftTheRoom = everLeft;
    out.slopeEscapes = g.player.escapes;
  }

  g.portals.clear();
  keys();
  return out;
});

const fail = [];
if (R.upsCount !== 18) fail.push(`expected eighteen ups, found ${R.upsCount}`);
if (!R.tilted) fail.push('a 45-degree up was not recognised as tilted');
if (!R.upKept) fail.push('a 45-degree up did not survive a frame of physics');
if (!R.landed) fail.push(`a tilted body never landed: ${JSON.stringify(R.restedAt)}`);
if (!R.stillInRoom) fail.push(`a tilted body left the room: ${JSON.stringify(R.restedAt)}`);
if (!R.slidItsOwnWay)
  fail.push(`a tilted body did not fall the way it points and settle: ${JSON.stringify(R.restedAt)}`);
if (!R.walkedAlongTheCamera)
  fail.push(`a tilted body did not walk where its camera looks: moved ${R.walkedDistance} m`);
if (!R.walkedStayedInRoom || R.walkEscapes) fail.push('walking tilted left the room');
if (!R.fallsAlongItsOwnDown)
  fail.push(`a tilted body does not fall the way its feet point: ${JSON.stringify(R.fallDir)}`);
if (!R.mouthOnASlope || Math.abs(R.mouthOnASlope.n.y) > 0.9)
  fail.push('the test mouth did not land on a 45-degree face: ' + JSON.stringify(R.mouthOnASlope));
if (!R.slopeCrossed) fail.push('never went through the mouth on the slope');
if (!R.slopeGaveATiltedUp)
  fail.push(`coming out of a 45-degree mouth did not tilt gravity: up ${JSON.stringify(R.slopeUp)}`);
if (R.slopeLeftTheRoom || R.slopeEscapes)
  fail.push(`being turned 45 degrees put the player outside the map (${R.slopeLeftTheRoom} frames)`);

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ')
                        : 'PASS: gravity rotates 45 degrees, and a body standing at 45 degrees is still a player');
await browser.close();
process.exit(fail.length ? 1 : 0);
