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
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
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
  // the reported gesture: right held, left pressed, hand rotates left. The nudge
  // arrives across the whole press, not in the first three frames.
  const duringPress = async (ms, mx) => {
    g.player.yaw = 0;
    g.input.lastButtonAt = performance.now();
    await sleep(ms);
    move(mx, 0);
    await sleep(120);
    return +(g.player.yaw * 180 / Math.PI).toFixed(2);
  };
  out.nudge10msIn = await duringPress(10, -58);
  out.nudge50msIn = await duringPress(50, -341);
  out.nudge100msIn = await duringPress(100, -58);
  out.nudge140msIn = await duringPress(140, -341);
  out.afterPressEnds = await duringPress(220, -58);

  // the reported gesture specifically: the RIGHT button is what shook the mouse,
  // and it has no binding at all - the window must still open for it
  const rightPress = async (delayMs, mx) => {
    const c = document.getElementById('game');
    g.player.yaw = 0;
    g.input.lastButtonAt = -1e9;
    c.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, pointerType: 'mouse', button: 2, buttons: 2, bubbles: true,
      clientX: 500, clientY: 320 }));
    await sleep(delayMs);
    move(mx, 0);
    await sleep(120);
    return +(g.player.yaw * 180 / Math.PI).toFixed(2);
  };
  out.rightPress10ms = await rightPress(10, -341);
  out.rightPress100ms = await rightPress(100, -58);

  // the exact reported gesture: right held down, and movement arriving at any
  // point during that hold, long after any edge-based window has expired
  const whileRightHeld = async (delayMs, mx, buttons) => {
    g.player.yaw = 0;
    g.input.lastButtonAt = performance.now() - 5000;   // no recent edge at all
    g.input._prevButtons = buttons;                    // and no button transition
    await sleep(delayMs);
    dispatchEvent(new PointerEvent('pointermove', {
      pointerType: 'mouse', bubbles: true, movementX: mx, movementY: 0, buttons }));
    await sleep(120);
    return +(g.player.yaw * 180 / Math.PI).toFixed(2);
  };
  // the actual reported gesture: one button held, a SECOND one pressed. The
  // second press may never reach the canvas, and pointermove may report no
  // buttons at all, so the settle window has to open from a global edge or from
  // the buttons mask changing.
  const secondButton = async (firstButtons, secondButton, secondButtons, mx) => {
    const c = document.getElementById('game');
    g.player.yaw = 0;
    g.input.lastButtonAt = -1e9;
    g.input._prevButtons = 0;
    // first button goes down and settles
    dispatchEvent(new PointerEvent('pointerdown', { pointerId:1, pointerType:'mouse',
      button:0, buttons:firstButtons, bubbles:true }));
    await sleep(300);
    // second button, delivered to the document rather than the canvas
    document.dispatchEvent(new MouseEvent('mousedown', { button:secondButton, buttons:secondButtons, bubbles:true }));
    await sleep(10);
    move(mx, 0);
    await sleep(120);
    return +(g.player.yaw * 180 / Math.PI).toFixed(2);
  };
  out.leftHeld_middlePressed = await secondButton(1, 1, 5, -341);
  out.leftHeld_rightPressed  = await secondButton(1, 2, 3, -341);
  out.rightHeld_leftPressed  = await secondButton(2, 0, 3, -341);

  // and a buttons-mask change seen only on a move must also count as an edge
  {
    g.player.yaw = 0;
    g.input.lastButtonAt = -1e9;
    g.input._prevButtons = 1;
    dispatchEvent(new PointerEvent('pointermove', { pointerType:'mouse', bubbles:true,
      movementX:-341, movementY:0, buttons:5 }));
    await sleep(120);
    out.buttonsMaskChange = +(g.player.yaw * 180 / Math.PI).toFixed(2);
  }

  // Holding the right button is aiming, so looking through it has to work; the
  // suppression is about button *edges*, not about holding a button down.
  out.lookWhileAiming       = await whileRightHeld(300, -58, 2);    // right held
  out.lookWhileAimingAndFiring = await whileRightHeld(300, -58, 3); // right + left
  out.leftOnlyStillAims     = await whileRightHeld(300, -58, 1);    // left only
  out.noButtonsStillAims    = await whileRightHeld(300, -58, 0);

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
const NUDGE = 1.1;   // 8px at 0.0022 rad/px is about one degree
if (Math.abs(R.onClick58) > NUDGE || Math.abs(R.onClick341) > NUDGE || Math.abs(R.onClick593) > NUDGE)
  fail.push(`a spike on a click moved the view (${R.onClick58}/${R.onClick341}/${R.onClick593} degrees)`);
if (R.nudge10msIn !== 0) fail.push(`a nudge 10ms into a press moved ${R.nudge10msIn} degrees`);
if (R.nudge50msIn !== 0) fail.push(`a nudge 50ms into a press moved ${R.nudge50msIn} degrees`);
if (Math.abs(R.nudge100msIn) > NUDGE) fail.push(`a nudge 100ms into a press moved ${R.nudge100msIn} degrees`);
if (Math.abs(R.nudge140msIn) > NUDGE) fail.push(`a nudge 140ms into a press moved ${R.nudge140msIn} degrees`);
if (R.rightPress10ms !== 0) fail.push(`a nudge after a RIGHT press moved ${R.rightPress10ms} degrees`);
if (R.leftHeld_middlePressed !== 0) fail.push(`left held + middle pressed moved ${R.leftHeld_middlePressed} degrees`);
if (R.leftHeld_rightPressed !== 0) fail.push(`left held + right pressed moved ${R.leftHeld_rightPressed} degrees`);
if (R.rightHeld_leftPressed !== 0) fail.push(`right held + left pressed moved ${R.rightHeld_leftPressed} degrees`);
if (R.buttonsMaskChange !== 0) fail.push(`a buttons-mask change moved ${R.buttonsMaskChange} degrees`);
if (Math.abs(R.lookWhileAiming) < 3) fail.push('looking while aiming was blocked');
if (Math.abs(R.lookWhileAimingAndFiring) < 3) fail.push('looking while aiming and firing was blocked');
if (Math.abs(R.leftOnlyStillAims) < 3) fail.push('aiming while only the left button is held was blocked');
if (Math.abs(R.noButtonsStillAims) < 3) fail.push('aiming with no buttons held was blocked');
if (Math.abs(R.rightPress100ms) > NUDGE) fail.push(`a late nudge after a RIGHT press moved ${R.rightPress100ms} degrees`);
if (Math.abs(R.afterPressEnds) < 3) fail.push('aiming did not resume after the press window');
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
