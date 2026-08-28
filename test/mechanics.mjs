// Movement-feel and protection mechanics, measured rather than eyeballed.
//   ./serve.sh 8080 &   then   node test/mechanics.mjs
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
await page.fill('#nameinput', 'mech');
await page.fill('#roominput', 'solo-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const keys = (...on) => {
    g.input.held.clear();
    for (const k of on) g.input.held.add(k);
    g.input._recalcKeys();
  };
  const speed = () => Math.hypot(g.player.vel.x, g.player.vel.z);
  const park = (x, y, z, yaw = 0) => {
    g.player.pos = { x, y, z };
    g.player.vel = { x: 0, y: 0, z: 0 };
    g.player.yaw = yaw; g.player.pitch = 0;
    g.player.crouchT = 0; g.player.sprintLatch = false; g.player.stepSmooth = 0;
  };
  const out = {};

  // ---- ground control is immediate ----
  park(0, 0.3, -20);
  await sleep(400);
  keys('fwd');
  await sleep(60);                       // ~4 frames
  out.groundSpeedAfter60ms = +speed().toFixed(2);
  keys();
  await sleep(80);
  out.stopSpeedAfter80ms = +speed().toFixed(2);

  // ---- sprint latches until forward is released ----
  // on a bare floor: at 9 m/s the arena's cover walls are only a third of a
  // second away, and running into one legitimately costs all your speed
  const sprintBoxes = g.world.boxes;
  g.world.boxes = sprintBoxes.filter(b => b.max.y === 0 && b.max.x - b.min.x > 50);
  park(0, 0.3, 0);
  await sleep(300);
  keys('fwd', 'sprint');
  await sleep(120);
  keys('fwd');                           // shift released, W still held
  await sleep(200);
  out.sprintingAfterShiftReleased = g.player.sprintLatch && speed() > 7.5;
  out.speedWithShiftReleased = +speed().toFixed(2);
  keys();                                // release W
  await sleep(120);
  keys('fwd');
  await sleep(200);
  out.sprintEndedAfterForwardReleased = !g.player.sprintLatch;
  keys();
  g.world.boxes = sprintBoxes;
  await sleep(100);

  // ---- crouch is a 0.3s animation, not a snap ----
  park(0, 0.3, -20);
  await sleep(300);
  const h0 = g.player.height;
  keys('crouch');
  await sleep(80);
  const hMid = g.player.height;
  await sleep(400);
  const hEnd = g.player.height;
  keys();
  await sleep(500);
  out.crouch = {
    standing: +h0.toFixed(2),
    partwayAt80ms: +hMid.toFixed(2),
    crouched: +hEnd.toFixed(2),
    animated: hMid < h0 - 0.05 && hMid > hEnd + 0.05,
    stoodBackUp: +g.player.height.toFixed(2)
  };

  // ---- stairs are climbed as a ramp, not a staircase of jolts ----
  park(13, 0.3, 0, Math.PI / 2);
  await sleep(300);
  let prevEye = g.player.eyeY, maxJolt = 0, startY = g.player.pos.y;
  const sampler = setInterval(() => {
    const e = g.player.eyeY;
    maxJolt = Math.max(maxJolt, Math.abs(e - prevEye));
    prevEye = e;
  }, 16);
  keys('fwd');
  await sleep(2200);
  keys();
  clearInterval(sampler);
  out.stairs = {
    climbed: +(g.player.pos.y - startY).toFixed(2),
    biggestSingleViewJump: +maxJolt.toFixed(3)
  };

  // ---- bunny hopping: strafe and turn together to build speed ----
  // The arena has no runway long enough for this, so the level is temporarily
  // reduced to its floor. This measures the air physics, not the map.
  const realBoxes = g.world.boxes;
  g.world.boxes = realBoxes.filter(b => b.max.y === 0 && b.max.x - b.min.x > 50);
  park(0, 0.3, 0, 0);
  await sleep(400);
  keys('fwd', 'right', 'jump');
  let peak = 0, sampleAt1s = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 4000) {
    g.player.yaw -= 0.016;              // turn right, into the strafe
    await sleep(16);
    peak = Math.max(peak, speed());
    if (!sampleAt1s && performance.now() - t0 > 1000) sampleAt1s = speed();
  }
  keys();
  out.bhop = {
    walkSpeed: 6.2,
    afterOneSecond: +sampleAt1s.toFixed(2),
    peak: +peak.toFixed(2),
    // the mechanic is the *difference*: strafing pays, holding W does not
    gainedSpeed: peak > 6.2 * 1.35
  };

  // straight-line hopping with no turning must NOT build speed
  park(0, 0.3, 0, 0);
  await sleep(400);
  keys('fwd', 'jump');
  let straightPeak = 0;
  const t1 = performance.now();
  while (performance.now() - t1 < 2500) { await sleep(16); straightPeak = Math.max(straightPeak, speed()); }
  keys();
  out.bhop.straightLinePeak = +straightPeak.toFixed(2);
  out.bhop.straightLineGainsNothing = straightPeak < 6.4;
  g.world.boxes = realBoxes;
  await sleep(100);

  // ---- accuracy by stance (there is no aiming; hipfire is all there is) ----
  {
    const rifle = g.loadout.weapon;
    out.spreadRadians = {
      standing: +window.__spreadFor(rifle, false).toFixed(5),
      moving: +window.__spreadFor(rifle, true).toFixed(5)
    };
    out.movingIsLessAccurate =
      out.spreadRadians.moving > out.spreadRadians.standing;
  }

  // ---- momentum must survive landings, stairs and strafe swaps ----
  out.momentum = {};

  // a heavy landing at speed, still holding forward
  {
    const real = g.world.boxes;
    g.world.boxes = real.filter(b => b.max.y === 0 && b.max.x - b.min.x > 50);
    park(0, 8, 0, 0);
    g.player.vel = { x: 0, y: 0, z: -14 };
    keys('fwd');
    for (let i = 0; i < 60 && !g.player.onGround; i++) await sleep(50);
    const onImpact = speed();
    await sleep(600);
    out.momentum.heavyLanding = {
      atImpact: +onImpact.toFixed(2),
      after600msOnGround: +speed().toFixed(2),
      kept: speed() > onImpact * 0.75
    };
    keys();
    g.world.boxes = real;
    await sleep(100);
  }

  // running up the centre staircase at speed
  {
    park(13, 0.3, 0, Math.PI / 2);
    await sleep(300);
    g.player.vel = { x: -12, y: 0, z: 0 };
    const before = 12;
    keys('fwd');
    await sleep(700);
    const after = speed();
    keys();
    out.momentum.upStairs = {
      before,
      after: +after.toFixed(2),
      climbedTo: +g.player.pos.y.toFixed(2),
      kept: after > before * 0.7 && g.player.pos.y > 2
    };
    await sleep(200);
  }

  // swapping strafe keys mid-air, against your own momentum
  {
    const real = g.world.boxes;
    g.world.boxes = real.filter(b => b.max.y === 0 && b.max.x - b.min.x > 50);
    park(0, 6, 0, 0);
    g.player.vel = { x: 0, y: 2, z: -12 };
    const start = speed();
    keys('right');
    await sleep(300);
    const mid = speed();
    keys('left');                       // flip against the momentum
    let low = Infinity;
    for (let i = 0; i < 30; i++) { await sleep(16); low = Math.min(low, speed()); }
    keys();
    out.momentum.strafeSwapInAir = {
      start: +start.toFixed(2),
      beforeSwap: +mid.toFixed(2),
      lowestAfterSwap: +low.toFixed(2),
      kept: low >= mid * 0.98
    };
    g.world.boxes = real;
    await sleep(100);
  }

  // ...but bumping into anything drops a hop chain back to running speed
  {
    park(0, 0.3, -26, 0);
    await sleep(300);
    g.player.vel = { x: 0, y: 0, z: -14 };
    keys('fwd');
    await sleep(700);
    out.momentum.wallHeadOn = { speedAfter: +speed().toFixed(2), stopped: speed() < 7 };
    keys();
    await sleep(200);
  }

  // a glancing bump while carrying speed sideways: also back to normal
  {
    park(0, 0.3, -26, 0);
    await sleep(300);
    g.player.vel = { x: 9, y: 0, z: -11 };   // mostly along the wall, partly into it
    keys('fwd');
    await sleep(600);
    const after = speed();
    out.momentum.glancingBump = {
      before: 14.2,
      after: +after.toFixed(2),
      backToNormal: after <= 6.4
    };
    keys();
    await sleep(200);
  }

  // ---- speed cap and no tunnelling through a thin wall ----
  park(0, 0.3, -18, 0);
  g.player.vel = { x: 0, y: 0, z: -21 };   // straight at the 0.6m cover wall at z=-22
  await sleep(600);
  out.wallStoppedFastPlayer = g.player.pos.z > -22.5;
  out.zAfterHighSpeedImpact = +g.player.pos.z.toFixed(2);

  return out;
});

// ---- shield / fire lock, driven through the real UI ----
await page.evaluate(() => { document.body.classList.add('touch-ui'); document.getElementById('touch').classList.remove('hidden'); });
await page.click('#editbtn');
await page.waitForTimeout(200);
const editing = await page.evaluate(() => ({
  editing: window.game.editing,
  shielded: window.game.shielded,
  panelUp: !document.getElementById('editpanel').classList.contains('hidden')
}));
const blocked = await page.evaluate(() => {
  const hp = window.game.player.hp;
  window.game._takeHit('someone', { dmg: 90 });
  return { hpBefore: hp, hpAfter: window.game.player.hp };
});
await page.click('#donelayout');
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({
  stillShielded: window.game.shielded,
  fireLockedFor: +((window.game.fireLockUntil - performance.now()) / 1000).toFixed(1),
  shieldLeft: +((window.game.shieldUntil - performance.now()) / 1000).toFixed(1)
}));
await page.waitForTimeout(3200);
const later = await page.evaluate(() => ({
  shieldExpired: !window.game.shielded,
  stillFireLocked: performance.now() < window.game.fireLockUntil
}));

console.log(JSON.stringify({ ...R, edit: { ...editing, ...blocked }, onExit: after, after3s: later }, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
await browser.close();
