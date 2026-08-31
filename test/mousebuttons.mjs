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
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
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
  g.loadout.state[g.loadout.index].mag = 30; g.protectedUntil = 0;
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

  // An event that under-reports which buttons are down must not take the aim or
  // the trigger away. This is the "I fire a few rounds and drop out of aim"
  // report: one stray mask of 0 used to clear both at once.
  await reset();
  down(2, 2); await sleep(40);
  down(0, 3); await sleep(40);
  g.loadout.state[g.loadout.index].mag = 30; g.protectedUntil = 0;
  const magBeforeStray = g.loadout.ammo.mag;
  // the mask-transition guard only syncs when the mask *changes*, so seed it
  // with the true state or the stray events below are never even looked at
  g.input._prevButtons = 3;
  for (let i = 0; i < 6; i++) {
    // a move claiming nothing is held, of the kind captured mid-fight
    dispatchEvent(new PointerEvent('pointermove', { pointerType:'mouse', bubbles:true,
      movementX: 4, movementY: 0, buttons: 0 }));
    await sleep(60);
  }
  out.afterStrayMasks = state();
  out.keptFiringThrough = magBeforeStray - g.loadout.ammo.mag;
  // and a genuine release still ends it
  up(0, 2); await sleep(60);
  out.leftReleaseStillWorks = state();
  up(2, 0); await sleep(60);
  out.rightReleaseStillWorks = state();

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
if (!(R.afterStrayMasks.fire && R.afterStrayMasks.ads))
  fail.push('a stray buttons=0 event dropped the aim or the trigger');
if (R.keptFiringThrough < 2) fail.push('the gun stopped firing through stray events');
if (R.leftReleaseStillWorks.fire || !R.leftReleaseStillWorks.ads)
  fail.push('a real left release did not behave');
if (R.rightReleaseStillWorks.ads) fail.push('a real right release did not drop the aim');
if (!R.rightReleasedFirst.fire) fail.push('releasing right dropped the trigger too');
if (R.rightReleasedFirst.ads) fail.push('aim stayed on after right was released');
if (R.thenLeftReleased.fire) fail.push('the trigger stayed down at the end');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: every button order tracked correctly');
await browser.close();
process.exit(fail.length ? 1 : 0);
