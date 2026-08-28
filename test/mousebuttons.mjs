// Mouse button state must come from the event's `buttons` mask, not from which
// element received the press.
//
// A second button pressed while another is held is often not delivered to the
// canvas at all. That broke two things: firing while holding right click did
// nothing, and releasing in the wrong order left the trigger stuck down so the
// gun kept firing until left was pressed again.
//
//   ./serve.sh 8080 &   then   node test/mousebuttons.mjs
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
await page.fill('#roominput', 'mb-' + Date.now());
await page.fill('#nameinput', 'mb');
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1300);

const R = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const c = document.getElementById('game');
  g.input.pointerLocked = true;

  // Deliberately dispatched to the document, not the canvas: that is what the
  // browser does with a second button, and what used to be missed entirely.
  const down = (button, buttons) => document.dispatchEvent(new MouseEvent('mousedown',
    { button, buttons, bubbles: true }));
  const up = (button, buttons) => document.dispatchEvent(new MouseEvent('mouseup',
    { button, buttons, bubbles: true }));
  const state = () => ({ fire: g.input.down('fire'), ads: g.input.down('ads') });
  const reset = async () => { up(0, 0); up(2, 0); await sleep(40); };

  const out = {};

  // fire while holding right click
  await reset();
  down(2, 2); await sleep(50);
  out.afterRightDown = state();
  down(0, 3); await sleep(50);
  out.thenLeftDown = state();
  g.loadout.state[g.loadout.index].mag = 30; g.fireLockUntil = 0;
  const mag = g.loadout.ammo.mag;
  await sleep(300);
  out.roundsFiredWhileAiming = mag - g.loadout.ammo.mag;

  // left, then right, then release both - the stuck-trigger report
  await reset();
  down(0, 1); await sleep(50);
  down(2, 3); await sleep(50);
  out.bothDown = state();
  up(0, 2); await sleep(50);
  out.leftReleasedFirst = state();
  up(2, 0); await sleep(50);
  out.bothReleased = state();
  await sleep(200);
  const magAfter = g.loadout.ammo.mag;
  await sleep(400);
  out.stillFiringAfterRelease = magAfter !== g.loadout.ammo.mag;

  // and the other release order
  await reset();
  down(0, 1); await sleep(50);
  down(2, 3); await sleep(50);
  up(2, 1); await sleep(50);
  out.rightReleasedFirst = state();     // fire should survive, aim should not
  up(0, 0); await sleep(50);
  out.thenLeftReleased = state();

  await reset();
  return out;
});

const fail = [];
if (!R.afterRightDown.ads) fail.push('right click did not aim');
if (!(R.thenLeftDown.fire && R.thenLeftDown.ads)) fail.push('left click while aiming did not arm the trigger');
if (R.roundsFiredWhileAiming < 1) fail.push('no rounds fired while holding right click');
if (!(R.bothDown.fire && R.bothDown.ads)) fail.push('holding both was not seen');
if (R.leftReleasedFirst.fire) fail.push('the trigger stayed down after left was released');
if (R.bothReleased.fire || R.bothReleased.ads) fail.push('a button stayed held after both were released');
if (R.stillFiringAfterRelease) fail.push('the gun kept firing after the buttons were released');
if (!R.rightReleasedFirst.fire) fail.push('releasing right dropped the trigger too');
if (R.rightReleasedFirst.ads) fail.push('aim stayed on after right was released');
if (R.thenLeftReleased.fire) fail.push('the trigger stayed down at the end');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: every button order tracked correctly');
await browser.close();
process.exit(fail.length ? 1 : 0);
