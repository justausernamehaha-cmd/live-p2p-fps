// Mouse-look sanity: a browser recentring warp must never reach the aim, and
// ordinary movement must always reach it.
//
// A locked pointer gets warped back to the screen centre by the browser, and the
// warp is reported as movement equal to the distance from the cursor to that
// centre. So it is small when you click near the middle and large when you click
// near the edge - no fixed pixel threshold can separate it from real aiming.
// Speed can: warps arrive at 44-1500 px/ms, a human flick is under 10.
//
//   ./serve.sh 8080 &   then   node test/mouselook.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#roominput', 'ml-' + Date.now());
await page.fill('#nameinput', 'ml');
await page.click('#playbtn');
await page.waitForTimeout(1400);

const R = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const c = document.getElementById('game');
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => c });
  document.dispatchEvent(new Event('pointerlockchange'));
  await sleep(300);                       // let the settle window lapse
  g.input.lockedAt = performance.now() - 1000;

  const move = (mx, my) => dispatchEvent(new PointerEvent('pointermove', {
    pointerType: 'mouse', bubbles: true, movementX: mx, movementY: my }));

  const run = async (label, steps, gapMs) => {
    g.player.yaw = 0; g.player.pitch = 0;
    g.input.lastMoveAt = performance.now() - 200;   // as after any pause in movement
    const d0 = g.input.dropped;
    for (const [mx, my] of steps) { move(mx, my); await sleep(gapMs); }
    await sleep(120);
    return { label, yaw: +g.player.yaw.toFixed(4), dropped: g.input.dropped - d0 };
  };

  const out = {};
  // a warp arriving on a button edge, which is when they actually happen
  const clickWarp = async (mx, my) => {
    g.player.yaw = 0;
    g.input.lastMoveAt = performance.now() - 200;
    g.input.lastButtonAt = performance.now();          // as if a button just moved
    move(mx, my);
    await sleep(120);
    return { yaw: +g.player.yaw.toFixed(4) };
  };
  out.clickWarpSmall = await clickWarp(-58, -7);
  out.clickWarpMid   = await clickWarp(-341, 71);
  out.clickWarpHuge  = await clickWarp(-500, -320);

  // the warp signature: half the viewport, arriving within a couple of ms
  out.warpNearCentre = await run('warp -58', [[-58, -7]], 1);
  out.warpFarOut     = await run('warp -341', [[-341, 71]], 1);
  out.warpHalfScreen = await run('warp -500', [[-500, -320]], 1);
  // ordinary aiming at a human pace
  out.slowAim  = await run('slow', [[20, 0], [20, 0], [20, 0], [20, 0]], 16);
  out.fastFlick = await run('fast flick', [[120, 0], [120, 0], [120, 0]], 16);
  // two legitimate events landing in the same millisecond must not be mistaken
  // for a warp just because the gap between them is tiny
  out.backToBack = await run('back to back', [[18, 0], [18, 0], [18, 0]], 0);
  return out;
});

const fail = [];
// the ones that matter: a warp on a button edge, at any size
if (Math.abs(R.clickWarpSmall.yaw) > 0.005) fail.push('a small click warp reached the aim');
if (Math.abs(R.clickWarpMid.yaw) > 0.005) fail.push('a -341 click warp reached the aim');
if (Math.abs(R.clickWarpHuge.yaw) > 0.005) fail.push('a half-screen click warp reached the aim');
if (Math.abs(R.slowAim.yaw) < 0.1 || R.slowAim.dropped !== 0) fail.push('ordinary aiming was blocked');
if (Math.abs(R.fastFlick.yaw) < 0.5 || R.fastFlick.dropped !== 0) fail.push('a fast flick was blocked');
if (Math.abs(R.backToBack.yaw) < 0.05 || R.backToBack.dropped !== 0) fail.push('back-to-back events were blocked');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: warps rejected, aiming untouched');
await browser.close();
process.exit(fail.length ? 1 : 0);
