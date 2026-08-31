// Four ways a portal used to put a player inside a wall, or outside the map.
//
// All four were reported by hand, and they are one fault: collision was told a
// portal was a hole by taking the *whole wall* away for as long as a body was in
// the mouth. A wall that is entirely absent is not a wall with a hole in it.
//
//   1. stand in a mouth and walk toward the edge of it — you leave the oval
//      while still inside the wall, the wall comes back, and _axis() then pushes
//      you clear of the whole box, which for a room wall is the far end of the
//      room;
//   2. stand *on* a wall (a portal turned you over) with a mouth on that same
//      wall. Gravity is into the wall, the wall switched off as soon as your
//      feet were near the oval, and you sank through it and out of the room
//      without ever reaching the hole;
//   3. stand on the far side of the wall the mouth is on, right behind it, and
//      walk in. A portal is a hole in one side of a wall, not a doorway through
//      it;
//   4. and a mouth that turns you over dropping you out of the room.
//
// Everything is done on the mid-field cover walls rather than the room's own:
// they stand on flat floor, they are free of the corner fillets, and they are
// 2.4 m tall, which is a mouth and a little.
//
// The independent source of truth is the room itself: at no point may the body
// be inside a solid box, or outside the arena, and the failsafe must never have
// had to fetch anybody back.
//
//   ./serve.sh 8080 &   then   node test/clipping.mjs
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
await page.fill('#nameinput', 'clip');
await page.fill('#roominput', 'clip-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const out = {};
  const round = v => +v.toFixed(2);
  const keys = (...on) => {
    g.input.held.clear();
    for (const k of on) g.input.held.add(k);
    g.input._recalcKeys();
  };
  const park = (x, y, z, yaw = 0, up = { x: 0, y: 1, z: 0 }) => {
    g.player.pos = { x, y, z };
    g.player.vel = { x: 0, y: 0, z: 0 };
    g.player.yaw = yaw; g.player.pitch = 0;
    g.player.crouchT = 0; g.player.sprintLatch = false; g.player.stepSmooth = 0;
    g.player.up = up;
    g.player.upFrom = null; g.player.upBlend = 0;
    g.player.straddling = null;
    g.player._inMouth = null;
    g.player._wasAt = new Map();
    g.player.escapes = 0;
  };

  // Inside the room, with room to spare — the walls' inner faces are at ±59.5
  // and the lid at 12. Anything past this is out of the map however it got there.
  const inRoom = () => {
    const p = g.player.pos;
    return Math.abs(p.x) < 60.4 && Math.abs(p.z) < 60.4 && p.y > -1.4 && p.y < 13;
  };
  // Inside solid geometry, as the player's own collision sees it — that is, the
  // level with the hole cut in it, so a body genuinely standing in a mouth is
  // not counted and a body inside the wall *beside* the hole is. Being half
  // inside a wall while emerging from a mouth in it is the ordinary case; being
  // inside the part of that wall the mouth is not, is the bug.
  //
  // A generous tolerance: resting against a face is not being inside it.
  const inSolid = () => {
    const a = g.player.aabb();
    for (const b of g.player._boxes()) {
      if (b.mover !== undefined) continue;
      if (a.min.x < b.max.x - 0.06 && a.max.x > b.min.x + 0.06 &&
          a.min.y < b.max.y - 0.06 && a.max.y > b.min.y + 0.06 &&
          a.min.z < b.max.z - 0.06 && a.max.z > b.min.z + 0.06) return b;
    }
    return null;
  };

  /** Run for `ms`, watching every frame rather than only the end: a body that
   *  goes through a wall and comes back is still a body that went through it. */
  const watch = async (ms) => {
    const bad = { outOfRoom: 0, inSolid: 0, flung: 0 };
    const t0 = performance.now();
    let seq = g.player.spawnSeq;
    let last = { ...g.player.pos };
    let lastT = performance.now();
    while (performance.now() - t0 < ms) {
      await sleep(16);
      if (!inRoom()) bad.outOfRoom++;
      else if (inSolid()) bad.inSolid++;
      // Being flung: moving further than your own speed can account for. That is
      // the signature of _axis() ejecting a body clear of a whole box, which is
      // how a step inside a wall became a trip to the far end of it — and it is
      // measured against the body's own velocity rather than a fixed distance,
      // because a portal fall is genuinely fast and a fling is genuinely not
      // movement. Portal hand-overs are exempt (spawnSeq is bumped by every
      // one); nothing else is.
      const p = g.player.pos;
      const t = performance.now();
      const dt = Math.max(0.001, (t - lastT) / 1000);
      const moved = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
      const could = Math.hypot(g.player.vel.x, g.player.vel.y, g.player.vel.z) * dt * 2 + 0.6;
      if (g.player.spawnSeq === seq && moved > could) {
        bad.flung = Math.max(bad.flung, round(moved));
      }
      seq = g.player.spawnSeq;
      last = { ...p };
      lastT = t;
    }
    bad.escapes = g.player.escapes;
    bad.endedAt = { x: round(g.player.pos.x), y: round(g.player.pos.y), z: round(g.player.pos.z) };
    return bad;
  };

  // The two mid-field cover walls: one across x at z = 44, one across z at x = 44.
  const flat = g.world.boxes.filter(b => b.mover === undefined &&
    b.min.y === 0 && Math.abs(b.max.y - 2.4) < 1e-6);
  const wallZ = flat.find(b => b.max.x - b.min.x > 20 && b.max.z - b.min.z < 1.5 && b.min.z > 40);
  const wallX = flat.find(b => b.max.z - b.min.z > 20 && b.max.x - b.min.x < 1.5 && b.min.x > 40);
  out.foundWalls = !!wallZ && !!wallX;
  out.wallZ = wallZ && { z: round(wallZ.min.z), to: round(wallZ.max.z), top: round(wallZ.max.y) };
  if (!wallZ || !wallX) return out;

  // A mouth 2 m tall with its bottom edge on the floor, so a player walks
  // straight in rather than having to climb.
  const mouthOnZ = { c: { x: 0, y: 1.0, z: wallZ.min.z }, n: { x: 0, y: 0, z: -1 },
                     u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 };
  const mouthOnX = { c: { x: wallX.min.x, y: 1.0, z: 0 }, n: { x: -1, y: 0, z: 0 },
                     u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 };

  // ------------------------------------------- 1. walk to the edge of a mouth
  g.portals.clear();
  g.portals.place('me', 'a', mouthOnZ);
  g.portals.place('me', 'b', mouthOnX);
  await sleep(250);
  // Astride the surface — some of the body behind the plane, which is the whole
  // point of standing in a hole and is where walking sideways used to leave you
  // buried in the wall.
  park(0, 0.02, wallZ.min.z + 0.10, 0);
  await sleep(150);
  out.stoodInIt = !!g.player.straddling;
  keys('right');                              // strafe along the wall, out of the oval
  out.walkedToTheEdge = await watch(1400);
  keys();

  // -------------------------------- 2. standing on a wall, a mouth on that wall
  // Up is that wall's own normal, so gravity is straight into it and the only
  // way in is the hole. Walk along the face at the mouth.
  g.portals.clear();
  g.portals.place('me', 'a', mouthOnX);
  g.portals.place('me', 'b', mouthOnZ);
  await sleep(250);
  // standing on the -x face of the z-wall, 3 m along it from the mouth
  park(wallX.min.x, 1.2, -3, 0, { x: -1, y: 0, z: 0 });
  // face along +z, which is "forward" across that face
  g.player.yaw = window.__frame.anglesIn(g.player.up, { x: 0, y: 0, z: 1 }).yaw;
  await sleep(200);
  out.stoodOnTheWall = Math.abs(g.player.pos.x - wallX.min.x) < 0.05;
  keys('fwd');
  out.walkedAtItOnTheWall = await watch(1600);
  keys();

  // --------------------------------------- 3. from behind the wall it is on
  g.portals.clear();
  g.portals.place('me', 'a', mouthOnZ);
  g.portals.place('me', 'b', mouthOnX);
  await sleep(250);
  park(0, 0.05, wallZ.max.z + 1.4, 0);         // behind the wall, facing it (yaw 0 looks -z)
  await sleep(200);
  const crossings = g.player.portalCount;
  keys('fwd');
  out.walkedAtTheBack = await watch(1600);
  keys();
  out.backWentThrough = g.player.pos.z < wallZ.min.z;
  out.backCrossed = g.player.portalCount - crossings;

  // ---------------------------------------- 4. being turned over by a mouth
  // Up into a mouth over your head, out of one on a wall, standing on that wall.
  // The body's box is a different shape in the new frame, about a different
  // anchor, and it must not land inside anything.
  g.portals.clear();
  g.portals.place('me', 'a', { c: { x: -20, y: 2.4, z: -20 }, n: { x: 0, y: -1, z: 0 },
    u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 }, mover: -1 });
  g.portals.place('me', 'b', mouthOnX);
  await sleep(250);
  park(-20, 0.05, -20, 0);
  const before = g.player.portalCount;
  keys('jump');
  out.turnedOver = await watch(2400);
  keys();
  out.turnedOverCrossed = g.player.portalCount - before > 0;
  out.turnedOverUp = { ...g.player.up };
  // ...and gravity really did follow the feet: coming out of a mouth whose
  // normal is -x stands you on that face, so up is -x
  out.gravityFollowsFeet = g.player.up.x === -1;

  g.portals.clear();
  keys();
  return out;
});

const fail = [];
const clean = (name, r) => {
  if (!r) { fail.push(`${name}: never ran`); return; }
  if (r.outOfRoom) fail.push(`${name}: ${r.outOfRoom} frames outside the map, ended ${JSON.stringify(r.endedAt)}`);
  if (r.inSolid) fail.push(`${name}: ${r.inSolid} frames inside a solid box, ended ${JSON.stringify(r.endedAt)}`);
  if (r.escapes) fail.push(`${name}: the failsafe had to fetch the player back ${r.escapes} time(s)`);
  if (r.flung) fail.push(`${name}: flung ${r.flung} m in one frame, ended ${JSON.stringify(r.endedAt)}`);
};

if (!R.foundWalls) fail.push('could not find the mid-field cover walls');
else {
  if (!R.stoodInIt) fail.push('the player did not end up standing in the first mouth at all');
  clean('walking to the edge of a mouth', R.walkedToTheEdge);
  if (!R.stoodOnTheWall) fail.push('the player was not standing on the wall for case 2');
  clean('walking at a mouth on the wall you stand on', R.walkedAtItOnTheWall);
  clean('walking into the back of a mouth', R.walkedAtTheBack);
  if (R.backWentThrough) fail.push('walked straight through the wall from behind the mouth');
  if (R.backCrossed) fail.push('entering a mouth from behind handed the player over');
  clean('being turned over by a mouth', R.turnedOver);
  if (!R.turnedOverCrossed) fail.push('the turn-over case never went through a portal');
  if (!R.gravityFollowsFeet) fail.push(`gravity did not follow the feet: up is ${JSON.stringify(R.turnedOverUp)}`);
}

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: no portal puts a player inside a wall or outside the map');
await browser.close();
process.exit(fail.length ? 1 : 0);
