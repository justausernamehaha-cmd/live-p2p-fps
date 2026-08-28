// Pointer-lock regression test.
//
// Reported as: right click to aim, left click, and the view snaps tens of
// degrees in a direction that repeats all session. The F3 overlay showed
// movementX values like -341 arriving per click.
//
// A lock only emits a settling move - the jump from wherever the cursor sat to
// the locked origin - when it *engages*. Getting one per click meant the lock
// was being re-requested on clicks it already held, because the decision read a
// cached flag instead of document.pointerLockElement. Let that flag go stale and
// every click re-locks.
//
//   ./serve.sh 8080 &   then   node test/pointerlock.mjs
import { chromium } from 'playwright';
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await (await b.newContext({ viewport:{width:1000,height:640} })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(process.env.GAME_URL || 'http://127.0.0.1:8080/'); await p.waitForFunction(() => window.__paStarted);
await p.fill('#roominput','rl-'+Date.now()); await p.fill('#nameinput','rl');
await p.click('#playbtn'); await p.waitForTimeout(1200);

const R = await p.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f=>setTimeout(f,ms));
  const c = document.getElementById('game');
  const out = {};

  // count every request the page makes
  let requests = 0;
  const realReq = c.requestPointerLock.bind(c);
  c.requestPointerLock = function () { requests++; return Promise.resolve(); };

  const click = (button, buttons) => c.dispatchEvent(new PointerEvent('pointerdown', {
    pointerId:1, pointerType:'mouse', button, buttons, bubbles:true, clientX:500, clientY:320 }));
  const move = (mx, my) => dispatchEvent(new PointerEvent('pointermove', {
    pointerType:'mouse', bubbles:true, movementX:mx, movementY:my }));

  // the browser genuinely holds the lock, but the cached flag has gone stale -
  // the exact state that made every click re-lock and emit a settling spike
  Object.defineProperty(document, 'pointerLockElement', { configurable:true, get: () => c });
  g.input.pointerLocked = false;
  requests = 0;
  for (let i = 0; i < 5; i++) { click(2, 2); click(0, 1); await sleep(30); }
  out.staleFlag = { requestsMade: requests, flagResynced: g.input.pointerLocked };

  // properly locked, no stale flag: still no requests
  g.input.pointerLocked = true;
  requests = 0;
  for (let i = 0; i < 5; i++) { click(0, 1); await sleep(30); }
  out.whileLocked = { requestsMade: requests };

  // settling window: a move just after a lock engages is ignored, even at a
  // magnitude that sits under the absolute spike threshold
  g.input.lockedAt = performance.now();
  g.player.yaw = 0;
  const droppedBefore = g.input.dropped;
  move(-341, 71);
  await sleep(100);
  out.settlingIgnored = {
    yaw: +g.player.yaw.toFixed(4),
    dropped: g.input.dropped - droppedBefore,
    moved: Math.abs(g.player.yaw) > 0.01
  };

  // once settled, ordinary aiming works again. Push the last button edge well
  // into the past first: this test clicks a lot, and movement is deliberately
  // ignored around clicks.
  g.input.lockedAt = performance.now() - 400;
  g.input.lastButtonAt = performance.now() - 5000;
  g.input.lastMoveAt = performance.now() - 200;
  g.player.yaw = 0;
  move(-58, -7);
  await sleep(100);
  out.afterSettling = { yaw: +g.player.yaw.toFixed(4), aims: Math.abs(g.player.yaw) > 0.05 };

  // and a genuinely absurd value is still refused
  g.player.yaw = 0;
  g.input.lastButtonAt = performance.now() - 5000;
  g.input.lastMoveAt = performance.now() - 200;
  move(-1500, 0);
  await sleep(100);
  out.absurdStillDropped = Math.abs(g.player.yaw) < 0.01;

  c.requestPointerLock = realReq;
  Object.defineProperty(document, 'pointerLockElement', { configurable:true, get: () => null });
  return out;
});
console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');

const fail = [];
if (R.staleFlag.requestsMade !== 0) fail.push(`a stale flag re-locked on ${R.staleFlag.requestsMade} clicks`);
if (!R.staleFlag.flagResynced) fail.push('the cached flag was not resynced from the DOM');
if (R.whileLocked.requestsMade !== 0) fail.push('re-locked while already locked');
if (R.settlingIgnored.moved) fail.push('a settling move turned the view');
if (!R.afterSettling.aims) fail.push('ordinary aiming stopped working after settling');
if (!R.absurdStillDropped) fail.push('an absurd movement value was applied');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: no spurious re-locks, no settling spikes');
await b.close();
process.exit(fail.length ? 1 : 0);
