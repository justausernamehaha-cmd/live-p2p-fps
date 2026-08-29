// Momentum: the three things that were wrong about carrying speed.
//
//   1. a hop chain dropped jumps at speed, because ground contact was decided by
//      the last collision sub-step rather than by the frame;
//   2. and for the same reason ground friction never ran either, so a chain that
//      had been stopped never bled off;
//   3. falling is heavier than rising, and a real drop is paid out as speed.
//
// Nothing here trusts a flag. Jumps are counted by the player leaving the floor,
// friction by the speed measured a second later, and the fall bonus by the speed
// difference between a short drop and a long one from the same standing start.
//
//   ./serve.sh 8080 &   then   node test/momentum.mjs
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
await page.fill('#nameinput', 'mo');
await page.fill('#roominput', 'mo-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1500);

// Every trial runs on a bare floor: the arena's crates and stairs would deflect
// a run and make "did it slow down" unanswerable.
await page.evaluate(() => {
  const g = window.game;
  window.__realBoxes = g.world.boxes;
  window.__realSolids = g.world.solids;
  g.world.boxes = g.world.boxes.filter(b => b.max.y === 0 && b.max.x - b.min.x > 50);
  g.world.solids = [];          // the ramps would deflect a run across the floor
});

const R = {};
const fail = [];

// ------------------------------------------- 1. every hop lands and takes off
// Hold jump and forward and turn steadily — a strafe-jump chain. Count take-offs
// against the frames spent on the ground: at speed the old code stood on the
// floor with onGround false and simply refused to jump.
R.hopChain = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn({ x: 0, y: 0.2, z: 0 });
  g.player.yaw = 0; g.player.pitch = 0;
  await sleep(300);
  // forward + strafe + jump, turning into the strafe: the same driver
  // test/mechanics.mjs uses, which is the one known to build speed
  for (const code of ['Space', 'KeyW', 'KeyD']) dispatchEvent(new KeyboardEvent('keydown', { code }));

  let hops = 0, groundFrames = 0, missed = 0, wasGround = true, peak = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 4000) {
    g.player.yaw -= 0.016;                       // turn right, into the strafe
    await sleep(16);
    const on = g.player.onGround;
    if (on) {
      groundFrames++;
      // grounded with jump held and still grounded next sample = a lost hop
      if (wasGround) missed++;
    }
    if (wasGround && !on) hops++;
    wasGround = on;
    peak = Math.max(peak, Math.hypot(g.player.vel.x, g.player.vel.z));
  }
  for (const code of ['Space', 'KeyW', 'KeyD']) dispatchEvent(new KeyboardEvent('keyup', { code }));
  const speed = Math.hypot(g.player.vel.x, g.player.vel.z);
  return { hops, groundFrames, missed, peak: +peak.toFixed(2), speed: +speed.toFixed(2) };
});

// ------------------------------------------------ 2. stop hopping, and slow down
// Straight into a run at bunny-hop speed, then release jump but keep pressing
// forward. The speed has to come down, and keep coming down.
R.slowsDown = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn({ x: 0, y: 0.2, z: 0 });
  g.player.yaw = 0; g.player.pitch = 0;
  await sleep(250);
  g.player.vel = { x: 0, y: 0, z: -18 };         // moving at a hop chain's speed
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  const at = [];
  for (let i = 0; i < 4; i++) {
    await sleep(500);
    at.push(+Math.hypot(g.player.vel.x, g.player.vel.z).toFixed(2));
  }
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  return { start: 18, at, settled: at[3], falling: at[0] > at[1] && at[1] > at[2] };
});

// and letting go of everything stops you outright
R.stopsDead = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn({ x: 0, y: 0.2, z: 0 });
  await sleep(250);
  g.player.vel = { x: 0, y: 0, z: -18 };
  await sleep(1200);
  return +Math.hypot(g.player.vel.x, g.player.vel.z).toFixed(2);
});

// --------------------------------------------- 3a. falling is heavier than rising
R.gravity = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const sample = async up => {
    g.player.spawn({ x: 0, y: 30, z: 0 });
    await sleep(60);
    g.player.vel = { x: 0, y: up, z: 0 };
    g.player.pos.y = 30;
    const v0 = g.player.vel.y, t0 = performance.now();
    await sleep(200);
    return (g.player.vel.y - v0) / ((performance.now() - t0) / 1000);
  };
  const rising = await sample(14);      // still going up
  const falling = await sample(-6);     // already coming down
  return { rising: +rising.toFixed(1), falling: +falling.toFixed(1),
           heavier: Math.abs(falling) > Math.abs(rising) * 1.2 };
});

// ---------------------------------------- 3b. a long fall is paid out as speed
// Same standing start, same run-up, two different drop heights. The taller one
// has to land faster across the ground, and neither may exceed the safety cap.
R.fallPaysOut = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  // Measured at the instant of landing. A frame later, ground friction has
  // already started eating it, and how much depends on how long the poll took.
  const drop = async height => {
    g.player.spawn({ x: 0, y: height, z: 0 });
    g.player.yaw = 0; g.player.pitch = 0;
    await sleep(60);
    g.player.pos.y = height;
    g.player.vel = { x: 0, y: 0, z: -6 };        // walking off a ledge at 6 m/s
    let frames = 0;
    for (; frames < 300; frames++) {
      await sleep(16);
      if (g.player.onGround) break;
    }
    return { speed: +Math.hypot(g.player.vel.x, g.player.vel.z).toFixed(2),
             impact: +g.player.fellAt.toFixed(1), landed: g.player.onGround, frames };
  };
  const shortDrop = await drop(2);
  const longDrop = await drop(40);
  return {
    shortDrop, longDrop,
    bothLanded: shortDrop.landed && longDrop.landed,
    taller: longDrop.speed > shortDrop.speed + 2,
    capped: longDrop.speed <= 22.01
  };
});

// standing still and dropping must not fling you somewhere
R.standingDrop = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn({ x: 0, y: 40, z: 0 });
  await sleep(40);
  g.player.pos.y = 40;
  g.player.vel = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 300; i++) { await sleep(16); if (g.player.onGround) break; }
  return +Math.hypot(g.player.vel.x, g.player.vel.z).toFixed(2);
});

await page.evaluate(() => {
  window.game.world.boxes = window.__realBoxes;
  window.game.world.solids = window.__realSolids;
});

// ------------------------------------- and the real arena still lets you hop
R.onTheRealMap = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn(g.world.spawns[0]);
  await sleep(400);
  for (const code of ['Space', 'KeyW', 'KeyD']) dispatchEvent(new KeyboardEvent('keydown', { code }));
  let hops = 0, wasGround = true;
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) {
    g.player.yaw -= 0.016;
    await sleep(16);
    const on = g.player.onGround;
    if (wasGround && !on) hops++;
    wasGround = on;
  }
  for (const code of ['Space', 'KeyW', 'KeyD']) dispatchEvent(new KeyboardEvent('keyup', { code }));
  return { hops, speed: +Math.hypot(g.player.vel.x, g.player.vel.z).toFixed(2) };
});

// -------------------------------------------------------------------- verdict
// Four seconds of held jump is roughly 8-10 hops; anything under 6 means hops
// are being eaten. `missed` counts samples that found the player still standing
// on the floor with jump held, which should essentially never happen.
if (R.hopChain.hops < 6) fail.push('hops were dropped from the chain: ' + JSON.stringify(R.hopChain));
if (R.hopChain.missed > 2) fail.push('the player stood on the floor with jump held: ' + JSON.stringify(R.hopChain));
if (R.hopChain.peak < 8.5) fail.push('the chain never built speed, so it was not a chain: ' + JSON.stringify(R.hopChain));
if (!R.slowsDown.falling) fail.push('speed did not keep falling after the hops stopped: ' + JSON.stringify(R.slowsDown));
if (R.slowsDown.settled > 10) fail.push('two seconds after stopping, still faster than a sprint: ' + JSON.stringify(R.slowsDown));
if (R.stopsDead > 0.5) fail.push('letting go of everything did not stop the player: ' + R.stopsDead);
if (!R.gravity.heavier) fail.push('falling is not heavier than rising: ' + JSON.stringify(R.gravity));
if (!R.fallPaysOut.bothLanded) fail.push('a drop never reached the ground: ' + JSON.stringify(R.fallPaysOut));
if (!R.fallPaysOut.taller) fail.push('a long fall was worth no more speed than a short one: ' + JSON.stringify(R.fallPaysOut));
if (!R.fallPaysOut.capped) fail.push('the fall bonus broke the speed cap: ' + JSON.stringify(R.fallPaysOut));
if (R.standingDrop > 0.5) fail.push('dropping while standing still flung the player: ' + R.standingDrop);
if (R.onTheRealMap.hops < 4) fail.push('the chain does not work on the real arena: ' + JSON.stringify(R.onTheRealMap));
if (errs.length) fail.push('page errors: ' + errs.join(' | '));

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
if (fail.length) { console.log('FAIL: ' + fail.join('\n      ')); await browser.close(); process.exit(1); }
console.log('PASS — every hop lands and takes off, speed bleeds when the chain stops, and a fall is worth speed');
await browser.close();
