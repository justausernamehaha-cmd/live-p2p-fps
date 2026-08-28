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

  const deg = r => +(r * 180 / Math.PI).toFixed(1);
  const run = async (label, steps, gapMs) => {
    g.player.yaw = 0; g.player.pitch = 0;
    for (const [mx, my] of steps) { move(mx, my); await sleep(gapMs); }
    await sleep(120);
    return { label, degrees: deg(g.player.yaw), steps: steps.length };
  };

  const out = {};
  // the reported case: a spike arriving on a button edge must not move the view
  const onClick = async (mx, my) => {
    g.player.yaw = 0;
    g.input.lastButtonAt = performance.now();
    move(mx, my);
    await sleep(120);
    return +(g.player.yaw * 180 / Math.PI).toFixed(2);
  };
  out.onClick58 = await onClick(-58, -7);
  out.onClick341 = await onClick(-341, 71);
  out.onClick593 = await onClick(-500, -320);

  // A single event may never swing the view more than the ceiling allows,
  // whatever its size and wherever it came from.
  g.input.lastButtonAt = -1e9;      // away from any click, the ceiling alone applies
  out.spike58   = await run('one event, 58px',   [[-58, -7]], 20);
  out.spike341  = await run('one event, 341px',  [[-341, 71]], 20);
  out.spike593  = await run('one event, 593px',  [[-500, -320]], 20);
  out.spike5000 = await run('one event, 5000px', [[-5000, 0]], 20);

  // Ordinary aiming is untouched, and sustained turning is still fast.
  out.slowAim   = await run('20 x 20px',  Array.from({length:20}, () => [20, 0]), 16);
  out.fastFlick = await run('10 x 70px',  Array.from({length:10}, () => [70, 0]), 16);
  out.backToBack = await run('3 x 18px, no gap', [[18,0],[18,0],[18,0]], 0);

  // how fast can you turn if you really try: 60 events a second at the ceiling
  out.maxTurnRatePerSecond = deg(50 * 0.0022 * g.input.sensitivity * 60);
  return out;
});

const fail = [];
if (R.onClick58 !== 0 || R.onClick341 !== 0 || R.onClick593 !== 0)
  fail.push(`a spike on a click moved the view (${R.onClick58}/${R.onClick341}/${R.onClick593} degrees)`);
const CEILING = 7;     // 50px at 0.0022 rad/px is about 6.3 degrees
if (Math.abs(R.spike58.degrees) > CEILING) fail.push('a 58px event exceeded the ceiling');
if (Math.abs(R.spike341.degrees) > CEILING) fail.push('a 341px event exceeded the ceiling');
if (Math.abs(R.spike593.degrees) > CEILING) fail.push('a 593px event exceeded the ceiling');
if (Math.abs(R.spike5000.degrees) > CEILING) fail.push('a 5000px event exceeded the ceiling');
if (Math.abs(R.slowAim.degrees) < 30) fail.push('ordinary aiming was throttled');
if (Math.abs(R.fastFlick.degrees) < 50) fail.push('a fast flick was throttled');
if (Math.abs(R.backToBack.degrees) < 5) fail.push('back-to-back events were blocked');
if (R.maxTurnRatePerSecond < 350) fail.push('the ceiling makes turning too slow');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: no single event can swing the view; aiming untouched');
await browser.close();
process.exit(fail.length ? 1 : 0);
