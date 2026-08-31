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
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
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

  // Counted per *game* frame, not per wall-clock sample. Polling every 16 ms
  // measures how fast the page is rendering — under a software rasteriser one
  // frame of ground contact spans two or three polls, and every one of them
  // looked like a dropped hop. The claim is about frames the player spent
  // standing on the floor with jump held, so count those.
  let hops = 0, groundFrames = 0, missed = 0, wasGround = true, peak = 0;
  const realUpdate = g.player.update.bind(g.player);
  g.player.update = function (dt, input) {
    realUpdate(dt, input);
    const on = this.onGround;
    if (on) {
      groundFrames++;
      if (wasGround) missed++;          // two frames on the floor = a lost hop
    }
    if (wasGround && !on) hops++;
    wasGround = on;
    peak = Math.max(peak, Math.hypot(this.vel.x, this.vel.z));
  };
  const t0 = performance.now();
  while (performance.now() - t0 < 4000) {
    g.player.yaw -= 0.016;                       // turn right, into the strafe
    await sleep(16);
  }
  g.player.update = realUpdate;
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
    // There is no speed cap any more, so what bounds this is the payout itself:
    // FALL_SPEED_MAX is 8 m/s, and the short drop (which pays out nothing) is
    // the walking speed both of them start from.
    capped: longDrop.speed <= shortDrop.speed + 8.01
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

// ------------------------------- a ramp onto a ledge must not rob a hop chain
// The centre platform's ramps end flush against a 2.5 m plate, but "flush" is
// only true at the very top: a metre short of it the ramp is a few centimetres
// below the plate's edge. A hop that meets that lip while still *rising* used to
// be refused a step up — the step-up was gated on being grounded or falling —
// and eighteen metres a second stopped dead against six centimetres of nothing.
// It depended on where in the hop's arc you arrived, which is why it happened
// "sometimes". Swept across speeds and arc phases so it cannot come back.
R.rampLip = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const keys = (...on) => {
    g.input.held.clear();
    for (const k of on) g.input.held.add(k);
    g.input._recalcKeys();
  };
  const speed = () => Math.hypot(g.player.vel.x, g.player.vel.z);
  const runs = [];
  // the west ramp climbs +x from x=-19 to the plate's edge at x=-14
  for (const sp of [9, 12, 15, 18]) {
    for (const z of [0, 3, 5]) {
      for (const y of [0.3, 0.9, 1.6]) {
        for (const vy of [0, -4, -9]) {
          g.player.pos = { x: -21.5, y, z };
          g.player.vel = { x: sp, y: vy, z: 0 };
          g.player.yaw = -Math.PI / 2; g.player.pitch = 0;
          g.player.crouchT = 0; g.player.stepSmooth = 0;
          g.player.onGround = false; g.player.bumped = false;
          keys('fwd', 'jump');
          let lowest = 99, reached = false, gapWhenStopped = null;
          for (let i = 0; i < 26 && g.player.pos.x < -11; i++) {
            await sleep(16);
            if (g.player.pos.x > -18.5) reached = true;
            if (!reached) continue;
            const sp2 = speed();
            if (sp2 < lowest) {
              lowest = sp2;
              // How far below the plate's top the body was when it lost its
              // speed. This is what separates the bug from honest collision: a
              // 2.5 m wall is allowed to stop you, a lip inside the step height
              // is not, and only the second one is a fault.
              gapWhenStopped = 2.5 - g.player.pos.y;
            }
          }
          keys();
          if (reached) {
            runs.push({ sp, z, y, vy, kept: +lowest.toFixed(2),
                        gap: gapWhenStopped === null ? null : +gapWhenStopped.toFixed(2) });
          }
        }
      }
    }
  }
  // Anything that arrives at a walking pace or better has to leave at one — but
  // only where what stopped it was small enough to step over. The bar is a walk
  // rather than the speed it came in at, because a ramp is a hill and a hill
  // legitimately costs something. STEP_HEIGHT is 0.55.
  const robbed = runs.filter(r => r.kept < 6 && r.gap !== null && r.gap <= 0.55);
  const walled = runs.filter(r => r.kept < 6 && (r.gap === null || r.gap > 0.55));
  return {
    tried: runs.length, robbed: robbed.length, stoppedByRealWall: walled.length,
    worst: robbed.sort((a, b) => a.kept - b.kept).slice(0, 5),
    wallExamples: walled.slice(0, 3),
    madeIt: runs.filter(r => r.kept >= 6).length
  };
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
if (!R.fallPaysOut.capped) fail.push('the fall bonus paid out more than its own maximum: ' + JSON.stringify(R.fallPaysOut));
if (R.standingDrop > 0.5) fail.push('dropping while standing still flung the player: ' + R.standingDrop);
if (R.onTheRealMap.hops < 4) fail.push('the chain does not work on the real arena: ' + JSON.stringify(R.onTheRealMap));
if (!R.rampLip.tried) fail.push('the ramp sweep never reached the ramp: ' + JSON.stringify(R.rampLip));
if (R.rampLip.robbed) fail.push(`${R.rampLip.robbed} of ${R.rampLip.tried} runs up the ramp were stopped by a lip inside the step height: ` + JSON.stringify(R.rampLip.worst));
// and the sweep has to be doing something, or "nothing was robbed" is vacuous
if (R.rampLip.madeIt < R.rampLip.tried * 0.5) fail.push('most runs never kept their speed at all, so the sweep is not measuring what it claims: ' + JSON.stringify(R.rampLip));
if (errs.length) fail.push('page errors: ' + errs.join(' | '));

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
if (fail.length) { console.log('FAIL: ' + fail.join('\n      ')); await browser.close(); process.exit(1); }
console.log('PASS — every hop lands and takes off, speed bleeds when the chain stops, and a fall is worth speed');
await browser.close();
