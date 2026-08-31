// Moving platforms, from the outside.
//
// Three reports, all about being near one rather than on one:
//
//   1. "if I stand beside a moving horizontal platform then jump, I get stuck on
//      the edge of that platform" — _ride() snapped the feet up onto the top
//      whenever the body's box clipped its footprint, and the crush rule shoved
//      them straight off again, every frame;
//   2. the same crush rule put the player against whichever face the platform's
//      *velocity* pointed at, whoever they were and wherever they stood, so
//      standing behind one that was running away teleported you across it;
//   3. "if the vertical platform has a portal at the bottom and I'm below it, the
//      portal comes down and I'm still at the original place" — a mouth on the
//      underside of a lift is entered head first, and the crossing was judged on
//      the middle of the body, which for a ceiling means half of you is inside
//      the platform before anything happens.
//
//   ./serve.sh 8080 &   then   node test/platforms.mjs
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
await page.fill('#nameinput', 'plat');
await page.fill('#roominput', 'plat-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(800);

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
  const park = (x, y, z, yaw = 0) => {
    g.player.pos = { x, y, z };
    g.player.vel = { x: 0, y: 0, z: 0 };
    g.player.yaw = yaw; g.player.pitch = 0;
    g.player.up = { x: 0, y: 1, z: 0 };
    g.player.crouchT = 0; g.player.height = 1.8;
    g.player.straddling = null; g.player._inMouth = null; g.player._wasAt = new Map();
    g.player.alive = true; g.player.hp = 100; g.player.squashed = false;
  };
  // The biggest step between two frames that the player's own speed accounts
  // for. Anything more is a teleport, whatever caused it.
  const watchJumps = async (ms) => {
    let worst = 0, last = { ...g.player.pos }, lastT = performance.now();
    const seq0 = g.player.spawnSeq;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await sleep(16);
      const p = g.player.pos, t = performance.now();
      const dt = Math.max(0.001, (t - lastT) / 1000);
      const moved = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
      const could = Math.hypot(g.player.vel.x, g.player.vel.y, g.player.vel.z) * dt * 2 + 0.6;
      if (g.player.spawnSeq === seq0 && moved > could) worst = Math.max(worst, moved);
      last = { ...p }; lastT = t;
    }
    return round(worst);
  };

  const shuttle = g.world.movers.find(m => Math.abs(m.p1.x - m.p0.x) > 10);
  const lift = g.world.movers.find(m => Math.abs(m.p1.y - m.p0.y) > 2);
  out.foundShuttle = !!shuttle;
  out.foundLift = !!lift;
  if (!shuttle || !lift) return out;

  // ------------------------------------------- 1. jumping beside a shuttle
  // Right against its side, with the body's box clipping its footprint, which is
  // the pose that had _ride() and the crush rule pulling in opposite directions.
  shuttle.at = 0.4; shuttle.dir = 1;
  await sleep(80);
  const sh = shuttle.shape;
  out.shuttleTop = round(sh.max.y);
  keys('jump');                       // held: auto-hop, over and over
  park((sh.min.x + sh.max.x) / 2, 0.05, sh.min.z - 0.14, 0);
  const besideStartX = g.player.pos.x;
  out.jumpBesideFlung = await watchJumps(1600);   // watched from the first frame
  keys();
  await sleep(120);
  out.jumpBesideAlive = g.player.alive;
  out.jumpBesideEndedNear = round(Math.abs(g.player.pos.z - sh.min.z));
  // ...and not slid the length of the thing either
  out.jumpBesideDriftedX = round(Math.abs(g.player.pos.x - besideStartX));

  // -------------------------------------- 2. standing behind one leaving you
  shuttle.at = 0.5; shuttle.dir = 1;         // running toward +x
  await sleep(80);
  const sb = shuttle.shape;
  // just behind its trailing face, touching it
  keys();
  park(sb.min.x - 0.16, 0.05, (sb.min.z + sb.max.z) / 2, 0);
  const behindStart = g.player.pos.x;
  out.behindFlung = await watchJumps(900);       // watched from the first frame
  out.behindMoved = round(g.player.pos.x - behindStart);
  out.behindStillBehind = g.player.pos.x < (shuttle.shape.min.x + shuttle.shape.max.x) / 2;
  out.behindAlive = g.player.alive;

  // ------------------- 3. a mouth on the underside of a lift, coming down on you
  // Stand under it. The lift descends, the mouth reaches the camera, and that is
  // the moment you go through — not when half of you is inside the platform.
  park(0, 3, 0, 0);
  await sleep(200);
  // High enough that everything below can be set up before it is anywhere near
  // the player's head: the lift falls at 2.6 m/s and placing a portal takes a
  // couple of hundred milliseconds, which is most of a metre.
  lift.at = 1; lift.dir = -1;
  await sleep(60);
  const ls = lift.shape;
  g.portals.clear();
  g.portals.place('me', 'a', {
    c: { x: (ls.min.x + ls.max.x) / 2, y: ls.min.y, z: (ls.min.z + ls.max.z) / 2 },
    n: { x: 0, y: -1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 },
    mover: lift.index
  });
  // somewhere well away, on a mid-field cover wall
  const cover = g.world.boxes.find(b => b.mover === undefined && b.min.y === 0 &&
    Math.abs(b.max.y - 2.4) < 1e-6 && b.max.x - b.min.x > 20 && b.max.z - b.min.z < 1.5 && b.min.z > 40);
  g.portals.place('me', 'b', { c: { x: 0, y: 1.0, z: cover.min.z }, n: { x: 0, y: 0, z: -1 },
    u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  await sleep(250);
  park((ls.min.x + ls.max.x) / 2, 0.05, (ls.min.z + ls.max.z) / 2, 0);
  keys();
  await sleep(150);
  // ...and only now let it come down, so the mouth really does arrive at a head
  // that is already standing there.
  lift.at = 1; lift.dir = -1;
  const before = g.player.portalCount;
  // watch, inside the physics, where the eye was when the crossing happened
  let eyeAtCrossing = null, mouthAtCrossing = null, cameOutAt = null, exitMouth = null;
  const realThrough = g.player._through.bind(g.player);
  g.player._through = function (link, dt) {
    const first = eyeAtCrossing === null;
    if (first) {
      eyeAtCrossing = this.eye().y;
      mouthAtCrossing = link.from.c.y;
      exitMouth = { ...link.to.c };
    }
    const r = realThrough(link, dt);
    // Where the body is the instant it is handed over. Read here rather than a
    // moment later, because these two mouths are a loop and a moment later is
    // often back where it started.
    if (first) cameOutAt = { ...this.pos };
    return r;
  };
  for (let i = 0; i < 220 && g.player.portalCount === before; i++) await sleep(16);
  g.player._through = realThrough;
  out.liftMouthTookThem = g.player.portalCount - before > 0;
  out.crossedAtEye = eyeAtCrossing === null ? null : round(eyeAtCrossing);
  out.crossedAtMouth = mouthAtCrossing === null ? null : round(mouthAtCrossing);
  // the eye is what the surface reached, so the two are the same height
  out.crossedOnTheCamera = eyeAtCrossing !== null &&
    Math.abs(eyeAtCrossing - mouthAtCrossing) < 0.25;
  out.cameOutAt = cameOutAt && { x: round(cameOutAt.x), y: round(cameOutAt.y), z: round(cameOutAt.z) };
  out.exitMouth = exitMouth && { x: round(exitMouth.x), y: round(exitMouth.y), z: round(exitMouth.z) };
  // ...and it comes out at the *other* mouth, on the outside of it, rather than
  // staying where it was under the lift
  out.cameOutAtTheOtherMouth = !!cameOutAt && !!exitMouth &&
    Math.hypot(cameOutAt.x - exitMouth.x, cameOutAt.z - exitMouth.z) < 2.2;
  out.liftAlive = g.player.alive;

  g.portals.clear();
  keys();
  return out;
});

const fail = [];
if (!R.foundShuttle || !R.foundLift) fail.push('could not find the arena platforms');
else {
  if (R.jumpBesideFlung > 0) fail.push(`jumping beside a shuttle teleported the player ${R.jumpBesideFlung} m`);
  if (!R.jumpBesideAlive) fail.push('jumping beside a shuttle killed the player');
  if (R.jumpBesideDriftedX > 3)
    fail.push(`jumping beside a shuttle slid the player ${R.jumpBesideDriftedX} m along it`);
  if (R.behindFlung > 0) fail.push(`standing behind a shuttle teleported the player ${R.behindFlung} m`);
  if (!R.behindStillBehind) fail.push('standing behind a shuttle put the player across on its far side');
  if (!R.behindAlive) fail.push('standing behind a shuttle that was leaving killed the player');
  if (!R.liftMouthTookThem) fail.push('a mouth on the underside of a descending lift never took the player through');
  if (!R.crossedOnTheCamera)
    fail.push(`the crossing was not judged on the camera: eye at ${R.crossedAtEye}, mouth at ${R.crossedAtMouth}`);
  if (!R.cameOutAtTheOtherMouth)
    fail.push(`did not come out at the other mouth: at ${JSON.stringify(R.cameOutAt)}, mouth at ${JSON.stringify(R.exitMouth)}`);
  if (!R.liftAlive) fail.push('the lift crushed the player instead of letting them through the hole in it');
}

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ')
                        : 'PASS: platforms shove and carry without teleporting, and a mouth in one takes you at the camera');
await browser.close();
process.exit(fail.length ? 1 : 0);
