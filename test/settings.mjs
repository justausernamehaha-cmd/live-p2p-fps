// The settings panel: rebinding keys, hold-or-toggle for the four actions that
// support it, the sprint button a phone needs, and the pause that draws over the
// game instead of replacing it.
//
// The assertions are against consequences, not appearances: a rebound key is
// proved by the player moving, a latched jump by the player leaving the ground
// again and again with nothing held down.
//
//   ./serve.sh 8080 &   then   node test/settings.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 780 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));

await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'set');
await page.fill('#roominput', 'set-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1300);

const R = {};
const fail = [];
// A missing panel or a missing row makes every later click hang for thirty
// seconds and die as a timeout. Stop at the cause instead, and say what it was.
const must = async (ok, why) => {
  if (ok) return;
  console.log(JSON.stringify(R, null, 2));
  console.log('FAIL: ' + why);
  await browser.close();
  process.exit(1);
};
const open = async () => { await page.keyboard.press('Backquote'); await page.waitForTimeout(220); };
const close = async () => { await page.keyboard.press('Backquote'); await page.waitForTimeout(220); };

// ------------------------------------------------ the panel opens on ` and on =
await open();
R.openedOnBacktick = await page.isVisible('#editpanel');
await close();
R.closedAgain = !(await page.isVisible('#editpanel'));
await page.keyboard.press('Equal');
await page.waitForTimeout(220);
R.openedOnEquals = await page.isVisible('#editpanel');
await must(R.openedOnBacktick, '` did not open the settings panel');
await must(R.closedAgain, '` did not close it again');
await must(R.openedOnEquals, '= did not open the settings panel');

// -------------------------------------------------------------- the key rows
R.rows = await page.evaluate(() =>
  [...document.querySelectorAll('.bindrow')].map(r => [r.children[0].textContent, r.children[1].textContent]));
R.forwardShowsW = (R.rows.find(r => r[0] === 'Forward') || [])[1];
R.sprintShowsBothShifts = (R.rows.find(r => r[0] === 'Sprint') || [])[1];
await must(R.rows.length === 14, `expected 14 key rows, got ${R.rows.length}`);

// ------------------------------------------------------- rebind forward to I
await page.click('.bindrow:has-text("Forward") .bindkey');
R.arming = await page.evaluate(() =>
  document.querySelector('.bindrow .bindkey.arming')?.previousElementSibling.textContent);
await page.keyboard.press('KeyI');
await page.waitForTimeout(150);
R.forwardNowShows = await page.evaluate(() =>
  [...document.querySelectorAll('.bindrow')].find(r => r.children[0].textContent === 'Forward').children[1].textContent);
R.savedBinds = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('pa.binds'))?.KeyI ?? null; } catch { return null; }
});
await close();

// the proof is the player, not the label: I walks forward and W does nothing
R.rebindWorks = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const realBoxes = g.world.boxes;
  g.world.boxes = realBoxes.filter(b => b.max.y === 0 && b.max.x - b.min.x > 50);
  const run = async code => {
    g.player.pos = { x: 0, y: 0.2, z: 0 };
    g.player.vel = { x: 0, y: 0, z: 0 };
    g.player.yaw = 0; g.player.pitch = 0;
    await sleep(180);
    const z0 = g.player.pos.z;
    dispatchEvent(new KeyboardEvent('keydown', { code }));
    await sleep(320);
    dispatchEvent(new KeyboardEvent('keyup', { code }));
    await sleep(60);
    return +(g.player.pos.z - z0).toFixed(2);
  };
  const withI = await run('KeyI');      // yaw 0 faces -z, so forward is negative
  const withW = await run('KeyW');
  g.world.boxes = realBoxes;
  return { withI, withW, iMoves: withI < -0.5, wIsDead: Math.abs(withW) < 0.1 };
});

// a rebind survives a reload, because it is the saved map that is read
await page.reload();
await page.waitForFunction(() => window.__paStarted);
R.survivedReload = await page.evaluate(() => window.game.input.binds.KeyI);

await page.fill('#nameinput', 'set');
await page.fill('#roominput', 'set2-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1300);

// -------------------------------------------------------------- reset the keys
await open();
await page.click('#resetbinds');
await page.waitForTimeout(150);
R.afterReset = await page.evaluate(() => ({
  w: window.game.input.binds.KeyW,
  iGone: window.game.input.binds.KeyI === undefined,
  label: [...document.querySelectorAll('.bindrow')]
    .find(r => r.children[0].textContent === 'Forward').children[1].textContent
}));

// -------------------------------------------- hold/toggle now covers four actions
R.modeRows = await page.evaluate(() =>
  [...document.querySelectorAll('.moderow')].map(r => r.dataset.action));
await must(String(R.modeRows) === 'crouch,ads,sprint,jump',
           'hold/toggle rows are wrong: ' + R.modeRows);

// sprint as a toggle: one tap and it stays on with nothing held
await page.click('.modes button[data-action=sprint][data-mode=toggle]');
await page.waitForTimeout(120);
await close();
R.sprintLatches = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
  await sleep(200);
  const afterTap = g.input.down('sprint');
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
  await sleep(200);
  return { afterTap, afterSecondTap: g.input.down('sprint') };
});

// jump as a toggle is the mobile bunny hop: one tap and the hops keep coming
await open();
await page.click('.modes button[data-action=jump][data-mode=toggle]');
await page.waitForTimeout(120);
await close();
R.jumpLatches = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn({ x: 0, y: 0.2, z: 0 });
  await sleep(400);
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
  const held = g.input.down('jump');
  // count take-offs over two seconds with nothing held down
  let hops = 0, wasGround = g.player.onGround;
  const t0 = performance.now();
  while (performance.now() - t0 < 2000) {
    await sleep(16);
    if (wasGround && !g.player.onGround) hops++;
    wasGround = g.player.onGround;
  }
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
  await sleep(300);
  return { held, hops, releasedOnSecondTap: !g.input.down('jump') };
});

// -------------------------------------------------------- the sprint touch button
R.sprintButton = await page.evaluate(async () => {
  const el = document.querySelector('.tbtn[data-btn=sprint]');
  if (!el) return { exists: false };
  const g = window.game;
  g.input.setToggleMode('sprint', false);      // back to hold for this check
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
  const whileDown = g.input.down('sprint');
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
  await new Promise(f => setTimeout(f, 60));
  return { exists: true, whileDown, afterUp: g.input.down('sprint'),
           inTouchPad: !!el.closest('#tbuttons') };
});

// ----------------------------------------------------- pause draws over the game
R.pause = await page.evaluate(async () => {
  const g = window.game;
  const frames = () => new Promise(res => {
    const t0 = performance.now(); let n = 0;
    (function c() { n++; if (performance.now() - t0 < 400) requestAnimationFrame(c); else res(n); })();
  });
  g._pause();
  await new Promise(f => setTimeout(f, 200));
  const menu = document.getElementById('menu');
  const style = getComputedStyle(menu);
  const drawnWhilePaused = await frames();
  const out = {
    menuShown: !menu.classList.contains('hidden'),
    isOverlay: menu.classList.contains('overlay'),
    bodyPaused: document.body.classList.contains('paused'),
    // the game is behind it, not replaced by it
    blurred: style.backdropFilter !== 'none' && style.backdropFilter !== '',
    seeThrough: !/^rgb\(/.test(style.backgroundColor),
    stillRendering: drawnWhilePaused > 8,
    pointerFree: document.pointerLockElement === null,
    worldStillMoving: false
  };
  const before = g.player.pos.y;
  g.player.pos.y += 4;                          // it is an online game: you keep falling
  await new Promise(f => setTimeout(f, 500));
  out.worldStillMoving = Math.abs(g.player.pos.y - (before + 4)) > 0.2;
  document.getElementById('playbtn').click();
  await new Promise(f => setTimeout(f, 200));
  out.overlayClearedOnResume = !menu.classList.contains('overlay') &&
                               !document.body.classList.contains('paused');
  return out;
});

// -------------------------------------------------------------------- verdict
if (!R.openedOnBacktick) fail.push('` did not open the settings panel');
if (!R.closedAgain) fail.push('` did not close it again');
if (!R.openedOnEquals) fail.push('= did not open the settings panel');
if (R.rows.length !== 14) fail.push(`expected 14 key rows, got ${R.rows.length}`);
if (R.forwardShowsW !== 'W') fail.push('the Forward row does not show W: ' + R.forwardShowsW);
if (R.sprintShowsBothShifts !== 'Shift L / Shift R') fail.push('Sprint does not show both shifts: ' + R.sprintShowsBothShifts);
if (R.arming !== 'Forward') fail.push('clicking a key row did not arm it');
if (R.forwardNowShows !== 'I') fail.push('the row did not repaint after rebinding: ' + R.forwardNowShows);
if (R.savedBinds !== 'fwd') fail.push('the rebind was not saved');
if (!R.rebindWorks.iMoves) fail.push('the rebound key does not move the player: ' + JSON.stringify(R.rebindWorks));
if (!R.rebindWorks.wIsDead) fail.push('the old key still moves the player: ' + JSON.stringify(R.rebindWorks));
if (R.survivedReload !== 'fwd') fail.push('the rebind did not survive a reload');
if (R.afterReset.w !== 'fwd' || !R.afterReset.iGone) fail.push('RESET KEYS did not restore the defaults');
if (R.afterReset.label !== 'W') fail.push('RESET KEYS did not repaint the rows');
if (String(R.modeRows) !== 'crouch,ads,sprint,jump') fail.push('hold/toggle rows are wrong: ' + R.modeRows);
if (!R.sprintLatches.afterTap) fail.push('sprint did not latch on');
if (R.sprintLatches.afterSecondTap) fail.push('sprint did not latch off');
if (!R.jumpLatches.held) fail.push('jump did not latch on');
if (R.jumpLatches.hops < 2) fail.push('a latched jump did not keep hopping: ' + JSON.stringify(R.jumpLatches));
if (!R.jumpLatches.releasedOnSecondTap) fail.push('jump did not latch off');
if (!R.sprintButton.exists) fail.push('there is no sprint button');
if (!R.sprintButton.inTouchPad) fail.push('the sprint button is not on the touch pad');
if (!R.sprintButton.whileDown) fail.push('the sprint button does not press sprint');
if (R.sprintButton.afterUp) fail.push('the sprint button stayed down after release');
if (!R.pause.menuShown || !R.pause.isOverlay || !R.pause.bodyPaused) fail.push('pause did not open as an overlay');
if (!R.pause.blurred) fail.push('the paused view is not blurred');
if (!R.pause.seeThrough) fail.push('the pause screen is opaque, so the game is not behind it');
if (!R.pause.stillRendering) fail.push('the game stopped rendering while paused');
if (!R.pause.pointerFree) fail.push('the mouse is still captured on the pause screen');
if (!R.pause.worldStillMoving) fail.push('the world froze while paused');
if (!R.pause.overlayClearedOnResume) fail.push('the overlay survived RESUME');
if (errs.length) fail.push('page errors: ' + errs.join(' | '));

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
if (fail.length) { console.log('FAIL: ' + fail.join('\n      ')); await browser.close(); process.exit(1); }
console.log('PASS — keys rebind and stick, four actions latch, sprint has a button, pause floats over the game');
await browser.close();
