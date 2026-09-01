// Regression: a finger that leaves without a release must never take the
// controls with it.
//
// The reported fault is "at some point I just can't turn my view, move with the
// joystick, or both". Both were singleton slots claimed by pointerId and freed
// only by an event carrying that same id — so any release that never arrived
// left the slot owned by a finger that was no longer on the glass, and no later
// finger could take it. The stick was worse than dead: it kept whatever value it
// last read and walked the player into a wall.
//
// Four ways a release goes missing, one test each. The independent source of
// truth is the player's own yaw and position, not the input state.
//
//   ./serve.sh 8080 &   then   node test/touch.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({
  viewport: { width: 900, height: 600 }, hasTouch: true, isMobile: false
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#roominput', 't-' + Date.now());
await page.fill('#nameinput', 't');
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1400);

const R = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const cv = document.getElementById('game');
  const out = {};
  const round = n => +n.toFixed(3);

  const ev = (type, id, x, y, target = cv) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id,
    clientX: x, clientY: y, isPrimary: true
  }));

  // A finger drag on the right half of the screen, in several steps the way a
  // real one arrives.
  const drag = async (id, x0, y0, dx) => {
    ev('pointerdown', id, x0, y0);
    for (let i = 1; i <= 5; i++) { ev('pointermove', id, x0 + (dx * i) / 5, y0); await sleep(20); }
  };

  const yawMoved = async (id, x0) => {
    const before = g.player.yaw;
    await drag(id, x0, 300, 120);
    await sleep(60);
    ev('pointerup', id, x0 + 120, 300);
    return round(Math.abs(g.player.yaw - before));
  };

  const stickMoved = async (id) => {
    ev('pointerdown', id, 150, 400);
    for (let i = 1; i <= 4; i++) { ev('pointermove', id, 150, 400 - i * 12); await sleep(20); }
    await sleep(40);
    const v = g.input.moveVector();
    return round(Math.hypot(v.x, v.y));
  };

  const clean = () => { g.input.dropTouches?.(); g.input.releaseAll(); };

  // ---------------------------------------------------------------- 1. blur
  // A phone put down, or swapped away from, with a thumb on the glass: no
  // pointerup is ever delivered.
  clean();
  out.lookAfterLostRelease = {};
  await drag(1, 600, 300, 120);                 // look finger, never released
  dispatchEvent(new Event('blur'));
  await sleep(80);
  out.lookAfterLostRelease.thenANewFinger = await yawMoved(2, 600);

  clean();
  out.stickAfterLostRelease = {};
  out.stickAfterLostRelease.whileHeld = await stickMoved(3);
  dispatchEvent(new Event('blur'));
  await sleep(80);
  out.stickAfterLostRelease.afterBlur = round(Math.hypot(g.input.moveVector().x,
                                                         g.input.moveVector().y));
  out.stickAfterLostRelease.thenANewFinger = await stickMoved(4);
  clean();

  // ------------------------------------------- 2. the release lands elsewhere
  // The element the finger went down on is gone, or something swallowed the
  // event: the up arrives on the HUD instead of on the canvas.
  clean();
  await drag(5, 600, 300, 120);
  ev('pointerup', 5, 720, 300, document.getElementById('hud'));
  await sleep(60);
  out.releaseElsewhere = { thenANewFinger: await yawMoved(6, 600) };
  clean();

  // ------------------------------------------------------- 3. the reconciler
  // Nothing at all is delivered — but the browser's own list of fingers says
  // there are none, and that is authoritative.
  clean();
  out.ghostReaped = {};
  out.ghostReaped.whileHeld = await stickMoved(7);
  dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [] }));
  await sleep(60);
  out.ghostReaped.afterEmptyTouchList = round(Math.hypot(g.input.moveVector().x,
                                                         g.input.moveVector().y));
  out.ghostReaped.thenANewFinger = await stickMoved(8);
  clean();

  // ------------------------------------- 4. the layout editor takes the buttons
  // A thumb on FIRE when the panel opens. The buttons' own pointerup handler
  // returns early while editing, so that release never happened.
  clean();
  const fire = document.querySelector('.tbtn[data-btn=fire]');
  ev('pointerdown', 9, 200, 500, fire);
  await sleep(60);
  g._startEdit();
  await sleep(80);
  g._endEdit();
  await sleep(80);
  out.editorLeak = {
    fireStillHeld: g.input.down('fire'),
    thenANewFinger: await yawMoved(10, 600)
  };
  clean();

  // ------------------------- 5. a parked thumb must not own the view pad
  // "If I first hold a button, I can't drag my view with another finger."
  // A finger on FIRE is a look pad as well, because on a phone that is the same
  // thumb doing both — but it is not aiming while it sits still, and the view
  // used to go to whichever look finger landed first, for as long as it stayed.
  clean();
  out.buttonThenDrag = {};
  ev('pointerdown', 13, 200, 500, fire);
  await sleep(60);
  out.buttonThenDrag.fireHeld = g.input.down('fire');
  out.buttonThenDrag.otherFingerTurns = await yawMoved(14, 600);
  out.buttonThenDrag.fireStillHeld = g.input.down('fire');
  ev('pointerup', 13, 200, 500, fire);
  await sleep(60);
  // ...and the thumb on the button still aims when it is the one that moves.
  {
    const before = g.player.yaw;
    ev('pointerdown', 15, 200, 500, fire);
    for (let i = 1; i <= 5; i++) { ev('pointermove', 15, 200 + i * 24, 500, fire); await sleep(20); }
    await sleep(60);
    ev('pointerup', 15, 320, 500, fire);
    out.buttonThenDrag.buttonFingerTurns = round(Math.abs(g.player.yaw - before));
  }
  clean();

  // ------------------------------------------------ and ordinary aiming works
  out.plainLook = await yawMoved(11, 600);
  out.plainStick = await stickMoved(12);
  clean();
  out.stickZeroWhenNothingHeld = round(Math.hypot(g.input.moveVector().x,
                                                  g.input.moveVector().y));
  return out;
});

const fail = [];
const turns = v => v > 0.05;
if (!turns(R.plainLook)) fail.push('a plain touch drag does not turn the view at all');
if (R.plainStick < 0.3) fail.push('a plain thumbstick drag does not move the player');
if (R.stickZeroWhenNothingHeld > 1e-6) fail.push('the stick is not zero with no finger on it');

if (!turns(R.lookAfterLostRelease.thenANewFinger))
  fail.push('after a look finger vanished without a release, no new finger can turn the view');
if (R.stickAfterLostRelease.whileHeld < 0.3)
  fail.push('the thumbstick did not read while a finger was on it');
if (R.stickAfterLostRelease.afterBlur > 1e-6)
  fail.push('the thumbstick stayed pushed after the window lost focus');
if (R.stickAfterLostRelease.thenANewFinger < 0.3)
  fail.push('a new finger cannot take the thumbstick back');
if (!turns(R.releaseElsewhere.thenANewFinger))
  fail.push('a release delivered off the canvas left the look pad owned');
if (R.ghostReaped.afterEmptyTouchList > 1e-6)
  fail.push('a ghost finger survived a touch event that reported no fingers at all');
if (R.ghostReaped.thenANewFinger < 0.3)
  fail.push('a ghost finger kept the thumbstick from being reclaimed');
if (R.editorLeak.fireStillHeld) fail.push('FIRE stayed held through the layout editor');
if (!turns(R.editorLeak.thenANewFinger))
  fail.push('opening the layout editor with a thumb on a button killed the look pad');
if (!R.buttonThenDrag.fireHeld) fail.push('a finger on FIRE did not hold fire');
if (!turns(R.buttonThenDrag.otherFingerTurns))
  fail.push('a second finger cannot turn the view while a button is held');
if (!R.buttonThenDrag.fireStillHeld)
  fail.push('dragging with a second finger let go of the held button');
if (!turns(R.buttonThenDrag.buttonFingerTurns))
  fail.push('the finger on the button can no longer drag the view itself');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: no finger can take the controls away with it');
await browser.close();
process.exit(fail.length ? 1 : 0);
